import { FileSystemAdapter, Notice, Plugin, WorkspaceLeaf, debounce, normalizePath } from 'obsidian';
import * as nodePath from 'path';
import { pathToFileURL } from 'url';
import axios from 'axios';

import { setHost, Uri, dispatchUri, window as vscodeWindow, type InputBoxOptions, type QuickPickItem, type ExtensionContext } from './vscode-shim';
import { PromptModal, ConfirmModal, PickModal } from './modals';
import { BrunoView, SIDEBAR_VIEW_TYPE, EDITOR_VIEW_TYPE, type ViewMode } from './view';
import { registerShellHandlers, viewKey, type ViewData } from './shell';
import { initLog, disposeLog, logPath } from './log';
import { ensureWebviewAssets } from './webview-assets';

import { registerHandler, registerCoreHandlers, setMessageSender, setWebviewSender, emit, handleInvoke } from '../extension/ipc/handlers';
import { stateManager } from '../extension/webview/state-manager';
import { setSidebarWebviewGetter, notifyActiveItemToSidebar } from '../extension/ipc/collection';

import { setExtensionContext as setPreferencesContext } from '../extension/store/preferences';
import { setExtensionContext as setGlobalEnvContext } from '../extension/store/global-environments';
import { setExtensionContext as setLastCollectionsContext } from '../extension/store/last-opened-collections';
import { setExtensionContext as setLastWorkspacesContext } from '../extension/store/last-opened-workspaces';
import { setExtensionContext as setDefaultWorkspaceContext } from '../extension/store/default-workspace';
import { setExtensionContext as setEnvSecretsContext } from '../extension/store/env-secrets';
import { setExtensionContext as setCollectionSecurityContext } from '../extension/store/collection-security';
import { setExtensionContext as setUiStateContext } from '../extension/store/ui-state-snapshot';
import { setExtensionContext as setCookiesContext, cookiesStore } from '../extension/store/cookies';
import { setExtensionContext as setOAuth2Context } from '../extension/store/oauth2';

import registerPreferencesIpc from '../extension/ipc/preferences';
import registerCollectionIpc from '../extension/ipc/collection';
import registerFilesystemIpc from '../extension/ipc/filesystem';
import registerGlobalEnvironmentsIpc from '../extension/ipc/global-environments';
import registerNetworkIpc from '../extension/ipc/network/index';
import registerWorkspaceIpc from '../extension/ipc/workspace';

import collectionWatcher, { setMessageSender as setWatcherMessageSender } from '../extension/app/collection-watcher';
import { setMessageSender as setCollectionsMessageSender, setEventEmitter as setCollectionsEventEmitter } from '../extension/app/collections';
import { createOAuth2UriHandler } from '../extension/ipc/network/authorize-user-in-system-browser';

interface PersistedState { [key: string]: unknown; }

export default class BrunoPlugin extends Plugin {
  private state: PersistedState = {};
  private saveState = debounce((): void => { void this.saveData(this.state); }, 300, true);

