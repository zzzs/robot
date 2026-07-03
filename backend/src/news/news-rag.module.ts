import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { NewsLoaderService } from './news-loader.service';
import { NewsEmbeddingService } from './news-embedding.service';
import { NewsRetrievalService } from './news-retrieval.service';
import { NewsDebugController } from './news-debug.controller';
import { buildSearchNewsTool } from './tools/search-news.tool';

export const SEARCH_NEWS_TOOL = Symbol('SEARCH_NEWS_TOOL');

@Module({
  imports: [ConfigModule],
  controllers: [NewsDebugController],
  providers: [
    NewsLoaderService,
    NewsEmbeddingService,
    NewsRetrievalService,
    {
      provide: SEARCH_NEWS_TOOL,
      inject: [NewsRetrievalService],
      useFactory: (retrieval: NewsRetrievalService) =>
        buildSearchNewsTool(retrieval),
    },
  ],
  exports: [SEARCH_NEWS_TOOL, NewsRetrievalService],
})
export class NewsRagModule {}
