import { Injectable } from '@nestjs/common';
import { InMemoryChatMessageHistory } from '@langchain/core/chat_history';

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

  get(sessionId: string): InMemoryChatMessageHistory {
    let h = this.histories.get(sessionId);
    if (!h) {
      h = new InMemoryChatMessageHistory();
      this.histories.set(sessionId, h);
    }
    return h;
  }
}
