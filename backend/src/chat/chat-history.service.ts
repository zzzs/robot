import { Injectable } from '@nestjs/common';
import { InMemoryChatMessageHistory } from '@langchain/core/chat_history';
import { BaseMessage } from '@langchain/core/messages';
import { SummaryMemoryService } from './summary-memory.service';

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

@Injectable()
export class ChatHistoryService {
  private readonly histories = new Map<string, InMemoryChatMessageHistory>();

  constructor(private readonly summarizer: SummaryMemoryService) {}

  get(sessionId: string): InMemoryChatMessageHistory {
    let h = this.histories.get(sessionId);
    if (!h) {
      h = new InMemoryChatMessageHistory();
      this.histories.set(sessionId, h);
    }
    return h;
  }

  /**
   * 取消息:对底层 InMemoryChatMessageHistory 的 raw 历史做 summary wrap。
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
