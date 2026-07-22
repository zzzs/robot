import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Document } from '@langchain/core/documents';
import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters';
import { OpenAIEmbeddings } from '@langchain/openai';
import { MemoryVectorStore } from '@langchain/classic/vectorstores/memory';
import { PGVectorStore } from '@langchain/community/vectorstores/pgvector';
import { Embeddings } from '@langchain/core/embeddings';
import { VectorStore } from '@langchain/core/vectorstores';
import { NewsLoaderService } from './news-loader.service';
import { PostgresPoolService } from '../postgres/postgres-pool.service';

export type IngestStatus = 'idle' | 'loading' | 'ready' | 'failed';

/**
 * RAG pipeline: split → batch-embed → vector store.
 *
 * 双模式 vector store:
 *   - DATABASE_URL 设了 → PGVectorStore(持久化,重启无需 reingest)
 *   - 没设 → MemoryVectorStore(开发降级,进程重启丢)
 *
 * Embedding 用 GLM embedding-3(OpenAI 兼容,open.bigmodel.cn)。
 * 本地 HuggingFace embedding 在本机不可用(HF 被墙 + 镜像限速 + ONNX Runtime
 * macOS 12.x bug)。GLM API 是唯一可用方案。
 */
@Injectable()
export class NewsEmbeddingService implements OnModuleInit {
  private readonly logger = new Logger(NewsEmbeddingService.name);
  private readonly splitter: RecursiveCharacterTextSplitter;
  private readonly embeddings: Embeddings;
  private vectorStore: VectorStore;  // mutable: 占位 MemoryVectorStore,init 后换 PGVectorStore
  private readonly configService: ConfigService;
  private readonly poolSvc: PostgresPoolService;

  status: IngestStatus = 'idle';
  chunkCount = 0;

  constructor(
    private readonly loader: NewsLoaderService,
    config: ConfigService,
    poolSvc: PostgresPoolService,
  ) {
    this.configService = config;
    this.poolSvc = poolSvc;
    this.splitter = new RecursiveCharacterTextSplitter({
      chunkSize: 800,
      chunkOverlap: 100,
      separators: ['\n\n', '\n', '。', '!', '?', '.', ' '],
    });
    this.embeddings = new OpenAIEmbeddings({
      modelName: 'embedding-3',
      openAIApiKey:
        config.get<string>('news.glmApiKey') ?? process.env.GLM_API_KEY ?? '',
      configuration: {
        baseURL:
          config.get<string>('news.glmBaseUrl') ??
          'https://open.bigmodel.cn/api/paas/v4',
      },
    });
    // PGVectorStore 在 onModuleInit 异步初始化(需要建表)
    // 构造期先用 MemoryVectorStore 占位,PGVectorStore 初始化后替换
    this.vectorStore = new MemoryVectorStore(this.embeddings);
  }

  async onModuleInit(): Promise<void> {
    // 如果有 Postgres,初始化 PGVectorStore
    if (this.poolSvc.isAvailable()) {
      try {
        const pgStore = await PGVectorStore.initialize(this.embeddings, {
          postgresConnectionOptions: {
            connectionString: this.configService.get<string>('database.url'),
          },
          tableName: 'news_vectors',
          dimensions: 512,  // GLM embedding-3 实测返 512 维
          distanceStrategy: 'cosine',
          columns: {
            contentColumnName: 'content',     // 跟 migration 002 对齐
            metadataColumnName: 'metadata',
            vectorColumnName: 'embedding',
          },
        });
        // 替换占位 store
        this.vectorStore = pgStore;
        this.logger.log('PGVectorStore initialized (持久化向量库)');
      } catch (err) {
        this.logger.error(
          `PGVectorStore init failed, fallback to memory: ${(err as Error).message}`,
        );
      }
    }

    // ingest 启动异步跑(已有逻辑)
    void this.ingest().catch((err: unknown) => {
      this.logger.error(`ingest crashed: ${(err as Error).message}`);
      this.status = 'failed';
    });
  }

  async ingest(): Promise<void> {
    if (this.status === 'loading') {
      this.logger.warn('ingest already in progress; skipping');
      return;
    }
    this.status = 'loading';
    const startedAt = Date.now();
    try {
      // PGVectorStore 已经有数据就跳过(避免重启重复 ingest)
      if (this.vectorStore instanceof PGVectorStore && this.poolSvc.pool) {
        const result = await this.poolSvc.pool.query(
          'SELECT COUNT(*) FROM news_vectors',
        );
        const count = parseInt(result.rows[0].count, 10);
        if (count > 0) {
          this.logger.log(`news_vectors already has ${count} rows, skipping ingest`);
          this.chunkCount = count;
          this.status = 'ready';
          return;
        }
      }

      const docs = await this.loader.loadNews();
      if (docs.length === 0) {
        this.logger.warn('no articles to ingest; staying in idle state');
        this.status = 'idle';
        return;
      }
      const chunks = await this.splitter.splitDocuments(docs);
      await this.embedInBatches(chunks);
      this.chunkCount = chunks.length;
      this.status = 'ready';
      const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
      this.logger.log(
        `ingested ${chunks.length} chunks from ${docs.length} articles in ${elapsed}s`,
      );
    } catch (err) {
      this.status = 'failed';
      this.logger.error(`ingest failed: ${(err as Error).message}`);
    }
  }

  asRetriever(k = 5) {
    return this.vectorStore.asRetriever({ k });
  }

  private async embedInBatches(chunks: Document[]): Promise<void> {
    const batchSize =
      this.configService.get<number>('news.embeddingBatchSize') ?? 10;
    const delayMs =
      this.configService.get<number>('news.embeddingBatchDelayMs') ?? 200;
    for (let i = 0; i < chunks.length; i += batchSize) {
      const batch = chunks.slice(i, i + batchSize);
      try {
        await this.addWithRetry(batch);
      } catch (err) {
        this.logger.warn(
          `batch ${Math.floor(i / batchSize)} failed permanently: ${(err as Error).message}; skipping ${batch.length} chunks`,
        );
      }
      if (i + batchSize < chunks.length) {
        await this.sleep(delayMs);
      }
    }
  }

  private async addWithRetry(batch: Document[], attempts = 2): Promise<void> {
    let lastErr: unknown;
    for (let i = 1; i <= attempts; i++) {
      try {
        await this.vectorStore.addDocuments(batch);
        return;
      } catch (err) {
        lastErr = err;
        this.logger.warn(
          `embedding batch attempt ${i}/${attempts} failed: ${(err as Error).message}`,
        );
        if (i < attempts) await this.sleep(1000);
      }
    }
    throw lastErr;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }
}
