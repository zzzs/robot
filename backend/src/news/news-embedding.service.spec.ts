import { Document } from '@langchain/core/documents';
import { NewsEmbeddingService } from './news-embedding.service';
import { NewsLoaderService } from './news-loader.service';

function makeStubLoader(docs: Document[]): NewsLoaderService {
  return {
    loadNews: () => Promise.resolve(docs),
  } as unknown as NewsLoaderService;
}

function makeService(loader: NewsLoaderService): NewsEmbeddingService {
  const config = {
    get: (key: string) => {
      if (key === 'news.embeddingBatchSize') return 5;
      if (key === 'news.embeddingBatchDelayMs') return 1;
      return undefined;
    },
  } as never;
  return new NewsEmbeddingService(loader, config);
}

describe('NewsEmbeddingService.ingest', () => {
  it('transitions idle → loading → ready with stub embeddings', async () => {
    const docs = [
      new Document({
        pageContent: '茅台净利润大涨。'.repeat(50),
        metadata: { title: '茅台 Q3', link: 'l1', pubDate: 't1', source: 's' },
      }),
    ];
    const svc = makeService(makeStubLoader(docs));
    // Stub both embeddings AND vectorStore — vectorStore was created from
    // the real LocalTransformersEmbeddings in the constructor, so we need
    // to replace it with a fake that accepts addDocuments without real ONNX.
    const stubEmbeddings = {
      embedQuery: () => Promise.resolve([0.1, 0.2, 0.3]),
      embedDocuments: (texts: string[]) =>
        Promise.resolve(texts.map(() => [0.1, 0.2, 0.3])),
    };
    const stubVectorStore = {
      addDocuments: () => Promise.resolve(),
      asRetriever: () => ({ invoke: () => Promise.resolve([]) }),
    };
    (svc as unknown as Record<string, unknown>).embeddings = stubEmbeddings;
    (svc as unknown as Record<string, unknown>).vectorStore = stubVectorStore;

    expect(svc.status).toBe('idle');
    await svc.ingest();
    expect(svc.status).toBe('ready');
    expect(svc.chunkCount).toBeGreaterThan(0);
  });

  it('stays idle when loader returns empty (no articles)', async () => {
    const svc = makeService(makeStubLoader([]));
    await svc.ingest();
    expect(svc.status).toBe('idle');
    expect(svc.chunkCount).toBe(0);
  });
});
