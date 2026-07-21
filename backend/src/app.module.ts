import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import configuration from './config/configuration';
import { ChatModule } from './chat/chat.module';
import { StockModule } from './stock/stock.module';
import { NewsRagModule } from './news/news-rag.module';
import { EvalModule } from './eval/eval.module';
import { CaiCompModule } from './cai-comp/cai-comp.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [configuration] }),
    StockModule,
    NewsRagModule,
    CaiCompModule,
    ChatModule,
    EvalModule,
  ],
})
export class AppModule {}
