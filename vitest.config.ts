import { defineConfig } from 'vitest/config';
import path from 'path';

const r = (p: string) => path.resolve(__dirname, p);

export default defineConfig({
  resolve: {
    alias: {
      '@bruno-types': r('src/bruno-types'),
      components: r('src/webview/components'),
      providers: r('src/webview/providers'),
      hooks: r('src/webview/hooks'),
      utils: r('src/webview/utils'),
      themes: r('src/webview/themes'),
      assets: r('src/webview/assets'),
      selectors: r('src/webview/selectors'),
      ui: r('src/webview/ui'),
      views: r('src/webview/views')
    }
  },
  test: {
    include: ['test/unit/**/*.test.ts'],
    environment: 'node'
  }
});
