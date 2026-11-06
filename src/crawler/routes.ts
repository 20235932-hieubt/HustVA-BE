import express from 'express';
import {
  CrawlStore,
  sources,
  executeRun,
  getSource,
  printRunResults,
  readableDocuments,
} from './index.js';

export const crawlerShutdown = new AbortController();

export function createCrawlerRouter(store = new CrawlStore()): express.Router {
  const router = express.Router();
  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (!['localhost', '127.0.0.1', '[::1]'].includes(req.hostname)) {
      res.status(403).json({ error: 'Crawler API chỉ chạy local' });
      return;
    }
    if (!['GET', 'HEAD'].includes(req.method)) {
      const origin = req.get('origin');
      if (
        origin &&
        ![`http://${req.get('host')}`, process.env.WEB_ORIGIN ?? 'http://localhost:3000'].includes(
          origin,
        )
      ) {
        res.status(403).json({ error: 'Origin không được phép' });
        return;
      }
      const queryOnlyCrawl =
        req.path === '/crawl' &&
        typeof req.query.sourceId === 'string' &&
        !req.headers['transfer-encoding'] &&
        (!req.headers['content-length'] || req.headers['content-length'] === '0');
      if (!queryOnlyCrawl && !req.is('application/json')) {
        res.status(415).json({ error: 'Cần Content-Type: application/json' });
        return;
      }
    }
    next();
  });
  router.get('/sources', (_req, res) => res.json({ sources }));
  router.post('/crawl', async (req, res, next) => {
    const sourceId = req.query.sourceId ?? req.body?.sourceId;
    try {
      if (typeof sourceId !== 'string')
        throw new Error('Cần sourceId trong danh sách GET /sources');
      getSource(sourceId);
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
      return;
    }
    let release: (() => Promise<void>) | undefined;
    try {
      release = await store.acquireCrawler();
    } catch (error) {
      if ((error as Error).message.includes('đang')) {
        res.status(409).json({ error: 'Đang có yêu cầu crawl khác; chờ hoàn tất rồi gọi lại.' });
      } else next(error);
      return;
    }
    let run;
    try {
      // With the process lock held, any unfinished persisted run belongs to an old process.
      for (const previous of await store.listRuns()) {
        if (['queued', 'running'].includes(previous.status)) {
          previous.status = 'cancelled';
          previous.stopReason = 'process-interrupted';
          previous.finishedAt = new Date().toISOString();
          await store.saveRun(previous);
        }
      }
      run = await store.createRun(sourceId as string);
      console.log(`Bắt đầu crawl nguồn: ${run.sourceId}`);
      await executeRun(store, run, { log: console.log, signal: crawlerShutdown.signal });
      await store.refreshExports(run.id);
      await printRunResults(store, run);
      res.json({ run, documents: await store.documents(run.id) });
    } catch (error) {
      if (run && ['queued', 'running'].includes(run.status)) {
        run.status = 'failed';
        run.stopReason = 'api-error';
        run.finishedAt = new Date().toISOString();
        await store.saveRun(run).catch(console.error);
      }
      next(error);
    } finally {
      await release();
    }
  });
  router.get('/runs', async (_req, res) =>
    res.json({ runs: (await store.listRuns()).slice(0, 50) }),
  );
  router.get('/runs/:id', async (req, res) => {
    const run = await store.getRun(req.params.id);
    if (!run) {
      res.status(404).json({ error: 'Không tìm thấy lượt crawl' });
      return;
    }
    res.json({ run, documents: await store.documents(run.id) });
  });
  router.get('/runs/:id/results/:index/raw', async (req, res) => {
    const run = await store.getRun(req.params.id);
    const index = Number(req.params.index);
    if (!Number.isInteger(index) || index < 0) {
      res.status(400).json({ error: 'index phải là số nguyên không âm' });
      return;
    }
    const result = run?.results[index];
    if (!result?.rawHash) {
      res.status(404).json({ error: 'Không có bản tải gốc cho kết quả này' });
      return;
    }
    res
      .type('application/octet-stream')
      .attachment(`original.${result.kind === 'pdf' ? 'pdf' : 'html'}`)
      .send(await store.getArtifact(result.rawHash));
  });
  router.post('/runs/:id/cancel', async (req, res) => {
    const run = await store.getRun(req.params.id);
    if (!run) {
      res.status(404).json({ error: 'Không tìm thấy lượt crawl' });
      return;
    }
    if (!['queued', 'running'].includes(run.status)) {
      res.status(409).json({ error: 'Lượt crawl đã kết thúc' });
      return;
    }
    await store.cancelRun(run.id);
    res.status(202).json({ message: 'Crawler sẽ dừng sau khi xử lý URL hiện tại.' });
  });
  router.get('/documents', async (req, res) => {
    const runId = typeof req.query.runId === 'string' ? req.query.runId : undefined;
    if (runId && !(await store.getRun(runId))) {
      res.status(404).json({ error: 'Không tìm thấy lượt crawl' });
      return;
    }
    const limit = Number(req.query.limit ?? 25);
    const offset = Number(req.query.offset ?? 0);
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      !Number.isInteger(offset) ||
      offset < 0
    ) {
      res.status(400).json({ error: 'limit: 1–100; offset: số nguyên không âm' });
      return;
    }
    const documents = await store.documents(runId);
    res.json({
      documents: documents.slice(offset, offset + limit),
      total: documents.length,
      offset,
      limit,
    });
  });
  router.get('/documents/:id', async (req, res) => {
    const document = await store.getDocument(
      req.params.id,
      typeof req.query.versionId === 'string' ? req.query.versionId : undefined,
    );
    if (!document) {
      res.status(404).json({ error: 'Không tìm thấy tài liệu' });
      return;
    }
    res.json({ document });
  });
  router.get('/documents/:id/raw', async (req, res) => {
    const document = await store.getDocument(
      req.params.id,
      typeof req.query.versionId === 'string' ? req.query.versionId : undefined,
    );
    if (!document) {
      res.status(404).json({ error: 'Không tìm thấy tài liệu' });
      return;
    }
    res
      .type('application/octet-stream')
      .attachment(
        `${document.documentId}.${document.mimeType === 'application/pdf' ? 'pdf' : 'html'}`,
      )
      .send(await store.getArtifact(document.rawHash));
  });
  router.get('/export', async (req, res) => {
    const format = String(req.query.format ?? 'json');
    if (!['json', 'jsonl', 'txt'].includes(format)) {
      res.status(400).json({ error: 'format: json, jsonl hoặc txt' });
      return;
    }
    const runId = typeof req.query.runId === 'string' ? req.query.runId : undefined;
    if (runId && !(await store.getRun(runId))) {
      res.status(404).json({ error: 'Không tìm thấy lượt crawl' });
      return;
    }
    const documents = await store.documents(runId);
    if (format === 'json') {
      res.json({ documents });
      return;
    }
    if (format === 'txt') {
      res.type('text/plain').send(readableDocuments(documents));
      return;
    }
    res
      .type('application/x-ndjson')
      .attachment(`hustva-${runId ?? 'latest'}.jsonl`)
      .send(
        documents.map((document) => JSON.stringify(document)).join('\n') +
          (documents.length ? '\n' : ''),
      );
  });
  router.use((_req, res) => res.status(404).json({ error: 'Endpoint crawler không tồn tại' }));
  router.use(
    (error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      void _next;
      if (error.message.includes('ID không hợp lệ')) {
        res.status(400).json({ error: error.message });
        return;
      }
      console.error('Crawler API:', error.message);
      res.status(500).json({ error: 'Không thể xử lý dữ liệu crawler; xem log API' });
    },
  );
  return router;
}
