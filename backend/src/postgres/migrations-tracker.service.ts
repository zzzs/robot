import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Inject } from '@nestjs/common';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { PostgresPoolService } from './postgres-pool.service';
import { POSTGRES_SAVER } from './postgres.constants';

/**
 * Migration runner —— 简易版,不引 Knex / Prisma。
 *
 * 启动时:
 *   1. 建 migrations 表(如果不存在)
 *   2. 读 migrations/ 目录下所有 .sql(按文件名排序)
 *   3. 跳过已执行的
 *   4. 未执行的:每个文件 BEGIN ... COMMIT 包着跑,失败回滚 + 抛
 *   5. 跑完业务迁移后,调 PostgresSaver.setup() 一次(单例,全局只跑一次)
 *
 * DATABASE_URL 没设 → 跳过(no-op),业务模块各自降级到 in-memory。
 */
@Injectable()
export class MigrationsTrackerService implements OnModuleInit {
  private readonly logger = new Logger(MigrationsTrackerService.name);

  constructor(
    private readonly poolSvc: PostgresPoolService,
    @Inject(POSTGRES_SAVER) private readonly saver: PostgresSaver | null,
  ) {}

  async onModuleInit() {
    if (!this.poolSvc.isAvailable()) {
      this.logger.log('Postgres not configured, skipping migrations');
      return;
    }
    try {
      await this.runMigrations();
    } catch (err) {
      this.logger.error(`Migration failed: ${(err as Error).message}`);
      // 不抛 —— 让 backend 起来,业务模块各自降级
    }
    // LangGraph 框架表(checkpoints / writes)只跑一次 setup
    if (this.saver) {
      try {
        await this.saver.setup();
        this.logger.log('PostgresSaver.setup() complete (shared singleton)');
      } catch (err) {
        this.logger.error(`PostgresSaver.setup() failed: ${(err as Error).message}`);
      }
    }
  }

  private async runMigrations() {
    const migrationsDir = this.findMigrationsDir();
    const files = readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    if (files.length === 0) {
      this.logger.log('No migrations to run');
      return;
    }

    await this.poolSvc.withClient(async (client) => {
      // 1. 建 migrations 表
      await client.query(`
        CREATE TABLE IF NOT EXISTS migrations (
          id SERIAL PRIMARY KEY,
          filename TEXT NOT NULL UNIQUE,
          applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);

      // 2. 读已执行的
      const applied = await client.query(
        'SELECT filename FROM migrations',
      );
      const appliedSet = new Set(applied.rows.map((r) => r.filename));

      // 3. 跑未执行的
      for (const file of files) {
        if (appliedSet.has(file)) continue;
        const sql = readFileSync(join(migrationsDir, file), 'utf8');
        this.logger.log(`Running migration: ${file}`);
        try {
          await client.query('BEGIN');
          await client.query(sql);
          await client.query(
            'INSERT INTO migrations (filename) VALUES ($1)',
            [file],
          );
          await client.query('COMMIT');
          this.logger.log(`✓ ${file}`);
        } catch (err) {
          await client.query('ROLLBACK');
          this.logger.error(`✗ ${file}: ${(err as Error).message}`);
          throw err;
        }
      }
    });
  }

  /**
   * 找 migrations 目录。
   * 开发期从 src/postgres/migrations/ 找(代码在 src/);
   * 生产期(代码在 dist/postgres/)从同级 dist/postgres/migrations/ 找 ——
   * 需要 nest-cli.json 配置把 .sql 复制到 dist/(见 nest-cli.json 的 compilerOptions.assets)。
   */
  private findMigrationsDir(): string {
    // __dirname 是编译后的 .js 文件所在目录(可能是 dist/postgres/ 或 src/postgres/)
    // 先看同目录的 migrations/ 子目录(开发和生产都能用)
    const here = __dirname;
    const candidates = [
      join(here, 'migrations'),              // 同级 migrations/(src 或 dist)
      join(here, '..', 'src', 'postgres', 'migrations'),  // dist/postgres → src/postgres/migrations
    ];
    for (const c of candidates) {
      try {
        readdirSync(c);
        return c;
      } catch {
        // not found, try next
      }
    }
    throw new Error(`migrations dir not found, tried: ${candidates.join(', ')}`);
  }
}
