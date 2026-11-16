import 'dotenv/config';
import { app } from './app.js';
import { crawlerShutdown } from './crawler/routes.js';
import { chatShutdown, closeChatRuntime } from './chat/runtime.js';
import { logger } from './observability/logger.js';
const port = Number(process.env.PORT ?? 4000);
const server = app.listen(port, '127.0.0.1', () => logger.info('server.started', { port }));
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    logger.info('server.stopping');
    crawlerShutdown.abort();
    chatShutdown.abort();
    server.close(() => {
      void closeChatRuntime().finally(() => process.exit(0));
    });
  });
}
