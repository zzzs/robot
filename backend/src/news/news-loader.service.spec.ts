import { NewsLoaderService } from './news-loader.service';

/**
 * rss-parser doesn't expose a "parse from string" method on the public API
 * in a way that's easy to mock. We mock the parser instance directly.
 *
 * Strategy: instantiate NewsLoaderService, then reach into its private
 * `parser` field and replace `parseURL` with our stub.
 */
function makeService(): NewsLoaderService {
  const config = {
    get: (key: string) => {
      if (key === 'news.rssUrls') return ['https://feed-a.test/rss'];
      if (key === 'news.ingestCount') return 5;
      return undefined;
    },
  } as never;
  return new NewsLoaderService(config);
}

function injectParserStub(
  service: NewsLoaderService,
  itemsByFeed: Record<string, unknown[]>,
) {
  const parser = (
    service as unknown as { parser: { parseURL: (url: string) => unknown } }
  ).parser;
  parser.parseURL = (url: string) =>
    Promise.resolve({ items: itemsByFeed[url] ?? [] });
}

describe('NewsLoaderService', () => {
  it('parses normal RSS items into Documents with citation metadata', async () => {
    const svc = makeService();
    injectParserStub(svc, {
      'https://feed-a.test/rss': [
        {
          title: '茅台三季度净利润同比增长 15%',
          link: 'https://feed-a.test/news/1',
          pubDate: 'Wed, 15 Jul 2026 08:00:00 GMT',
          'content:encoded':
            '<p>贵州茅台发布三季报,营收 X 亿元,<b>净利润</b>同比增长 15%。</p>',
        },
        {
          title: '宁德时代德国工厂投产',
          link: 'https://feed-a.test/news/2',
          pubDate: 'Thu, 16 Jul 2026 09:30:00 GMT',
          content: '德国工厂正式投产,产能 X GWh。',
        },
      ],
    });
    const docs = await svc.loadNews();
    expect(docs).toHaveLength(2);
    const first = docs[0];
    expect(first.metadata.title).toBe('茅台三季度净利润同比增长 15%');
    expect(first.metadata.link).toBe('https://feed-a.test/news/1');
    expect(first.metadata.pubDate).toContain('2026');
    expect(first.metadata.source).toBe('feed-a.test');
    // HTML stripped, whitespace normalized
    expect(first.pageContent).toContain('贵州茅台发布三季报');
    expect(first.pageContent).not.toContain('<p>');
    expect(first.pageContent).not.toContain('<b>');
  });

  it('returns empty array on RSS error (does NOT throw)', async () => {
    const svc = makeService();
    const parser = (svc as unknown as { parser: { parseURL: () => unknown } })
      .parser;
    parser.parseURL = () => Promise.reject(new Error('connect ECONNREFUSED'));
    const docs = await svc.loadNews();
    expect(docs).toEqual([]);
  });

  it('skips items with missing title or content', async () => {
    const svc = makeService();
    injectParserStub(svc, {
      'https://feed-a.test/rss': [
        { title: 'good', content: 'has body' },
        { title: 'no content' }, // missing content → skip
        { content: 'no title' }, // missing title → skip
        { title: '', content: 'empty title' }, // empty title → skip
      ],
    });
    const docs = await svc.loadNews();
    expect(docs).toHaveLength(1);
    expect(docs[0].metadata.title).toBe('good');
  });

  it('caps total to ingestCount', async () => {
    const svc = makeService();
    injectParserStub(svc, {
      'https://feed-a.test/rss': Array.from({ length: 20 }, (_, i) => ({
        title: `news ${i}`,
        content: 'body',
      })),
    });
    const docs = await svc.loadNews();
    expect(docs).toHaveLength(5); // ingestCount = 5 in our stub config
  });

  it('loads from fixture: scheme (no network)', async () => {
    // Override config to use fixture
    const config = {
      get: (key: string) => {
        if (key === 'news.rssUrls') return ['fixture:sample'];
        if (key === 'news.ingestCount') return 5;
        return undefined;
      },
    } as never;
    const svc = new NewsLoaderService(config);
    const docs = await svc.loadNews();
    // Fixture ships 20 articles; ingestCount caps to 5
    expect(docs).toHaveLength(5);
    expect(docs[0].metadata.title).toBeTruthy();
    expect(docs[0].metadata.source).toBe('fixture:sample');
    expect(docs[0].pageContent.length).toBeGreaterThan(50);
  });
});
