import {
  Controller,
  Post,
  Get,
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
import { contentToString } from './chat-history.service';

@Controller('chat')
export class ChatController {
  constructor(private readonly chatService: ChatService) {}

  @Post()
  @UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
  async chat(@Body() dto: ChatMessageDto) {
    const content = await this.chatService.chat(dto);
    return { sessionId: dto.sessionId, content };
  }

  @Sse('stream')
  @UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
  stream(@Query() dto: ChatMessageDto): Observable<MessageEvent> {
    return new Observable<MessageEvent>((subscriber) => {
      let cancelled = false;
      (async () => {
        try {
          const iter = await this.chatService.stream(dto);
          for await (const chunk of iter) {
            if (cancelled) break;
            const text = contentToString(chunk.content);
            if (text) {
              subscriber.next({ data: { content: text } });
            }
          }
          if (!cancelled) {
            subscriber.next({ data: { done: true } });
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
