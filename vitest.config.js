import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/unit/**/*.test.js', 'test/integration/**/*.test.js'],
    exclude: ['test/live/**'],
    coverage: {
      provider: 'v8',
      include: ['src/**'],
    },
  },
});
