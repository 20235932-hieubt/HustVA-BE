import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { createCrawlerRouter } from './crawler/routes.js';
export const app: express.Express = express();
app.use(helmet());
app.use(cors({ origin: process.env.WEB_ORIGIN ?? 'http://localhost:3000' }));
app.use(express.json({ limit: '1mb' }));
app.use('/api/v1/crawler', createCrawlerRouter());
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
