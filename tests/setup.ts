import { existsSync } from 'node:fs';

if (existsSync('.env')) process.loadEnvFile('.env');

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!testDatabaseUrl) throw new Error('TEST_DATABASE_URL is not set, run: npm run test:setup');
if (testDatabaseUrl === process.env.DATABASE_URL) {
  throw new Error('TEST_DATABASE_URL must differ from DATABASE_URL: tests truncate every table');
}

// The app reads DATABASE_URL; point it at the test database so tests never
// touch the dev data.
process.env.DATABASE_URL = testDatabaseUrl;