  async onload(): Promise<void> {
    // QuickJS (via @usebruno/js) locates its .wasm relative to `import.meta.url`,
    // which the CJS bundle cannot know until the plugin folder is resolved.
    const pluginDir = this.pluginDir();
    const globals = globalThis as { __brunoMetaUrl?: string; __brunoPluginDir?: string };
    globals.__brunoMetaUrl = pathToFileURL(nodePath.join(pluginDir, 'main.js')).href;
    // @usebruno/js resolves modules a test script requires (chai, ajv, ...) from
    // here; `__dirname` is undefined inside Obsidian's plugin loader.
    globals.__brunoPluginDir = pluginDir;
    initLog(pluginDir, this.manifest.id);
    // A catalog install brings only main.js/manifest.json/styles.css, so the
    // webview bundle has to be unpacked out of main.js before any view opens.
    await ensureWebviewAssets(pluginDir);
    // The renderer has XMLHttpRequest, so axios would pick its XHR adapter and
    // every request would hit Chromium's CORS. Bruno's engine (stream responses,
    // agents, proxies, cookies) is written for Node's http adapter.
    axios.defaults.adapter = 'http';

    this.state = (await this.loadData()) ?? {};
    const storage = this.pluginRel('storage');
    if (!(await this.app.vault.adapter.exists(storage))) { await this.app.vault.adapter.mkdir(storage); }

    setHost({
      app: this.app,
      plugin: this,
      pluginDir: this.pluginDir(),
      prompt: (opts: InputBoxOptions) =>
        new Promise(resolve => new PromptModal(this.app, opts, resolve).open()),
      confirm: (message: string, actions: string[]) =>
        new Promise(resolve => new ConfirmModal(this.app, message, actions, resolve).open()),
      notice: (message: string) => { new Notice(message); },
      pickFromList: <T extends QuickPickItem>(items: T[], placeholder?: string, heading?: string) =>
        new Promise<T | undefined>(resolve => {
          new PickModal<T>(this.app, items, placeholder, resolve as (v: T | undefined) => void, heading).open();
        })
    });

    this.initializeStores();
    cookiesStore.initializeCookies();
    this.setupMessageBroadcaster();
    this.registerIpcHandlers();

    // OAuth2 authorization-code callbacks arrive as obsidian://bruno?...
    vscodeWindow.registerUriHandler(createOAuth2UriHandler());
    this.registerObsidianProtocolHandler('bruno', params => {
      const query = new URLSearchParams(params as Record<string, string>).toString();
      dispatchUri(Uri.parse(`obsidian://bruno?${query}`));
    });

    this.registerView(SIDEBAR_VIEW_TYPE, (leaf: WorkspaceLeaf) => new BrunoView(leaf, this, 'sidebar'));
    this.registerView(EDITOR_VIEW_TYPE, (leaf: WorkspaceLeaf) => new BrunoView(leaf, this, 'editor'));
    registerShellHandlers({
      openView: v => this.openView(v),
      closeView: w => this.closeView(w),
      pinView: w => this.editorViews().find(v => v.webview === w)?.setPreview(false),
      viewDataFor: w => this.editorViews().find(v => v.webview === w)?.viewData ?? undefined,
      closeViewsForCollection: (p, u) => this.closeViewsForCollection(p, u),
      markDirty: (webview, payload) => {
        const view = [...this.editorViews(), this.sidebarView()].find(v => v?.webview === webview);
        view?.setDirtyState(payload);
      },
      vault: { root: this.vaultRoot(), name: this.app.vault.getName(), configDir: this.app.vault.configDir }
    });
    setSidebarWebviewGetter(() => this.sidebarView()?.webview as never);
    this.registerEvent(this.app.workspace.on('active-leaf-change', leaf => {
      const view = leaf?.view;
      if (!(view instanceof BrunoView)) { return; }
      view.onResize();
      if (view.mode !== 'editor') { return; }
      stateManager.setActiveEditorWebview(view.webview as never);
      const v = view.viewData;
      notifyActiveItemToSidebar(v?.itemUid ?? v?.folderUid ?? v?.collectionUid ?? null);
    }));

    this.addRibbonIcon('send', 'Open Bruno', () => void this.activateSidebar());
    this.addCommand({ id: 'open', name: 'Open sidebar', callback: () => void this.activateSidebar() });
    this.addCommand({ id: 'refresh', name: 'Refresh collections', callback: () => void handleInvoke('sidebar:refresh-collections', []) });
    this.addCommand({ id: 'open-log', name: 'Show log file', callback: () => {
      (window as unknown as { require(id: string): { shell: { showItemInFolder(p: string): void } } }).require('electron').shell.showItemInFolder(logPath());
      new Notice(`Bruno log: ${logPath()}`);
    } });
    this.addCommand({ id: 'global-environments', name: 'Open global environments', callback: () => void this.openView({ viewType: 'global-environments' }) });
  }

  onunload(): void {
    // Flush debounced writes so a disable/reload never drops state or cookies.
    this.saveState.run();
    cookiesStore.saveCookieJar(true);
    stateManager.dispose();
    collectionWatcher.dispose();
    disposeLog();
  }

  // --- plugin paths --------------------------------------------------------

