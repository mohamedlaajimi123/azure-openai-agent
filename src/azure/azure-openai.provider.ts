import { Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AzureOpenAI } from 'openai';

export const AZURE_OPENAI_CLIENT = 'AZURE_OPENAI_CLIENT';

export const AzureOpenAIProvider: Provider = {
  provide: AZURE_OPENAI_CLIENT,
  useFactory: (config: ConfigService) => {
    return new AzureOpenAI({
      endpoint: config.getOrThrow<string>('AZURE_OPENAI_ENDPOINT'),
      apiKey: config.getOrThrow<string>('AZURE_OPENAI_API_KEY'),
      apiVersion: config.getOrThrow<string>('AZURE_OPENAI_API_VERSION'),
      deployment: config.getOrThrow<string>('AZURE_OPENAI_CHAT_DEPLOYMENT'),
    });
  },
  inject: [ConfigService],
};