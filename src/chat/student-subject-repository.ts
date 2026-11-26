import type { Db } from 'mongodb';
import type {
  StudentSubjects,
  StudentSubjectStore,
} from '../tools/student-subject.js';
import type { Conversation } from './repository.js';

interface Binding extends StudentSubjects {
  _id: string;
  ownerHash: string;
}

/** A private, expiring binding; never included in public conversation context. */
export class MongoStudentSubjectStore implements StudentSubjectStore {
  private readonly bindings;
  private readonly conversations;
  constructor(db: Db) {
    this.bindings = db.collection<Binding>('chat_student_subjects');
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
  ): Promise<StudentSubjects | undefined> {
    const now = new Date();
    const owned = await this.conversations.findOne({
      _id: id,
      tokenHash: ownerHash,
      expiresAt: { $gt: now },
    });
    if (!owned) return undefined;
    const binding = await this.bindings.findOne({
      _id: id,
      ownerHash,
      expiresAt: { $gt: now },
    });
    if (!binding) return undefined;
    return {
      self: binding.self,
      active: binding.active,
      source: binding.source,
      establishedAt: binding.establishedAt,
      expiresAt: binding.expiresAt,
    };
  }
  async save(
    id: string,
    ownerHash: string,
    runId: string,
    state: StudentSubjects,
  ) {
    const now = new Date();
    const owned = await this.conversations.findOne({
      _id: id,
      tokenHash: ownerHash,
      expiresAt: { $gt: now },
      'lease.runId': runId,
      'lease.until': { $gt: now },
    });
    if (!owned) throw new Error('SUBJECT_LEASE_LOST');
    await this.bindings.replaceOne(
      { _id: id },
      {
        ...state,
        ownerHash,
        expiresAt: new Date(
          Math.min(state.expiresAt.getTime(), owned.expiresAt.getTime()),
        ),
      },
      { upsert: true },
    );
  }
}
