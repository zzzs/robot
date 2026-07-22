import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool, type PoolClient } from 'pg';

/**
 * 共享的 Postgres 连接池 provider。
 *
 * 双模式:
 *   - DATABASE_URL 设了 → 创建 Pool,所有持久化模块共用
 *   - DATABASE_URL 没设 → pool=null,模块各自降级到 in-memory
 *
 * 用 `isAvailable()` 判断是否可用,不要直接访问 `pool`(可能是 null)。
 *
 * 用 `getClient()` 拿一个 client(用完自动释放),不要直接 `pool.connect()`,
 * 因为 pool 可能是 null。
 */
@Injectable()
export class PostgresPoolService implements OnModuleDestroy {
  private readonly logger = new Logger(PostgresPoolService.name);
  readonly pool: Pool | null;

  constructor(private readonly config: ConfigService) {
    const url = this.config.get<string>('database.url');
    if (!url) {
      this.logger.warn(
        'DATABASE_URL not set — persistence disabled, falling back to in-memory ' +
          '(see docker-compose.yml to start Postgres)',
      );
      this.pool = null;
      return;
    }
    const max = this.config.get<number>('database.poolMax') ?? 10;
    this.pool = new Pool({
      connectionString: url,
      max,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });
    this.logger.log(`Postgres pool created (max=${max})`);
  }

  isAvailable(): boolean {
    return this.pool !== null;
  }

  /**
   * 拿一个 client。callback 模式:用完自动 release。
   * pool 不可用时抛 Error,调用方应该先 isAvailable() 检查。
   */
  async withClient<T>(
    fn: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    if (!this.pool) {
      throw new Error('Postgres pool not available (DATABASE_URL not set)');
    }
    const client = await this.pool.connect();
    try {
      return await fn(client);
    } finally {
      client.release();
    }
  }

  async onModuleDestroy() {
    if (this.pool) {
      await this.pool.end();
      this.logger.log('Postgres pool closed');
    }
  }
}
