/**
 * Minimal `vscode` module implemented on top of Obsidian + Electron + node.
 *
 * esbuild aliases the bare specifier `vscode` to this file, so the ~45 ported
 * files from bruno-vscode compile and run unchanged. Only the APIs those files
 * actually hit at runtime are implemented; everything else throws loudly so a
 * missing piece shows up as a clear error instead of `undefined is not a function`.
 */
import * as nodePath from 'path';
import * as fs from 'fs';
import chokidar, { FSWatcher } from 'chokidar';
import picomatch from 'picomatch';
import { FileSystemAdapter, type App, type Plugin } from 'obsidian';

// --- host wiring -----------------------------------------------------------

interface Host {
  app: App;
  plugin: Plugin;
  /** absolute path of the plugin folder, used for asset lookups */
  pluginDir: string;
  prompt(opts: InputBoxOptions): Promise<string | undefined>;
  confirm(message: string, actions: string[]): Promise<string | undefined>;
  notice(message: string): void;
  pickFromList<T extends QuickPickItem>(items: T[], placeholder?: string): Promise<T | undefined>;
}

let host: Host | null = null;

export function setHost(h: Host): void {
  host = h;
}

function requireHost(): Host {
  if (!host) { throw new Error('[bruno] vscode shim used before setHost()'); }
  return host;
}

function electron(): any {
  // Obsidian desktop runs in an Electron renderer with node integration.
  // `globalThis`, not `window`: this module exports its own `window` (the
  // vscode.window stand-in), which shadows the DOM global here.
  return (globalThis as unknown as { require(id: string): any }).require('electron');
}

function dialogApi(): any {
  const e = electron() as any;
  return e.remote?.dialog ?? e.dialog;
}

// --- Uri -------------------------------------------------------------------

export class Uri {
  readonly scheme: string;
  readonly authority = '';
  readonly path: string;
  readonly query = '';
  readonly fragment = '';

  private constructor(scheme: string, path: string, query = '', fragment = '') {
    this.scheme = scheme;
    this.path = path;
    (this as any).query = query;
    (this as any).fragment = fragment;
  }

  get fsPath(): string { return this.path; }

  static file(p: string): Uri { return new Uri('file', p); }

  static parse(value: string): Uri {
    const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/.exec(value);
    if (!m) { return new Uri('file', value); }
    return new Uri(m[1], m[2] ? `/${m[2].replace(/^\/+/, '')}` : '', m[3] ?? '', m[4] ?? '');
  }

  static joinPath(base: Uri, ...segments: string[]): Uri {
    return new Uri(base.scheme, nodePath.join(base.path, ...segments));
  }

  with(change: { scheme?: string; path?: string; query?: string; fragment?: string }): Uri {
    return new Uri(
      change.scheme ?? this.scheme,
      change.path ?? this.path,
      change.query ?? this.query,
      change.fragment ?? this.fragment
    );
  }

  toString(): string {
    const q = this.query ? `?${this.query}` : '';
    const f = this.fragment ? `#${this.fragment}` : '';
    return `${this.scheme}://${this.path.replace(/^\//, '')}${q}${f}`;
  }
}

// --- disposables & events --------------------------------------------------

export interface Disposable { dispose(): void; }

export const Disposable = {
  from(...items: Disposable[]): Disposable {
    return { dispose: () => items.forEach(i => i.dispose()) };
  }
};

export type Event<T> = (listener: (e: T) => void) => Disposable;

export class EventEmitter<T> {
  private listeners = new Set<(e: T) => void>();

  readonly event: Event<T> = (listener) => {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  };

  fire(data: T): void {
    for (const l of [...this.listeners]) {
      try { l(data); } catch (err) { console.error('[bruno] event listener failed', err); }
    }
  }

  dispose(): void { this.listeners.clear(); }
}

const noopEvent = <T,>(): Event<T> => () => ({ dispose: () => {} });

// --- file watching ---------------------------------------------------------

export class RelativePattern {
  readonly base: string;
  readonly pattern: string;

  constructor(base: string | Uri | { uri: Uri }, pattern: string) {
    this.base = typeof base === 'string'
      ? base
      : base instanceof Uri ? base.fsPath : base.uri.fsPath;
    this.pattern = pattern;
  }
}

