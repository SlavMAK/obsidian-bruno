import * as esbuild from 'esbuild';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { builtinModules } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isWatch = process.argv.includes('--watch');
const nodeModulesPath = path.join(__dirname, 'node_modules');

// Obsidian's renderer provides these; everything else gets bundled into main.js.
const external = ['obsidian', 'electron', '@codemirror/state', '@codemirror/view', ...builtinModules, ...builtinModules.map(m => `node:${m}`)];

// The ported bruno-vscode files import the bare specifier `vscode`; point it at
// the Obsidian-backed shim so they compile and run unchanged.
const vscodeShimPlugin = {
  name: 'vscode-shim',
  setup(build) {
    build.onResolve({ filter: /^vscode$/ }, () => ({
      path: path.join(__dirname, 'src/obsidian/vscode-shim.ts')
    }));
  }
};

// The default QuickJS variant fetches a sibling .wasm file at load time, which
// Electron's renderer cannot do over file:// and Obsidian blocks over app://.
// The single-file variant embeds the WASM in its JS, so nothing is fetched.
const quickjsSingleFilePlugin = {
  name: 'quickjs-singlefile',
  setup(build) {
    build.onResolve({ filter: /^@jitl\/quickjs-wasmfile-release-sync/ }, () => ({
      path: path.join(nodeModulesPath, '@jitl/quickjs-singlefile-cjs-release-sync/dist/index.js')
    }));
  }
};

// `tough-cookie` requires the userland shim `punycode/` (trailing slash) because
// Node deprecated the builtin. esbuild sees a builtin name and leaves it external,
// and Electron's renderer no longer provides it — so resolve it from node_modules.
const punycodePlugin = {
  name: 'punycode',
  setup(build) {
    build.onResolve({ filter: /^punycode\/?$/ }, () => ({
      path: path.join(nodeModulesPath, 'punycode', 'punycode.js')
    }));
  }
};

// Same fix bruno-vscode needs: in a bundled CJS file `module.paths` is undefined
// inside esbuild's __commonJS wrapper, which breaks @usebruno/js's node-vm require.
const patchNodeVmPlugin = {
  name: 'patch-node-vm',
  setup(build) {
    build.onLoad({ filter: /node-vm[/\\][^/\\]+\.js$/ }, async (args) => {
      let contents = await fs.promises.readFile(args.path, 'utf8');
      // In a bundled CJS file `module` is esbuild's stub, so `module.paths` is
      // undefined and @usebruno/js cannot resolve modules a test script requires.
      // `__dirname` is not defined in Obsidian's plugin loader either, so fall back
      // to the plugin folder that main.ts publishes on globalThis at load time.
      const fallback = `[require('path').join(globalThis.__brunoPluginDir || '.', 'node_modules')]`;
      contents = contents
        .replaceAll('...module.paths', `...(module.paths || ${fallback})`)
        .replaceAll('paths: module.paths', `paths: module.paths || ${fallback}`);
      return { contents, loader: 'js' };
    });
  }
};

const buildOptions = {
  entryPoints: ['src/obsidian/main.ts'],
  bundle: true,
  outfile: 'main.js',
  format: 'cjs',
  platform: 'node',
  target: 'es2020',
  sourcemap: isWatch ? 'inline' : false,
  minify: !isWatch,
  external,
  plugins: [vscodeShimPlugin, quickjsSingleFilePlugin, punycodePlugin, patchNodeVmPlugin],
  logLevel: 'info',
  // esbuild leaves `import.meta.url` undefined in CJS output, which breaks
  // QuickJS's node loader inside @usebruno/js.
  define: {
    'process.env.NODE_ENV': isWatch ? '"development"' : '"production"',
    'import.meta': '__brunoMeta'
  },
  banner: { js: "const __brunoMeta = { get url() { return globalThis.__brunoMetaUrl || (typeof __filename !== 'undefined' ? require('url').pathToFileURL(__filename).href : 'file:///bruno'); } };" }
};


if (isWatch) {
  const ctx = await esbuild.context(buildOptions);
  await ctx.watch();
  console.log('watching...');
} else {
  await esbuild.build(buildOptions);
  console.log('main.js built');
}
