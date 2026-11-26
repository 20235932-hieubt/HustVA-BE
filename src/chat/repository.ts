import { createHash, randomUUID } from 'node:crypto';
import { MongoServerError, type Db } from 'mongodb';
import type { ChatResult, StudentContext } from './contracts.js';

export const tokenHash = (token: string) =>
  createHash('sha256').update(token).digest('hex');
export interface Conversation {
  _id: string;
  tokenHash: string;
  context: StudentContext;
  createdAt: Date;
  expiresAt: Date;
  lease?: { runId: string; until: Date };
}
export interface RequestRecord {
  _id: string;
  conversationId: string;
  requestId: string;
  runId: string;
  fingerprint: string;
  privacyVersion?: string;
  user: string;
  retainInContext: boolean;
  status: 'pending' | 'completed' | 'failed';
  createdAt: Date;
  expiresAt: Date;
  result?: ChatResult;
  errorCode?: string;
  nonReplayable?: boolean;
}
export interface ConversationStore {
  create(hash: string): Promise<Conversation>;
  find(id: string, hash: string): Promise<Conversation | null>;
  acquire(
    id: string,
    hash: string,
    runId: string,
    until: Date,
  ): Promise<Conversation | null>;
  release(id: string, runId: string): Promise<void>;
  request(id: string, requestId: string): Promise<RequestRecord | null>;
  begin(record: RequestRecord): Promise<void>;
  complete(
    record: RequestRecord,
    context: StudentContext,
    result: ChatResult,
  ): Promise<void>;
  fail(record: RequestRecord, code: string): Promise<void>;
  list(
    id: string,
    limit: number,
    offset: number,
    contextOnly?: boolean,
  ): Promise<RequestRecord[]>;
  remove(id: string): Promise<void>;
}

export class MongoConversationStore implements ConversationStore {
  private readonly conversations;
  private readonly requests;
  private readonly subjects;
  constructor(db: Db) {
    this.conversations = db.collection<Conversation>('chat_conversations');
    this.requests = db.collection<RequestRecord>('chat_requests');
    this.subjects = db.collection<{ _id: string }>('chat_student_subjects');
  }
  async init() {
    await this.conversations.createIndex(
      { expiresAt: 1 },
      { expireAfterSeconds: 0, name: 'conversation_expiry' },
    );
    await this.requests.createIndex(
      { expiresAt: 1 },
      { expireAfterSeconds: 0, name: 'request_expiry' },
    );
    await this.requests.createIndex(
      { conversationId: 1, createdAt: -1 },
      { name: 'conversation_history' },
    );
  }
  async create(hash: string) {
    const now = new Date();
    const conversation: Conversation = {
      _id: randomUUID(),
      tokenHash: hash,
      context: {},
      createdAt: now,
      expiresAt: new Date(now.getTime() + 30 * 86_400_000),
    };
    await this.conversations.insertOne(conversation);
    return conversation;
  }
  find(id: string, hash: string) {
    return this.conversations.findOne({
      _id: id,
      tokenHash: hash,
      expiresAt: { $gt: new Date() },
    });
  }
  acquire(id: string, hash: string, runId: string, until: Date) {
    return this.conversations.findOneAndUpdate(
      {
        _id: id,
        tokenHash: hash,
        expiresAt: { $gt: new Date() },
        $or: [
          { lease: { $exists: false } },
          { 'lease.until': { $lt: new Date() } },
        ],
      },
      { $set: { lease: { runId, until } } },
      { returnDocument: 'after' },
    );
  }
  async release(id: string, runId: string) {
    await this.conversations.updateOne(
      { _id: id, 'lease.runId': runId },
      { $unset: { lease: '' } },
    );
  }
  request(id: string, requestId: string) {
    return this.requests.findOne({
      _id: `${id}:${requestId}`,
      expiresAt: { $gt: new Date() },
    });
  }
  async begin(record: RequestRecord) {
    try {
      await this.requests.insertOne(record);
    } catch (error) {
      if (error instanceof MongoServerError && error.code === 11000)
        throw new Error('REQUEST_CONFLICT');
      throw error;
    }
  }
  async complete(
    record: RequestRecord,
    context: StudentContext,
    result: ChatResult,
  ) {
    // The lease prevents another turn/delete from modifying this conversation during completion.
    const updated = await this.conversations.updateOne(
      {
        _id: record.conversationId,
        'lease.runId': record.runId,
        'lease.until': { $gt: new Date() },
      },
      { $set: { context } },
    );
    if (updated.matchedCount !== 1) throw new Error('LEASE_LOST');
    const saved = await this.requests.updateOne(
      { _id: record._id, runId: record.runId, status: 'pending' },
      {
        $set: {
          result,
          status: 'completed',
          retainInContext: record.retainInContext,
          ...(record.nonReplayable ? { nonReplayable: true } : {}),
        },
      },
    );
    if (saved.matchedCount !== 1) throw new Error('REQUEST_CONFLICT');
  }
  async fail(record: RequestRecord, code: string) {
    await this.requests.updateOne(
      { _id: record._id, status: 'pending', runId: record.runId },
      { $set: { status: 'failed', errorCode: code } },
    );
  }
  list(id: string, limit: number, offset: number, contextOnly = false) {
    return this.requests
      .find({
        conversationId: id,
        expiresAt: { $gt: new Date() },
        ...(contextOnly
          ? { status: 'completed' as const, retainInContext: true }
          : {}),
      })
      .sort({ createdAt: -1, _id: -1 })
      .skip(offset)
      .limit(limit)
      .toArray();
  }
  async remove(id: string) {
    // Delete messages first so a failed operation can be retried with the existing capability.
    await this.requests.deleteMany({ conversationId: id });
    await this.subjects.deleteMany({ _id: id });
    await this.conversations.deleteOne({ _id: id });
  }
}
