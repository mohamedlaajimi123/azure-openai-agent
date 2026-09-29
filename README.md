# Enterprise RAG & Agentic Tool Engine (Prototype — Untested Against Live Azure Services)

A NestJS application designed to demonstrate Retrieval-Augmented Generation (RAG) and dynamic tool execution using Azure OpenAI and Azure AI Search.

Designed around a two-stage hybrid search pipeline (HNSW Vector + BM25 Lexical + L2 Semantic Reranking), a bounded agentic execution loop, and deterministic prompt guardrails. **This code has not yet been run against live Azure resources — see Status below.**

---

## Status

This project is at the design/implementation stage. The code below reflects the intended architecture, written against the documented Azure SDK API surface, but **has not yet been executed against a real Azure OpenAI or Azure AI Search deployment.** Field names, request shapes, and threshold values (e.g. `MIN_RERANKER_SCORE`, `MAX_TOOL_ITERATIONS`) are based on documentation and reasoning, not on observed behavior, and should be expected to need correction once tested against live services.

---

## Architecture Overview

```
                    ┌──────────────────────────────────────────┐
                    │              Azure AI Search             │
                    │  ┌────────────────┐  ┌─────────────────┐ │
                    │  │ HNSW Vector    │  │  BM25 Lexical   │ │
                    │  │ Index          │  │  Search         │ │
                    │  └────────┬────────  └────────┬────────┘ │
                    │           └── Reciprocal Rank ┘          │
                    │                Fusion (RRF)              │
                    │                     │                    │
                    │        ┌────────────▼────────────┐       │
                    │        │  L2 Semantic Reranker   │       │
                    │        │  (top 50 candidates)    │       │
                    │        └────────────┬────────────┘       │
                    │        rerankerScore >= 1.8 filter       │
                    └─────────────────────┬────────────────────┘
                                          │ Retrieved Context
                                          ▼
┌────────────┐   User Query   ┌───────────────────────────┐
│ Client/API │ ─────────────► │   NestJS AgentService     │
└────────────┘                └─────────────┬─────────────┘
      ▲                                     │ Context + Tool Schema
      │                                     ▼
      │                       ┌──────────────────────────┐
      │  Final Answer         │       Azure OpenAI       │
      └───────────────────────┤    (gpt-4o / gpt-4-turbo)│
                              └─────────────┬────────────┘
                                            │ Tool Call (lookupOrder)
                                            ▼
                               ┌───────────────────────────┐
                               │   Local Tool Executor     │
                               │  (executeOrderLookup)     │
                               └───────────────────────────┘
```

---

## Intended Technical Features

### 1. Two-Stage Retrieval Pipeline (Design)
* **Hybrid Recall Stage:** HNSW dense vector search (`kNearestNeighborsCount: 50`) alongside BM25 full-text lexical search, intended to fuse automatically via Reciprocal Rank Fusion (RRF) — per Azure AI Search's documented behavior when both `userQuery` text and `vectorSearchOptions` are set in a single `search()` call.
* **L2 Semantic Reranker:** Top 50 fused candidates intended to be re-scored using Azure AI Search's Semantic Ranker (`queryType: 'semantic'`).
* **Relevance Thresholding (unvalidated):** Chunks below a `rerankerScore` of `1.8` (0–4 scale) are intended to be discarded before prompt construction. This value is a starting assumption, not a tuned or observed threshold — it needs validation against real query results.

### 2. Agentic Engine & Bounded Loop (Design)
* **Bounded Tool Execution:** A `while` loop intended to cap tool-calling rounds at `MAX_TOOL_ITERATIONS` (default 3), to prevent runaway execution.
* **Fallback Safety:** On the final allowed iteration, the `tools` schema is omitted from the request, intended to force the model into a plain-text final answer.
* **Defensive Tool Execution:** Tool-call arguments are parsed inside a try/catch; malformed arguments are intended to produce a structured error fed back to the model rather than a thrown exception — this logic is covered by unit tests with mocked Azure clients, but not yet verified against real API responses, which may have different shapes than assumed.
* **Deterministic Guardrails:** The system prompt is written to separate passive knowledge retrieval (RAG) from active state operations (function tools), instructing the model to call `lookupOrder` for any real-time/transactional query rather than trusting static document context.

---

## Project Structure

```
src/
├── agent/
│   ├── agent.module.ts          # NestJS Agent Feature Module
│   └── agent.service.ts         # RAG pipeline, tool orchestration, agent loop
├── azure/
│   ├── azure-openai.provider.ts # OpenAI client provider
│   └── azure-search.provider.ts # Azure AI Search client provider
├── ingest/
│   ├── ingest.module.ts         # Ingestion Module
│   └── ingest.service.ts        # Index creation with Semantic Configuration
├── tools/
│   └── order-lookup.tool.ts     # Function schema & execution logic (defines `lookupOrder`)
└── main.ts                      # Application bootstrap
```

