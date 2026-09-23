/**
 * End-to-end check that the request pipeline ported from bruno-vscode still
 * runs outside VS Code: boot the network IPC handlers, fire a real HTTP
 * request at a throwaway server, and assert the response comes back with the
 * pre-request script's variable interpolated into the URL.
 *
 * Run: npm run test:smoke
 */
import assert from 'assert';
import http from 'http';
import os from 'os';
import fs from 'fs';
import path from 'path';

import { handleInvoke, setMessageSender, emit, setCurrentWebview, clearCurrentWebview } from '../src/extension/ipc/handlers';
import registerNetworkIpc from '../src/extension/ipc/network/index';
import registerCollectionIpc from '../src/extension/ipc/collection';
import { setExtensionContext as setPreferencesContext } from '../src/extension/store/preferences';
import { setExtensionContext as setCookiesContext, cookiesStore } from '../src/extension/store/cookies';
import { setExtensionContext as setOAuth2Context } from '../src/extension/store/oauth2';
import { setExtensionContext as setCollectionSecurityContext } from '../src/extension/store/collection-security';
import { setExtensionContext as setLastCollectionsContext } from '../src/extension/store/last-opened-collections';
import { setMessageSender as setCollectionsMessageSender } from '../src/extension/app/collections';
import collectionWatcher from '../src/extension/app/collection-watcher';
import { Uri, RelativePattern, workspace, window as vscodeWindow } from '../src/obsidian/vscode-shim';
import { registerShellHandlers, viewDataForFile, viewKey, initCollection, seedRuntimeVariables, type ViewData } from '../src/obsidian/shell';
import { BrunoView } from '../src/obsidian/view';
import { generateUidBasedOnHash } from '../src/extension/utils/common';

const memory: Record<string, unknown> = {};
const memento = {
  get: <T,>(key: string, def?: T): T => (memory[key] as T) ?? (def as T),
  update: async (key: string, value: unknown) => { memory[key] = value; },
  keys: () => Object.keys(memory)
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bruno-smoke-'));
const context = {
  globalState: memento,
  workspaceState: memento,
  subscriptions: [],
  extensionUri: Uri.file(tmp),
  extensionPath: tmp,
  globalStorageUri: Uri.file(tmp)
};

async function testUriShim(): Promise<void> {
  assert.strictEqual(Uri.file('/a/b/c.bru').fsPath, '/a/b/c.bru');
  assert.strictEqual(Uri.joinPath(Uri.file('/a'), 'b', 'c').fsPath, '/a/b/c');
  const parsed = Uri.parse('obsidian://bruno?code=xyz&state=1');
  assert.strictEqual(parsed.scheme, 'obsidian');
  assert.strictEqual(new URLSearchParams(parsed.query).get('code'), 'xyz');
  console.log('  ok  Uri shim');
}

/** The shim reaches Electron through the renderer's global `require`. */
async function testElectronDialogShim(): Promise<void> {
  const fakeElectron = {
    dialog: { showSaveDialog: async () => ({ canceled: false, filePath: '/tmp/export.json' }) }
  };
  (globalThis as unknown as { require: (id: string) => unknown }).require = (id: string) =>
    id === 'electron' ? fakeElectron : require(id);
  const target = await vscodeWindow.showSaveDialog({ defaultUri: Uri.file('/tmp/collection.json') });
  assert.strictEqual(target?.fsPath, '/tmp/export.json', 'showSaveDialog did not go through electron.dialog');
  console.log('  ok  electron dialog shim');
}

async function testWatcherShim(): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bruno-watch-'));
  const watcher = workspace.createFileSystemWatcher(new RelativePattern(dir, '**/*.bru'));

  const seen = new Promise<string>((resolve, reject) => {
    watcher.onDidCreate(uri => resolve(uri.fsPath));
    setTimeout(() => reject(new Error('watcher never fired for **/*.bru')), 5000);
  });

  // chokidar needs a beat to finish its initial crawl before writes register.
  await new Promise(r => setTimeout(r, 300));
  fs.writeFileSync(path.join(dir, 'ignored.txt'), 'no');
  fs.mkdirSync(path.join(dir, 'nested'));
  fs.writeFileSync(path.join(dir, 'nested', 'req.bru'), 'meta { name: req }');

  assert.strictEqual(path.basename(await seen), 'req.bru', 'watcher matched the wrong file');
  watcher.dispose();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('  ok  file-system watcher shim');
}

