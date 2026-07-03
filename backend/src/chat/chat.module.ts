import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChatController } from './chat.controller';
import { ChatService, CHAT_ORCHESTRATOR } from './chat.service';
import { ChatHistoryService } from './chat-history.service';
import { chatModelProvider } from './providers/chat-chain.provider';
import { ChatOrchestrator } from './chat.orchestrator';
import { LangGraphOrchestrator } from './langgraph-orchestrator';
import { SupervisorOrchestrator } from './supervisor-orchestrator';
import { StockModule } from '../stock/stock.module';
import { NewsRagModule } from '../news/news-rag.module';

@Module({
  imports: [StockModule, NewsRagModule],
  controllers: [ChatController],
  providers: [
    ChatService,
    ChatHistoryService,
    ChatOrchestrator,
    LangGraphOrchestrator,
    SupervisorOrchestrator,
    chatModelProvider,
    {
      // 根据 ORCHESTRATOR env 选择实现:
      //   'langgraph' → LangGraph 状态机版本
      //   'supervisor' → 多 agent (supervisor + researcher + summarizer)
      //   其他       → 手写 ChatOrchestrator
      provide: CHAT_ORCHESTRATOR,
      inject: [
        ChatOrchestrator,
        LangGraphOrchestrator,
        SupervisorOrchestrator,
        ConfigService,
      ],
      useFactory: (
        manual: ChatOrchestrator,
        langgraph: LangGraphOrchestrator,
        supervisor: SupervisorOrchestrator,
        config: ConfigService,
      ) => {
        const choice = config.get<string>('orchestrator') ?? 'manual';
        if (choice === 'langgraph') return langgraph;
        if (choice === 'supervisor') return supervisor;
        return manual;
      },
    },
  ],
})
export class ChatModule {}
