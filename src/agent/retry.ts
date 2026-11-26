import { setTimeout as delay } from 'node:timers/promises';

/**
 * One Gemini call with its own deadline, retried when it hangs or fails transiently (503
 * "high demand", 429, network). Overload errors often come back in under a second, so retries
 * wait briefly first; the total time stays within `totalMs` to leave room in the 30 s turn.
 * Without a deadline a hung request used the whole turn and the user got CHAT_TIMEOUT.
 * A cancelled turn is never retried.
 */
export async function withModelRetry<T>(
  call: (signal: AbortSignal) => Promise<T>,
  signal: AbortSignal,
  { attemptMs = 10_000, attempts = 3, totalMs = 16_000 } = {},
): Promise<T> {
  const started = Date.now();
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    signal.throwIfAborted();
    const left = totalMs - (Date.now() - started);
    if (attempt > 0 && left < 2_000) break;
    const deadline = AbortSignal.timeout(
      Math.min(attemptMs, Math.max(left, 1_000)),
    );
    try {
      return await call(AbortSignal.any([signal, deadline]));
    } catch (error) {
      signal.throwIfAborted();
      lastError = deadline.aborted
        ? Object.assign(new Error('MODEL_ATTEMPT_TIMEOUT'), { status: 504 })
        : error;
      const status =
        error && typeof error === 'object' && 'status' in error
          ? Number(error.status)
          : undefined;
      // Bad request, auth or unknown model will not succeed on a second try.
      if (status !== undefined && [400, 401, 403, 404].includes(status)) break;
      if (attempt + 1 < attempts)
        await delay(1_000 * (attempt + 1), undefined, { signal });
    }
  }
  throw lastError;
}
