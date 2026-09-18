import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { jest} from '@jest/globals';
import { AgentService } from './agent.service.js';
import { AZURE_OPENAI_CLIENT } from '../azure/azure-openai.provider.js';
import { AZURE_SEARCH_CLIENT } from '../azure/azure-search.provider.js';

describe('AgentService', () => {
  let service: AgentService;
  let mockOpenAiClient: any;
  let mockSearchClient: any;

  beforeEach(async () => {
    mockOpenAiClient = {
      embeddings: {
        create: jest.fn().mockResolvedValue({
          data: [{ embedding: [0.1, 0.2, 0.3] }],
        }),
      },
      chat: {
        completions: {
          create: jest.fn(),
        },
      },
    };

    mockSearchClient = {
      search: jest.fn().mockReturnValue(
        (async function* () {
          yield {
            rerankerScore: 2.5,
            document: { source: 'policy.md', content: 'Standard return policy.' },
          };
        })(),
      ),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AgentService,
        { provide: AZURE_OPENAI_CLIENT, useValue: mockOpenAiClient },
        { provide: AZURE_SEARCH_CLIENT, useValue: mockSearchClient },
        {
          provide: ConfigService,
          useValue: {
            getOrThrow: jest.fn((key: string) => {
              if (key === 'AZURE_OPENAI_CHAT_DEPLOYMENT') return 'gpt-4o';
              if (key === 'AZURE_OPENAI_EMBEDDING_DEPLOYMENT') return 'text-embedding-3-small';
              return 'mock-value';
            }),
          },
        },
      ],
    }).compile();

    service = module.get<AgentService>(AgentService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // =========================================================================
  // 1. Bounded Loop Tests (Highest Priority)
  // =========================================================================
  describe('Bounded Loop Behavior', () => {
    it('should terminate exactly at MAX_TOOL_ITERATIONS (3) and omit tools on the final call', async () => {
      const toolCallResponse = {
        choices: [
          {
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call_infinite',
                  type: 'function',
                  function: { name: 'lookupOrder', arguments: '{"orderId":"ORD-123"}' },
                },
              ],
            },
          },
        ],
      };

      const finalContentResponse = {
        choices: [{ message: { role: 'assistant', content: 'Forced final response after max iterations.' } }],
      };

      mockOpenAiClient.chat.completions.create
        .mockResolvedValueOnce(toolCallResponse) // Iteration 1
        .mockResolvedValueOnce(toolCallResponse) // Iteration 2
        .mockResolvedValueOnce(toolCallResponse) // Iteration 3
        .mockResolvedValueOnce(finalContentResponse); // Final call (tools removed)

      const result = await service.chat('Check order status');

      // 1 initial call + 3 loop calls = 4 total completion calls
      expect(mockOpenAiClient.chat.completions.create).toHaveBeenCalledTimes(4);

      // Verify the final call (4th invocation) receives undefined for tools/tool_choice
      const finalCallArgs = mockOpenAiClient.chat.completions.create.mock.calls[3][0];
      expect(finalCallArgs.tools).toBeUndefined();
      expect(finalCallArgs.tool_choice).toBeUndefined();
      expect(result).toBe('Forced final response after max iterations.');
    });

    it('should bypass the loop entirely when the model responds with direct text', async () => {
      mockOpenAiClient.chat.completions.create.mockResolvedValueOnce({
        choices: [{ message: { role: 'assistant', content: 'Here is your answer.' } }],
      });

      const result = await service.chat('What is the return policy?');

      expect(mockOpenAiClient.chat.completions.create).toHaveBeenCalledTimes(1);
      expect(result).toBe('Here is your answer.');
    });

    it('should execute exactly 2 API calls when model calls a tool once then returns text', async () => {
      mockOpenAiClient.chat.completions.create
        .mockResolvedValueOnce({
          choices: [
            {
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [
                  {
                    id: 'call_1',
                    type: 'function',
                    function: { name: 'lookupOrder', arguments: '{"orderId":"ORD-999"}' },
                  },
                ],
              },
            },
          ],
        })
        .mockResolvedValueOnce({
          choices: [{ message: { role: 'assistant', content: 'Your order has shipped.' } }],
        });

      const result = await service.chat('Where is ORD-999?');

      expect(mockOpenAiClient.chat.completions.create).toHaveBeenCalledTimes(2);
      expect(result).toBe('Your order has shipped.');
    });
  });

  // =========================================================================
  // 2. Tool Argument Handling & Parsing
  // =========================================================================
  describe('Tool Execution Handling', () => {
    it('should safely catch malformed JSON tool arguments and push structured error message', async () => {
      mockOpenAiClient.chat.completions.create
        .mockResolvedValueOnce({
          choices: [
            {
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [
                  {
                    id: 'call_bad_json',
                    type: 'function',
                    function: { name: 'lookupOrder', arguments: 'INVALID_JSON_{' },
                  },
                ],
              },
            },
          ],
        })
        .mockResolvedValueOnce({
          choices: [{ message: { role: 'assistant', content: 'I need your valid order ID.' } }],
        });

      await expect(service.chat('Check my order')).resolves.not.toThrow();

      // Inspect second API call to confirm error payload was passed back to model
      const secondCallMessages = mockOpenAiClient.chat.completions.create.mock.calls[1][0].messages;
      const toolResultMessage = secondCallMessages.find((m: any) => m.role === 'tool');

      expect(toolResultMessage).toBeDefined();
      expect(toolResultMessage.tool_call_id).toBe('call_bad_json');
      expect(toolResultMessage.content).toContain('Invalid or missing orderId');
    });

    it('should execute valid order search successfully and pass tool result to conversation', async () => {
      mockOpenAiClient.chat.completions.create
        .mockResolvedValueOnce({
          choices: [
            {
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [
                  {
                    id: 'call_valid',
                    type: 'function',
                    function: { name: 'lookupOrder', arguments: '{"orderId":"1001"}' },
                  },
                ],
              },
            },
          ],
        })
        .mockResolvedValueOnce({
          choices: [{ message: { role: 'assistant', content: 'Order 1001 is processing.' } }],
        });

      await service.chat('Status of 1001?');

      const secondCallMessages = mockOpenAiClient.chat.completions.create.mock.calls[1][0].messages;
      const toolResultMessage = secondCallMessages.find((m: any) => m.role === 'tool');

      expect(toolResultMessage.tool_call_id).toBe('call_valid');
      expect(toolResultMessage.content).toContain('PROCESSING');
    });
  });

  // =========================================================================
  // 3. Reranker Score Filtering
  // =========================================================================
  describe('Reranker Score Filtering', () => {
    it('should include high-scoring chunks and discard chunks below MIN_RERANKER_SCORE (1.8)', async () => {
      mockSearchClient.search.mockReturnValue(
        (async function* () {
          yield {
            rerankerScore: 2.5, // Keep
            document: { source: 'high-quality.md', content: 'Good relevant content.' },
          };
          yield {
            rerankerScore: 1.2, // Discard (< 1.8)
            document: { source: 'low-quality.md', content: 'Irrelevant noise.' },
          };
        })(),
      );

      mockOpenAiClient.chat.completions.create.mockResolvedValueOnce({
        choices: [{ message: { role: 'assistant', content: 'Answer based on search.' } }],
      });

      await service.chat('How do returns work?');

      const firstCallSystemPrompt = mockOpenAiClient.chat.completions.create.mock.calls[0][0].messages[0].content;

      expect(firstCallSystemPrompt).toContain('high-quality.md');
      expect(firstCallSystemPrompt).not.toContain('low-quality.md');
    });

    it('should set fallback string when search returns empty results or all results fail threshold', async () => {
      mockSearchClient.search.mockReturnValue(
        (async function* () {
          // Empty iteration
        })(),
      );

      mockOpenAiClient.chat.completions.create.mockResolvedValueOnce({
        choices: [{ message: { role: 'assistant', content: 'I do not have info on that.' } }],
      });

      await service.chat('Unknown topic query');

      const firstCallSystemPrompt = mockOpenAiClient.chat.completions.create.mock.calls[0][0].messages[0].content;

      expect(firstCallSystemPrompt).toContain('No relevant internal documents were found matching this query.');
    });
  });
});