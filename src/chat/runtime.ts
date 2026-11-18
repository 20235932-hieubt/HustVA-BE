import { createChatAgent } from '../agent/graph.js';
import { readChatConfig } from '../agent/config.js';
import { createGeminiModel } from '../agent/model.js';
import { createMongoConnection } from '../db/client.js';
import { readMongoConfig } from '../db/config.js';
import { StubKnowledge, type KnowledgePort } from '../knowledge/stub.js';
import { ChatError } from './contracts.js';
import { MongoConversationStore } from './repository.js';
import { ChatService } from './service.js';
import { logger } from '../observability/logger.js';
import { performance } from 'node:perf_hooks';

export const chatShutdown = new AbortController();
let pending: Promise<ChatService> | undefined;
let connection: ReturnType<typeof createMongoConnection> | undefined;
let knowledge: KnowledgePort = new StubKnowledge();

/** Called once by app.ts with the retrieval adapter; the stub stays only as a fallback. */
export function useKnowledge(port: KnowledgePort): void {
  knowledge = port;
}

export function getChatService(): Promise<ChatService> {
  pending ??= (async () => {
    const started = performance.now();
    logger.info('chat.runtime.initializing');
    try {
      const config = readChatConfig();
      connection = createMongoConnection(readMongoConfig());
      await connection.client.connect();
      const store = new MongoConversationStore(connection.db);
      await store.init();
      logger.info('chat.runtime.ready', { durationMs: performance.now() - started });
      // TODO(CHAT-02): add a controlled MongoDBSaver integration when checkpoint/resume is required.
      // For this baseline only sanitized completed history is persisted; scratchpad stays per-turn.
      return new ChatService(
        store,
        createChatAgent(createGeminiModel(config), knowledge, config),
        config.timeoutMs,
      );
    } catch {
      logger.error('chat.runtime.failed', {
        errorCode: 'CHAT_NOT_READY',
        durationMs: performance.now() - started,
      });
      await connection?.client.close().catch(() => undefined);
      connection = undefined;
      throw new ChatError(
        503,
        'CHAT_NOT_READY',
        'Chatbot chưa kết nối được MongoDB hoặc cấu hình chưa hợp lệ. Kiểm tra cấu hình và db:check.',
      );
    }
  })().catch((error) => {
    pending = undefined;
    throw error;
  });
  return pending;
}
export async function closeChatRuntime() {
  chatShutdown.abort();
  await pending?.catch(() => undefined);
  await connection?.client.close();
  logger.info('chat.runtime.closed');
}