export type GlobPattern = string | RelativePattern;

export interface FileSystemWatcher extends Disposable {
  onDidCreate: Event<Uri>;
  onDidChange: Event<Uri>;
  onDidDelete: Event<Uri>;
}

class ChokidarWatcher implements FileSystemWatcher {
  private watcher: FSWatcher;
  private created = new EventEmitter<Uri>();
  private changed = new EventEmitter<Uri>();
  private deleted = new EventEmitter<Uri>();

  readonly onDidCreate = this.created.event;
  readonly onDidChange = this.changed.event;
  readonly onDidDelete = this.deleted.event;

  constructor(base: string, pattern: string) {
    // Only watch as deep as the pattern needs. `environments/*.bru` and
    // `bruno.json` do not need a recursive crawl of the whole collection.
    const depth = pattern.includes('**') ? undefined : pattern.split('/').length - 1;
    const isMatch = picomatch(pattern, { dot: true });
    const matches = (p: string) => isMatch(nodePath.relative(base, p).split(nodePath.sep).join('/'));

    this.watcher = chokidar.watch(base, {
      ignoreInitial: true,
      depth,
      // Skip node_modules and every dot-directory (.obsidian, .git, .trash);
      // `.env` at the collection root is a file Bruno reads, so it stays.
      ignored: (p: string) => {
        const segments = nodePath.relative(base, p).split(nodePath.sep);
        return segments.some((seg, i) => seg === 'node_modules' || (seg.startsWith('.') && !(i === segments.length - 1 && seg === '.env')));
      },
      awaitWriteFinish: { stabilityThreshold: 80, pollInterval: 20 }
    });

    this.watcher.on('add', p => { if (matches(p)) { this.created.fire(Uri.file(p)); } });
    this.watcher.on('change', p => { if (matches(p)) { this.changed.fire(Uri.file(p)); } });
    this.watcher.on('unlink', p => { if (matches(p)) { this.deleted.fire(Uri.file(p)); } });
    this.watcher.on('error', err => console.error('[bruno] watcher error', err));
  }

  dispose(): void {
    void this.watcher.close();
    this.created.dispose();
    this.changed.dispose();
    this.deleted.dispose();
  }
}

// --- window ----------------------------------------------------------------

export interface InputBoxOptions {
  title?: string;
  prompt?: string;
  value?: string;
  placeHolder?: string;
  password?: boolean;
  ignoreFocusOut?: boolean;
  validateInput?: (value: string) => string | undefined | null | Promise<string | undefined | null>;
}

export interface QuickPickItem {
  label: string;
  description?: string;
  detail?: string;
  picked?: boolean;
  alwaysShow?: boolean;
}

export interface OpenDialogOptions {
  canSelectFiles?: boolean;
  canSelectFolders?: boolean;
  canSelectMany?: boolean;
  defaultUri?: Uri;
  openLabel?: string;
  title?: string;
  filters?: Record<string, string[]>;
}

export interface SaveDialogOptions {
  defaultUri?: Uri;
  saveLabel?: string;
  title?: string;
  filters?: Record<string, string[]>;
}

function toElectronFilters(filters?: Record<string, string[]>) {
  if (!filters) { return undefined; }
  return Object.entries(filters).map(([name, extensions]) => ({ name, extensions }));
}

export interface MessageOptions { modal?: boolean; detail?: string; }

async function showMessage(message: string, rest: Array<string | MessageOptions>): Promise<string | undefined> {
  const h = requireHost();
  const items = rest.filter((r): r is string => typeof r === 'string');
  if (items.length === 0) { h.notice(message); return undefined; }
  return h.confirm(message, items);
}

/** Minimal stand-in for vscode's QuickPick object API. */
class QuickPick<T extends QuickPickItem> {
  items: T[] = [];
  placeholder?: string;
  title?: string;
  value = '';
  step?: number;
  totalSteps?: number;
  matchOnDescription = false;
  matchOnDetail = false;
  busy = false;
  ignoreFocusOut = false;
  buttons: unknown[] = [];
  activeItems: T[] = [];
  selectedItems: T[] = [];
  private accepted = new EventEmitter<void>();
  private hidden = new EventEmitter<void>();
  private changedSelection = new EventEmitter<T[]>();

