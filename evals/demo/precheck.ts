// Checks before a full demo run (evals/demo-full.ts). Results carry key
// names, model names and HTTP status codes only, never secret values.
import { readChatConfig } from '../../src/agent/config.js';
import {
  readSystemOneConfig,
  type SystemOneConfig,
} from '../../src/system-one/config.js';

export interface Check {
  name: string;
  ok: boolean;
  /** A failed fatal check stops the run; a failed non-fatal one warns. */
  fatal: boolean;
  detail: string;
}

export const MIN_TURN_TOKENS = 24_000; // demo-plan "Cần chốt" #16
const DEFAULT_EMBEDDING_URL = 'http://127.0.0.1:8001';
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const PING_TIMEOUT_MS = 30_000;

const present = (env: NodeJS.ProcessEnv, key: string) =>
  Boolean(env[key]?.trim());

/** The config the demo uses when ON: every demo site enabled. */
export function demoSystemOneConfig(env: NodeJS.ProcessEnv): SystemOneConfig {
  return readSystemOneConfig(
    {
      ...env,
      SYSTEM_ONE_MODE: 'on',
      SYSTEM_ONE_INPUT_GATE: 'true',
      SYSTEM_ONE_TOOL_SKIP: 'true',
      SYSTEM_ONE_CLAIM_CHECK: 'true',
    },
    { warn: () => undefined },
  );
}

function turnTokens(env: NodeJS.ProcessEnv): Check {
  const name = `CHAT_MAX_TURN_TOKENS ≥ ${MIN_TURN_TOKENS}`;
  try {
    const value = readChatConfig(env).maxTurnTokens;
    return {
      name,
      ok: value >= MIN_TURN_TOKENS,
      fatal: true,
      detail: `= ${value}${env.CHAT_MAX_TURN_TOKENS?.trim() ? '' : ' (mặc định code)'}`,
    };
  } catch {
    return { name, ok: false, fatal: true, detail: 'cấu hình CHAT_* sai' };
  }
}

/** Env only, no network: safe for --dry-run. */
export function staticChecks(env: NodeJS.ProcessEnv): Check[] {
  const provider = env.SYSTEM_ONE_PROVIDER?.trim() || 'laya';
  const missingClef = [
    'SYSTEM_ONE_CLEF_ACCOUNT_ID',
    'SYSTEM_ONE_CLEF_API_TOKEN',
  ].filter((key) => !present(env, key));
  const systemOne = demoSystemOneConfig(env);
  return [
    {
      name: 'GEMINI_API_KEY',
      ok: present(env, 'GEMINI_API_KEY'),
      fatal: true,
      detail: present(env, 'GEMINI_API_KEY') ? 'có' : 'thiếu',
    },
    {
      name: 'GEMINI_MODEL',
      ok: present(env, 'GEMINI_MODEL'),
      fatal: true,
      detail: env.GEMINI_MODEL?.trim() || 'thiếu',
    },
    turnTokens(env),
    {
      name: 'SYSTEM_ONE_PROVIDER=clef',
      ok: provider === 'clef',
      fatal: true,
      detail: `= ${provider}`,
    },
    {
      name: 'SYSTEM_ONE_CLEF_*',
      ok: missingClef.length === 0 && systemOne.mode !== 'off',
      fatal: true,
      detail: missingClef.length
        ? `thiếu ${missingClef.join(', ')}`
        : systemOne.mode === 'off'
          ? 'giá trị SYSTEM_ONE_* không hợp lệ'
          : `model ${systemOne.model ?? '—'}`,
    },
  ];
}

async function status(
  fetcher: typeof fetch,
  url: string,
  init: RequestInit,
): Promise<number | string> {
  try {
    const response = await fetcher(url, {
      ...init,
      signal: AbortSignal.timeout(PING_TIMEOUT_MS),
    });
    await response.body?.cancel().catch(() => undefined);
    return response.status;
  } catch (error) {
    // The error name only: messages may echo the URL (Clef account id).
    return error instanceof Error ? error.name : 'lỗi mạng';
  }
}

/** A provider ping: 2xx passes; 5xx only warns (Gemini is often briefly
 *  unavailable and the runner sets those turns aside); anything else stops. */
function ping(name: string, code: number | string): Check {
  const ok = typeof code === 'number' && code >= 200 && code < 300;
  const transient = typeof code === 'number' && code >= 500;
  return {
    name,
    ok,
    fatal: !ok && !transient,
    detail: typeof code === 'number' ? `HTTP ${code}` : code,
  };
}

/** Embedding 8001 plus one neutral "ping" to Gemini and to Clef. Call only
 *  after staticChecks passed. */
export async function networkChecks(
  env: NodeJS.ProcessEnv,
  fetcher: typeof fetch = fetch,
): Promise<Check[]> {
  const embeddingUrl = (
    env.EMBEDDING_SERVICE_URL?.trim() || DEFAULT_EMBEDDING_URL
  ).replace(/\/+$/u, '');
  const embedding = await status(fetcher, `${embeddingUrl}/info`, {
    method: 'GET',
  });
  const model = env.GEMINI_MODEL?.trim() ?? '';
  const gemini = await status(
    fetcher,
    `${GEMINI_BASE}/${encodeURIComponent(model)}:generateContent`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-goog-api-key': env.GEMINI_API_KEY?.trim() ?? '',
      },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: 'ping' }] }],
        generationConfig: { maxOutputTokens: 16 },
      }),
    },
  );
  const systemOne = demoSystemOneConfig(env);
  const clef = await status(fetcher, systemOne.url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${systemOne.apiKey ?? ''}`,
    },
    body: JSON.stringify({
      model: systemOne.model,
      state: { message: 'ping' },
      questions: {
        ping: { type: 'noul', instructions: 'Is the message a greeting?' },
      },
    }),
  });
  return [
    {
      name: `embedding ${embeddingUrl}`,
      ok: embedding === 200,
      fatal: embedding !== 200,
      detail: typeof embedding === 'number' ? `HTTP ${embedding}` : embedding,
    },
    ping(`Gemini ping (${model})`, gemini),
    ping(`Clef ping (${systemOne.model ?? '—'})`, clef),
  ];
}

export function checkLine(check: Check): string {
  const mark = check.ok ? '✔' : check.fatal ? '✖' : '!';
  return `${mark} ${check.name}: ${check.detail}`;
}