async function testHttpRequest(): Promise<void> {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      url: req.url,
      method: req.method,
      token: req.headers['x-token'],
      scripted: req.headers['x-scripted'],
      access_token: 'fresh-token'
    }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };

  const collectionPath = fs.mkdtempSync(path.join(os.tmpdir(), 'bruno-collection-'));
  fs.writeFileSync(path.join(collectionPath, 'bruno.json'), JSON.stringify({ version: '1', name: 'smoke', type: 'collection' }));

  const item = {
    uid: 'item-1',
    name: 'smoke',
    type: 'http-request',
    pathname: path.join(collectionPath, 'smoke.bru'),
    request: {
      method: 'GET',
      url: '{{baseUrl}}/hello',
      headers: [
        { uid: 'h1', name: 'x-token', value: 'abc', enabled: true },
        { uid: 'h2', name: 'x-scripted', value: '{{injected}}', enabled: true }
      ],
      params: [],
      body: { mode: 'none' },
      auth: { mode: 'none' },
      // Forces the QuickJS sandbox to actually boot and run: the single-file
      // variant must be bundled, because nothing can fetch a .wasm here.
      script: {
        req: "bru.setVar('injected', 'from-script');",
        res: "bru.setVar('access_token', res.getBody().access_token);"
      },
      vars: {},
      assertions: [],
      tests: ''
    }
  };

  const collection = {
    uid: 'collection-1',
    name: 'smoke',
    pathname: collectionPath,
    brunoConfig: { version: '1', name: 'smoke', type: 'collection' },
    root: { request: { headers: [], auth: { mode: 'none' }, script: {}, vars: {}, tests: '' } },
    items: [item],
    environments: [],
    runtimeVariables: {}
  };

  const environment = {
    uid: 'env-1',
    name: 'local',
    variables: [{ uid: 'v1', name: 'baseUrl', value: `http://127.0.0.1:${port}`, enabled: true, secret: false, type: 'text' }]
  };

  const broadcasts: Array<{ channel: string; args: unknown[] }> = [];
  setMessageSender((channel, ...args) => { broadcasts.push({ channel, args }); });
  const response = await handleInvoke('send-http-request', [item, collection, environment, {}]) as {
    status: number; data: unknown;
  };

  server.close();
  fs.rmSync(collectionPath, { recursive: true, force: true });

  assert.strictEqual(response.status, 200, `expected 200, got ${response.status}`);
  const body = typeof response.data === 'string' ? JSON.parse(response.data) : response.data as Record<string, string>;
  assert.strictEqual(body.url, '/hello', 'environment variable was not interpolated into the URL');
  assert.strictEqual(body.token, 'abc', 'request header was not sent');
  assert.strictEqual(body.scripted, 'from-script', 'pre-request script did not run in the QuickJS sandbox');
  console.log('  ok  http request round-trip');
  console.log('  ok  pre-request script ran in QuickJS (embedded wasm)');

  // pre-request and post-response each publish; the last one carries both.
  const updates = broadcasts.filter(b => b.channel === 'main:script-environment-update');
  const update = updates[updates.length - 1];
  assert.ok(update, 'post-response script result was not broadcast to all webviews');
  const { runtimeVariables } = update.args[0] as { runtimeVariables: Record<string, string> };
  assert.strictEqual(runtimeVariables.access_token, 'fresh-token', `post-response script did not read the JSON body; updates: ${JSON.stringify(updates.map(u => u.args[0]))}`);
  console.log('  ok  post-response script published runtime variables to every webview');

  // A leaf opened after the script ran must still see the variables.
  const seeded: unknown[] = [];
  seedRuntimeVariables('collection-1', (channel, payload) => { seeded.push({ channel, payload }); });
  assert.deepStrictEqual(seeded, [{
    channel: 'main:script-environment-update',
    payload: { collectionUid: 'collection-1', runtimeVariables }
  }], 'late webview was not seeded with runtime variables');
  console.log('  ok  late-opened webview is seeded with runtime variables');
}

