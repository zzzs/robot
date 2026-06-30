import { Inject, Injectable } from '@nestjs/common';
import { ChatMessageDto } from './dto/chat-message.dto';
import { ChatStreamEvent } from './chat-stream.types';

/** 共享接口 — ChatOrchestrator 和 LangGraphOrchestrator 都实现这个 */
export interface ChatOrchestratorInterface {
  stream(dto: ChatMessageDto): AsyncGenerator<ChatStreamEvent>;
}

export const CHAT_ORCHESTRATOR = Symbol('CHAT_ORCHESTRATOR');

@Injectable()
export class ChatService {
  constructor(
    @Inject(CHAT_ORCHESTRATOR)
    private readonly orchestrator: ChatOrchestratorInterface,
  ) {}

  async chat(dto: ChatMessageDto): Promise<ChatStreamEvent[]> {
    const events: ChatStreamEvent[] = [];
    for await (const ev of this.orchestrator.stream(dto)) {
      events.push(ev);
    }
    return events;
  }

  stream(dto: ChatMessageDto): AsyncGenerator<ChatStreamEvent> {
    return this.orchestrator.stream(dto);
  }
}
