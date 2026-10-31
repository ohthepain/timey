import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import { nitro } from 'nitro/vite';
import { defineConfig, lazyPlugins } from 'vite-plus';
import viteReact from '@vitejs/plugin-react';

export default defineConfig({
  lint: {
    jsPlugins: [{ name: 'vite-plus', specifier: 'vite-plus/oxlint-plugin' }],
    rules: { 'vite-plus/prefer-vite-plus-imports': 'error' },
    options: { typeAware: true, typeCheck: true },
  },
  fmt: {
    semi: true,
    singleQuote: true,
    trailingComma: 'es5',
    printWidth: 120,
    tabWidth: 2,
    sortPackageJson: false,
    ignorePatterns: ['**/build', '**/public', 'pnpm-lock.yaml', 'routeTree.gen.ts'],
  },
  server: {
    port: 3000,
  },
  resolve: {
    tsconfigPaths: true,
  },
  plugins: lazyPlugins(() => [
    tanstackStart({
      srcDirectory: 'src',
      router: {
        routeFileIgnorePattern: '\\.test\\.',
        quoteStyle: 'single',
        semicolons: true,
      },
    }),
    viteReact(),
    nitro(),
  ]),
});
