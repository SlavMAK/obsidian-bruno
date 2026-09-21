import { defineConfig } from '@rsbuild/core';
import { pluginReact } from '@rsbuild/plugin-react';
import { pluginBabel } from '@rsbuild/plugin-babel';
import { pluginStyledComponents } from '@rsbuild/plugin-styled-components';
import { pluginSass } from '@rsbuild/plugin-sass';
import { pluginNodePolyfill } from '@rsbuild/plugin-node-polyfill';

export default defineConfig({
  plugins: [
    pluginNodePolyfill(),
    pluginReact(),
    pluginStyledComponents(),
    pluginSass(),
    pluginBabel({
      include: /\.(?:jsx?|tsx?)$/
    })
  ],
  source: {
    entry: {
      index: './src/webview/index.tsx'
    }
  },
  resolve: {
    alias: {
      // Webview path aliases
      components: './src/webview/components',
      providers: './src/webview/providers',
      hooks: './src/webview/hooks',
      utils: './src/webview/utils',
      themes: './src/webview/themes',
      assets: './src/webview/assets',
      selectors: './src/webview/selectors',
      ui: './src/webview/ui',
      views: './src/webview/views',
      // @usebruno package shims for browser compatibility
      '@usebruno/common/utils': './src/webview/shims/bruno-common-utils.ts',
      '@usebruno/converters': './src/webview/shims/bruno-converters.ts',
      '@usebruno/graphql-docs': './src/webview/shims/bruno-graphql-docs.tsx'
    }
  },
  output: {
    distPath: {
      root: 'webview'
    },
    // Obsidian's CSP (inherited by the srcdoc iframe) is
    // `style-src 'unsafe-inline' 'self'`, and the bundle is served from a
    // different app:// host than the document origin — so external stylesheets
    // are refused. Injecting them as <style> tags keeps them under 'unsafe-inline'.
    injectStyles: true,
    // Relative asset URLs so the bundle loads straight from the iframe's
    // app:// document without any path rewriting on the Obsidian side.
    assetPrefix: './',
    // Default content-hashed names: the srcdoc iframe loads chunks over app://
    // with no query string, so a stable name would be served from Chromium's
    // cache after a rebuild. index.html itself is re-read from disk on every open.
    cleanDistPath: true,
    cssModules: {
      localIdentName: '[local]'
    }
  },
  html: {
    template: './src/webview/index.html'
  },
  dev: {
    port: 3000
  },
  performance: {
    chunkSplit: {
      strategy: 'split-by-experience'
    }
  }
});