/** The Obsidian shell maps sidebar clicks (file paths) onto editor leaves. */
async function testShellRouting(): Promise<void> {
  const root = path.join(tmp, 'collection');
  const folder = path.join(root, 'folder');
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(root, 'bruno.json'), JSON.stringify({ version: '1', name: 'c', type: 'collection' }));
  fs.writeFileSync(path.join(root, 'collection.bru'), 'meta {\n  name: c\n}\n');
  fs.writeFileSync(path.join(folder, 'folder.bru'), 'meta {\n  name: folder\n}\n');
  const request = path.join(folder, 'req.bru');
  fs.writeFileSync(request, 'meta {\n  name: req\n  type: http\n}\n');

  assert.deepStrictEqual(viewDataForFile(request), {
    viewType: 'request', collectionUid: generateUidBasedOnHash(root), collectionPath: root,
    itemUid: generateUidBasedOnHash(request), itemPath: request
  });
  assert.strictEqual(viewDataForFile(path.join(root, 'collection.bru'))?.viewType, 'collection-settings');
  assert.strictEqual(viewDataForFile(path.join(folder, 'folder.bru'))?.viewType, 'folder-settings');
  assert.strictEqual(viewDataForFile(path.join(tmp, 'stray.bru')), null, 'file outside any collection');

  const opened: ViewData[] = [];
  registerShellHandlers({ openView: async v => { opened.push(v); }, closeView: () => {}, vault: { root: tmp, name: 'vault', configDir: '.obsidian' } });
  await handleInvoke('sidebar:open-request', [request]);
  await handleInvoke('sidebar:open-collection-settings', [{ collectionPath: folder }]);
  await handleInvoke('sidebar:open-request', [path.join(tmp, 'stray.bru')]);
  await handleInvoke('sidebar:open-request', ['relative/req.bru']);
  assert.strictEqual(opened.length, 2, 'unresolvable paths must not open a view');
  assert.strictEqual(opened[0].viewType, 'request');
  assert.strictEqual(opened[1].collectionPath, root, 'settings resolve a subfolder to the collection root');
  assert.strictEqual(viewKey(opened[0]), viewKey(viewDataForFile(request)!), 'same file → same leaf');
  assert.notStrictEqual(viewKey(opened[0]), viewKey(opened[1]));
  console.log('ok  shell routes sidebar channels to editor views');

  const vault = path.join(tmp, 'vault');
  fs.mkdirSync(vault);
  assert.strictEqual(await initCollection(vault, 'My Vault', ['.obsidian']), true);
  const config = JSON.parse(fs.readFileSync(path.join(vault, 'bruno.json'), 'utf8'));
  assert.strictEqual(config.name, 'My Vault');
  assert.ok(config.ignore.includes('.obsidian'), `unexpected bruno.json ignore: ${config.ignore}`);
  assert.strictEqual(viewDataForFile(path.join(vault, 'x.bru'))?.collectionPath, vault, 'vault is now a collection root');
  assert.strictEqual(await initCollection(vault, 'My Vault', []), false, 'init is idempotent');
  console.log('ok  init collection in vault root');
}

/**
 * A git checkout that deletes bruno.json drops the vault's watchers; when the
 * config comes back, both recovery paths must reopen it.
 */
async function testRefreshRecoversTheVault(): Promise<void> {
  const vault = path.join(tmp, 'git-vault');
  fs.mkdirSync(vault, { recursive: true });
  fs.writeFileSync(path.join(vault, 'bruno.json'), JSON.stringify({ version: '1', name: 'git-vault', type: 'collection' }));

  const events: Array<{ channel: string; args: unknown[] }> = [];
  setCollectionsMessageSender((channel, ...args) => { events.push({ channel, args }); });
  registerShellHandlers({
    openView: async () => {}, closeView: () => {}, pinView: () => {},
    viewDataFor: () => undefined, closeViewsForCollection: () => {},
    vault: { root: vault, name: 'git-vault', configDir: '.obsidian' }
  });

  // Nothing is watched anymore (the "collection gone" handling ran); refresh
  // must still reopen the vault that is a collection on disk again.
  assert.strictEqual(collectionWatcher.getWatchedCollectionPaths().length, 0);
  await handleInvoke('sidebar:refresh-collections', []);
  const opened = events.find(e => e.channel === 'main:collection-opened');
  assert.ok(opened, 'refresh must reopen a collection that vanished from the watch list');
  assert.strictEqual(path.resolve(opened!.args[0] as string), path.resolve(vault));
  assert.ok(collectionWatcher.hasWatcher(path.resolve(vault)), 'refresh must re-attach the watchers');
  console.log('ok  refresh recovers a collection gone from the watch list');

  collectionWatcher.removeWatcher(path.resolve(vault), generateUidBasedOnHash(vault));
}

