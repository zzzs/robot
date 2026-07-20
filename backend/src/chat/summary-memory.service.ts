import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { traceable } from 'langsmith/traceable';
import {
  AIMessage,
  BaseMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
} from '@langchain/core/messages';
import { CHAT_MODEL } from './chat.constants';

/**
 * SummaryMemoryService —— 长会话压缩
 *
 * 触发条件(可配置):
 *   - `summary.threshold` (默认 20):消息条数 >= 此值时触发
 *   - `summary.recentKeep` (默认 6):最近 K 条原封不动
 *   - `summary.enabled` (默认 true):总开关
 *
 * 行为:
 *   - 把 `raw[0 .. length-recentKeep]` 喂给 LLM 压成一段中文 summary
 *   - 返回 `[SystemMessage(summary, __summary=true), ...raw.slice(-recentKeep)]`
 *   - ToolMessage 内容**绝不**进 LLM prompt —— 改用 `[ToolMessage: <name> → <status>]` 占位
 *   - LLM 失败时降级:返回 raw 原样 + WARN 日志
 *   - 并发安全:同 sessionId 同时触发复用同一 Promise
 *   - 缓存:同 `raw.length` 直接返回上次结果,不同则重压(全量重压,不增量合并)
 */
@Injectable()
export class SummaryMemoryService {
  private readonly logger = new Logger(SummaryMemoryService.name);
  private readonly enabled: boolean;
  private readonly threshold: number;
  private readonly recentKeep: number;

  /**
   * 缓存:key = sessionId,value = { length, summary }。
   * length 匹配时直接复用 summary,避免同次对话多次 LLM 调用。
   */
  private readonly cache = new Map<string, { length: number; summary: string }>();

  /**
   * 并发去重:key = sessionId,value = in-flight Promise。
   * 同 session 并发触发时,所有调用者拿到同一个 Promise。
   */
  private readonly inFlight = new Map<string, Promise<string>>();

  constructor(
    private readonly config: ConfigService,
    @Inject(CHAT_MODEL) private readonly model: { invoke: (m: BaseMessage[]) => Promise<unknown> },
  ) {
    this.enabled = this.config.get<boolean>('summary.enabled') ?? true;
    this.threshold = this.config.get<number>('summary.threshold') ?? 20;
    this.recentKeep = this.config.get<number>('summary.recentKeep') ?? 6;
    this.logger.log(
      `SummaryMemoryService init: enabled=${this.enabled} threshold=${this.threshold} recentKeep=${this.recentKeep}`,
    );
  }

  /**
   * Orchestrator-side helper:从 history 数组里抽出 summary(如果在 index 0),
   * 合并进真实 system prompt,返回合并后的 prompt 和剥离 summary 后的 history。
   *
   * 为什么需要这个:Anthropic API 只允许 1 条 SystemMessage。如果 history 头上
   * 是 summary SystemMessage、orchestrator 又要 prepend 真实 prompt,会触发
   * "System messages are only permitted as the first passed message"。所以
   * orchestrator 在拼 messages 前调这个 helper 把 summary 并入 prompt。
   */
  static mergeSummaryIntoPrompt(
    realPrompt: string,
    history: BaseMessage[],
  ): { prompt: string; messages: BaseMessage[] } {
    if (
      history.length > 0 &&
      history[0] instanceof SystemMessage &&
      (history[0].additional_kwargs as { __summary?: boolean } | undefined)?.__summary === true
    ) {
      const summaryText = extractTextContent(history[0].content);
      const merged = `${realPrompt}\n\n[历史对话摘要]\n${summaryText}`;
      return { prompt: merged, messages: history.slice(1) };
    }
    return { prompt: realPrompt, messages: history };
  }

  /**
   * 主入口:对 raw messages 做压缩 + summary 注入。
   * 失败时降级返回 raw。
   */
  async wrap(sessionId: string, raw: BaseMessage[]): Promise<BaseMessage[]> {
    if (!this.enabled) return raw;
    if (raw.length < this.threshold) return raw;

    try {
      const oldMessages = raw.slice(0, raw.length - this.recentKeep);
      const recent = raw.slice(-this.recentKeep);
      const summary = await this.summarizeOrCached(sessionId, oldMessages);
      const summaryMsg = new SystemMessage({
        content: summary,
        additional_kwargs: { __summary: true },
      });
      return [summaryMsg, ...recent];
    } catch (err) {
      this.logger.warn(
        `summarization failed for session=${sessionId}; returning raw: ${(err as Error).message}`,
      );
      return raw;
    }
  }

