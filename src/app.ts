import { createDemoAuthRouter } from './auth/routes.js';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { createCrawlerRouter } from './crawler/routes.js';
import { CrawlStore } from './crawler/store.js';
import { createChatRouter } from './chat/routes.js';
import { useKnowledge } from './chat/runtime.js';
import { EmbeddingService, createEmbeddingRouter } from './embedding/index.js';
import { RagKnowledge } from './knowledge/rag.js';
import { requestTrace } from './observability/http.js';
import { logger } from './observability/logger.js';
import { readHttpConfig } from './http-config.js';
import { createToolsRouter } from './tools/routes.js';
import { getToolManager } from './tools/runtime.js';

const crawlStore = new CrawlStore();
/** Every saved document is queued for embedding right after the crawler stores it. */
export const embedding = new EmbeddingService(crawlStore);
/** The chatbot's search tools read the same vectors the embedding pipeline writes. */
useKnowledge(new RagKnowledge(embedding.pipeline));
export const app: express.Express = express();
app.use(helmet());
app.use(
  cors({
    origin: readHttpConfig().webOrigin,
    credentials: true,
    exposedHeaders: ['X-Trace-Id'],
  }),
);
app.use(requestTrace);
app.use(express.json({ limit: '1mb' }));
app.use(
  '/api/v1/crawler',
  createCrawlerRouter(crawlStore, embedding.publisher),
);
app.use('/api/v1/embedding', createEmbeddingRouter(embedding));
app.use('/api/v1/auth/demo', createDemoAuthRouter());
app.use('/api/v1/chat', createChatRouter());
app.use('/api/v1/tools', createToolsRouter(undefined, getToolManager()));
app.get('/api/v1/health', (_req, res) => {
  res.json({ status: 'ok', service: 'api' });
});
app.use(
  (
    error: Error & { status?: number },
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    void _next;
    const status = error.status ?? 500;
    logger[status >= 500 ? 'error' : 'warn']('http.request.failed', {
      statusCode: status,
      errorCode:
        status === 400
          ? 'JSON_INVALID'
          : status === 413
            ? 'BODY_TOO_LARGE'
            : 'HTTP_ERROR',
    });
    res.status(status).json({
      error:
        status === 400
          ? 'Body JSON không hợp lệ'
          : status === 413
            ? 'Body quá lớn'
            : 'Không thể xử lý yêu cầu',
    });
  },
);
