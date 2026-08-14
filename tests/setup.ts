import { existsSync } from 'node:fs';
import { afterAll } from 'vitest';

if (existsSync('.env')) process.loadEnvFile('.env');

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!testDatabaseUrl) throw new Error('TEST_DATABASE_URL is not set, run: npm run test:setup');
if (testDatabaseUrl === process.env.DATABASE_URL) {
  throw new Error('TEST_DATABASE_URL must differ from DATABASE_URL: tests truncate every table');
}

const testRedisUrl = process.env.TEST_REDIS_URL;
if (!testRedisUrl) throw new Error('TEST_REDIS_URL is not set, see .env.example');
if (testRedisUrl === process.env.REDIS_URL) {
  throw new Error('TEST_REDIS_URL must differ from REDIS_URL: tests obliterate the queue');
}

// The app reads DATABASE_URL; point it at the test database so tests never
// touch the dev data. Same for the queue, which lives in its own Redis database index.
process.env.DATABASE_URL = testDatabaseUrl;
process.env.REDIS_URL = testRedisUrl;

// Every test file that builds the app opens the shared Redis connection through the
// queue module, and the queue does not own it: without this it outlives the last test
// and keeps vitest from exiting.
afterAll(async () => {
  const { closeQueue } = await import('../src/lib/queue.js');
  await closeQueue();
});