---

## Environment Configuration

Create a `.env` file in the project root:

```
AZURE_OPENAI_ENDPOINT=https://<your-openai-instance>.openai.azure.com/
AZURE_OPENAI_API_KEY=<your-azure-openai-key>
AZURE_OPENAI_CHAT_DEPLOYMENT=gpt-4o
AZURE_OPENAI_EMBEDDING_DEPLOYMENT=text-embedding-3-small

AZURE_SEARCH_ENDPOINT=https://<your-search-instance>.search.windows.net
AZURE_SEARCH_API_KEY=<your-azure-search-key>
AZURE_SEARCH_INDEX_NAME=enterprise-knowledge-index
```

---

## Getting Started

### Prerequisites
* Node.js: >= 18.x
* Azure Subscriptions:
  * Azure OpenAI Resource (chat + embedding deployments)
  * Azure AI Search Resource (**Basic tier or higher** — required for Semantic Ranker; verify current tier requirements against Azure docs before deploying, as these change over time)

### Installation

```bash
git clone https://github.com/mohamedlaajimi123/azure-openai-agent.git
cd azure-openai-agent
npm install
```

### Running the Application

```bash
# Development mode
npm run start:dev

# Production build
npm run build
npm run start:prod
```

---

## Core Components

### 1. Azure AI Search Index Schema (`src/ingest/ingest.service.ts`)

Configures the vector HNSW algorithm profile, standard Lucene analyzer, and semantic field prioritization:

```typescript
await this.indexClient.createIndex({
  name: indexName,
  fields: [
    { name: 'id', type: 'Edm.String', key: true, searchable: false },
    { name: 'content', type: 'Edm.String', searchable: true, analyzerName: 'standard.lucene' },
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
  semanticSearch: {
    configurations: [
      {
        name: 'default-semantic-config',
        prioritizedFields: {
          contentFields: [{ fieldName: 'content' }],
        },
      },
    ],
  },
});
```

### 2. Retrieval & Reranking (`src/agent/agent.service.ts`)

Hybrid search with candidate expansion (`kNearestNeighborsCount: 50`), L2 semantic reranking, and score-based filtering:

```typescript
const MIN_RERANKER_SCORE = 1.8; // unvalidated — tune against real query logs before deploying

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
  const relevanceScore = result.rerankerScore ?? result.score ?? 0;
  if (relevanceScore >= MIN_RERANKER_SCORE) {
    retrievedContext += `[Source: ${result.document.source} (Score: ${relevanceScore.toFixed(2)})]\n${result.document.content}\n\n`;
    resultCount++;
  }
}

if (resultCount === 0) {
  retrievedContext = 'No relevant documents were found for this query.';
}
```

### 3. Agent Execution Loop (`src/agent/agent.service.ts`)

Multi-turn tool calling with a hard iteration cap and defensive argument parsing:

```typescript
const MAX_TOOL_ITERATIONS = 3;
let iterations = 0;

while (responseMessage.tool_calls && responseMessage.tool_calls.length > 0 && iterations < MAX_TOOL_ITERATIONS) {
  iterations++;
  messages.push(responseMessage);

  for (const toolCall of responseMessage.tool_calls) {
    if (toolCall.type === 'function' && toolCall.function.name === 'lookupOrder') {
      let toolResult: string;

      try {
        const args = JSON.parse(toolCall.function.arguments);
        toolResult = executeOrderLookup(args.orderId);
      } catch (err) {
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

  response = await this.openAiClient.chat.completions.create({
    model: chatDeployment,
    messages,
    tools: iterations < MAX_TOOL_ITERATIONS ? [ORDER_LOOKUP_TOOL_SCHEMA as any] : undefined,
    tool_choice: iterations < MAX_TOOL_ITERATIONS ? 'auto' : undefined,
  });

  responseMessage = response.choices[0].message;
}
```

---

## Testing

Unit tests exist for the tool-execution and argument-parsing logic using mocked Azure OpenAI/Search clients. **These verify the code behaves correctly against assumed response shapes — they do not confirm the assumed shapes match the real Azure SDK's actual behavior.** Integration testing against live Azure resources is the next step before any of the above can be called verified.

---

## Next Steps

- Provision live Azure OpenAI and Azure AI Search resources
- Run the ingestion pipeline against real documents and confirm the index schema is accepted
- Run real queries and validate `rerankerScore` values actually fall in a useful range around the assumed `1.8` threshold
- Confirm the tool-calling loop behaves correctly against real (not mocked) OpenAI responses
- Update this README to remove "prototype/untested" framing once the above is confirmed

---

## License

Distributed under the MIT License.