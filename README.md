# Enterprise RAG & Agentic Tool Engine

A production-ready NestJS application demonstrating enterprise Retrieval-Augmented Generation (RAG) and dynamic tool execution powered by Azure OpenAI and Azure AI Search.

Built with a two-stage hybrid search pipeline (HNSW Vector + BM25 Lexical + L2 Semantic Reranking), a bounded agentic execution loop, and deterministic prompt guardrails.

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

## Key Technical Features

### 1. Two-Stage Retrieval Pipeline
* **Hybrid Recall Stage:** HNSW dense vector search (`kNearestNeighborsCount: 50`) runs alongside BM25 full-text lexical search, fused automatically via Reciprocal Rank Fusion (RRF) — a single `search()` call with both `userQuery` text and `vectorSearchOptions` set triggers this.
* **L2 Deep-Learning Reranker:** The top 50 fused candidates are re-scored using Azure AI Search's Semantic Ranker (`queryType: 'semantic'`) for contextual relevance.
* **Calibrated Relevance Thresholding:** Chunks below a `rerankerScore` of `1.8` (0–4 scale) are discarded before prompt construction, filtering low-confidence noise. This threshold is defined as `MIN_RERANKER_SCORE` in `agent.service.ts` and should be tuned against real query logs, not assumed.

### 2. Grounded Agentic Engine & Bounded Loop
* **Bounded Tool Execution:** A `while` loop caps tool-calling rounds at `MAX_TOOL_ITERATIONS` (default 3, set in `agent.service.ts`), preventing runaway execution.
* **Fallback Safety:** On the final allowed iteration, the `tools` schema is omitted from the request, forcing the model to return a plain-text final answer instead of requesting another tool call.
* **Defensive Tool Execution:** Tool-call arguments are parsed inside a try/catch; malformed or missing arguments produce a structured error message fed back to the model (not a thrown exception), so the model can recover — e.g. by asking the user to clarify — instead of the request failing outright.
* **Deterministic Guardrails:** The system prompt explicitly separates passive knowledge retrieval (RAG) from active state operations (function tools), instructing the model to call `lookupOrder` for any real-time/transactional query rather than trusting static document context.

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
git clone https://github.com/your-org/azure-rag-agent-nestjs.git
cd azure-rag-agent-nestjs
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
const MIN_RERANKER_SCORE = 1.8; // tune against real query logs before deploying

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

## License

Distributed under the MIT License.