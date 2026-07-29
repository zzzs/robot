import { Controller, Post, Body, Get, Logger, HttpException, HttpStatus } from '@nestjs/common';
import { CodebaseIndexingService, type IndexResult } from './codebase-indexing.service';
import { CodebaseSearchService } from './codebase-search.service';
import { DocIndexDto } from './dto/docs-index.dto';

/**
 * DocsController —— 独立文档索引(单文件)
 *
 * 跟 CodebaseController 平行,但只处理单个本地 .md 文件
 * 数据存到同一张 codebase_vectors 表,search_codebase 能同时搜代码 + 文档
 *
 * 后续可扩展:多文件、目录、上传
 */
@Controller('docs')
export class DocsController {
  private readonly logger = new Logger(DocsController.name);

  constructor(
    private readonly indexingService: CodebaseIndexingService,
    private readonly searchService: CodebaseSearchService,
  ) {}

  /**
   * POST /api/docs/index
   * 索引单个本地 .md 文件
   * body: { source: "/abs/path/file.md", name: "业务文档" }
   */
  @Post('index')
  async index(@Body() dto: DocIndexDto) {
    this.logger.log(`docs index: name=${dto.name} source=${dto.source}`);
    try {
      const result: IndexResult = await this.indexingService.indexSingleMarkdownFile(
        dto.source,
        dto.name,
      );
      return result;
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      this.logger.error(`docs index failed: ${msg}`);
      throw new HttpException({ error: msg.slice(0, 500) }, HttpStatus.BAD_REQUEST);
    }
  }

  /**
   * GET /api/docs/projects
   * 列出所有已索引的项目名(跟 codebase 共用一张表)
   */
  @Get('projects')
  async projects() {
    const projects = await this.searchService.listProjects();
    return { projects };
  }
}
