import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChatController } from './chat.controller';
import { ChatService, CHAT_ORCHESTRATOR } from './chat.service';
import { ChatHistoryService } from './chat-history.service';
import { chatModelProvider } from './providers/chat-chain.provider';
import { ChatOrchestrator } from './chat.orchestrator';
import { LangGraphOrchestrator } from './langgraph-orchestrator';
import { StockModule } from '../stock/stock.module';

@Module({
  imports: [StockModule],
  controllers: [ChatController],
  providers: [
    ChatService,
    ChatHistoryService,
    ChatOrchestrator,
    LangGraphOrchestrator,
    chatModelProvider,
    {
      // 根据 ORCHESTRATOR env 选择实现:
      //   'langgraph' → LangGraph 状态机版本
      //   其他        → 手写 ChatOrchestrator
      provide: CHAT_ORCHESTRATOR,
      inject: [ChatOrchestrator, LangGraphOrchestrator, ConfigService],
      useFactory: (
        manual: ChatOrchestrator,
        langgraph: LangGraphOrchestrator,
        config: ConfigService,
      ) => {
        const choice = config.get<string>('orchestrator') ?? 'manual';
        return choice === 'langgraph' ? langgraph : manual;
      },
    },
  ],
})
export class ChatModule {}
