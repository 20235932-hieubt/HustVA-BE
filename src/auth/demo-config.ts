import { resolve } from 'node:path';

export function readDemoConfig(env: NodeJS.ProcessEnv = process.env) {
  const enabled = env.DEMO_AUTH_ENABLED === 'true';
  const ttlMs = Number(env.DEMO_SESSION_TTL_MS || 3_600_000);
  if (
    !['true', 'false', undefined, ''].includes(env.DEMO_AUTH_ENABLED) ||
    !Number.isInteger(ttlMs) ||
    ttlMs < 60_000 ||
    ttlMs > 86_400_000
  )
    throw new Error('DEMO_CONFIG_INVALID');
  return {
    enabled,
    ttlMs,
    accountsFile: resolve(
      env.DEMO_ACCOUNTS_FILE || '.local/demo-auth/accounts.json',
    ),
    secure: (env.API_ORIGIN || '').startsWith('https://'),
  };
}