  /**
   * 缓存 + 并发去重。
   * 同 session 同 length → 复用缓存;不同 length → 全量重压。
   * 同 session 并发 → 复用 in-flight Promise。
   */
  private async summarizeOrCached(
    sessionId: string,
    oldMessages: BaseMessage[],
  ): Promise<string> {
    const cached = this.cache.get(sessionId);
    if (cached && cached.length === oldMessages.length) {
      return cached.summary;
    }

    const inFlight = this.inFlight.get(sessionId);
    if (inFlight) return inFlight;

    const p = this.summarizeNow(sessionId, oldMessages)
      .then((summary) => {
        this.cache.set(sessionId, { length: oldMessages.length, summary });
        return summary;
      })
      .finally(() => {
        this.inFlight.delete(sessionId);
      });

    this.inFlight.set(sessionId, p);
    return p;
  }

  /**
   * 实际调用 LLM 压缩。包了 traceable 让 LangSmith 能看到独立的 run。
   * 失败时抛出,由 wrap() catch 后降级。
   */
  private summarizeNow = traceable(
    async (sessionId: string, oldMessages: BaseMessage[]): Promise<string> => {
      const text = messagesToSummaryText(oldMessages);
      const prompt = [
        new SystemMessage(
          [
            '你是会话压缩器。把下面的多轮对话历史压成一段 200-400 字的中文 summary,',
            '要求:',
            '1. 保留关键信息:用户问过什么、助手答过什么、调过哪些工具(工具名)、最终结论是什么',
            '2. **绝不**改写工具返回的具体状态(如 status=no-data / status=insufficient),原样引用',
            '3. 不捏造、不补全;不确定的信息宁可省略',
            '4. 用一段连续的文字输出,不要列表、不要标题',
          ].join('\n'),
        ),
        new HumanMessage(`以下是历史对话:\n\n${text}`),
      ];
      const response = await this.model.invoke(prompt);
      const content =
        typeof response === 'string'
          ? response
          : extractTextContent((response as { content?: unknown }).content);
      if (!content) {
        throw new Error('summarize LLM returned empty content');
      }
      this.logger.log(
        `compressed session=${sessionId}: ${oldMessages.length} msgs → ${content.length} chars`,
      );
      return content;
    },
    { name: 'summary-memory.compress', run_type: 'chain' },
  );
}

/**
 * 把 messages 数组转成 LLM 可读的"结构化文本"。
 * ToolMessage 的字符串内容**永不**出现 —— 只用占位。
 */
export function messagesToSummaryText(messages: BaseMessage[]): string {
  return messages
    .map((m, i) => {
      const text = extractTextContent(m.content);
      if (m instanceof HumanMessage) {
        return `[${i + 1}] 用户: ${text}`;
      }
      if (m instanceof ToolMessage) {
        const toolName = m.name ?? 'unknown';
        const status = extractToolStatus(text).status;
        return `[${i + 1}] 工具结果 (${toolName}): status=${status}`;
      }
      if (m instanceof AIMessage) {
        const toolCalls = (m as AIMessage).tool_calls ?? [];
        if (toolCalls.length > 0) {
          const callDesc = toolCalls
            .map(
              (tc) =>
                `${tc.name}(${truncate(JSON.stringify(tc.args ?? {}), 80)})`,
            )
            .join(', ');
          return `[${i + 1}] 助手调用工具: ${callDesc}${text ? ` (附文本: ${text})` : ''}`;
        }
        return `[${i + 1}] 助手: ${text}`;
      }
      if (m instanceof SystemMessage) {
        // 已有的 summary —— 让新 summary 看到上次压过的内容
        return `[${i + 1}] (历史 summary): ${text}`;
      }
      return `[${i + 1}] (${m.getType()}): ${text}`;
    })
    .join('\n');
}

/**
 * 从 ToolMessage 的 string content 里解析出 status。
 * 失败时返回 { status: 'raw' },不抛。
 *
 * 项目里 ToolMessage content 都是 JSON 字符串,例如:
 *   '{"status":"no-data","required_reply":"No data available for analysis"}'
 *   '{"status":"ok","symbol":"300033.SZ",...}'
 */
export function extractToolStatus(content: string): {
  toolName?: string;
  status: string;
} {
  if (!content) return { status: 'raw' };
  try {
    const parsed = JSON.parse(content) as { status?: string; tool_name?: string };
    if (parsed && typeof parsed === 'object') {
      return {
        toolName: typeof parsed.tool_name === 'string' ? parsed.tool_name : undefined,
        status: typeof parsed.status === 'string' ? parsed.status : 'raw',
      };
    }
  } catch {
    // fall through
  }
  return { status: 'raw' };
}

/**
 * 从 BaseMessage.content 里抽 text(string 或 content-blocks 数组)。
 */
function extractTextContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => {
        if (typeof c === 'string') return c;
        if (c && typeof c === 'object') {
          const obj = c as { text?: unknown; type?: string };
          if (typeof obj.text === 'string') return obj.text;
        }
        return '';
      })
      .join('');
  }
  return '';
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n) + '…';
}
