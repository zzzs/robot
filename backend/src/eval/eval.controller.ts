import { Controller, Post, Query } from '@nestjs/common';
import { EvalRunnerService } from './eval-runner.service';
import { EvalReport, EvalRunOptions } from './eval.types';

@Controller('eval')
export class EvalController {
  constructor(private readonly runner: EvalRunnerService) {}

  /**
   * 触发 eval 运行。
   *
   * POST /api/eval/run                  → 全量运行
   * POST /api/eval/run?offline=true     → 只跑离线用例(不依赖外部 API)
   * POST /api/eval/run?category=integrity → 只跑某类用例
   */
  @Post('run')
  async run(
    @Query('offline') offline?: string,
    @Query('category') category?: string,
  ): Promise<EvalReport> {
    const options: EvalRunOptions = {};
    if (offline === 'true') options.offline = true;
    if (category) {
      options.category = category as EvalRunOptions['category'];
    }
    return this.runner.run(options);
  }
}
