import { Module } from '@nestjs/common';
import { ChatController } from './chat.controller';
import { ChatService } from './chat.service';
import { ChatHistoryService } from './chat-history.service';
import { chatChainProvider, chatModelProvider } from './providers/chat-chain.provider';

@Module({
  controllers: [ChatController],
  providers: [ChatService, ChatHistoryService, chatModelProvider, chatChainProvider],
})
export class ChatModule {}
