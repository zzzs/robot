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
import { ResumeDto } from './dto/resume.dto';
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
            if (ev.type === 'interrupt') {
              // interrupt: SSE 流关闭,等用户调 resume
              subscriber.complete();
              return;
            }
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

  /**
   * HITL 恢复:用户确认或取消后,从 interrupt 处继续执行。
   * GET /api/chat/resume?sessionId=xxx&action=confirm
   * GET /api/chat/resume?sessionId=xxx&action=cancel
   * 返回 SSE 流(跟 stream 格式一致)。
   */
  @Sse('resume')
  @UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
  resume(@Query() dto: ResumeDto): Observable<MessageEvent> {
    return new Observable<MessageEvent>((subscriber) => {
      let cancelled = false;
      (async () => {
        try {
          const iter = this.chatService.resume(dto.sessionId, dto.action);
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
