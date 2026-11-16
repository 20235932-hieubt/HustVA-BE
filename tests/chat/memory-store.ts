// Test double only. Runtime always uses MongoConversationStore.
import { randomUUID } from 'node:crypto';
import type { ChatResult, StudentContext } from '../../src/chat/contracts.js';
import type { Conversation, ConversationStore, RequestRecord } from '../../src/chat/repository.js';

export class MemoryStore implements ConversationStore {
  conversations = new Map<string, Conversation>();
  requests = new Map<string, RequestRecord>();
  async create(hash: string) {
    const conversation: Conversation = {
      _id: randomUUID(),
      tokenHash: hash,
      context: {},
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 86_400_000),
    };
    this.conversations.set(conversation._id, conversation);
    return structuredClone(conversation);
  }
  async find(id: string, hash: string) {
    const conversation = this.conversations.get(id);
    return conversation?.tokenHash === hash && conversation.expiresAt.getTime() > Date.now()
      ? structuredClone(conversation)
      : null;
  }
  async acquire(id: string, hash: string, runId: string, until: Date) {
    const conversation = this.conversations.get(id);
    if (
      !(await this.find(id, hash)) ||
      (conversation!.lease && conversation!.lease.until.getTime() > Date.now())
    )
      return null;
    conversation!.lease = { runId, until };
    return structuredClone(conversation!);
  }
  async release(id: string, runId: string) {
    const conversation = this.conversations.get(id);
    if (conversation?.lease?.runId === runId) delete conversation.lease;
  }
  async request(id: string, requestId: string) {
    return structuredClone(this.requests.get(`${id}:${requestId}`) ?? null);
  }
  async begin(record: RequestRecord) {
    if (this.requests.has(record._id)) throw new Error('duplicate');
    this.requests.set(record._id, structuredClone(record));
  }
  async complete(record: RequestRecord, context: StudentContext, result: ChatResult) {
    this.conversations.get(record.conversationId)!.context = structuredClone(context);
    Object.assign(this.requests.get(record._id)!, {
      status: 'completed',
      result: structuredClone(result),
    });
  }
  async fail(record: RequestRecord, code: string) {
    const current = this.requests.get(record._id);
    if (current?.status === 'pending')
      Object.assign(current, { status: 'failed', errorCode: code });
  }
  async list(id: string, limit: number, offset: number, contextOnly = false) {
    return [...this.requests.values()]
      .filter(
        (record) =>
          record.conversationId === id &&
          (!contextOnly || (record.status === 'completed' && record.retainInContext)),
      )
      .reverse()
      .slice(offset, offset + limit)
      .map((record) => structuredClone(record));
  }
  async remove(id: string) {
    this.conversations.delete(id);
    for (const [key, record] of this.requests)
      if (record.conversationId === id) this.requests.delete(key);
  }
}
