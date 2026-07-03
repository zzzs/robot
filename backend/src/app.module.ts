import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import configuration from './config/configuration';
import { ChatModule } from './chat/chat.module';
import { StockModule } from './stock/stock.module';
import { NewsRagModule } from './news/news-rag.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [configuration] }),
    StockModule,
    NewsRagModule,
    ChatModule,
  ],
})
export class AppModule {}
