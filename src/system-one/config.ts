import { logger } from '../observability/logger.js';

export type SystemOneMode = 'off' | 'shadow' | 'on';
export type SystemOneProvider = 'laya' | 'jev' | 'clef';
export interface SystemOneSites {
  inputGate: boolean; // SYSTEM_ONE_INPUT_GATE (a)
  toolSkip: boolean; // SYSTEM_ONE_TOOL_SKIP (f)
  clarify: boolean; // SYSTEM_ONE_CLARIFY (c)
  claimCheck: boolean; // SYSTEM_ONE_CLAIM_CHECK (b)
  unitHint: boolean; // SYSTEM_ONE_UNIT_HINT (d)
  relevance: boolean; // SYSTEM_ONE_RELEVANCE (e)
}
export type SystemOneSiteName = keyof SystemOneSites;
export interface SystemOneConfig {
  mode: SystemOneMode;
  /** Already folded with `mode`: every site is false when mode is 'off'. */
  sites: SystemOneSites;
  provider: SystemOneProvider;
  url: string;
  model?: string;
  /** Header only; never log it. */
  apiKey?: string;
  timeoutMs: number;
}

const DEFAULT_TIMEOUT_MS = 1500;
const MIN_TIMEOUT_MS = 100;
const MAX_TIMEOUT_MS = 5000;
const SITE_ENV: Record<SystemOneSiteName, string> = {
  inputGate: 'SYSTEM_ONE_INPUT_GATE',
  toolSkip: 'SYSTEM_ONE_TOOL_SKIP',
  clarify: 'SYSTEM_ONE_CLARIFY',
  claimCheck: 'SYSTEM_ONE_CLAIM_CHECK',
  unitHint: 'SYSTEM_ONE_UNIT_HINT',
  relevance: 'SYSTEM_ONE_RELEVANCE',
};
const PROVIDER_DEFAULTS: Record<
  SystemOneProvider,
  { url?: string; model?: string; external: boolean }
> = {
  laya: { url: 'http://127.0.0.1:8002', external: false },
  jev: { url: 'https://api.typesafe.ai', model: 'jev-latest', external: true },
  // The Cloudflare URL embeds the account id, so it has no default.
  clef: { model: 'clef-flash', external: true },
};
const NO_SITES: SystemOneSites = {
  inputGate: false,
  toolSkip: false,
  clarify: false,
  claimCheck: false,
  unitHint: false,
  relevance: false,
};
const DISABLED: SystemOneConfig = {
  mode: 'off',
  sites: NO_SITES,
  provider: 'laya',
  url: 'http://127.0.0.1:8002',
  timeoutMs: DEFAULT_TIMEOUT_MS,
};

class InvalidConfig extends Error {}

function readMode(raw: string | undefined): SystemOneMode {
  const value = raw?.trim() || 'off';
  if (value === 'off' || value === 'shadow' || value === 'on') return value;
  throw new InvalidConfig('SYSTEM_ONE_MODE');
}

function readProvider(raw: string | undefined): SystemOneProvider {
  const value = raw?.trim() || 'laya';
  if (value === 'laya' || value === 'jev' || value === 'clef') return value;
  throw new InvalidConfig('SYSTEM_ONE_PROVIDER');
}

function readUrl(raw: string | undefined, provider: SystemOneProvider) {
  const value = raw?.trim() || PROVIDER_DEFAULTS[provider].url;
  if (!value) throw new InvalidConfig('SYSTEM_ONE_URL');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new InvalidConfig('SYSTEM_ONE_URL');
  }
  // A bearer key and student messages must not travel in clear text.
  const allowed = PROVIDER_DEFAULTS[provider].external
    ? ['https:']
    : ['http:', 'https:'];
  if (!allowed.includes(url.protocol))
    throw new InvalidConfig('SYSTEM_ONE_URL');
  return value.replace(/\/+$/u, '');
}

function readTimeout(raw: string | undefined) {
  const value = raw?.trim() ? Number(raw) : DEFAULT_TIMEOUT_MS;
  if (
    !Number.isInteger(value) ||
    value < MIN_TIMEOUT_MS ||
    value > MAX_TIMEOUT_MS
  )
    throw new InvalidConfig('SYSTEM_ONE_TIMEOUT_MS');
  return value;
}

function readSites(env: NodeJS.ProcessEnv): SystemOneSites {
  const entries = Object.entries(SITE_ENV).map(([site, key]) => [
    site,
    env[key]?.trim() === 'true',
  ]);
  return Object.fromEntries(entries) as SystemOneSites;
}

function parse(env: NodeJS.ProcessEnv): SystemOneConfig {
  const mode = readMode(env.SYSTEM_ONE_MODE);
  if (mode === 'off') return DISABLED;
  const provider = readProvider(env.SYSTEM_ONE_PROVIDER);
  const defaults = PROVIDER_DEFAULTS[provider];
  const apiKey = env.SYSTEM_ONE_API_KEY?.trim() || undefined;
  if (defaults.external && !apiKey)
    throw new InvalidConfig('SYSTEM_ONE_API_KEY');
  return {
    mode,
    sites: readSites(env),
    provider,
    url: readUrl(env.SYSTEM_ONE_URL, provider),
    model: env.SYSTEM_ONE_MODEL?.trim() || defaults.model,
    apiKey,
    timeoutMs: readTimeout(env.SYSTEM_ONE_TIMEOUT_MS),
  };
}

/**
 * Reads SYSTEM_ONE_* without throwing. Any invalid value turns System One off
 * entirely (fail-open) instead of making the chat runtime unavailable.
 */
export function readSystemOneConfig(
  env: NodeJS.ProcessEnv = process.env,
  log: Pick<typeof logger, 'warn'> = logger,
): SystemOneConfig {
  try {
    return parse(env);
  } catch (error) {
    if (!(error instanceof InvalidConfig)) throw error;
    log.warn('system_one.config.invalid', {
      errorCode: 'SYSTEM_ONE_CONFIG_INVALID',
    });
    return DISABLED;
  }
}

export function isSiteActive(
  config: SystemOneConfig,
  site: SystemOneSiteName,
): boolean {
  return config.mode !== 'off' && config.sites[site];
}

export function hasActiveSite(config: SystemOneConfig): boolean {
  return (Object.keys(SITE_ENV) as SystemOneSiteName[]).some((site) =>
    isSiteActive(config, site),
  );
}
