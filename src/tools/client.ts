import type { ToolConfig } from './config.js';
import type { ToolDefinition } from './catalog.js';
import { UpstreamError } from './contracts.js';
import { setTimeout as delay } from 'node:timers/promises';

export class HustClient {
  constructor(
    private config: ToolConfig,
    private fetcher: typeof fetch = fetch,
  ) {}

  configured(): boolean {
    return Boolean(
      this.config.partnerUrl &&
      this.config.partnerToken &&
      this.config.partnerAuthorization,
    );
  }

  studentConfigured(): boolean {
    return Boolean(this.config.studentId);
  }

  async call(
    tool: ToolDefinition,
    input: Record<string, unknown>,
    retries: number,
    signal: AbortSignal,
  ): Promise<unknown> {
    if (!this.configured()) throw new UpstreamError('UPSTREAM_NOT_CONFIGURED');
    for (let attempt = 0; ; attempt++) {
      signal.throwIfAborted();
      try {
        return await this.request(tool, input, signal);
      } catch (error) {
        signal.throwIfAborted();
        const safe =
          error instanceof UpstreamError
            ? error
            : new UpstreamError('UPSTREAM_NETWORK', true);
        if (!safe.retryable || attempt >= retries) throw safe;
        await delay(250 * 2 ** attempt, undefined, { signal });
      }
    }
  }

  private async request(
    tool: ToolDefinition,
    input: Record<string, unknown>,
    signal: AbortSignal,
  ) {
    const url = new URL(
      `${this.config.partnerUrl!.replace(/\/$/u, '')}/${tool.endpoint}`,
    );
    url.searchParams.set('token', this.config.partnerToken!);
    for (const [key, value] of Object.entries(input))
      if (value !== undefined) url.searchParams.set(key, String(value));
    if (tool.studentBound) {
      // ToolManager supplies the authenticated mapping after validating caller arguments.
      if (typeof input.studentId !== 'string')
        throw new UpstreamError('STUDENT_NOT_CONFIGURED');
      url.searchParams.set('studentId', input.studentId);
    }
    const headers = {
      Accept: 'application/json',
      Authorization: this.config.partnerAuthorization!,
    };
    // Never follow redirects carrying API tokens. Never expose raw upstream errors or URLs.
    const response = await this.fetcher(url, {
      method: 'POST',
      headers,
      signal,
      redirect: 'error',
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new UpstreamError(
        'UPSTREAM_HTTP',
        response.status === 429 || response.status >= 500,
      );
    }
    const maxBytes = 8 * 1024 * 1024;
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (response.body) {
      const reader = response.body.getReader();
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > maxBytes) {
            await reader.cancel();
            throw new UpstreamError('UPSTREAM_RESPONSE_TOO_LARGE');
          }
          chunks.push(value);
        }
      } finally {
        reader.releaseLock();
      }
    }
    let payload: unknown;
    try {
      payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      throw new UpstreamError('UPSTREAM_INVALID_JSON');
    }
    if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
      const object = payload as Record<string, unknown>;
      if (
        object.error ||
        object.success === false ||
        object.status === false ||
        (typeof object.status === 'string' &&
          ['error', 'failed', 'failure'].includes(
            object.status.toLowerCase(),
          )) ||
        (typeof object.status === 'number' && object.status >= 400)
      )
        throw new UpstreamError('UPSTREAM_APPLICATION_ERROR', true);
      if ('data' in object) return object.data;
    }
    throw new UpstreamError('UPSTREAM_INVALID_RESPONSE');
  }
}
