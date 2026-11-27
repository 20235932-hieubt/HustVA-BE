import type { Db } from 'mongodb';
import type { Conversation } from './repository.js';
import {
  validResearchState,
  type ResearchLookupState,
  type ResearchLookupStore,
} from '../tools/research-lookup.js';

interface Binding extends ResearchLookupState {
  _id: string;
  ownerHash: string;
}
/** Lookup state contains source IDs, never topic descriptions or student identity. */
export class MongoResearchLookupStore implements ResearchLookupStore {
  private readonly bindings;
  private readonly conversations;
  constructor(db: Db) {
    this.bindings = db.collection<Binding>('chat_research_targets');
    this.conversations = db.collection<Conversation>('chat_conversations');
  }
  async init() {
    await this.bindings.createIndex(
      { expiresAt: 1 },
      { expireAfterSeconds: 0 },
    );
  }
  async load(
    id: string,
    ownerHash: string,
  ): Promise<ResearchLookupState | undefined> {
    const now = new Date();
    const owned = await this.conversations.findOne({
      _id: id,
      tokenHash: ownerHash,
      expiresAt: { $gt: now },
    });
    if (!owned) return;
    const binding = await this.bindings.findOne({
      _id: id,
      ownerHash,
      expiresAt: { $gt: now },
    });
    return validResearchState(binding, now);
  }
  async save(
    id: string,
    ownerHash: string,
    runId: string,
    state: ResearchLookupState,
  ) {
    const now = new Date();
    const valid = validResearchState(state, now);
    if (!valid) throw new Error('TOPIC_CONTEXT_EXPIRED');
    const owned = await this.conversations.findOne({
      _id: id,
      tokenHash: ownerHash,
      expiresAt: { $gt: now },
      'lease.runId': runId,
      'lease.until': { $gt: now },
    });
    if (!owned) throw new Error('TOPIC_CONTEXT_LEASE_LOST');
    await this.bindings.replaceOne(
      { _id: id },
      {
        ...valid,
        ownerHash,
        expiresAt: new Date(
          Math.min(
            valid.expiresAt.getTime(),
            owned.expiresAt.getTime(),
            valid.establishedAt.getTime() + 600_000,
          ),
        ),
      },
      { upsert: true },
    );
  }
}
