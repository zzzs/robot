import { Inject, Injectable } from '@nestjs/common';
import type { AIMessageChunk } from '@langchain/core/messages';
import { CHAT_CHAIN } from './chat.constants';
import { ChatMessageDto } from './dto/chat-message.dto';
import { contentToString } from './chat-history.service';

export interface ChatChain {
  invoke(
    input: Record<string, unknown>,
    config: { configurable: { sessionId: string } },
  ): Promise<AIMessageChunk>;
  stream(
    input: Record<string, unknown>,
    config: { configurable: { sessionId: string } },
  ): Promise<AsyncIterable<AIMessageChunk>>;
}

@Injectable()
export class ChatService {
  constructor(@Inject(CHAT_CHAIN) private readonly chain: ChatChain) {}

  async chat(dto: ChatMessageDto): Promise<string> {
    const res = await this.chain.invoke(
      { ability: 'general Q&A', question: dto.message },
      { configurable: { sessionId: dto.sessionId } },
    );
    return contentToString(res.content);
  }

  async stream(
    dto: ChatMessageDto,
  ): Promise<AsyncIterable<AIMessageChunk>> {
    return this.chain.stream(
      { ability: 'general Q&A', question: dto.message },
      { configurable: { sessionId: dto.sessionId } },
    );
  }
}