/**
 * renderer:ready on a sidebar remount only replays *watched* collections; when
 * the watch list is empty (the vault "went away" before the plugin reload),
 * the last-opened restore must run instead of silently doing nothing.
 */
async function testRendererReadyRestoresVanishedCollection(): Promise<void> {
  const root = path.join(tmp, 'restored');
  fs.mkdirSync(root, { recursive: true });

  registerCollectionIpc(collectionWatcher);
  const channels: string[] = [];
  setCollectionsMessageSender(channel => { channels.push(channel); });

  // A config-less vault can only yield nothing on the first pass.
  memory['lastOpenedCollections'] = [root];
  emit('main:renderer-ready');
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(!channels.includes('main:collection-opened'), 'a vault without bruno.json must not open');

  // git checkout restores bruno.json while the app keeps running; the next
  // renderer-ready must reopen from lastOpenedCollections.
  fs.writeFileSync(path.join(root, 'bruno.json'), JSON.stringify({ version: '1', name: 'restored', type: 'collection' }));
  emit('main:renderer-ready');
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(channels.includes('main:collection-opened'),
    'renderer-ready must reopen last-opened collections when nothing is watched');
  console.log('ok  renderer-ready restores a collection that came back on disk');
}

/**
 * The renderer's dirty-state middleware reports every draft creation and save
 * through `renderer:set-dirty-state`; the tab of the webview that sent it must
 * pick up (and lose) the unsaved-changes marker.
 */
async function testDirtyTabIndicator(): Promise<void> {
  const marked: boolean[] = [];
  const header = { toggleClass: (cls: string, on: boolean) => { if (cls === 'bruno-dirty') { marked.push(on); } } };
  const view = new BrunoView({ tabHeaderEl: header } as never, undefined as never, 'editor');
  registerShellHandlers({
    openView: async () => {}, closeView: () => {}, pinView: () => {},
    viewDataFor: () => undefined, closeViewsForCollection: () => {},
    markDirty: (webview, payload) => { if (webview === view.webview) { view.setDirtyState(payload); } },
    vault: { root: tmp, name: 'vault', configDir: '.obsidian' }
  });

  const file = path.join(tmp, 'a.bru');
  setCurrentWebview(view.webview as never);
  try {
    await handleInvoke('renderer:set-dirty-state', [{ filePath: file, isDirty: true }]);
    assert.ok(marked[marked.length - 1], 'an unsaved draft must mark the tab');
    // Two drafts on one tab: saving only one keeps the marker on.
    await handleInvoke('renderer:set-dirty-state', [{ filePath: path.join(tmp, 'b.bru'), isDirty: true }]);
    await handleInvoke('renderer:set-dirty-state', [{ filePath: file, isDirty: false }]);
    assert.ok(marked[marked.length - 1], 'a second unsaved draft must keep the marker');
    await handleInvoke('renderer:set-dirty-state', [{ filePath: path.join(tmp, 'b.bru'), isDirty: false }]);
    assert.ok(!marked[marked.length - 1], 'saving every draft must clear the marker');

    // A transient "Untitled" request has no file to save to: always dirty.
    view.viewData = { viewType: 'request', collectionUid: 'c', collectionPath: tmp, itemUid: 'u', transient: true };
    await handleInvoke('renderer:set-dirty-state', [{ filePath: file, isDirty: true }]);
    await handleInvoke('renderer:set-dirty-state', [{ filePath: file, isDirty: false }]);
    assert.ok(marked[marked.length - 1], 'a transient request must keep the marker');
  } finally {
    clearCurrentWebview();
  }
  console.log('ok  unsaved drafts mark their tab');
}

async function main(): Promise<void> {
  setPreferencesContext(context as never);
  setCookiesContext(context as never);
  setOAuth2Context(context as never);
  setCollectionSecurityContext(context as never);
  setLastCollectionsContext(context as never);
  cookiesStore.initializeCookies();
  setMessageSender(() => {});
  registerNetworkIpc();

  await testUriShim();
  await testElectronDialogShim();
  await testWatcherShim();
  await testHttpRequest();
  await testShellRouting();
  await testRefreshRecoversTheVault();
  await testRendererReadyRestoresVanishedCollection();
  await testDirtyTabIndicator();
  console.log('smoke: all checks passed');
}

main().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
