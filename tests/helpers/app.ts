import { buildApp } from '../../src/app.js';

// A fresh instance per test keeps the in-memory rate limiter isolated.
export async function buildTestApp() {
  const app = buildApp();
  await app.ready();
  return app;
}
