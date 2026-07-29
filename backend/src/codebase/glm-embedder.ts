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
 */

export interface EmbeddingsLike {
  embedQuery(text: string): Promise<number[]>;
  embedDocuments(texts: string[]): Promise<number[][]>;
}

export class GLMEmbedder implements EmbeddingsLike {
  private readonly apiKey: string;
  private readonly baseURL: string;
  private readonly model: string;
  private readonly dimensions: number;

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
    return this.embedSingle(text);
  }

  async embedDocuments(texts: string[]): Promise<number[][]> {
    // 批量 embed(每次最多 10 个,避免超限)
    const batchSize = 10;
    const results: number[][] = [];
    for (let i = 0; i < texts.length; i += batchSize) {
      const batch = texts.slice(i, i + batchSize);
      const batchResults = await Promise.all(batch.map((t) => this.embedSingle(t)));
      results.push(...batchResults);
      if (i + batchSize < texts.length) {
        await new Promise((r) => setTimeout(r, 200));
      }
    }
    return results;
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
}
