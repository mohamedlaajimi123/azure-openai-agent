import { Injectable, Inject, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SearchClient } from '@azure/search-documents';
import AzureOpenAI from 'openai';
import { AZURE_OPENAI_CLIENT } from '../azure/azure-openai.provider.js';
import { AZURE_SEARCH_CLIENT } from '../azure/azure-search.provider.js';
import { DocumentChunk } from '../ingest/ingest.service.js';
import { ORDER_LOOKUP_TOOL_SCHEMA, executeOrderLookup } from '../tools/order-lookup.tool.js';

const MAX_TOOL_ITERATIONS = 3;
//Minimum semantic relevance score threshold (0-4 scale for Semantic Ranker)
const MIN_RERANKER_SCORE = 1.8;

@Injectable()
export class AgentService {
  private readonly logger = new Logger(AgentService.name);

  constructor(
    @Inject(AZURE_OPENAI_CLIENT) private readonly openAiClient: AzureOpenAI,
    @Inject(AZURE_SEARCH_CLIENT) private readonly searchClient: SearchClient<DocumentChunk>,
    private readonly configService: ConfigService,
  ) {}

  async chat(userQuery: string): Promise<string> {
    const chatDeployment = this.configService.getOrThrow<string>('AZURE_OPENAI_CHAT_DEPLOYMENT');
    const embeddingDeployment = this.configService.getOrThrow<string>('AZURE_OPENAI_EMBEDDING_DEPLOYMENT');

    // 1. Embed user query to retrieve relevant context from Azure AI Search
    const embeddingResponse = await this.openAiClient.embeddings.create({
      model: embeddingDeployment,
      input: userQuery,
    });
    const queryVector = embeddingResponse.data[0].embedding;

    // 2. Perform Hybrid Search +Semantic Ranking (L2)
    const searchResults = await this.searchClient.search(userQuery, {
      vectorSearchOptions: {
        queries: [{ kind: 'vector', vector: queryVector, kNearestNeighborsCount: 50, fields: ['contentVector'] }],
      },
      queryType: 'semantic',
      semanticSearchOptions:{
        configurationName: 'default-semantic-config',
      },
      top: 3
    });

    let retrievedContext = '';
    let resultCount = 0;

    for await (const result of searchResults.results) {
      // Use rerankerScore (0-4 scole), falling back to raw RRF score if unranked 
      const relevanceScore = result.rerankerScore ?? result.score ?? 0;
      
      if(relevanceScore >= MIN_RERANKER_SCORE){
        retrievedContext += `[Source: ${result.document.source} (Score: ${relevanceScore.toFixed(2)})]\n${result.document.content}\n\n`;
        resultCount++;
      } else{
        this.logger.debug(
          `Discard chunk from ${result.document.source} due to low score (${relevanceScore.toFixed(2)}) `,
        );
      }
      
    }

    if (resultCount === 0) {
      this.logger.warn(`No search results found for query: "${userQuery}"`);
      retrievedContext = 'No relevant documents were found for this query.';
    }

    //3.prepare initial chat systel prompt with explicit guardrails
    const systemPrompt = `You are an entreprise AI assistant for Microsoft Azure services.
    
    CRITICAL INSTRUCTIONS:
    1. DATA FRESHENESS & TOOL SELECTION: Document search results contain general static policies and product info, NOT live trasnactiona data. For ant question abouta specific order's status, tracking, or details, ALWAYS call the'lookupOrder' tool rather than trusting document search - retrieved documents will never contain real-time order status.
    2. DOCUMENT GROUNDING: For non-transactional factual or policy questions, answer strictly using the "Retrieved Context" provided below. If the context states "No relevant internal documents were found", inform user that internal knowledge ases do not contain the answer. Do NOT invent or hallucinate policies.
    
    
    Retrieved Context:
    ${retrievedContext}`;

    // Prepare initial chat messages
    const messages: AzureOpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      {
        role: 'system',
        content: systemPrompt,
      },
      { role: 'user', content: userQuery },
    ];

    // 4. Send query + context + tool schema to Azure OpenAI
    let response = await this.openAiClient.chat.completions.create({
      model: chatDeployment,
      messages,
      tools: [ORDER_LOOKUP_TOOL_SCHEMA as any],
      tool_choice: 'auto',
    });

    let responseMessage = response.choices[0].message;
    let iterations = 0;

    // 5. Bounded Agentic Loop (Max N turns)
    while (responseMessage.tool_calls && responseMessage.tool_calls.length > 0 && iterations < MAX_TOOL_ITERATIONS) {
      iterations++;
      this.logger.log(`Executing Tool Iteration #${iterations}`);

      // Push assistant's request (containing tool_calls) to history
      messages.push(responseMessage);

      // Process all tool calls in this turn
      for (const toolCall of responseMessage.tool_calls) {
        if (toolCall.type === 'function' && toolCall.function.name === 'lookupOrder') {
          let toolResult: string;
          try {
            const args = JSON.parse(toolCall.function.arguments);
            toolResult = executeOrderLookup(args.orderId);
          } catch (err) {
            this.logger.warn(`Tool execution failed: ${err instanceof Error ? err.message : err}`);
            toolResult = JSON.stringify({
              error: 'Invalid or missing orderId. Please ask the user to confirm their order number.',
            });
          }

          messages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: toolResult,
          });
        }
      }

      // Re-query Azure OpenAI: Omit tools if iteration limit reached to force final text response
      response = await this.openAiClient.chat.completions.create({
        model: chatDeployment,
        messages,
        tools: iterations < MAX_TOOL_ITERATIONS ? ([ORDER_LOOKUP_TOOL_SCHEMA as any] as any) : undefined,
        tool_choice: iterations < MAX_TOOL_ITERATIONS ? 'auto' : undefined,
      });

      responseMessage = response.choices[0].message;
    }

    return responseMessage.content || 'No response generated.';
  }
}