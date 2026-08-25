/**
 * GLMEmbedder —— 直接调 GLM embedding-3 API,不走 LangChain OpenAIEmbeddings
 *
 * 为什么不用 LangChain 的 OpenAIEmbeddings?
 *   LangChain v1.x 的 OpenAIEmbeddings 通过 openai SDK 发请求,
 *   可能传了 GLM 不支持的参数(encoding_format 等),GLM 静默返零向量。
 *   直接 fetch 调 GLM API 最可靠。
 *
 * 实现 LangChain 的 Embeddings 接口:
 *   embedQuery(text) → number[]
 *   embedDocuments(texts) → number[][]
 *
 * 内置 cache:同文本(按 SHA-256 hash)直接命中内存,不调 API
 *   - 索引时同文件未变 chunk → 0 成本(只 embed 真的变了的)
 *   - 增量更新时省 50-90% 成本
 */

import { createHash } from 'node:crypto';

export interface EmbeddingsLike {
  embedQuery(text: string): Promise<number[]>;
  embedDocuments(texts: string[]): Promise<number[][]>;
}

export class GLMEmbedder implements EmbeddingsLike {
  private readonly apiKey: string;
  private readonly baseURL: string;
  private readonly model: string;
  private readonly dimensions: number;
  /** 文本 hash → embedding 缓存,跨 embedQuery/embedDocuments 共享 */
  private readonly cache = new Map<string, number[]>();
  /** 缓存命中统计(日志用) */
  private cacheHits = 0;
  private cacheMisses = 0;

  constructor(opts: {
    apiKey: string;
    baseURL?: string;
    model?: string;
    dimensions?: number;
  }) {
    this.apiKey = opts.apiKey;
    this.baseURL = opts.baseURL ?? 'https://open.bigmodel.cn/api/paas/v4';
    this.model = opts.model ?? 'embedding-3';
    this.dimensions = opts.dimensions ?? 512;
  }

  async embedQuery(text: string): Promise<number[]> {
    return this.embedWithCache(text);
  }

  async embedDocuments(texts: string[]): Promise<number[][]> {
    // 先查 cache,把未命中的收集起来批量调 API
    const results: number[][] = new Array(texts.length);
    const missIndices: number[] = [];
    const missTexts: string[] = [];
    for (let i = 0; i < texts.length; i++) {
      const text = texts[i];
      const hash = this.hashText(text);
      const cached = this.cache.get(hash);
      if (cached) {
        results[i] = cached;
        this.cacheHits++;
      } else {
        missIndices.push(i);
        missTexts.push(text);
      }
    }

    if (missTexts.length > 0) {
      // 批量 embed 未命中的(每次最多 10 个)
      const batchSize = 10;
      for (let i = 0; i < missTexts.length; i += batchSize) {
        const batch = missTexts.slice(i, i + batchSize);
        const batchResults = await Promise.all(
          batch.map((t) => this.embedSingle(t)),
        );
        for (let j = 0; j < batch.length; j++) {
          const text = batch[j];
          const emb = batchResults[j];
          const hash = this.hashText(text);
          this.cache.set(hash, emb);
          results[missIndices[i + j]] = emb;
          this.cacheMisses++;
        }
        if (i + batchSize < missTexts.length) {
          await new Promise((r) => setTimeout(r, 200));
        }
      }
    }

    // 日志(每 100 次打一次命中率)
    const total = this.cacheHits + this.cacheMisses;
    if (total > 0 && total % 100 === 0) {
      const hitRate = ((this.cacheHits / total) * 100).toFixed(1);
      console.log(
        `[GLMEmbedder] cache stats: hits=${this.cacheHits}, misses=${this.cacheMisses}, hit_rate=${hitRate}%`,
      );
    }

    return results;
  }

  /**
   * 单文本 embed(带 cache)
   */
  private async embedWithCache(text: string): Promise<number[]> {
    const hash = this.hashText(text);
    const cached = this.cache.get(hash);
    if (cached) {
      this.cacheHits++;
      return cached;
    }
    this.cacheMisses++;
    const embedding = await this.embedSingle(text);
    this.cache.set(hash, embedding);
    return embedding;
  }

  private hashText(text: string): string {
    return createHash('sha256').update(text).digest('hex');
  }

  private async embedSingle(text: string): Promise<number[]> {
    const url = `${this.baseURL}/embeddings`;
    const body = JSON.stringify({
      model: this.model,
      input: text,
      dimensions: this.dimensions,
    });

    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body,
    });

    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`GLM embedding API error ${resp.status}: ${errText.slice(0, 200)}`);
    }

    const json = (await resp.json()) as {
      data: Array<{ embedding: number[] }>;
    };

    const embedding = json.data?.[0]?.embedding;
    if (!embedding || embedding.length === 0) {
      throw new Error('GLM embedding API returned empty embedding');
    }

    return embedding;
  }

  /** 用于测试 / 调试:看缓存命中率 */
  getCacheStats(): { hits: number; misses: number; size: number; hitRate: number } {
    const total = this.cacheHits + this.cacheMisses;
    return {
      hits: this.cacheHits,
      misses: this.cacheMisses,
      size: this.cache.size,
      hitRate: total > 0 ? this.cacheHits / total : 0,
    };
  }

  /** 清缓存(测试用) */
  clearCache(): void {
    this.cache.clear();
    this.cacheHits = 0;
    this.cacheMisses = 0;
  }
}
