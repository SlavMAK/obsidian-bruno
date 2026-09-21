import * as fs from 'fs/promises';
import * as nodePath from 'path';
import * as zlib from 'zlib';
import { promisify } from 'util';

import { buildId, payload } from './webview-payload';

const gunzip = promisify(zlib.gunzip);

/** Records which embedded bundle the unpacked folder came from. */
const STAMP = '.bruno-build-id';

/**
 * The webview is a folder of lazily loaded chunks and fonts, but Obsidian's
 * plugin catalog installs only main.js, manifest.json and styles.css — an
 * install that way would leave the view with nothing to load. So the bundle
 * travels inside main.js and is unpacked next to it on first load.
 *
 * The bundle ships as one gzipped blob: a JSON index of `[path, byteLength]`
 * pairs, a newline, then the file contents back to back. Gzipping the raw bytes
 * once beats base64-ing each file, and the single blob keeps the bundler output
 * to one string literal.
 */
export async function ensureWebviewAssets(pluginDir: string): Promise<void> {
  // Dev build: rsbuild writes webview/ directly and nothing is embedded.
  if (!payload || !buildId) { return; }

  const webviewDir = nodePath.join(pluginDir, 'webview');
  const stampPath = nodePath.join(webviewDir, STAMP);
  if (await fs.readFile(stampPath, 'utf8').catch((): null => null) === buildId) { return; }

  const blob = await gunzip(Buffer.from(payload, 'base64'));
  const headerEnd = blob.indexOf(0x0a);
  const index = JSON.parse(blob.subarray(0, headerEnd).toString('utf8')) as [string, number][];

  // Wipe first: a stale chunk from a previous version would otherwise linger,
  // and the content-hashed filenames mean it would never be overwritten.
  await fs.rm(webviewDir, { recursive: true, force: true });

  let offset = headerEnd + 1;
  for (const [relative, size] of index) {
    const target = nodePath.join(webviewDir, relative);
    await fs.mkdir(nodePath.dirname(target), { recursive: true });
    await fs.writeFile(target, blob.subarray(offset, offset + size));
    offset += size;
  }

  // Written last, so an interrupted unpack is retried on the next load.
  await fs.writeFile(stampPath, buildId);
}
