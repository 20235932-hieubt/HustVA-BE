import { randomUUID } from 'node:crypto';
import type { ChatResult, StudentContext } from '../../src/chat/contracts.js';
import type {
  Conversation,
  ConversationStore,
  RequestRecord,
} from '../../src/chat/repository.js';

const DAY_MS = 86_400_000;
const TTL_DAYS = 30;

/**
 * In-memory ConversationStore for the demo script and tests (no Mongo).
 * Mirrors MongoConversationStore semantics; returns copies so callers cannot
 * mutate stored records.
 */
export class MemoryConversationStore implements ConversationStore {
  private readonly conversations = new Map<string, Conversation>();
  // Map keeps insertion order = creation order of requests.
  private readonly requests = new Map<string, RequestRecord>();

  async create(hash: string): Promise<Conversation> {
    const now = new Date();
    const conversation: Conversation = {
      _id: randomUUID(),
      tokenHash: hash,
      context: {},
      createdAt: now,
      expiresAt: new Date(now.getTime() + TTL_DAYS * DAY_MS),
    };
    this.conversations.set(conversation._id, conversation);
    return { ...conversation };
  }
  async find(id: string, hash: string): Promise<Conversation | null> {
    const found = this.conversations.get(id);
    return found?.tokenHash === hash ? { ...found } : null;
  }
  async acquire(
    id: string,
    hash: string,
    runId: string,
    until: Date,
  ): Promise<Conversation | null> {
    const found = this.conversations.get(id);
    if (found?.tokenHash !== hash) return null;
    if (found.lease && found.lease.until > new Date()) return null;
    const leased = { ...found, lease: { runId, until } };
    this.conversations.set(id, leased);
    return { ...leased };
  }
  async release(id: string, runId: string): Promise<void> {
    const found = this.conversations.get(id);
    if (found?.lease?.runId !== runId) return;
    const { lease: _lease, ...rest } = found;
    void _lease;
    this.conversations.set(id, rest);
  }
  async request(id: string, requestId: string): Promise<RequestRecord | null> {
    const found = this.requests.get(`${id}:${requestId}`);
    return found ? { ...found } : null;
  }
  async begin(record: RequestRecord): Promise<void> {
    if (this.requests.has(record._id)) throw new Error('REQUEST_CONFLICT');
    this.requests.set(record._id, { ...record });
  }
  async complete(
    record: RequestRecord,
    context: StudentContext,
    result: ChatResult,
  ): Promise<void> {
    const conversation = this.conversations.get(record.conversationId);
    if (conversation?.lease?.runId !== record.runId)
      throw new Error('LEASE_LOST');
    this.conversations.set(conversation._id, { ...conversation, context });
    const saved = this.requests.get(record._id);
    if (saved?.status !== 'pending' || saved.runId !== record.runId)
      throw new Error('REQUEST_CONFLICT');
    this.requests.set(record._id, {
      ...saved,
      result,
      status: 'completed',
      retainInContext: record.retainInContext,
    });
  }
  async fail(record: RequestRecord, code: string): Promise<void> {
    const saved = this.requests.get(record._id);
    if (saved?.status !== 'pending' || saved.runId !== record.runId) return;
    this.requests.set(record._id, {
      ...saved,
      status: 'failed',
      errorCode: code,
    });
  }
  async list(
    id: string,
    limit: number,
    offset: number,
    contextOnly = false,
  ): Promise<RequestRecord[]> {
    return [...this.requests.values()]
      .filter(
        (record) =>
          record.conversationId === id &&
          (!contextOnly ||
            (record.status === 'completed' && record.retainInContext)),
      )
      .reverse()
      .slice(offset, offset + limit)
      .map((record) => ({ ...record }));
  }
  async remove(id: string): Promise<void> {
    for (const [key, record] of this.requests)
      if (record.conversationId === id) this.requests.delete(key);
    this.conversations.delete(id);
  }
}
