import { resolve } from 'node:path';

export function readDemoConfig(env: NodeJS.ProcessEnv = process.env) {
  const ttlMs = Number(env.DEMO_SESSION_TTL_MS || 3_600_000);
  if (!Number.isInteger(ttlMs) || ttlMs < 60_000 || ttlMs > 86_400_000)
    throw new Error('DEMO_CONFIG_INVALID');
  return {
    enabled: true,
    ttlMs,
    accountsFile: resolve(
      env.DEMO_ACCOUNTS_FILE || '.local/demo-auth/accounts.json',
    ),
    secure: (env.API_ORIGIN || '').startsWith('https://'),
  };
}
