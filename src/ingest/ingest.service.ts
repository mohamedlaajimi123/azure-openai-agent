import { Injectable, Inject, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SearchIndexClient, SearchClient } from '@azure/search-documents';
import AzureOpenAI from 'openai';
import * as fs from 'fs';
import * as path from 'path';
import { AZURE_OPENAI_CLIENT } from '../azure/azure-openai.provider.js';
import { AZURE_SEARCH_INDEX_CLIENT, AZURE_SEARCH_CLIENT } from '../azure/azure-search.provider.js';

export interface DocumentChunk {
  id: string;
  content: string;
  source: string;
  contentVector: number[];
}

@Injectable()
export class IngestService {
  private readonly logger = new Logger(IngestService.name);

  constructor(
    @Inject(AZURE_OPENAI_CLIENT) private readonly openAiClient: AzureOpenAI,
    @Inject(AZURE_SEARCH_INDEX_CLIENT) private readonly indexClient: SearchIndexClient,
    @Inject(AZURE_SEARCH_CLIENT) private readonly searchClient: SearchClient<DocumentChunk>,
    private readonly configService: ConfigService,
  ) {}

  async createIndexIfNotExists(): Promise<void> {
    const indexName = this.configService.getOrThrow<string>('AZURE_SEARCH_INDEX_NAME');
    const indexNames = [];
    for await (const index of this.indexClient.listIndexes()) {
      indexNames.push(index.name);
    }

    if (!indexNames.includes(indexName)) {
      this.logger.log(`Creating Azure AI Search Index: ${indexName}`);
      await this.indexClient.createIndex({
        name: indexName,
        fields: [
          { name: 'id', type: 'Edm.String', key: true, searchable: false },
          { name: 'content', type: 'Edm.String', searchable: true },
          { name: 'source', type: 'Edm.String', searchable: true, filterable: true },
          {
            name: 'contentVector',
            type: 'Collection(Edm.Single)',
            searchable: true,
            vectorSearchDimensions: 1536,
            vectorSearchProfileName: 'my-vector-profile',
          },
        ],
        vectorSearch: {
          algorithms: [{ name: 'hnsw-algo', kind: 'hnsw' }],
          profiles: [{ name: 'my-vector-profile', algorithmConfigurationName: 'hnsw-algo' }],
        },
      });
    }
  }

  async runIngestion(): Promise<{ indexedCount: number }> {
    await this.createIndexIfNotExists();

    const docsPath = path.join(process.cwd(), 'data', 'docs');
    const files = fs.readdirSync(docsPath).filter((f) => f.endsWith('.txt') || f.endsWith('.md'));
    const embeddingDeployment = this.configService.getOrThrow<string>('AZURE_OPENAI_EMBEDDING_DEPLOYMENT');

    const documentsToUpload: DocumentChunk[] = [];

    for (const file of files) {
      const filePath = path.join(docsPath, file);
      const text = fs.readFileSync(filePath, 'utf-8');

      // Generate Vector Embedding via Azure OpenAI
      const embeddingResponse = await this.openAiClient.embeddings.create({
        model: embeddingDeployment,
        input: text,
      });

      const vector = embeddingResponse.data[0].embedding;

      documentsToUpload.push({
        id: Buffer.from(file).toString('base64url'),
        content: text,
        source: file,
        contentVector: vector,
      });
    }

    if (documentsToUpload.length > 0) {
      await this.searchClient.uploadDocuments(documentsToUpload);
    }

    this.logger.log(`Successfully indexed ${documentsToUpload.length} documents.`);
    return { indexedCount: documentsToUpload.length };
  }
}