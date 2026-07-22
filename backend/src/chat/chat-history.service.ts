import { Injectable, Logger } from '@nestjs/common';
import { BaseChatMessageHistory } from '@langchain/core/chat_history';
import { AIMessage, BaseMessage, HumanMessage } from '@langchain/core/messages';
import { SummaryMemoryService } from './summary-memory.service';
import { PostgresChatMessageHistory } from './postgres-chat-history';
import { PostgresPoolService } from '../postgres/postgres-pool.service';

/**
 * 把 message content(string 或 content-blocks 数组)抽成字符串。
 * orchestrator / summary memory 都用这个。
 */
export function contentToString(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => {
        if (typeof c === 'string') return c;
        if (c && typeof c === 'object') {
          if (typeof (c as { text?: unknown }).text === 'string') {
            return (c as { text: string }).text;
          }
        }
        return '';
      })
      .join('');
  }
  return '';
}

/**
 * 内存兜底用的最简 BaseChatMessageHistory 实现。
 * DATABASE_URL 没设时用这个,功能跟原 InMemoryChatMessageHistory 一样。
 */
class InMemoryChatHistoryImpl extends BaseChatMessageHistory {
  lc_namespace: string[] = ['langchain', 'stores', 'message'];
  private msgs: BaseMessage[] = [];

  async getMessages(): Promise<BaseMessage[]> {
    return [...this.msgs];
  }
  async addMessage(m: BaseMessage): Promise<void> {
    this.msgs.push(m);
  }
  async addUserMessage(content: string): Promise<void> {
    this.msgs.push(new HumanMessage(content));
  }
  async addAIMessage(content: string): Promise<void> {
    this.msgs.push(new AIMessage(content));
  }
  async clear(): Promise<void> {
    this.msgs = [];
  }
}

/**
 * 双模式 ChatHistoryService:
 *   - DATABASE_URL 设了 → PostgresChatMessageHistory(持久化)
 *   - 没设 → 降级到 in-memory Map(进程重启丢,开发用)
 */
@Injectable()
export class ChatHistoryService {
  private readonly logger = new Logger(ChatHistoryService.name);
  /** in-memory fallback(只在 DATABASE_URL 没设时用) */
  private readonly memoryHistories = new Map<
    string,
    BaseChatMessageHistory
  >();

  constructor(
    private readonly summarizer: SummaryMemoryService,
    private readonly poolSvc: PostgresPoolService,
  ) {
    if (poolSvc.isAvailable()) {
      this.logger.log('ChatHistoryService: Postgres-backed (persistent)');
    } else {
      this.logger.warn(
        'ChatHistoryService: in-memory fallback (DATABASE_URL not set)',
      );
    }
  }

  /**
   * 返回 history 实例。
   * Postgres 模式下每次都 new 一个(PostgresChatMessageHistory 是无状态轻量对象),
   * 不缓存 —— 避免长 session 内存累积。
   */
  get(sessionId: string): BaseChatMessageHistory {
    if (this.poolSvc.isAvailable() && this.poolSvc.pool) {
      return new PostgresChatMessageHistory(this.poolSvc.pool, sessionId);
    }
    // 降级:in-memory
    let h = this.memoryHistories.get(sessionId);
    if (!h) {
      h = new InMemoryChatHistoryImpl();
      this.memoryHistories.set(sessionId, h);
    }
    return h;
  }

  /**
   * 取消息:对底层 history 的 raw 历史做 summary wrap。
   * orchestrator 调这个方法,自动获得压缩后的 messages。
   */
  async getMessages(sessionId: string): Promise<BaseMessage[]> {
    const raw = await this.get(sessionId).getMessages();
    return this.summarizer.wrap(sessionId, raw);
  }

  async addMessage(sessionId: string, message: BaseMessage): Promise<void> {
    await this.get(sessionId).addMessage(message);
  }

  async addAIMessage(sessionId: string, content: string): Promise<void> {
    await this.get(sessionId).addAIMessage(content);
  }
}
