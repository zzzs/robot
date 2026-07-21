import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChatController } from './chat.controller';
import { ChatService, CHAT_ORCHESTRATOR } from './chat.service';
import { ChatHistoryService } from './chat-history.service';
import { SummaryMemoryService } from './summary-memory.service';
import { CHAT_MODEL } from './chat.constants';
import { chatModelProvider } from './providers/chat-chain.provider';
import { ChatOrchestrator } from './chat.orchestrator';
import { LangGraphOrchestrator } from './langgraph-orchestrator';
import { SupervisorOrchestrator } from './supervisor-orchestrator';
import { CreateAgentOrchestrator } from './create-agent-orchestrator';
import { StockModule } from '../stock/stock.module';
import { NewsRagModule } from '../news/news-rag.module';
import { CaiCompModule } from '../cai-comp/cai-comp.module';

@Module({
  imports: [StockModule, NewsRagModule, CaiCompModule],
  controllers: [ChatController],
  providers: [
    ChatService,
    SummaryMemoryService,
    ChatHistoryService,
    ChatOrchestrator,
    LangGraphOrchestrator,
    SupervisorOrchestrator,
    CreateAgentOrchestrator,
    chatModelProvider,
    {
      // 根据 ORCHESTRATOR env 选择实现:
      //   'langgraph'     → LangGraph 状态机版本
      //   'supervisor'     → 多 agent (supervisor + researcher + summarizer)
      //   'create-agent'   → langchain 包 createAgent prebuilt 版 (学习对比用)
      //   其他           → 手写 ChatOrchestrator
      provide: CHAT_ORCHESTRATOR,
      inject: [
        ChatOrchestrator,
        LangGraphOrchestrator,
        SupervisorOrchestrator,
        CreateAgentOrchestrator,
        ConfigService,
      ],
      useFactory: (
        manual: ChatOrchestrator,
        langgraph: LangGraphOrchestrator,
        supervisor: SupervisorOrchestrator,
        createAgent: CreateAgentOrchestrator,
        config: ConfigService,
      ) => {
        const choice = config.get<string>('orchestrator') ?? 'manual';
        if (choice === 'langgraph') return langgraph;
        if (choice === 'supervisor') return supervisor;
        if (choice === 'create-agent') return createAgent;
        return manual;
      },
    },
  ],
  exports: [ChatService, CHAT_MODEL],
})
export class ChatModule {}
