import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['tests/setup.ts'],
    // Test files share one database and truncate it between tests.
    fileParallelism: false,
  },
});
