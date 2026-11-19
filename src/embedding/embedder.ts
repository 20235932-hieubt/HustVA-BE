import type { Embedder, EmbedderInfo } from './types.js';

/** The service is down or unreachable; the job is retried later without counting a failure. */
export class EmbedderUnavailableError extends Error {}

/** Calls the Python service in services/embedding. */
export class HttpEmbedder implements Embedder {
  private cached: EmbedderInfo | null = null;
  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs: number,
  ) {}

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        headers: { 'content-type': 'application/json' },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      this.cached = null;
      throw new EmbedderUnavailableError(
        `Không kết nối được embedding service ${this.baseUrl}: ${(error as Error).message}`,
      );
    }
    if (response.status === 503) {
      this.cached = null;
      throw new EmbedderUnavailableError('Embedding service đang tải mô hình');
    }
    if (!response.ok)
      throw new Error(`Embedding service trả HTTP ${response.status}: ${await response.text()}`);
    return (await response.json()) as T;
  }

  async info(): Promise<EmbedderInfo> {
    this.cached ??= await this.request<EmbedderInfo>('/info');
    return this.cached;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (!texts.length) return [];
    const { dimension } = await this.info();
    const result = await this.request<{ vectors: number[][] }>('/embed', {
      method: 'POST',
      body: JSON.stringify({ texts }),
    });
    if (
      result.vectors?.length !== texts.length ||
      result.vectors.some((vector) => vector.length !== dimension)
    )
      throw new Error('Embedding service trả số vector hoặc số chiều không khớp');
    return result.vectors;
  }
}
