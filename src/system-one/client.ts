import { z } from 'zod';
import { logger } from '../observability/logger.js';
import type { SystemOneConfig, SystemOneProvider } from './config.js';
import {
  normalizeDecision,
  type SystemOneAnswer,
  type SystemOneQuestion,
} from './response.js';

export type { SystemOneAnswer, SystemOneQuestion } from './response.js';
export interface SystemOneDecision {
  answers: Record<string, SystemOneAnswer>;
  latencyMs: number;
  truncated: boolean;
}
export interface SystemOneClient {
  /**
   * Never throws: any failure (network, HTTP, timeout, abort, malformed or
   * mismatched response) resolves to null so callers take the old path.
   * `state` must already have PII replaced by privacy tokens.
   */
  decide(
    state: Record<string, string>,
    questions: Record<string, SystemOneQuestion>,
    signal: AbortSignal,
  ): Promise<SystemOneDecision | null>;
}
type FailureCode =
  | 'SYSTEM_ONE_TIMEOUT'
  | 'SYSTEM_ONE_HTTP'
  | 'SYSTEM_ONE_INVALID'
  | 'SYSTEM_ONE_ABORTED';
export interface SystemOneClientDeps {
  fetch?: typeof fetch;
  log?: Pick<typeof logger, 'info' | 'warn'>;
  now?: () => number;
}

interface ProviderSpec {
  endpoint(config: SystemOneConfig): string;
  sendsModel: boolean;
  unwrap(body: unknown): unknown;
}
const PROVIDERS: Record<SystemOneProvider, ProviderSpec> = {
  laya: {
    endpoint: (config) => `${config.url}/v1/systemone`,
    sendsModel: false,
    unwrap: (body) => body,
  },
  jev: {
    endpoint: (config) => `${config.url}/v1/systemone`,
    sendsModel: true,
    unwrap: (body) => body,
  },
  // Cloudflare Workers AI wraps the payload: { success, result: {...} }.
  clef: {
    endpoint: (config) => config.url,
    sendsModel: true,
    unwrap: (body) =>
      z
        .object({ success: z.literal(true), result: z.unknown() })
        .safeParse(body).data?.result,
  },
};

class Failure extends Error {
  constructor(
    readonly code: FailureCode,
    readonly providerStatus?: number,
  ) {
    super(code);
  }
}

function classify(
  error: unknown,
  caller: AbortSignal,
  deadline: AbortSignal,
): Failure {
  if (error instanceof Failure) return error;
  if (caller.aborted) return new Failure('SYSTEM_ONE_ABORTED');
  if (deadline.aborted) return new Failure('SYSTEM_ONE_TIMEOUT');
  return new Failure('SYSTEM_ONE_HTTP');
}

export function createSystemOneClient(
  config: SystemOneConfig,
  deps: SystemOneClientDeps = {},
): SystemOneClient {
  const fetcher = deps.fetch ?? fetch;
  const log = deps.log ?? logger;
  const now = deps.now ?? (() => performance.now());
  const provider = PROVIDERS[config.provider];

  async function call(
    state: Record<string, string>,
    questions: Record<string, SystemOneQuestion>,
    signal: AbortSignal,
  ) {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
    };
    if (config.apiKey) headers.authorization = `Bearer ${config.apiKey}`;
    const body = provider.sendsModel
      ? { model: config.model, state, questions }
      : { state, questions };
    const response = await fetcher(provider.endpoint(config), {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal,
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Failure('SYSTEM_ONE_HTTP', response.status);
    }
    let json: unknown;
    try {
      json = await response.json();
    } catch (error) {
      if (signal.aborted) throw error;
      throw new Failure('SYSTEM_ONE_INVALID', response.status);
    }
    const decision = normalizeDecision(provider.unwrap(json), questions);
    if (!decision) throw new Failure('SYSTEM_ONE_INVALID', response.status);
    return { decision, providerStatus: response.status };
  }

  return {
    async decide(state, questions, signal) {
      const started = now();
      const elapsed = () => Math.max(0, now() - started);
      if (Object.keys(questions).length === 0)
        return { answers: {}, latencyMs: 0, truncated: false };
      const deadline = AbortSignal.timeout(config.timeoutMs);
      try {
        if (signal.aborted) throw new Failure('SYSTEM_ONE_ABORTED');
        const { decision, providerStatus } = await call(
          state,
          questions,
          AbortSignal.any([signal, deadline]),
        );
        const latencyMs = elapsed();
        log.info('system_one.call.completed', {
          durationMs: latencyMs,
          providerStatus,
        });
        return { ...decision, latencyMs };
      } catch (error) {
        const failure = classify(error, signal, deadline);
        log.warn('system_one.call.failed', {
          errorCode: failure.code,
          providerStatus: failure.providerStatus,
          durationMs: elapsed(),
        });
        return null;
      }
    },
  };
}
