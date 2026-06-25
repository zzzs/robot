import { Module } from '@nestjs/common';
import { ChatController } from './chat.controller';
import { ChatService } from './chat.service';
import { ChatHistoryService } from './chat-history.service';
import { chatModelProvider } from './providers/chat-chain.provider';
import { ChatOrchestrator } from './chat.orchestrator';
import { StockModule } from '../stock/stock.module';

@Module({
  imports: [StockModule],
  controllers: [ChatController],
  providers: [
    ChatService,
    ChatHistoryService,
    ChatOrchestrator,
    chatModelProvider,
  ],
})
export class ChatModule {}
