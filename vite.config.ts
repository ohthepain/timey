import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import { nitro } from 'nitro/vite';
import { defineConfig, lazyPlugins } from 'vite-plus';
import viteReact from '@vitejs/plugin-react';
import { z } from 'zod';
import formatConfig from './.oxfmtrc.json';

export default defineConfig({
  fmt: {
    ...formatConfig,
    trailingComma: z.enum(['all', 'es5', 'none']).parse(formatConfig.trailingComma),
  },
  lint: {
    jsPlugins: [{ name: 'vite-plus', specifier: 'vite-plus/oxlint-plugin' }],
    rules: { 'vite-plus/prefer-vite-plus-imports': 'error' },
    options: { typeAware: true, typeCheck: true },
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
