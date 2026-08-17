import { buildApp } from './app.js';
import { config } from './config.js';
import { prisma } from './lib/prisma.js';
import { closeQueue } from './lib/queue.js';

// One process can carry both roles where a second one is not available (Render's free
// tier has no background worker). The worker is closed by the chain below rather than
// by handlers of its own.
const worker = config.RUN_WORKER ? (await import('./worker.js')).emailWorker : null;

const app = buildApp();

app.listen({ port: config.PORT, host: '0.0.0.0' }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});

// A container stop is a signal, not a call to close(): without this the Redis
// connection is dropped mid-command instead of quitting. The queue goes after the
// server so a request already in flight can still enqueue its notification. Prisma
// goes last and cannot be skipped: its pool holds ref'd sockets that keep the event
// loop alive for 10 s, exactly Docker's stop grace, which turns the stop into a SIGKILL.
const shutdown = () =>
  Promise.resolve(worker?.close())
    .then(() => app.close())
    .then(closeQueue)
    .then(() => prisma.$disconnect())
    .catch((err) => {
      app.log.error(err);
      process.exit(1);
    });

process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
