/**
 * Guards the failure mode that actually bit us: main.js loading fine under
 * esbuild but throwing at `require` time inside Obsidian's renderer, where only
 * Node builtins and `obsidian`/`electron` are resolvable (`punycode/` was not).
 *
 * Run: npm run test:load
 */
const assert = require('assert');
const path = require('path');
const Module = require('module');

const resolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'obsidian') { return 'obsidian-stub'; }
  if (request === 'electron') { return 'electron-stub'; }
  return resolve.call(this, request, ...rest);
};

class Stub {}
const stub = (exports) => ({ id: 'stub', filename: 'stub', loaded: true, exports });
require.cache['obsidian-stub'] = stub({
  Plugin: Stub, ItemView: Stub, Modal: Stub, SuggestModal: Stub,
  Setting: Stub, Notice: Stub, TFile: Stub, WorkspaceLeaf: Stub, addIcon() {}
});
require.cache['electron-stub'] = stub({ shell: {}, remote: { dialog: {} } });

// Obsidian runs plugins in an Electron renderer, so browser globals exist.
global.window = {
  require,
  addEventListener() {}, setTimeout, clearTimeout, open() {},
  location: { href: 'app://obsidian.md/index.html', origin: 'app://obsidian.md', protocol: 'app:' }
};
global.location = global.window.location;
global.self = global.window;
global.navigator = { clipboard: {}, userAgent: 'obsidian', product: 'Gecko' };
global.document = { body: { classList: { contains: () => false } }, createElement: () => ({ style: {} }) };

const plugin = require(path.join(__dirname, '..', 'main.js'));
assert.strictEqual(typeof plugin.default, 'function', 'main.js must default-export the plugin class');
console.log('  ok  main.js loads in a renderer-like context');
console.log('load: all checks passed');
