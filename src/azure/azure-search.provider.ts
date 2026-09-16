import { Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SearchIndexClient, SearchClient, AzureKeyCredential } from '@azure/search-documents';

export const AZURE_SEARCH_INDEX_CLIENT = 'AZURE_SEARCH_INDEX_CLIENT';
export const AZURE_SEARCH_CLIENT = 'AZURE_SEARCH_CLIENT';

export const AzureSearchIndexClientProvider: Provider = {
  provide: AZURE_SEARCH_INDEX_CLIENT,
  useFactory: (config: ConfigService) => {
    const endpoint = config.getOrThrow<string>('AZURE_SEARCH_ENDPOINT');
    const apiKey = config.getOrThrow<string>('AZURE_SEARCH_API_KEY');
    return new SearchIndexClient(endpoint, new AzureKeyCredential(apiKey));
  },
  inject: [ConfigService],
};

export const AzureSearchClientProvider: Provider = {
  provide: AZURE_SEARCH_CLIENT,
  useFactory: (config: ConfigService) => {
    const endpoint = config.getOrThrow<string>('AZURE_SEARCH_ENDPOINT');
    const apiKey = config.getOrThrow<string>('AZURE_SEARCH_API_KEY');
    const indexName = config.getOrThrow<string>('AZURE_SEARCH_INDEX_NAME');
    return new SearchClient(endpoint, indexName, new AzureKeyCredential(apiKey));
  },
  inject: [ConfigService],
};