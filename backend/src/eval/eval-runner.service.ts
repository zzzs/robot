import { Injectable, Logger } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ChatService } from '../chat/chat.service';
import { ChatMessageDto } from '../chat/dto/chat-message.dto';
import { ChatStreamEvent } from '../chat/chat-stream.types';
import { IntegrityEvaluator } from './evaluators/integrity.evaluator';
import { ToolSelectionEvaluator } from './evaluators/tool-selection.evaluator';
import { LlmJudgeEvaluator } from './evaluators/llm-judge.evaluator';
import { CaseResult, EvalCase, EvalReport, EvalRunOptions } from './eval.types';

const PASS_THRESHOLD = 0.7;

@Injectable()
export class EvalRunnerService {
  private readonly logger = new Logger(EvalRunnerService.name);
  private dataset: EvalCase[] | null = null;

  constructor(
    private readonly chatService: ChatService,
    private readonly integrity: IntegrityEvaluator,
    private readonly toolSelection: ToolSelectionEvaluator,
    private readonly judge: LlmJudgeEvaluator,
  ) {}

  private loadDataset(): EvalCase[] {
    if (this.dataset) return this.dataset;
    const candidates = [
      resolve(__dirname, 'datasets/stock-agent.eval.json'),
      resolve(process.cwd(), 'src/eval/datasets/stock-agent.eval.json'),
      resolve(process.cwd(), 'dist/eval/datasets/stock-agent.eval.json'),
    ];
    for (const path of candidates) {
      try {
        const raw = readFileSync(path, 'utf-8');
        this.dataset = JSON.parse(raw) as EvalCase[];
        return this.dataset;
      } catch {
        // try next
      }
    }
    this.logger.error('eval dataset not found in any candidate path');
    return [];
  }

  async run(options: EvalRunOptions = {}): Promise<EvalReport> {
    const allCases = this.loadDataset();
    const filtered = this.filterCases(allCases, options);

    this.logger.log(
      `running eval: ${filtered.length}/${allCases.length} cases` +
        (options.offline ? ' (offline only)' : '') +
        (options.category ? ` (category: ${options.category})` : ''),
    );

    const startedAt = Date.now();
    const results: CaseResult[] = [];

    for (const evalCase of filtered) {
      const result = await this.runOne(evalCase);
      results.push(result);
      this.logger.log(
        `  ${result.pass ? '✓' : '✗'} ${result.id} (${result.category})` +
          (result.judge ? ` judge=${result.judge.score}` : ''),
      );
    }

    const passed = results.filter((r) => r.pass).length;
    const duration = Date.now() - startedAt;

    return {
      totalCases: filtered.length,
      passed,
      passRate: filtered.length > 0 ? passed / filtered.length : 0,
      results,
      ranAt: new Date().toISOString(),
      duration,
    };
  }

  private async runOne(evalCase: EvalCase): Promise<CaseResult> {
    const sessionId = `eval-${evalCase.id}-${Date.now()}`;
    const dto: ChatMessageDto = { sessionId, message: evalCase.input };

    let events: ChatStreamEvent[];
    try {
      events = await this.chatService.chat(dto);
    } catch (err) {
      return {
        id: evalCase.id,
        category: evalCase.category,
        description: evalCase.description,
        requiresNetwork: evalCase.requiresNetwork,
        input: evalCase.input,
        responseText: '',
        detectedTool: 'error',
        pass: false,
        integrity: null,
        toolSelection: null,
        judge: null,
        error: `chat failed: ${(err as Error).message}`,
      };
    }

    const responseText = this.extractText(events);
    const detectedTool = this.toolSelection.detectTool(events);

    // Run evaluators
    const integrityResult = this.integrity.evaluate(
      responseText,
      evalCase.expectations,
    );

    const toolResult = this.toolSelection.evaluate(
      events,
      evalCase.expectations,
    );

    let judgeResult = null;
    try {
      judgeResult = await this.judge.evaluate(
        evalCase.input,
        responseText,
        evalCase.expectations.judgePrompt,
      );
    } catch (err) {
      judgeResult = {
        score: -1,
        explanation: `judge error: ${(err as Error).message}`,
      };
    }

    // Aggregate: pass = integrity ✓ && toolSelection ✓ && judge >= threshold
    const passes: boolean[] = [];
    if (integrityResult) passes.push(integrityResult.pass);
    if (toolResult) passes.push(toolResult.pass);
    if (judgeResult && judgeResult.score >= 0) {
      passes.push(judgeResult.score >= PASS_THRESHOLD);
    }
    const pass = passes.length > 0 ? passes.every(Boolean) : false;

    return {
      id: evalCase.id,
      category: evalCase.category,
      description: evalCase.description,
      requiresNetwork: evalCase.requiresNetwork,
      input: evalCase.input,
      responseText: responseText.slice(0, 500),
      detectedTool,
      pass,
      integrity: integrityResult,
      toolSelection: toolResult,
      judge: judgeResult,
    };
  }

  private extractText(events: ChatStreamEvent[]): string {
    return events
      .filter((e) => e.type === 'text')
      .map((e) => (e as { content: string }).content)
      .join('');
  }

  private filterCases(cases: EvalCase[], options: EvalRunOptions): EvalCase[] {
    let filtered = cases;
    if (options.offline) {
      filtered = filtered.filter((c) => !c.requiresNetwork);
    }
    if (options.category) {
      filtered = filtered.filter((c) => c.category === options.category);
    }
    return filtered;
  }
}
