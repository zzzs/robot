import { Module } from '@nestjs/common';
import { DynamicStructuredTool } from '@langchain/core/tools';
import { CodebaseIndexingService } from './codebase-indexing.service';
import { CodebaseSearchService } from './codebase-search.service';
import {
  buildSearchCodebaseTool,
  buildListProjectsTool,
} from './codebase-search.tool';
import { CodebaseController } from './codebase.controller';
import { DocsController } from './docs.controller';

export const CODEBASE_SEARCH_TOOL = Symbol('CODEBASE_SEARCH_TOOL');
export const CODEBASE_LIST_PROJECTS_TOOL = Symbol('CODEBASE_LIST_PROJECTS_TOOL');

@Module({
  controllers: [CodebaseController, DocsController],
  providers: [
    CodebaseIndexingService,
    CodebaseSearchService,
    {
      provide: CODEBASE_SEARCH_TOOL,
      inject: [CodebaseSearchService],
      useFactory: (svc: CodebaseSearchService): DynamicStructuredTool =>
        buildSearchCodebaseTool(svc),
    },
    {
      provide: CODEBASE_LIST_PROJECTS_TOOL,
      inject: [CodebaseSearchService],
      useFactory: (svc: CodebaseSearchService): DynamicStructuredTool =>
        buildListProjectsTool(svc),
    },
  ],
  exports: [
    CODEBASE_SEARCH_TOOL,
    CODEBASE_LIST_PROJECTS_TOOL,
    CodebaseSearchService,
    CodebaseIndexingService,
  ],
})
export class CodebaseModule {}
