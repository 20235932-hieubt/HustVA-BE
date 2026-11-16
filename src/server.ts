import 'dotenv/config';
import { app, embedding } from './app.js';
import { crawlerShutdown } from './crawler/routes.js';
const port = Number(process.env.PORT ?? 4000);
const server = app.listen(port, '127.0.0.1', () => {
  console.log(`API đang chạy tại http://localhost:${port}`);
  embedding.start();
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    crawlerShutdown.abort();
    void embedding.stop().finally(() => server.close(() => process.exit(0)));
  });
}