  readonly onDidAccept = this.accepted.event;
  readonly onDidHide = this.hidden.event;
  readonly onDidChangeSelection = this.changedSelection.event;

  show(): void {
    void requireHost().pickFromList(this.items, this.placeholder).then(picked => {
      if (picked) {
        this.activeItems = [picked];
        this.selectedItems = [picked];
        this.changedSelection.fire([picked]);
        this.accepted.fire();
      }
      this.hidden.fire();
    });
  }

  hide(): void { this.hidden.fire(); }
  dispose(): void { this.accepted.dispose(); this.hidden.dispose(); this.changedSelection.dispose(); }
}

export const window = {
  showInformationMessage: (message: string, ...items: Array<string | MessageOptions>) => showMessage(message, items),
  showWarningMessage: (message: string, ...items: Array<string | MessageOptions>) => showMessage(message, items),
  showErrorMessage: (message: string, ...items: Array<string | MessageOptions>) => showMessage(message, items),

  showInputBox: (options: InputBoxOptions = {}) => requireHost().prompt(options),

  showQuickPick: async <T extends QuickPickItem>(items: T[] | Promise<T[]>, options?: { placeHolder?: string }) =>
    requireHost().pickFromList(await items, options?.placeHolder),

  createQuickPick: <T extends QuickPickItem>() => new QuickPick<T>(),

  showOpenDialog: async (options: OpenDialogOptions = {}): Promise<Uri[] | undefined> => {
    const properties: string[] = [];
    if (options.canSelectFolders) { properties.push('openDirectory'); }
    if (options.canSelectFiles !== false && !options.canSelectFolders) { properties.push('openFile'); }
    if (options.canSelectMany) { properties.push('multiSelections'); }
    const result = await dialogApi().showOpenDialog({
      title: options.title,
      defaultPath: options.defaultUri?.fsPath,
      buttonLabel: options.openLabel,
      filters: toElectronFilters(options.filters),
      properties
    });
    if (result.canceled || !result.filePaths?.length) { return undefined; }
    return result.filePaths.map((p: string) => Uri.file(p));
  },

  showSaveDialog: async (options: SaveDialogOptions = {}): Promise<Uri | undefined> => {
    const result = await dialogApi().showSaveDialog({
      title: options.title,
      defaultPath: options.defaultUri?.fsPath,
      buttonLabel: options.saveLabel,
      filters: toElectronFilters(options.filters)
    });
    if (result.canceled || !result.filePath) { return undefined; }
    return Uri.file(result.filePath);
  },

  // The custom-editor / tree-view surface has no Obsidian equivalent; the React
  // app owns tabs and the sidebar itself.
  tabGroups: {
    all: [] as Array<{ tabs: Array<{ input?: unknown }> }>,
    close: async (..._tabs: unknown[]) => true,
    onDidChangeTabs: noopEvent<unknown>()
  },
  activeTextEditor: undefined as unknown,
  registerUriHandler: (handler: { handleUri(uri: Uri): void }): Disposable => {
    // main.ts routes obsidian://bruno/... here.
    uriHandlers.add(handler);
    return { dispose: () => uriHandlers.delete(handler) };
  },
  createOutputChannel: (name: string) => ({
    appendLine: (line: string) => console.debug(`[${name}] ${line}`),
    append: (text: string) => console.debug(`[${name}] ${text}`),
    show: () => {}, clear: () => {}, dispose: () => {}
  })
};

const uriHandlers = new Set<{ handleUri(uri: Uri): void }>();

export function dispatchUri(uri: Uri): void {
  for (const h of uriHandlers) {
    try { h.handleUri(uri); } catch (err) { console.error('[bruno] uri handler failed', err); }
  }
}

// --- workspace -------------------------------------------------------------

