import {
  Controller,
  Post,
  Query,
  Body,
  UsePipes,
  ValidationPipe,
  Sse,
  MessageEvent,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { ChatService } from './chat.service';
import { ChatMessageDto } from './dto/chat-message.dto';
import { ChatStreamEvent } from './chat-stream.types';

@Controller('chat')
export class ChatController {
  constructor(private readonly chatService: ChatService) {}

  @Post()
  @UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
  async chat(@Body() dto: ChatMessageDto) {
    const events = await this.chatService.chat(dto);
    return { sessionId: dto.sessionId, events };
  }

  @Sse('stream')
  @UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
  stream(@Query() dto: ChatMessageDto): Observable<MessageEvent> {
    return new Observable<MessageEvent>((subscriber) => {
      let cancelled = false;
      (async () => {
        try {
          const iter = this.chatService.stream(dto);
          for await (const ev of iter) {
            if (cancelled) break;
            subscriber.next(toMessageEvent(ev));
            if (ev.type === 'done') {
              subscriber.complete();
              return;
            }
          }
          if (!cancelled) {
            subscriber.next({ data: { type: 'done' } });
            subscriber.complete();
          }
        } catch (err) {
          subscriber.error(err);
        }
      })();
      return () => {
        cancelled = true;
      };
    });
  }
}

function toMessageEvent(ev: ChatStreamEvent): MessageEvent {
  return { data: ev };
}
