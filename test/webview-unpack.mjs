/**
 * Guards the failure that a catalog install would hit: main.js must carry the
 * whole webview/ folder and restore it byte for byte, because Obsidian ships
 * only main.js/manifest.json/styles.css and the view reads webview/index.html
 * from disk.
 *
 * Bundles the real unpacker with the real embed plugin, unpacks into a temp
 * folder and compares every file against the built webview/.
 *
 * Run: npm run test:webview
 */
import * as esbuild from 'esbuild';
import assert from 'assert';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

import { createEmbedWebviewPlugin, STAMP } from '../esbuild.webview-embed.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const webviewDir = path.join(root, 'webview');

assert.ok(fs.existsSync(path.join(webviewDir, 'index.html')), 'webview/ not built - run `npm run build:webview` first');

const outfile = path.join(os.tmpdir(), `bruno-unpack-${process.pid}.mjs`);
await esbuild.build({
  stdin: {
    contents: "export { ensureWebviewAssets } from './src/obsidian/webview-assets';",
    resolveDir: root,
    loader: 'ts'
  },
  bundle: true,
  outfile,
  format: 'esm',
  platform: 'node',
  target: 'node18',
  logLevel: 'warning',
  plugins: [createEmbedWebviewPlugin({ rootDir: root, quiet: true })]
});

const { ensureWebviewAssets } = await import(`file://${outfile}`);

const hash = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const walk = (dir, base = dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  const full = path.join(dir, entry.name);
  if (entry.isDirectory()) { return walk(full, base); }
  if (entry.name === STAMP) { return []; }
  return [[path.relative(base, full).split(path.sep).join('/'), hash(full)]];
});

const expected = new Map(walk(webviewDir));
const pluginDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bruno-plugin-'));

try {
  await ensureWebviewAssets(pluginDir);

  const actual = new Map(walk(path.join(pluginDir, 'webview')));
  assert.deepStrictEqual([...actual.keys()].sort(), [...expected.keys()].sort(), 'unpacked file list differs');
  for (const [relative, digest] of expected) {
    assert.strictEqual(actual.get(relative), digest, `content differs: ${relative}`);
  }

  const stampPath = path.join(pluginDir, 'webview', STAMP);
  assert.ok(fs.existsSync(stampPath), 'build-id stamp not written');
  assert.strictEqual(fs.readFileSync(stampPath, 'utf8'), fs.readFileSync(path.join(webviewDir, STAMP), 'utf8'),
    'unpacked stamp does not match the built bundle');

  // Second call must be a no-op: the stamp matches, so nothing is rewritten.
  const before = fs.statSync(path.join(pluginDir, 'webview', 'index.html')).mtimeMs;
  await ensureWebviewAssets(pluginDir);
  assert.strictEqual(fs.statSync(path.join(pluginDir, 'webview', 'index.html')).mtimeMs, before,
    'second load re-unpacked an up-to-date bundle');

  // A stale bundle must be replaced, not merged: content-hashed chunk names
  // mean an orphan from a previous version would never be overwritten.
  fs.writeFileSync(path.join(pluginDir, 'webview', STAMP), 'stale');
  fs.writeFileSync(path.join(pluginDir, 'webview', 'orphan-chunk.js'), 'stale');
  await ensureWebviewAssets(pluginDir);
  assert.ok(!fs.existsSync(path.join(pluginDir, 'webview', 'orphan-chunk.js')), 'stale file survived the re-unpack');

  console.log(`webview unpack ok: ${expected.size} files restored byte for byte`);
} finally {
  fs.rmSync(pluginDir, { recursive: true, force: true });
  fs.rmSync(outfile, { force: true });
}
