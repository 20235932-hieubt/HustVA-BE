import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
export const app: express.Express = express();
app.use(helmet());
app.use(cors({ origin: process.env.WEB_ORIGIN ?? 'http://localhost:3000' }));
app.use(express.json({ limit: '1mb' }));
app.get('/api/v1/health', (_req, res) => {
  res.json({ status: 'ok', service: 'api', phase: 'setup' });
});