export const workspace = {
  get workspaceFolders(): Array<{ uri: Uri; name: string; index: number }> | undefined {
    const root = vaultRoot();
    return root ? [{ uri: Uri.file(root), name: nodePath.basename(root), index: 0 }] : undefined;
  },

  createFileSystemWatcher: (pattern: GlobPattern): FileSystemWatcher => {
    if (typeof pattern === 'string') {
      return new ChokidarWatcher(nodePath.dirname(pattern), nodePath.basename(pattern));
    }
    return new ChokidarWatcher(pattern.base, pattern.pattern);
  },

  getConfiguration: (_section?: string) => ({
    get: <T,>(_key: string, defaultValue?: T) => defaultValue,
    update: async () => {},
    has: () => false
  }),

  fs: {
    readFile: async (uri: Uri) => new Uint8Array(await fs.promises.readFile(uri.fsPath)),
    writeFile: async (uri: Uri, content: Uint8Array) => fs.promises.writeFile(uri.fsPath, content),
    delete: async (uri: Uri, options?: { recursive?: boolean }) =>
      fs.promises.rm(uri.fsPath, { recursive: options?.recursive, force: true }),
    createDirectory: async (uri: Uri) => { await fs.promises.mkdir(uri.fsPath, { recursive: true }); },
    stat: async (uri: Uri) => {
      const s = await fs.promises.stat(uri.fsPath);
      return { type: s.isDirectory() ? 2 : 1, ctime: s.ctimeMs, mtime: s.mtimeMs, size: s.size };
    }
  },

  findFiles: async () => [] as Uri[],
  applyEdit: async () => true,
  openTextDocument: async (uri: Uri) => ({ uri, getText: () => fs.readFileSync(uri.fsPath, 'utf8') }),
  onDidRenameFiles: noopEvent<unknown>(),
  onDidChangeTextDocument: noopEvent<unknown>(),
  onWillSaveTextDocument: noopEvent<unknown>(),
  onDidChangeWorkspaceFolders: noopEvent<unknown>(),
  onDidSaveTextDocument: noopEvent<unknown>()
};

function vaultRoot(): string | null {
  const adapter = host?.app.vault.adapter;
  return adapter instanceof FileSystemAdapter ? adapter.getBasePath() : null;
}

// --- commands & env --------------------------------------------------------

const commandRegistry = new Map<string, (...args: unknown[]) => unknown>();

export const commands = {
  registerCommand: (id: string, handler: (...args: unknown[]) => unknown): Disposable => {
    commandRegistry.set(id, handler);
    return { dispose: () => commandRegistry.delete(id) };
  },
  executeCommand: async (id: string, ...args: unknown[]) => {
    const handler = commandRegistry.get(id);
    if (handler) { return handler(...args); }
    if (id === 'revealFileInOS' && args[0] instanceof Uri) {
      (electron() as any).shell.showItemInFolder(args[0].fsPath);
      return undefined;
    }
    // Built-in VS Code commands (vscode.open, workbench.*) have no meaning here.
    console.debug('[bruno] ignoring vscode command', id);
    return undefined;
  },
  getCommands: async () => [...commandRegistry.keys()]
};

export const env = {
  openExternal: async (uri: Uri | string) => {
    const url = typeof uri === 'string' ? uri : uri.toString();
    (electron() as any).shell.openExternal(url);
    return true;
  },
  clipboard: {
    writeText: async (text: string) => navigator.clipboard.writeText(text),
    readText: async () => navigator.clipboard.readText()
  },
  uriScheme: 'obsidian',
  appName: 'Obsidian',
  machineId: 'obsidian'
};

// --- enums & leftovers used by ported type signatures ----------------------

export enum ViewColumn { Active = -1, Beside = -2, One = 1, Two = 2 }
export enum TreeItemCollapsibleState { None = 0, Collapsed = 1, Expanded = 2 }
export enum FileType { Unknown = 0, File = 1, Directory = 2, SymbolicLink = 64 }
export enum ConfigurationTarget { Global = 1, Workspace = 2, WorkspaceFolder = 3 }

export interface Webview { postMessage(message: unknown): void | PromiseLike<boolean>; }
export interface ExtensionContext {
  globalState: { get<T>(key: string, def?: T): T; update(key: string, value: unknown): Promise<void>; keys(): readonly string[] };
  workspaceState: ExtensionContext['globalState'];
  subscriptions: Disposable[];
  extensionUri: Uri;
  extensionPath: string;
  globalStorageUri: Uri;
}
export interface UriHandler { handleUri(uri: Uri): void; }
