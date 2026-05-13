import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: false,
    setupFiles: ['./vitest.setup.ts'],
    include: ['lib/**/*.test.ts', 'components/**/*.test.ts', 'components/**/*.test.tsx'],
    exclude: ['lib/planet-bindings/**'],
  },
});
