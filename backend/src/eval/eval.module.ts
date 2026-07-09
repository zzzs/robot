import { Module } from '@nestjs/common';
import { EvalController } from './eval.controller';
import { EvalRunnerService } from './eval-runner.service';
import { IntegrityEvaluator } from './evaluators/integrity.evaluator';
import { ToolSelectionEvaluator } from './evaluators/tool-selection.evaluator';
import { LlmJudgeEvaluator } from './evaluators/llm-judge.evaluator';
import { ChatModule } from '../chat/chat.module';

@Module({
  imports: [ChatModule],
  controllers: [EvalController],
  providers: [
    EvalRunnerService,
    IntegrityEvaluator,
    ToolSelectionEvaluator,
    LlmJudgeEvaluator,
  ],
})
export class EvalModule {}
