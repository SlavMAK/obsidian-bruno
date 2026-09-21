import path from 'path';
import fs from 'fs';
import zlib from 'zlib';
import crypto from 'crypto';

/** Records which embedded bundle an unpacked webview/ folder came from. */
export const STAMP = '.bruno-build-id';

const collectWebviewFiles = (dir, base = dir) => {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { files.push(...collectWebviewFiles(full, base)); continue; }
    if (entry.name === STAMP) { continue; }
    files.push([path.relative(base, full).split(path.sep).join('/'), fs.readFileSync(full)]);
  }
  return files;
};

/**
 * Obsidian's plugin catalog installs only main.js/manifest.json/styles.css, but
 * the webview is a folder of lazily loaded chunks and fonts. This embeds that
 * folder into main.js as one gzipped blob so the three-file install is
 * self-sufficient; src/obsidian/webview-assets.ts unpacks it on first load.
 *
 * Layout: a JSON index of `[path, byteLength]` pairs, a newline, then the file
 * contents back to back — gzipped once, then base64. Gzipping the raw bytes
 * beats base64-ing each file separately, and one blob keeps the bundler output
 * to a single string literal.
 *
 * @param {{ rootDir: string, isWatch?: boolean, quiet?: boolean }} options
 */
export const createEmbedWebviewPlugin = ({ rootDir, isWatch = false, quiet = false }) => ({
  name: 'embed-webview',
  setup(build) {
    const webviewDir = path.join(rootDir, 'webview');

    build.onLoad({ filter: /src[/\\]obsidian[/\\]webview-payload\.ts$/ }, () => {
      // Watch builds keep reading webview/ from disk so `dev:webview` stays live.
      if (isWatch || !fs.existsSync(webviewDir)) {
        if (!isWatch && !quiet) { console.warn('webview/ not built - main.js ships without an embedded bundle'); }
        return { contents: 'export const buildId = null;\nexport const payload = null;\n', loader: 'ts' };
      }

      const files = collectWebviewFiles(webviewDir);
      const index = JSON.stringify(files.map(([relative, contents]) => [relative, contents.length]));
      const blob = Buffer.concat([Buffer.from(index + '\n', 'utf8'), ...files.map(([, contents]) => contents)]);
      const payload = zlib.gzipSync(blob, { level: 9 }).toString('base64');
      const buildId = crypto.createHash('sha256').update(blob).digest('hex').slice(0, 16);

      // Stamp the built folder too, so a zip install skips the unpack entirely.
      fs.writeFileSync(path.join(webviewDir, STAMP), buildId);
      if (!quiet) {
        const mb = (n) => (n / 1024 / 1024).toFixed(1);
        console.log(`embedded webview: ${files.length} files, ${mb(blob.length)}mb -> ${mb(payload.length)}mb base64`);
      }

      return {
        contents: `export const buildId = ${JSON.stringify(buildId)};\nexport const payload = ${JSON.stringify(payload)};\n`,
        loader: 'ts'
      };
    });
  }
});
