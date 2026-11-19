import express from 'express';
import { checkKey } from '../crawler/store.js';
import { EmbedderUnavailableError } from './embedder.js';
import type { EmbeddingService } from './service.js';
import type { IndexStatus } from './types.js';

export function createEmbeddingRouter(
  service: EmbeddingService,
): express.Router {
  const router = express.Router();
  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (!['localhost', '127.0.0.1', '[::1]'].includes(req.hostname)) {
      res.status(403).json({ error: 'Embedding API chỉ chạy local' });
      return;
    }
    next();
  });

  router.get('/status', async (_req, res) => {
    const counts: Record<IndexStatus, number> = {
      pending: 0,
      indexed: 0,
      skipped: 0,
      failed: 0,
    };
    let chunks = 0;
    for (const state of await service.states.list()) {
      counts[state.status]++;
      chunks += state.chunkCount;
    }
    let model: unknown = null;
    let serviceError: string | null = null;
    try {
      model = await service.embedder.info();
    } catch (error) {
      serviceError = (error as Error).message;
    }
    res.json({
      store: service.vectors.name,
      model,
      serviceError,
      queue: { waiting: service.queue.size, processing: service.queue.current },
      documents: counts,
      chunks,
      lastReconcile: service.lastReconcile,
    });
  });

  router.get('/documents/:id', async (req, res) => {
    const state = await service.states.get(checkKey(req.params.id));
    if (!state) {
      res.status(404).json({ error: 'Tài liệu chưa được embed' });
      return;
    }
    res.json({ state });
  });

  router.post('/reconcile', async (_req, res) => {
    res.status(202).json({ queued: await service.reconcile() });
  });

  router.post('/documents/:id/reindex', (req, res) => {
    service.queue.enqueue(checkKey(req.params.id), true);
    res.status(202).json({ message: 'Đã xếp hàng embed lại tài liệu' });
  });

  router.post('/search', async (req, res) => {
    const {
      query,
      limit = 5,
      sourceId,
      cohort,
    } = (req.body ?? {}) as Record<string, unknown>;
    if (typeof query !== 'string' || !query.trim() || query.length > 2000) {
      res.status(400).json({ error: 'Cần query là chuỗi 1–2000 ký tự' });
      return;
    }
    const size = Number(limit);
    if (!Number.isInteger(size) || size < 1 || size > 50) {
      res.status(400).json({ error: 'limit: 1–50' });
      return;
    }
    const filter = {
      sourceId: typeof sourceId === 'string' ? sourceId : undefined,
      cohort: typeof cohort === 'string' ? cohort.toUpperCase() : undefined,
    };
    try {
      const hits = await service.pipeline.search(query.trim(), size, filter);
      res.json({
        results: hits.map(({ score, chunk }) => ({
          score: Number(score.toFixed(4)),
          title: chunk.payload.title,
          headings: chunk.headings,
          text: chunk.text,
          kind: chunk.kind,
          pages:
            chunk.pageStart === null
              ? null
              : chunk.pageStart === chunk.pageEnd
                ? String(chunk.pageStart)
                : `${chunk.pageStart}-${chunk.pageEnd}`,
          url: chunk.payload.url,
          parentUrl: chunk.payload.parentUrl,
          sourceId: chunk.payload.sourceId,
          cohorts: chunk.payload.cohorts,
          quality: chunk.payload.quality,
          documentId: chunk.payload.documentId,
          chunkId: chunk.id,
        })),
      });
    } catch (error) {
      if (error instanceof EmbedderUnavailableError) {
        res.status(503).json({ error: error.message });
        return;
      }
      throw error;
    }
  });

  router.use((_req, res) =>
    res.status(404).json({ error: 'Endpoint embedding không tồn tại' }),
  );
  router.use(
    (
      error: Error,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      void _next;
      if (error.message.includes('ID không hợp lệ')) {
        res.status(400).json({ error: error.message });
        return;
      }
      console.error('Embedding API:', error.message);
      res
        .status(500)
        .json({ error: 'Không thể xử lý yêu cầu embedding; xem log API' });
    },
  );
  return router;
}
