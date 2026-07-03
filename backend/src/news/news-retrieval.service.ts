import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NewsEmbeddingService } from './news-embedding.service';

export interface NewsSnippet {
  title: string;
  link: string;
  pubDate: string;
  content: string;
  source?: string;
}

const LOADING_REPLY = 'news database is loading, please retry in a few seconds';
const EMPTY_REPLY = 'news database is currently empty (no articles ingested)';
const FAILED_REPLY =
  'news database failed to load (RSS or embedding error); please check server logs';

/**
 * Wraps the vector store's retriever with status-aware semantics. Returns
 * either:
 *   - a friendly string when not ready (loading / empty / failed)
 *   - a formatted text with top-K snippets + citations when ready
 *
 * The orchestrator passes whatever string we return straight to the LLM via
 * the ToolMessage — so the LLM gets a useful response either way.
 */
@Injectable()
export class NewsRetrievalService {
  private readonly logger = new Logger(NewsRetrievalService.name);
  private readonly topK: number;

  constructor(
    private readonly embedding: NewsEmbeddingService,
    config: ConfigService,
  ) {
    this.topK = config.get<number>('news.topK') ?? 5;
  }

  /**
   * Search the news vector store. Returns a string ready to ship as
   * ToolMessage content. NEVER throws — surfaces all errors as text.
   */
  async search(query: string): Promise<string> {
    if (!query?.trim()) {
      return 'query is empty; nothing to search';
    }
    if (this.embedding.status !== 'ready') {
      this.logger.warn(
        `search called while status=${this.embedding.status}; returning placeholder`,
      );
      if (this.embedding.status === 'loading') return LOADING_REPLY;
      if (this.embedding.status === 'idle') return EMPTY_REPLY;
      return FAILED_REPLY;
    }
    try {
      const retriever = this.embedding.asRetriever(this.topK);
      const docs = await retriever.invoke(query);
      if (docs.length === 0) {
        return `no news found for query: "${query.slice(0, 100)}"`;
      }
      const snippets = docs.map((d) => this.toSnippet(d));
      return this.formatForLLM(snippets);
    } catch (err) {
      this.logger.error(
        `search failed unexpectedly: ${(err as Error).message}`,
      );
      return `news search failed: ${(err as Error).message}`;
    }
  }

  private toSnippet(doc: {
    pageContent?: string;
    metadata?: Record<string, unknown>;
  }): NewsSnippet {
    const meta = doc.metadata ?? {};
    return {
      title: (meta.title as string) ?? '(no title)',
      link: (meta.link as string) ?? '',
      pubDate: (meta.pubDate as string) ?? '',
      content: doc.pageContent ?? '',
      source: meta.source as string | undefined,
    };
  }

  /**
   * Format as numbered citations. LLM can then naturally reference them in
   * prose: "据 [1] 报道, ...;另据 [2] ..."
   */
  private formatForLLM(snippets: NewsSnippet[]): string {
    return snippets
      .map((s, i) => {
        const header = `[${i + 1}] ${s.title}${s.pubDate ? ` (${s.pubDate})` : ''}`;
        const link = s.link ? `    ${s.link}` : '';
        const content = `    ${s.content.slice(0, 800)}`;
        return [header, link, content].filter(Boolean).join('\n');
      })
      .join('\n\n');
  }
}
