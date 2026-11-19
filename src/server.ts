import 'dotenv/config';
import { app, embedding } from './app.js';
import { crawlerShutdown } from './crawler/routes.js';
import { chatShutdown, closeChatRuntime } from './chat/runtime.js';
import { logger } from './observability/logger.js';
import { readHttpConfig } from './http-config.js';
import { toolsShutdown } from './tools/routes.js';
const { port, host } = readHttpConfig();
const server = app.listen(port, host, () => {
  logger.info('server.started', { port });
  embedding.start();
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    logger.info('server.stopping');
    crawlerShutdown.abort();
    chatShutdown.abort();
    toolsShutdown.abort();
    void embedding.stop().finally(() =>
      server.close(() => {
        void closeChatRuntime().finally(() => process.exit(0));
      }),
    );
  });
}
