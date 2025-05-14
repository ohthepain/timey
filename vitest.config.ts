import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    environment: 'jsdom', // for React component tests
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    coverage: {
      provider: 'v8', // or 'c8'
      exclude: [
        '**/*.d.ts',
        '**/*.tsx', // 👈 exclude all .tsx files
        '**/test/**',
        '**/__tests__/**',
        'vitest.config.ts',
      ],
    },
  },
});
