import { Module, Global } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AzureOpenAIProvider, AZURE_OPENAI_CLIENT } from './azure-openai.provider.js';
import { 
  AzureSearchIndexClientProvider, 
  AzureSearchClientProvider, 
  AZURE_SEARCH_INDEX_CLIENT, 
  AZURE_SEARCH_CLIENT 
} from './azure-search.provider.js';

@Global()
@Module({
  imports: [ConfigModule],
  providers: [
    AzureOpenAIProvider,
    AzureSearchIndexClientProvider,
    AzureSearchClientProvider,
  ],
  exports: [
    AZURE_OPENAI_CLIENT,
    AZURE_SEARCH_INDEX_CLIENT,
    AZURE_SEARCH_CLIENT,
  ],
})
export class AzureModule {}