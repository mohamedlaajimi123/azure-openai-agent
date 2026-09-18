import { Injectable, Inject, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SearchClient } from '@azure/search-documents';
import AzureOpenAI from 'openai';
import { AZURE_OPENAI_CLIENT } from '../azure/azure-openai.provider.js';
import { AZURE_SEARCH_CLIENT } from '../azure/azure-search.provider.js';
import { DocumentChunk } from '../ingest/ingest.service.js';
import { ORDER_LOOKUP_TOOL_SCHEMA, executeOrderLookup } from '../tools/order-lookup.tool.js';

// Hard cap on tool-calling rounds. Prevents an infinite/runaway agent loop if the
// model keeps requesting tools — on the final iteration we drop the tool schema
// entirely to force a plain-text answer.
const MAX_TOOL_ITERATIONS = 3;

// Minimum semantic relevance score threshold (0-4 scale for Semantic Ranker).
// Chunks scoring below this are discarded before being added to the prompt,
// to stop irrelevant/low-confidence context from distracting the model.
// Tune this against real query logs before deploying — don't assume 1.8 is right
// for your data without checking.
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

    // 2. Perform Hybrid Search (BM25 lexical + HNSW vector, fused via RRF)
    //    + Semantic Ranking (L2 reranker on top 50 fused candidates).
    //    Passing userQuery as search text AND vectorSearchOptions is what makes
    //    this hybrid rather than pure-vector.
    const searchResults = await this.searchClient.search(userQuery, {
      vectorSearchOptions: {
        queries: [{ kind: 'vector', vector: queryVector, kNearestNeighborsCount: 50, fields: ['contentVector'] }],
      },
      queryType: 'semantic',
      semanticSearchOptions: {
        configurationName: 'default-semantic-config',
      },
      top: 3,
    });

    let retrievedContext = '';
    let resultCount = 0;

    for await (const result of searchResults.results) {
      // Use rerankerScore (0-4 scale) when semantic ranking succeeded, falling
      // back to the raw RRF fusion score if the result wasn't reranked.
      const relevanceScore = result.rerankerScore ?? result.score ?? 0;

      if (relevanceScore >= MIN_RERANKER_SCORE) {
        retrievedContext += `[Source: ${result.document.source} (Score: ${relevanceScore.toFixed(2)})]\n${result.document.content}\n\n`;
        resultCount++;
      } else {
        // Below-threshold chunks are dropped, not just deprioritized — logged at
        // debug level so you can inspect what got filtered out without it being
        // noisy in normal logs.
        this.logger.debug(
          `Discarded chunk from ${result.document.source} due to low score (${relevanceScore.toFixed(2)})`,
        );
      }
    }

    if (resultCount === 0) {
      this.logger.warn(`No search results found for query: "${userQuery}"`);
      // NOTE: this exact string is referenced in the system prompt below —
      // keep them in sync if you change either one, or the model's instruction
      // to check for "no documents found" silently stops matching.
      retrievedContext = 'No relevant internal documents were found for this query.';
    }

    // 3. Prepare initial chat system prompt with explicit guardrails.
    //    Two rules: (a) route real-time/transactional questions to the tool,
    //    never to document search, and (b) stay grounded in retrieved context
    //    for everything else — no hallucinating policy.
    const systemPrompt = `You are an enterprise AI assistant for Microsoft Azure services.

CRITICAL INSTRUCTIONS:
1. DATA FRESHNESS & TOOL SELECTION: Document search results contain general static policies and product info, NOT live transactional data. For any question about a specific order's status, tracking, or details, ALWAYS call the 'lookupOrder' tool rather than trusting document search - retrieved documents will never contain real-time order status.
2. DOCUMENT GROUNDING: For non-transactional factual or policy questions, answer strictly using the "Retrieved Context" provided below. If the context states "No relevant internal documents were found", inform the user that internal knowledge bases do not contain the answer. Do NOT invent or hallucinate policies.

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

    // 5. Bounded Agentic Loop (max MAX_TOOL_ITERATIONS turns).
    //    Each pass: execute whatever tool(s) the model asked for, feed the
    //    results back, and ask again. On the last allowed pass, tools/tool_choice
    //    are omitted from the request so the model is forced to answer in text
    //    instead of requesting yet another tool call.
    while (responseMessage.tool_calls && responseMessage.tool_calls.length > 0 && iterations < MAX_TOOL_ITERATIONS) {
      iterations++;
      this.logger.log(`Executing Tool Iteration #${iterations}`);

      // Push assistant's request (containing tool_calls) to history — required
      // by the API so it has context for what each tool_call_id refers to.
      messages.push(responseMessage);

      // Process all tool calls in this turn. Every tool_call_id MUST get a
      // matching role:'tool' message pushed back, even for tools we don't
      // recognize — otherwise the next API call is rejected with a 400
      // ("each tool_call must have a response").
      for (const toolCall of responseMessage.tool_calls) {
        if (toolCall.type === 'function' && toolCall.function.name === 'lookupOrder') {
          let toolResult: string;
          try {
            const args = JSON.parse(toolCall.function.arguments);
            toolResult = executeOrderLookup(args.orderId);
          } catch (err) {
            // Malformed/missing args shouldn't crash the request — feed the
            // model a structured error instead so it can recover (e.g. ask
            // the user to confirm their order number) rather than failing.
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
        } else {
          // Defensive fallback for any tool name we don't have a handler for
          // (hallucinated function name, or a new tool schema was added
          // without a corresponding branch here). Keeps every tool_call_id
          // answered so the conversation doesn't break.
          this.logger.warn(
            `Unhandled tool call: ${toolCall.type === 'function' ? toolCall.function.name : toolCall.type}`,
          );
          messages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: JSON.stringify({ error: 'Unknown tool requested.' }),
          });
        }
      }

      // Re-query Azure OpenAI: omit tools if iteration limit reached to force
      // final text response instead of another tool_calls round.
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