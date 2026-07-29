import { Controller, Post, Body, Get, Logger, HttpException, HttpStatus } from '@nestjs/common';
import { CodebaseIndexingService, type IndexResult, type UpdateResult } from './codebase-indexing.service';
import { CodebaseSearchService } from './codebase-search.service';
import { IndexDto, UpdateDto } from './dto/reindex.dto';

@Controller('codebase')
export class CodebaseController {
  private readonly logger = new Logger(CodebaseController.name);

  constructor(
    private readonly indexingService: CodebaseIndexingService,
    private readonly searchService: CodebaseSearchService,
  ) {}

  /**
   * POST /api/codebase/index
   * 首次全量索引:clone(或读本地)→ 读全部代码文件 → split → embed → store
   * name: 项目名称(用于多项目区分,如"组件中心前端")
   */
  @Post('index')
  async index(@Body() dto: IndexDto) {
    this.logger.log(`index request: name=${dto.name} source=${dto.source}`);
    try {
      const result = await this.indexingService.indexFull(dto.source, dto.name);
      return result;
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      this.logger.error(`index failed: ${msg}`);
      throw new HttpException({ error: msg.slice(0, 500) }, HttpStatus.BAD_REQUEST);
    }
  }

  /**
   * POST /api/codebase/update
   * 增量更新(webhook):
   *   changed_files → clone → 只读这些文件 → embed → 删旧 chunks → 存新
   *   deleted_files → 直接删 DB(不用 clone)
   */
  @Post('update')
  async update(@Body() dto: UpdateDto) {
    this.logger.log(
      `update request: name=${dto.name} changed=${dto.changed_files?.length ?? 0} deleted=${dto.deleted_files?.length ?? 0}`,
    );
    try {
      const result = await this.indexingService.updateIncremental(
        dto.source,
        dto.name,
        dto.changed_files ?? [],
        dto.deleted_files ?? [],
      );
      return result;
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      this.logger.error(`update failed: ${msg}`);
      throw new HttpException({ error: msg.slice(0, 500) }, HttpStatus.BAD_REQUEST);
    }
  }

  /**
   * GET /api/codebase/projects
   * 列出所有已索引的项目名
   */
  @Get('projects')
  async projects() {
    const projects = await this.searchService.listProjects();
    return { projects };
  }
}
