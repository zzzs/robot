import { Controller, Get, Query } from '@nestjs/common';
import { NewsEmbeddingService } from './news-embedding.service';

/**
 * Debug 端点:查看 MemoryVectorStore 的内部数据结构。
 *
 * 用法:
 *   curl http://localhost:3000/news/debug            → 查看 store 概览 + 样本
 *   curl 'http://localhost:3000/news/debug?q=茅台'   → 样本 + 模拟检索
 */
@Controller('news')
export class NewsDebugController {
  constructor(private readonly embedding: NewsEmbeddingService) {}

  @Get('debug')
  async debug(@Query('q') query?: string) {
    const status = this.embedding.status;
    const chunkCount = this.embedding.chunkCount;

    if (status !== 'ready') {
      return {
        status,
        chunkCount,
        message: 'vector store not ready yet',
      };
    }

    // 通过 similaritySearch 拿到真实的 Document(含 metadata),
    // 再通过 similaritySearchWithScore 拿到相似度分数。
    // 如果没有 query,用空检索拿前几个 chunk 做 sample。
    const sampleQuery = query || '茅台 净利润 新闻';
    const retriever = this.embedding.asRetriever(3);
    const docs = await retriever.invoke(sampleQuery);

    const samples = docs.map((doc, i) => ({
      index: i,
      contentPreview: (doc.pageContent ?? '').slice(0, 200),
      contentLength: (doc.pageContent ?? '').length,
      metadata: doc.metadata,
    }));

    // 用一个简单 query 做 similarity search,展示分数
    let searchResult: unknown = null;
    try {
      // MemoryVectorStore 支持 similaritySearchWithScore
      const store = (
        this.embedding as unknown as {
          vectorStore: {
            similaritySearchWithScore: (
              q: string,
              k: number,
            ) => Promise<unknown[]>;
          };
        }
      ).vectorStore;
      const scored = await store.similaritySearchWithScore(sampleQuery, 3);
      searchResult = scored.map(
        ([doc, score]: [unknown, number], i: number) => ({
          rank: i,
          score: Number(score.toFixed(4)),
          contentPreview: (
            (doc as { pageContent?: string }).pageContent ?? ''
          ).slice(0, 100),
        }),
      );
    } catch {
      searchResult = 'similaritySearchWithScore not available';
    }

    return {
      status,
      chunkCount,
      vectorDimension: 'embedding-3 (GLM)',
      sampleQuery,
      topResults: samples,
      similarityScores: searchResult,
    };
  }
}
