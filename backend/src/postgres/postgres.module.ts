import { Module, Global } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PG_POOL, POSTGRES_SAVER } from './postgres.constants';
import { PostgresPoolService } from './postgres-pool.service';
import { MigrationsTrackerService } from './migrations-tracker.service';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';

/**
 * PostgresModule —— 共享 Pool + migration runner + 单例 PostgresSaver。
 *
 * 全局 module(@Global),任何模块都能直接 inject PostgresPoolService,
 * 不需要在每个 module 的 imports 里重复声明。
 *
 * DATABASE_URL 没设时:PostgresPoolService.pool === null,
 * 业务模块应该走 in-memory fallback(各自判断 isAvailable())。
 */
@Global()
@Module({
  imports: [ConfigModule],
  providers: [
    PostgresPoolService,
    {
      // 保留 raw Pool provider 兼容老代码;实际推荐用 PostgresPoolService
      provide: PG_POOL,
      inject: [PostgresPoolService],
      useFactory: (svc: PostgresPoolService) => svc.pool,
    },
    {
      // PostgresSaver 单例 —— 两个 orchestrator 共用同一实例,避免 setup() 冲突
      provide: POSTGRES_SAVER,
      inject: [PostgresPoolService],
      useFactory: (svc: PostgresPoolService) => {
        if (!svc.pool) return null;
        return new PostgresSaver(svc.pool);
      },
    },
    MigrationsTrackerService,
  ],
  exports: [PG_POOL, POSTGRES_SAVER, PostgresPoolService, MigrationsTrackerService],
})
export class PostgresModule {}
