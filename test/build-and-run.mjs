import * as esbuild from 'esbuild';
import path from 'path';
import { builtinModules } from 'node:module';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const outfile = path.join(__dirname, '.smoke.cjs');

await esbuild.build({
  entryPoints: [path.join(__dirname, 'smoke.ts')],
  bundle: true,
  outfile,
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  sourcemap: 'inline',
  // esbuild leaves `import.meta.url` undefined in CJS output, which breaks
  // QuickJS's node loader inside @usebruno/js.
  define: { 'import.meta': '__brunoMeta' },
  banner: { js: "const __brunoMeta = { get url() { return globalThis.__brunoMetaUrl || (typeof __filename !== 'undefined' ? require('url').pathToFileURL(__filename).href : 'file:///bruno'); } };" },
  external: ['electron', ...builtinModules, ...builtinModules.map(m => `node:${m}`)],
   plugins: [{
     name: 'vscode-shim',
     setup(build) {
       build.onResolve({ filter: /^vscode$/ }, () => ({ path: path.join(root, 'src/obsidian/vscode-shim.ts') }));
       // The shim only needs `FileSystemAdapter` for an instanceof check.
       build.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian', namespace: 'stub' }));
        // Minimal surface: FileSystemAdapter (vscode-shim instanceof check) and
        // ItemView (base class of obsidian/view.ts).
        build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
          contents: `module.exports = {
            FileSystemAdapter: class {},
            ItemView: class { constructor(leaf) { this.leaf = leaf; } async setState() {} },
          };`
        }));
     }
   }, {
     // Same fix as esbuild.main.mjs: bundle the single-file QuickJS so the wasm
     // is embedded in the JS instead of fetched as a sibling file.
     name: 'quickjs-singlefile',
     setup(build) {
       build.onResolve({ filter: /^@jitl\/quickjs-wasmfile-release-sync/ }, () => ({
         path: path.join(root, 'node_modules/@jitl/quickjs-singlefile-cjs-release-sync/dist/index.js')
       }));
     }
   }, {
     name: 'punycode',
     setup(build) {
       build.onResolve({ filter: /^punycode\/?$/ }, () => ({
         path: path.join(root, 'node_modules/punycode/punycode.js')
       }));
     }
   }],
  logLevel: 'warning'
});

process.exit(spawnSync(process.execPath, [outfile], { stdio: 'inherit' }).status ?? 1);
