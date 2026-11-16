import type { CrawlStore } from '../crawler/store.js';
import type { DocumentEventPublisher } from '../crawler/types.js';
import { embeddingConfig } from './config.js';
import { EmbedderUnavailableError, HttpEmbedder } from './embedder.js';
import { LocalIndexStateStore, LocalVectorStore } from './local-store.js';
import { IngestionPipeline, LocalEventQueue } from './pipeline.js';
import { CrawlStoreReader } from './reader.js';
import type { Embedder, IndexStateStore } from './types.js';

/** Wires the MVP pieces together. Swap the reader, vector store or queue here, not in callers. */
export class EmbeddingService {
  readonly pipeline: IngestionPipeline;
  readonly queue: LocalEventQueue;
  readonly states: IndexStateStore;
  readonly embedder: Embedder;
  lastReconcile: { at: string; queued: number; error: string | null } | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    crawlStore: CrawlStore,
    private readonly config = embeddingConfig,
    private readonly log: (message: string) => void = console.log,
  ) {
    this.embedder = new HttpEmbedder(config.serviceUrl, config.requestTimeoutMs);
    this.states = new LocalIndexStateStore(config.dataDir);
    this.pipeline = new IngestionPipeline({
      reader: new CrawlStoreReader(crawlStore),
      embedder: this.embedder,
      vectors: new LocalVectorStore(config.dataDir),
      states: this.states,
      batchSize: config.batchSize,
      maxAttempts: config.maxAttempts,
      log,
    });
    this.queue = new LocalEventQueue(this.pipeline, log);
  }

  /** Given to the crawler. A no-op when embedding is turned off. */
  get publisher(): DocumentEventPublisher {
    return this.config.enabled ? this.queue : { publish: async () => {} };
  }

  /** Queues every document whose latest version is not embedded yet. */
  async reconcile(): Promise<number> {
    try {
      const outdated = await this.pipeline.outdated();
      outdated.forEach((documentId) => this.queue.enqueue(documentId));
      this.lastReconcile = { at: new Date().toISOString(), queued: outdated.length, error: null };
      if (outdated.length) this.log(`[embedding] Reconcile: xếp hàng ${outdated.length} tài liệu`);
      return outdated.length;
    } catch (error) {
      const message = (error as Error).message;
      this.lastReconcile = { at: new Date().toISOString(), queued: 0, error: message };
      if (!(error instanceof EmbedderUnavailableError)) throw error;
      this.log(`[embedding] Reconcile bỏ qua: ${message}`);
      return 0;
    }
  }

  /** Backfill once on start, then re-check on an interval to catch missed events and retries. */
  start(): void {
    if (!this.config.enabled || this.timer) return;
    const run = (): void => {
      this.reconcile().catch((error: Error) =>
        this.log(`[embedding] Reconcile lỗi: ${error.message}`),
      );
    };
    run();
    this.timer = setInterval(run, this.config.reconcileIntervalMs);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.queue.stop();
  }
}
