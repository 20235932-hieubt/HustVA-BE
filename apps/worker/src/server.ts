import 'dotenv/config';
console.log('Worker scaffold ready. No queue consumers or scheduled jobs registered.');
const keepAlive = setInterval(() => {}, 60_000);
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    clearInterval(keepAlive);
    process.exit(0);
  });
}
