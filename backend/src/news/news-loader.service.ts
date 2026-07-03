import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import RSSParser from 'rss-parser';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Document } from '@langchain/core/documents';

interface FixtureArticle {
  title: string;
  link: string;
  pubDate: string;
  content: string;
}

/**
 * Lazy-loaded static fixture. Read at first use so missing file doesn't crash
 * backend boot. Path resolution: prefer same-dir-as-compiled-js (works in
 * dist/), fall back to cwd-relative (works in dev with ts-node).
 */
function loadSampleFixture(): FixtureArticle[] {
  // Try a few candidate paths to cover dev (src/) and prod (dist/) layouts.
  const candidates = [
    resolve(__dirname, 'fixtures/sample-news.json'),
    resolve(process.cwd(), 'src/news/fixtures/sample-news.json'),
    resolve(process.cwd(), 'dist/news/fixtures/sample-news.json'),
  ];
  for (const path of candidates) {
    try {
      const raw = readFileSync(path, 'utf-8');
      return JSON.parse(raw) as FixtureArticle[];
    } catch {
      // try next
    }
  }
  return [];
}

export interface NewsArticle {
  title: string;
  link: string;
  pubDate: string;
  content: string;
  source: string;
}

/**
 * Pull A-share stock news from RSS feeds (default: Sina Finance).
 *
 * Each fetched article becomes a LangChain `Document` whose `pageContent` is
 * the article body (HTML stripped) and whose `metadata` carries the citation
 * (title / link / pubDate / source) — needed by the retriever to surface
 * sources in the final answer.
 *
 * On failure (any RSS unreachable / 5xx / timeout), this service returns an
 * empty array + warn log. It MUST NOT throw — backend startup must continue
 * even when RSS is down.
 */
@Injectable()
export class NewsLoaderService {
  private readonly logger = new Logger(NewsLoaderService.name);
  private readonly parser = new RSSParser({
    timeout: 8000,
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
    },
  });
  private readonly rssUrls: string[];
  private readonly ingestCount: number;

  constructor(private readonly config: ConfigService) {
    this.rssUrls = this.config.get<string[]>('news.rssUrls') ?? [
      'https://finance.sina.com.cn/rss/stock.xml',
    ];
    this.ingestCount = this.config.get<number>('news.ingestCount') ?? 50;
  }

  /**
   * Fetch latest articles from all configured RSS feeds. Returns LangChain
   * Documents directly so the splitter can consume them without conversion.
   * Caps total at `ingestCount` (distributed across feeds if multiple).
   */
  async loadNews(): Promise<Document[]> {
    const perFeed = Math.max(
      1,
      Math.ceil(this.ingestCount / this.rssUrls.length),
    );
    const all: NewsArticle[] = [];
    for (const url of this.rssUrls) {
      const articles = await this.loadOneSource(url, perFeed);
      all.push(...articles);
      if (all.length >= this.ingestCount) break;
    }
    const trimmed = all.slice(0, this.ingestCount);
    this.logger.log(
      `loaded ${trimmed.length} articles from ${this.rssUrls.length} feed(s)`,
    );
    return trimmed.map((a) => this.toDocument(a));
  }

  /**
   * Load articles from a single source. Supports two URL schemes:
   *
   *   - `fixture:sample`        →  内置 20 篇 A 股示例新闻(离线 demo 用)
   *   - 普通 https URL          →  走 RSSParser.parseURL
   *
   * 默认配置走 fixture,RSSHub / Sina 等真实源在用户网络可达时手动配置。
   */
  private async loadOneSource(
    url: string,
    limit: number,
  ): Promise<NewsArticle[]> {
    if (url.startsWith('fixture:')) {
      const name = url.slice('fixture:'.length);
      if (name === 'sample') {
        const fixture = loadSampleFixture();
        if (fixture.length === 0) {
          this.logger.warn(
            'fixture:sample not found in any candidate path; check dist/ layout',
          );
        }
        return fixture.slice(0, limit).map((a) => ({
          ...a,
          source: 'fixture:sample',
        }));
      }
      this.logger.warn(`unknown fixture: ${name}`);
      return [];
    }
    return this.loadOneFeed(url, limit);
  }

  private async loadOneFeed(
    url: string,
    limit: number,
  ): Promise<NewsArticle[]> {
    try {
      const feed = await this.parser.parseURL(url);
      const items = (feed.items ?? []).slice(0, limit);
      return items
        .map((item) => this.normalizeItem(item, url))
        .filter((a): a is NewsArticle => a !== null);
    } catch (err) {
      this.logger.warn(
        `rss fetch failed for ${url}: ${(err as Error).message}`,
      );
      return [];
    }
  }

  /**
   * RSS items have inconsistent field names across providers. Normalize to
   * our NewsArticle shape. Sina uses `content:encoded` / `content:encodedSnippet`
   * for full HTML; fall back to `content` / `description` / `summary`.
   */
  private normalizeItem(
    item: Record<string, unknown>,
    feedUrl: string,
  ): NewsArticle | null {
    const title = (item.title as string) ?? '';
    const link = (item.link as string) ?? '';
    const pubDate = (item.pubDate as string) ?? (item.isoDate as string) ?? '';
    const source = this.extractSourceName(feedUrl);
    const content = this.pickContent(item);
    if (!title || !content) return null;
    return { title, link, pubDate, content, source };
  }

  /** Prefer the longer, full-content fields. Strip HTML. */
  private pickContent(item: Record<string, unknown>): string {
    const raw =
      (item['content:encoded'] as string) ??
      (item.content as string) ??
      (item.contentSnippet as string) ??
      (item.summary as string) ??
      (item.description as string) ??
      '';
    return this.stripHtml(raw);
  }

  /** Strip HTML tags + collapse whitespace. RSS content is often HTML. */
  private stripHtml(html: string): string {
    return html
      .replace(/<[^>]*>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /** Derive a short source name from the feed URL host. */
  private extractSourceName(feedUrl: string): string {
    try {
      const host = new URL(feedUrl).hostname;
      return host.replace(/^www\./, '');
    } catch {
      return feedUrl;
    }
  }

  private toDocument(article: NewsArticle): Document {
    return new Document({
      pageContent: `${article.title}\n\n${article.content}`,
      metadata: {
        title: article.title,
        link: article.link,
        pubDate: article.pubDate,
        source: article.source,
        type: 'news',
      },
    });
  }
}