  private vaultRoot(): string {
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) { throw new Error('[bruno] desktop-only plugin'); }
    return adapter.getBasePath();
  }

  /** Vault-relative path inside the plugin folder, for the adapter API. */
  private pluginRel(...parts: string[]): string {
    return normalizePath([this.app.vault.configDir, 'plugins', this.manifest.id, ...parts].join('/'));
  }

  pluginDir(): string {
    return nodePath.join(this.vaultRoot(), this.pluginRel());
  }

  /**
   * Obsidian cancels every `app://` request whose frame origin is not
   * `app://obsidian.md`, so an iframe pointed at a plugin file can never load
   * its own scripts. A `srcdoc` iframe inherits the parent's origin and passes
   * that filter; a `<base>` tag then points relative asset URLs — including the
   * bundle's lazily loaded chunks — back at the plugin folder.
   */
  async webviewHtml(mode: ViewMode): Promise<string> {
    const relative = this.pluginRel('webview', 'index.html');
    const baseUrl = this.app.vault.adapter.getResourcePath(relative).split('?')[0].replace(/index\.html$/, '');
    const html = await this.app.vault.adapter.read(relative);
    const modeScript = mode === 'sidebar' ? `\n  <script>window.BRUNO_WEBVIEW_MODE = 'sidebar';</script>` : '';
    return html.replace('<head>', `<head>\n  <base href="${baseUrl}">${modeScript}`);
  }

  // --- vscode ExtensionContext stand-in -----------------------------------

  private extensionContext(): ExtensionContext {
    const memento = {
      get: <T,>(key: string, defaultValue?: T): T =>
        (this.state[key] as T) ?? (defaultValue as T),
      update: async (key: string, value: unknown): Promise<void> => {
        if (value === undefined) { delete this.state[key]; } else { this.state[key] = value; }
        this.saveState();
      },
      keys: () => Object.keys(this.state)
    };

    return {
      globalState: memento,
      workspaceState: memento,
      subscriptions: [],
      extensionUri: Uri.file(this.pluginDir()),
      extensionPath: this.pluginDir(),
      globalStorageUri: Uri.file(nodePath.join(this.pluginDir(), 'storage'))
    };
  }

  private initializeStores(): void {
    const context = this.extensionContext();
    for (const set of [
      setPreferencesContext, setGlobalEnvContext, setLastCollectionsContext,
      setLastWorkspacesContext, setDefaultWorkspaceContext, setEnvSecretsContext,
      setCollectionSecurityContext, setUiStateContext, setCookiesContext, setOAuth2Context
    ]) {
      (set as (c: unknown) => void)(context);
    }
  }

  private setupMessageBroadcaster(): void {
    const broadcast = (channel: string, ...args: unknown[]) => stateManager.broadcast(channel, ...args);
    setMessageSender(broadcast);
    setWebviewSender((webview, channel, ...args) => stateManager.sendTo(webview, channel, ...args));
    setWatcherMessageSender(broadcast);
    setCollectionsMessageSender(broadcast);
    setCollectionsEventEmitter((event: string, ...args: unknown[]) => emit(event, ...args));
  }

  private registerIpcHandlers(): void {
    registerCoreHandlers();
    registerPreferencesIpc();
    registerCollectionIpc(collectionWatcher);
    registerFilesystemIpc();
    registerGlobalEnvironmentsIpc();
    registerNetworkIpc();
    registerWorkspaceIpc({ addWatcher: () => {}, removeWatcher: () => {} });

    // VS Code owned the text buffer and needed a dirty-state protocol; Obsidian
    // does not open .bru files itself, so the React app is the only writer and
    // `renderer:set-dirty-state` is wired to the tabs in shell.ts.
    registerHandler('renderer:get-dirty-state', async () => false);
    registerHandler('renderer:sync-document', async () => undefined);
    registerHandler('renderer:write-file-vscode', async () => undefined);
    registerHandler('renderer:reveal-script-error-source', async () => undefined);
  }

  // --- views ---------------------------------------------------------------

  private editorViews(): BrunoView[] {
    return this.app.workspace.getLeavesOfType(EDITOR_VIEW_TYPE)
      .map(leaf => leaf.view)
      .filter((view): view is BrunoView => view instanceof BrunoView);
  }

  private sidebarView(): BrunoView | undefined {
    const view = this.app.workspace.getLeavesOfType(SIDEBAR_VIEW_TYPE)[0]?.view;
    return view instanceof BrunoView ? view : undefined;
  }

  private async activateSidebar(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(SIDEBAR_VIEW_TYPE)[0];
    const leaf = existing ?? this.app.workspace.getLeftLeaf(false);
    if (!leaf) { return; }
    if (!existing) { await leaf.setViewState({ type: SIDEBAR_VIEW_TYPE, active: true }); }
    await this.app.workspace.revealLeaf(leaf);
  }

  /** One editor leaf per ViewData, like one VS Code editor per file. */
  async openView(viewData: ViewData): Promise<void> {
    const key = viewKey(viewData);
    const views = this.editorViews();
    const existing = views.find(v => v.viewData && viewKey(v.viewData) === key);
    // Like VS Code's preview editor: a preview open replaces the current preview leaf instead of adding a tab.
    const previewLeaf = !existing && viewData.preview ? views.find(v => v.viewData?.preview)?.leaf : undefined;
    const leaf = existing?.leaf ?? previewLeaf ?? this.app.workspace.getLeaf('tab');
    if (existing) {
      if (!viewData.preview) { existing.setPreview(false); }
    } else {
      await leaf.setViewState({ type: EDITOR_VIEW_TYPE, active: true, state: { viewData } });
    }
    await this.app.workspace.revealLeaf(leaf);
  }

  closeView(webview: unknown): void {
    this.editorViews().find(v => v.webview === webview)?.leaf.detach();
  }

  /** A collection vanished from disk (git revert, delete): detach its editor tabs. */
  closeViewsForCollection(collectionPath: string, collectionUid: string): void {
    const root = nodePath.resolve(collectionPath);
    for (const view of this.editorViews()) {
      const data = view.viewData;
      if (!data) { continue; }
      const sameCollection = (!!data.collectionUid && data.collectionUid === collectionUid)
        || (!!data.collectionPath && nodePath.resolve(data.collectionPath) === root);
      if (sameCollection) { view.leaf.detach(); }
    }
  }
}
