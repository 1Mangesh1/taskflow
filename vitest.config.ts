import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['tests/setup.ts'],
    // Test files share one database and truncate it between tests.
    fileParallelism: false,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      // Without this, v8 reports only the files a test happened to import, so a module
      // nothing covers is absent from the table rather than sitting there at zero.
      include: ['src/**/*.ts'],
      // The Prisma client is generated, and server.ts is the listen call plus the signal
      // handlers, which no in-process test runs. worker.ts is not excluded: its processor
      // and dead-letter handler are the subject of tests/integration/worker.test.ts.
      exclude: ['src/generated/**', 'src/server.ts'],
    },
  },
});
