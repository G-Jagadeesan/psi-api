import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Unit tests only - nothing here may touch the network.
    testTimeout: 15_000,
    env: {
      // Keep the Fastify request log out of the test output.
      LOG_LEVEL: 'silent',
    },
  },
});
