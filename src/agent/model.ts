import type {
  AIMessage,
  AIMessageChunk,
  BaseMessage,
} from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { ChatGoogle } from '@langchain/google/node';
import { ChatError, draftSchema } from '../chat/contracts.js';
import { searchSchema, sectionSchema } from '../knowledge/stub.js';
import type { ChatConfig } from './config.js';
import { logger } from '../observability/logger.js';
import { providerMessages } from '../privacy/provider.js';
import {
  getGeminiKeyPool,
  geminiErrorStatus,
  type GeminiKeyPool,
} from './gemini-key-pool.js';

export type ModelReply = AIMessage | AIMessageChunk;
export interface AgentModel {
  /** `final`: the turn's tool budget is spent, so only `submit_answer` is offered. */
  invoke(
    messages: BaseMessage[],
    signal: AbortSignal,
    options?: { final?: boolean },
  ): Promise<ModelReply>;
}
// Schemas only: execution is dispatched through the backend gate, never through model-provided code.
const modelTools = [
  tool(async () => '', {
    name: 'search_knowledge',
    description:
      'Tìm theo nghĩa trong kho văn bản HUST đã crawl (quy chế, học phí, thông báo...). Trả về các đoạn evidence kèm id, tiêu đề, vị trí và link nguồn.',
    schema: searchSchema,
  }),
  tool(async () => '', {
    name: 'read_document_section',
    description:
      'Đọc đoạn ngay trước và sau một evidenceId đã nhận trong lượt này, khi đoạn đó bị cắt dở hoặc thiếu ngữ cảnh.',
    schema: sectionSchema,
  }),
  tool(async () => '', {
    name: 'submit_answer',
    description: 'Kết thúc lượt bằng draft có cấu trúc để backend kiểm tra.',
    schema: draftSchema,
  }),
];

export function createGeminiModel(
  config: ChatConfig,
  pool: GeminiKeyPool = getGeminiKeyPool(config),
): AgentModel {
  const clients = new Map<
    string,
    {
      bound: ReturnType<ChatGoogle['bindTools']>;
      finalOnly: ReturnType<ChatGoogle['bindTools']>;
    }
  >();
  return {
    async invoke(messages, signal, options = {}) {
      signal.throwIfAborted();
      const protectedMessages = providerMessages(messages);
      const model = config.model;
      if (!pool.configured || !model) {
        logger.warn('gemini.configuration.missing', {
          errorCode: 'GEMINI_NOT_CONFIGURED',
        });
        throw new ChatError(
          503,
          'GEMINI_NOT_CONFIGURED',
          'Mình chưa sẵn sàng trả lời câu hỏi này. Bạn vui lòng thử lại sau nhé.',
        );
      }
      try {
        return await pool.run(async (apiKey) => {
          let client = clients.get(apiKey);
          if (!client) {
            const chat = new ChatGoogle({
              apiKey,
              model,
              maxRetries: 0,
              maxOutputTokens: config.maxOutputTokens,
              safetySettings: [
                {
                  category: 'HARM_CATEGORY_HARASSMENT',
                  threshold: 'BLOCK_MEDIUM_AND_ABOVE',
                },
                {
                  category: 'HARM_CATEGORY_HATE_SPEECH',
                  threshold: 'BLOCK_MEDIUM_AND_ABOVE',
                },
                {
                  category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT',
                  threshold: 'BLOCK_MEDIUM_AND_ABOVE',
                },
                {
                  category: 'HARM_CATEGORY_DANGEROUS_CONTENT',
                  threshold: 'BLOCK_MEDIUM_AND_ABOVE',
                },
              ],
            });
            // Gemini's default AUTO mode may answer in plain text, which the graph must reject because it
            // carries no citations. ANY makes every turn a tool call (search, read or submit_answer).
            client = {
              bound: chat.bindTools(modelTools, { tool_choice: 'any' }),
              finalOnly: chat.bindTools(
                modelTools.filter((item) => item.name === 'submit_answer'),
                { tool_choice: 'any' },
              ),
            };
            clients.set(apiKey, client);
          }
          const result = await (
            options.final ? client.finalOnly : client.bound
          ).invoke(protectedMessages, { signal });
          signal.throwIfAborted();
          return result;
        }, signal);
      } catch (error) {
        signal.throwIfAborted();
        if (error instanceof ChatError) throw error;
        // Provider status is useful for quota/auth failures; messages and payloads may contain secrets.
        const providerStatus = geminiErrorStatus(error);
        if (!signal.aborted)
          logger.error('gemini.provider.failed', {
            errorCode: 'GEMINI_UNAVAILABLE',
            providerStatus,
          });
        signal.throwIfAborted();
        // Do not expose provider payloads, API keys, prompts or raw stack traces.
        throw new ChatError(
          503,
          'GEMINI_UNAVAILABLE',
          'Mình đang gặp trục trặc nên chưa trả lời được. Bạn thử lại sau một chút nhé.',
        );
      }
    },
  };
}
