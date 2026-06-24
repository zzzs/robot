import { ConfigService } from '@nestjs/config';
import { ChatAnthropic } from '@langchain/anthropic';
import {
  ChatPromptTemplate,
  MessagesPlaceholder,
} from '@langchain/core/prompts';
import { RunnableWithMessageHistory } from '@langchain/core/runnables';
import { ChatHistoryService } from '../chat-history.service';
import { CHAT_CHAIN, CHAT_MODEL } from '../chat.constants';

export const chatModelProvider = {
  provide: CHAT_MODEL,
  inject: [ConfigService],
  useFactory: (config: ConfigService) =>
    new ChatAnthropic({
      model: config.get<string>('dashscope.model'),
      apiKey: 'placeholder',
      anthropicApiUrl: config.get<string>('dashscope.baseUrl'),
      clientOptions: {
        defaultHeaders: {
          Authorization: `Bearer ${config.get<string>('dashscope.apiKey')}`,
          'x-api-key': '',
        },
      },
      temperature: 0.2,
      maxTokens: 2048,
    }),
};

export const chatChainProvider = {
  provide: CHAT_CHAIN,
  inject: [CHAT_MODEL, ChatHistoryService],
  useFactory: (
    model: ChatAnthropic,
    historySvc: ChatHistoryService,
  ) => {
    const prompt = ChatPromptTemplate.fromMessages([
      ['system', "You're an assistant who's good at {ability}"],
      new MessagesPlaceholder('history'),
      ['human', '{question}'],
    ]);
    const chain = prompt.pipe(model);
    return new RunnableWithMessageHistory({
      runnable: chain,
      getMessageHistory: (sessionId: string) => historySvc.get(sessionId),
      inputMessagesKey: 'question',
      historyMessagesKey: 'history',
    });
  },
};
