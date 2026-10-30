import { defineConfig } from 'vite-plus';

export default defineConfig({
  resolve: {
    tsconfigPaths: true,
  },
  test: {
    environment: 'jsdom', // for React component tests
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.issues/**',
      '**/.{idea,git,cache,output,temp}/**',
      '**/{karma,rollup,webpack,vite,vitest,jest,ava,babel,nyc,cypress,tsup,build,eslint,prettier}.config.*',
    ],
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
