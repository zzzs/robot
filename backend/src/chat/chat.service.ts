import { Injectable } from '@nestjs/common';
import { ChatOrchestrator } from './chat.orchestrator';
import { ChatMessageDto } from './dto/chat-message.dto';
import { ChatStreamEvent } from './chat-stream.types';

@Injectable()
export class ChatService {
  constructor(private readonly orchestrator: ChatOrchestrator) {}

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
