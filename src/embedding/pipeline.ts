import { CHUNKER_VERSION } from './config.js';
import { buildChunks } from './chunker.js';
import { EmbedderUnavailableError } from './embedder.js';
import type {
  DocumentReader,
  DocumentSavedEvent,
  Embedder,
  IndexState,
  IndexStateStore,
  SearchFilter,
  SearchHit,
  StoredChunk,
  VectorStore,
} from './types.js';
import type { DocumentEventPublisher } from '../crawler/types.js';

export type IndexOutcome =
  'indexed' | 'unchanged' | 'skipped' | 'failed' | 'unavailable' | 'missing';

export interface PipelineDeps {
  reader: DocumentReader;
  embedder: Embedder;
  vectors: VectorStore;
  states: IndexStateStore;
  batchSize: number;
  maxAttempts: number;
  log?: (message: string) => void;
}

/** read document → chunk → embed → replace vectors → record index state. */
export class IngestionPipeline {
  constructor(private readonly deps: PipelineDeps) {}

  private async modelKey(): Promise<{ key: string; dimension: number }> {
    const info = await this.deps.embedder.info();
    return { key: `${info.model}@${info.revision}`, dimension: info.dimension };
  }

  private upToDate(state: IndexState | null, versionId: string, model: string): boolean {
    if (!state || state.versionId !== versionId || state.chunkerVersion !== CHUNKER_VERSION)
      return false;
    return (
      state.status === 'skipped' || (state.status === 'indexed' && state.embeddingModel === model)
    );
  }

  async index(documentId: string, { force = false } = {}): Promise<IndexOutcome> {
    const { reader, embedder, vectors, states, batchSize, log } = this.deps;
    const document = await reader.get(documentId);
    if (!document) return 'missing';
    const previous = await states.get(documentId);
    const base = {
      documentId,
      versionId: document.versionId,
      chunkerVersion: CHUNKER_VERSION,
      attempts:
        previous?.versionId === document.versionId && previous.status === 'failed'
          ? previous.attempts
          : 0,
    };
    const save = (
      state: Pick<IndexState, 'status' | 'embeddingModel' | 'chunkCount' | 'error'> & {
        attempts?: number;
      },
    ): Promise<void> => states.set({ ...base, ...state, updatedAt: new Date().toISOString() });
    try {
      const model = await this.modelKey();
      if (!force && this.upToDate(previous, document.versionId, model.key)) return 'unchanged';
      const chunks = document.quality === 'index_only' ? [] : buildChunks(document);
      if (!chunks.length) {
        await vectors.deleteDocument(documentId);
        await save({
          status: 'skipped',
          embeddingModel: null,
          chunkCount: 0,
          error:
            document.quality === 'index_only'
              ? 'Trang chỉ dẫn tới tài liệu đính kèm; nội dung nằm ở tài liệu đó'
              : 'Không có nội dung để embed',
        });
        return 'skipped';
      }
      const stored: StoredChunk[] = [];
      for (let start = 0; start < chunks.length; start += batchSize) {
        const batch = chunks.slice(start, start + batchSize);
        const embedded = await embedder.embed(batch.map((chunk) => chunk.embedText));
        batch.forEach((chunk, i) => stored.push({ ...chunk, vector: embedded[i] }));
      }
      await vectors.replaceDocument(documentId, model.key, model.dimension, stored);
      await save({
        status: 'indexed',
        embeddingModel: model.key,
        chunkCount: stored.length,
        error: null,
      });
      log?.(`[embedding] Đã embed ${stored.length} đoạn: ${document.title}`);
      return 'indexed';
    } catch (error) {
      const message = (error as Error).message;
      if (error instanceof EmbedderUnavailableError) {
        // Keep an indexed state of this same version; only mark new content as pending.
        if (!(previous?.versionId === document.versionId && previous.status === 'indexed'))
          await save({ status: 'pending', embeddingModel: null, chunkCount: 0, error: message });
        return 'unavailable';
      }
      await save({
        status: 'failed',
        embeddingModel: null,
        chunkCount: 0,
        error: message,
        attempts: base.attempts + 1,
      });
      log?.(`[embedding] Lỗi khi embed ${document.url}: ${message}`);
      return 'failed';
    }
  }

  /** Documents whose latest version is not indexed yet: missed events, backfill, model change. */
  async outdated(): Promise<string[]> {
    const model = await this.modelKey();
    const result: string[] = [];
    for (const { documentId, versionId } of await this.deps.reader.listLatest()) {
      const state = await this.deps.states.get(documentId);
      if (this.upToDate(state, versionId, model.key)) continue;
      if (
        state?.status === 'failed' &&
        state.versionId === versionId &&
        state.attempts >= this.deps.maxAttempts
      )
        continue; // Gave up on this version; a new crawl version or a manual reindex retries it.
      result.push(documentId);
    }
    return result;
  }

  async search(query: string, limit: number, filter?: SearchFilter): Promise<SearchHit[]> {
    const model = await this.modelKey();
    const [vector] = await this.deps.embedder.embed([query]);
    return this.deps.vectors.search(vector, model.key, { limit, filter });
  }
}

/**
 * In-process queue: the crawler publishes here and documents are embedded one at a time in the
 * background, right after they are saved. A RabbitMQ publisher/consumer replaces this later;
 * the pipeline stays the same.
 */
export class LocalEventQueue implements DocumentEventPublisher {
  private readonly waiting = new Map<string, { force: boolean }>();
  private running: Promise<void> | null = null;
  private stopped = false;
  current: string | null = null;

  constructor(
    private readonly pipeline: IngestionPipeline,
    private readonly log: (message: string) => void = console.log,
  ) {}

  get size(): number {
    return this.waiting.size;
  }

  async publish(event: DocumentSavedEvent): Promise<void> {
    this.enqueue(event.documentId);
  }

  enqueue(documentId: string, force = false): void {
    if (this.stopped) return;
    const existing = this.waiting.get(documentId);
    this.waiting.set(documentId, { force: force || Boolean(existing?.force) });
    this.running ??= this.drain().finally(() => {
      this.running = null;
    });
  }

  private async drain(): Promise<void> {
    while (this.waiting.size && !this.stopped) {
      const [documentId, { force }] = this.waiting.entries().next().value!;
      this.waiting.delete(documentId);
      this.current = documentId;
      try {
        const outcome = await this.pipeline.index(documentId, { force });
        if (outcome === 'unavailable') {
          this.log(
            `[embedding] Embedding service chưa sẵn sàng; ${this.waiting.size + 1} tài liệu sẽ được thử lại ở lượt reconcile sau.`,
          );
          this.waiting.clear();
        }
      } catch (error) {
        this.log(`[embedding] Lỗi không mong đợi: ${(error as Error).message}`);
      } finally {
        this.current = null;
      }
    }
  }

  /** Resolves when the queue is empty. */
  async idle(): Promise<void> {
    while (this.running) await this.running;
  }

  /** Does not wait for the document in progress; reconcile picks it up on the next start. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.waiting.clear();
  }
}
