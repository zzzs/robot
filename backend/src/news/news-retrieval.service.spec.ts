import { Document } from '@langchain/core/documents';
import { NewsRetrievalService } from './news-retrieval.service';
import { NewsEmbeddingService, IngestStatus } from './news-embedding.service';

function makeEmbeddingStub(
  status: IngestStatus,
  docs: Document[] = [],
): NewsEmbeddingService {
  return {
    status,
    asRetriever: () => ({
      invoke: () => Promise.resolve(docs),
    }),
  } as unknown as NewsEmbeddingService;
}

const configStub = {
  get: (key: string) => (key === 'news.topK' ? 5 : undefined),
} as never;

describe('NewsRetrievalService.search', () => {
  it('returns loading placeholder when status=loading', async () => {
    const svc = new NewsRetrievalService(
      makeEmbeddingStub('loading'),
      configStub,
    );
    const result = await svc.search('anything');
    expect(result).toContain('loading');
    expect(result).toContain('retry');
  });

  it('returns empty placeholder when status=idle', async () => {
    const svc = new NewsRetrievalService(makeEmbeddingStub('idle'), configStub);
    const result = await svc.search('anything');
    expect(result).toContain('empty');
  });

  it('returns failed placeholder when status=failed', async () => {
    const svc = new NewsRetrievalService(
      makeEmbeddingStub('failed'),
      configStub,
    );
    const result = await svc.search('anything');
    expect(result).toContain('failed');
  });

  it('returns formatted snippets with citations when ready', async () => {
    const docs = [
      new Document({
        pageContent: '茅台 Q3 净利润同比增长 15%。',
        metadata: {
          title: '茅台 Q3 报',
          link: 'https://example.test/1',
          pubDate: '2026-07-15',
          source: 'example.test',
        },
      }),
      new Document({
        pageContent: '宁德时代德国工厂投产。',
        metadata: {
          title: '宁德德国',
          link: 'https://example.test/2',
          pubDate: '2026-07-16',
          source: 'example.test',
        },
      }),
    ];
    const svc = new NewsRetrievalService(
      makeEmbeddingStub('ready', docs),
      configStub,
    );
    const result = await svc.search('茅台');
    expect(result).toContain('[1]');
    expect(result).toContain('茅台 Q3 报');
    expect(result).toContain('https://example.test/1');
    expect(result).toContain('2026-07-15');
    expect(result).toContain('[2]');
  });

  it('returns "no news found" when ready but retriever returns empty', async () => {
    const svc = new NewsRetrievalService(
      makeEmbeddingStub('ready', []),
      configStub,
    );
    const result = await svc.search('xyz');
    expect(result).toContain('no news found');
  });

  it('handles empty query gracefully', async () => {
    const svc = new NewsRetrievalService(
      makeEmbeddingStub('ready'),
      configStub,
    );
    const result = await svc.search('   ');
    expect(result).toContain('empty');
  });
});
