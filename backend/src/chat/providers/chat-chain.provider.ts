import { ConfigService } from '@nestjs/config';
import { ChatAnthropic } from '@langchain/anthropic';
import { CHAT_MODEL } from '../chat.constants';

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
