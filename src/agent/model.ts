import type { AIMessage, AIMessageChunk, BaseMessage } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { ChatGoogle } from '@langchain/google/node';
import { ChatError, draftSchema } from '../chat/contracts.js';
import { searchSchema, sectionSchema } from '../knowledge/stub.js';
import type { ChatConfig } from './config.js';
import { logger } from '../observability/logger.js';

export type ModelReply = AIMessage | AIMessageChunk;
export interface AgentModel {
  invoke(messages: BaseMessage[], signal: AbortSignal): Promise<ModelReply>;
}
// Schemas only: execution is dispatched through the backend gate, never through model-provided code.
const modelTools = [
  tool(async () => '', {
    name: 'search_knowledge',
    description: 'Tra cứu nguồn HUST. STUB: chưa có dữ liệu thật.',
    schema: searchSchema,
  }),
  tool(async () => '', {
    name: 'read_document_section',
    description: 'Đọc thêm section theo evidence đã cấp. STUB.',
    schema: sectionSchema,
  }),
  tool(async () => '', {
    name: 'submit_answer',
    description: 'Kết thúc lượt bằng draft có cấu trúc để backend kiểm tra.',
    schema: draftSchema,
  }),
];

export function createGeminiModel(config: ChatConfig): AgentModel {
  let bound: ReturnType<ChatGoogle['bindTools']> | undefined;
  return {
    async invoke(messages, signal) {
      signal.throwIfAborted();
      if (!config.apiKey || !config.model) {
        logger.warn('gemini.configuration.missing', { errorCode: 'GEMINI_NOT_CONFIGURED' });
        throw new ChatError(
          503,
          'GEMINI_NOT_CONFIGURED',
          'Cần GEMINI_API_KEY và GEMINI_MODEL trong .env để gọi Gemini.',
        );
      }
      try {
        bound ??= new ChatGoogle({
          apiKey: config.apiKey,
          model: config.model,
          maxRetries: 0,
          maxOutputTokens: config.maxOutputTokens,
          safetySettings: [
            { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
            { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
            { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
            { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
          ],
        }).bindTools(modelTools);
        const result = await bound.invoke(messages, { signal });
        signal.throwIfAborted();
        return result;
      } catch (error) {
        // Provider status is useful for quota/auth failures; messages and payloads may contain secrets.
        const providerStatus =
          error &&
          typeof error === 'object' &&
          'status' in error &&
          typeof error.status === 'number'
            ? error.status
            : undefined;
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
          'Chưa hoàn tất được yêu cầu với Gemini. Kiểm tra model/quota hoặc thử lại sau.',
        );
      }
    },
  };
}
