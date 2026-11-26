import { setTimeout as delay } from 'node:timers/promises';
import { ChatError } from '../chat/contracts.js';
import { logger } from '../observability/logger.js';
import type { ChatConfig } from './config.js';

type Entry = { key: string; disabled: boolean; availableAt: number };
type ErrorShape = {
  status?: unknown;
  statusCode?: unknown;
  headers?: Record<string, unknown>;
  data?: { error?: { details?: { reason?: string }[] } };
};

export function geminiErrorStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const e = error as ErrorShape;
  const status = e.statusCode ?? e.status;
  return typeof status === 'number' && Number.isInteger(status)
    ? status
    : undefined;
}

/** One quota bucket for the configured key set: adding keys never raises its RPM. */
export class GeminiKeyPool {
  #entries: Entry[];
  #cursor = 0;
  #starts: number[] = [];
  #pausedUntil = 0;
  #rpm: number;
  #cooldown: number;
  #attempts: number;
  constructor(
    config: ChatConfig,
    private readonly now: () => number = Date.now,
    private readonly sleep: (
      ms: number,
      signal: AbortSignal,
    ) => Promise<unknown> = (ms, signal) => delay(ms, undefined, { signal }),
  ) {
    this.#entries = [
      ...new Set(
        (config.apiKeys?.length ? config.apiKeys : [config.apiKey])
          .filter((key): key is string => Boolean(key?.trim()))
          .map((key) => key.trim()),
      ),
    ].map((key) => ({ key, disabled: false, availableAt: 0 }));
    this.#rpm = Math.min(15, Math.max(1, config.geminiRequestsPerMinute ?? 15));
    this.#cooldown = Math.max(1, config.geminiKeyCooldownMs ?? 60_000);
    this.#attempts = Math.min(3, Math.max(1, config.geminiMaxAttempts ?? 2));
  }
  get configured(): boolean {
    return this.#entries.length > 0;
  }

  async run<T>(
    operation: (key: string) => Promise<T>,
    signal: AbortSignal,
  ): Promise<T> {
    const tried = new Set<Entry>();
    for (let attempt = 0; attempt < this.#attempts; attempt++) {
      signal.throwIfAborted();
      const now = this.now();
      this.#starts = this.#starts.filter((start) => now - start < 60_000);
      if (now < this.#pausedUntil || this.#starts.length >= this.#rpm)
        throw new ChatError(
          429,
          'GEMINI_RATE_LIMITED',
          'Đã chạm giới hạn gọi model. Bạn thử lại sau một chút nhé.',
        );
      let selected: Entry | undefined;
      for (let offset = 0; offset < this.#entries.length; offset++) {
        const index = (this.#cursor + offset) % this.#entries.length;
        const entry = this.#entries[index];
        if (!entry.disabled && entry.availableAt <= now && !tried.has(entry)) {
          selected = entry;
          this.#cursor = (index + 1) % this.#entries.length;
          break;
        }
      }
      if (!selected)
        throw new ChatError(
          503,
          this.configured ? 'GEMINI_KEYS_UNAVAILABLE' : 'GEMINI_NOT_CONFIGURED',
          'Kết nối model chưa sẵn sàng. Bạn thử lại sau nhé.',
        );
      tried.add(selected);
      this.#starts.push(now); // Synchronous reservation also counts failed attempts.
      try {
        const result = await operation(selected.key);
        signal.throwIfAborted();
        return result;
      } catch (error) {
        signal.throwIfAborted();
        const status = geminiErrorStatus(error);
        logger.warn('gemini.key.request_failed', {
          providerStatus: status,
          errorCode: 'GEMINI_PROVIDER_FAILED',
        });
        const shape =
          error && typeof error === 'object'
            ? (error as ErrorShape)
            : undefined;
        const details = shape?.data?.error?.details;
        const invalidKey =
          Array.isArray(details) &&
          details.some((detail) => detail?.reason === 'API_KEY_INVALID');
        if (status === 429) {
          const retry = shape?.headers?.['retry-after'];
          const seconds = typeof retry === 'string' ? Number(retry) : NaN;
          const retryAt =
            Number.isFinite(seconds) && seconds >= 0
              ? this.now() + seconds * 1000
              : typeof retry === 'string'
                ? Date.parse(retry)
                : NaN;
          this.#pausedUntil = Math.max(
            this.#pausedUntil,
            this.now() + this.#cooldown,
            Number.isFinite(retryAt) ? retryAt : 0,
          );
          // Project quota is shared: do not cycle through other keys after a 429.
          throw new ChatError(
            429,
            'GEMINI_RATE_LIMITED',
            'Dịch vụ model đang giới hạn lượt gọi. Bạn thử lại sau nhé.',
          );
        }
        if (status === 401 || status === 403 || invalidKey) {
          selected.disabled = true; // Configuration/permissions must be fixed, then restart.
        } else if (
          status !== undefined &&
          [408, 500, 502, 503, 504].includes(status)
        ) {
          selected.availableAt = this.now() + this.#cooldown;
          if (
            attempt + 1 < this.#attempts &&
            this.#entries.some(
              (entry) =>
                !entry.disabled &&
                !tried.has(entry) &&
                entry.availableAt <= this.now(),
            )
          )
            await this.sleep(
              500 * 2 ** attempt + Math.floor(Math.random() * 200),
              signal,
            );
          else if (attempt + 1 < this.#attempts) {
            // Retry transient overload with one key, reserving RPM for every attempt.
            // Auth failures and project quota (429) never reach this branch.
            await this.sleep(1000 * 2 ** attempt, signal);
            tried.delete(selected);
            selected.availableAt = this.now();
          }
        } else {
          throw new ChatError(
            503,
            'GEMINI_UNAVAILABLE',
            'Mình chưa kết nối được model. Bạn thử lại sau nhé.',
          );
        }
      }
    }
    throw new ChatError(
      503,
      'GEMINI_UNAVAILABLE',
      'Mình chưa kết nối được model. Bạn thử lại sau nhé.',
    );
  }
}

const pools = new WeakMap<ChatConfig, GeminiKeyPool>();
/** Routing and answer generation pass the same runtime config and share this instance. */
export function getGeminiKeyPool(config: ChatConfig): GeminiKeyPool {
  let pool = pools.get(config);
  if (!pool) {
    pool = new GeminiKeyPool(config);
    pools.set(config, pool);
  }
  return pool;
}
