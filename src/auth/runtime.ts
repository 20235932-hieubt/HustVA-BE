import { randomUUID } from 'node:crypto';
import { createMongoConnection } from '../db/client.js';
import { readMongoConfig } from '../db/config.js';
import { ChatError } from '../chat/contracts.js';
import { logger } from '../observability/logger.js';
import { readDemoConfig } from './demo-config.js';
import { loadDemoAccounts } from './demo-accounts.js';
import {
  DemoAuthService,
  MongoDemoSessionStore,
  type DemoPrincipal,
} from './demo-service.js';

let pending: Promise<DemoAuthService | undefined> | undefined;
let connection: ReturnType<typeof createMongoConnection> | undefined;
export function getDemoAuth(): Promise<DemoAuthService | undefined> {
  let stage = 'DEMO_CONFIG';
  pending ??= (async () => {
    const config = readDemoConfig();
    stage = 'DEMO_ACCOUNTS';
    const { accounts, version } = await loadDemoAccounts(config.accountsFile);
    stage = 'DEMO_MONGO_CONNECTION';
    connection = createMongoConnection(readMongoConfig());
    await connection.client.connect();
    stage = 'DEMO_SESSION_INDEX';
    const store = new MongoDemoSessionStore(connection.db);
    await store.init();
    return new DemoAuthService(
      accounts,
      `${version}:${randomUUID()}`,
      store,
      config.ttlMs,
    );
  })().catch(async (error: unknown) => {
    const code = (error as { code?: unknown } | null)?.code;
    logger.error('demo.auth.initialization_failed', {
      errorCode: `${stage}_FAILED`,
      ...(typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,40}$/u.test(code)
        ? { reasonCode: code }
        : {}),
    });
    await connection?.client.close().catch(() => undefined);
    connection = undefined;
    pending = undefined;
    throw new ChatError(
      503,
      'DEMO_AUTH_UNAVAILABLE',
      'Đăng nhập demo chưa sẵn sàng.',
    );
  });
  return pending;
}
export const demoCookieName = 'hustva_demo';
export function readDemoCookie(header: string | undefined) {
  const matches = (header ?? '')
    .split(';')
    .map((v) => v.trim())
    .filter((v) => v.startsWith(`${demoCookieName}=`));
  if (!matches.length) return undefined;
  const token =
    matches.length === 1 ? matches[0].slice(demoCookieName.length + 1) : '';
  if (!/^[a-zA-Z0-9_-]{43}$/u.test(token))
    throw new ChatError(401, 'DEMO_AUTH_REQUIRED', 'Phiên demo không hợp lệ.');
  return token;
}
export async function resolveDemoPrincipal(
  cookie: string | undefined,
): Promise<DemoPrincipal | undefined> {
  const token = readDemoCookie(cookie);
  if (!token) return undefined;
  const auth = await getDemoAuth();
  if (!auth)
    throw new ChatError(
      401,
      'DEMO_AUTH_REQUIRED',
      'Đăng nhập demo chưa được bật.',
    );
  return auth.principal(token);
}
export async function closeDemoRuntime() {
  await pending?.catch(() => undefined);
  await connection?.client.close();
}
