import { createHash, randomBytes } from 'node:crypto';
import type { Db } from 'mongodb';
import { ChatError } from '../chat/contracts.js';
import type { DemoAccount } from './demo-accounts.js';
import { normalizeUsername } from './demo-accounts.js';
import { hashPassword, verifyPassword } from './password.js';

export const sessionHash = (token: string) =>
  createHash('sha256').update(token).digest('hex');
export interface DemoSession {
  _id: string;
  accountId: string;
  version: string;
  createdAt: Date;
  expiresAt: Date;
}
export interface DemoSessionStore {
  insert(session: DemoSession): Promise<void>;
  find(hash: string): Promise<DemoSession | null>;
  remove(hash: string): Promise<void>;
}
export class MongoDemoSessionStore implements DemoSessionStore {
  private collection;
  constructor(db: Db) {
    this.collection = db.collection<DemoSession>('demo_auth_sessions');
  }
  async init() {
    await this.collection.createIndex(
      { expiresAt: 1 },
      { expireAfterSeconds: 0 },
    );
  }
  async insert(session: DemoSession) {
    await this.collection.insertOne(session);
  }
  find(hash: string) {
    return this.collection.findOne({ _id: hash });
  }
  async remove(hash: string) {
    await this.collection.deleteOne({ _id: hash });
  }
}
export interface DemoPrincipal {
  readonly accountId: string;
  readonly studentId: string;
  readonly sessionId: string;
  readonly expiresAt: Date;
  readonly source: 'demo_account';
  validate(): Promise<void>;
}
export const authRequired = () =>
  new ChatError(
    401,
    'DEMO_AUTH_REQUIRED',
    'Vui lòng đăng nhập tài khoản demo để tra cứu điểm.',
  );
export class DemoAuthService {
  private dummy = hashPassword(randomBytes(32).toString('hex'));
  constructor(
    private accounts: DemoAccount[],
    private version: string,
    private store: DemoSessionStore,
    private ttlMs: number,
  ) {}
  async login(username: string, password: string) {
    const account = this.accounts.find(
      (a) => a.username === normalizeUsername(username),
    );
    const valid = await verifyPassword(
      password,
      account?.passwordHash ?? (await this.dummy),
    );
    if (!valid || !account?.enabled)
      throw new ChatError(
        401,
        'DEMO_LOGIN_INVALID',
        'Tên đăng nhập hoặc mật khẩu không đúng.',
      );
    const token = randomBytes(32).toString('base64url');
    const session: DemoSession = {
      _id: sessionHash(token),
      accountId: account.accountId,
      version: this.version,
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + this.ttlMs),
    };
    await this.store.insert(session);
    return { token, user: this.publicUser(account, session) };
  }
  private publicUser(account: DemoAccount, session: DemoSession) {
    return {
      accountId: account.accountId,
      studentId: account.studentId,
      displayName: account.displayName ?? account.username,
      expiresAt: session.expiresAt,
      mode: 'demo' as const,
    };
  }
  private async checked(hash: string) {
    const session = await this.store.find(hash);
    const account = this.accounts.find(
      (a) => a.accountId === session?.accountId,
    );
    if (
      !session ||
      session.version !== this.version ||
      session.expiresAt.getTime() <= Date.now() ||
      !account?.enabled
    )
      throw authRequired();
    return { session, account };
  }
  async principal(token: string): Promise<DemoPrincipal> {
    const hash = sessionHash(token);
    const { session, account } = await this.checked(hash);
    return Object.freeze({
      accountId: account.accountId,
      studentId: account.studentId,
      sessionId: hash,
      expiresAt: session.expiresAt,
      source: 'demo_account' as const,
      validate: async () => {
        await this.checked(hash);
      },
    });
  }
  async me(token: string) {
    const { session, account } = await this.checked(sessionHash(token));
    return this.publicUser(account, session);
  }
  async logout(token: string) {
    await this.store.remove(sessionHash(token));
  }
}
