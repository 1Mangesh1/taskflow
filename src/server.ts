import { buildApp } from './app.js';
import { config } from './config.js';
import { closeQueue } from './lib/queue.js';

const app = buildApp();

app.listen({ port: config.PORT, host: '0.0.0.0' }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});

// A container stop is a signal, not a call to close(): without this the Redis
// connection is dropped mid-command instead of quitting. The queue goes after the
// server so a request already in flight can still enqueue its notification.
const shutdown = () =>
  app
    .close()
    .then(closeQueue)
    .catch((err) => {
      app.log.error(err);
      process.exit(1);
    });

process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
