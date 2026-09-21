/**
 * bruno-vscode spread the app over a sidebar webview, custom editors and
 * panels; VS Code's shell wired them together with commands. Obsidian gets the
 * same pieces as leaves — one sidebar view, one editor view per `ViewData` —
 * and this module is that wiring: the `sidebar:*` channels the React app sends,
 * and the per-webview collection streaming every editor needs (each webview
 * owns its own Redux store). Bodies are ported from SidebarViewProvider,
 * BrunoEditorProvider and the panels.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { registerHandler, getCurrentWebview } from '../extension/ipc/handlers';
import { stateManager } from '../extension/webview/state-manager';
import collectionWatcher, {
  isCollectionRootFile,
  isFolderRootFile,
  setMessageSender as setWatcherMessageSender
} from '../extension/app/collection-watcher';
import {
  openCollection,
  openCollectionForSingleRequest,
  loadCollectionMetadata,
  setMessageSender as setCollectionsMessageSender
} from '../extension/app/collections';
import { defaultWorkspaceManager } from '../extension/store/default-workspace';
import { findCollectionRoot, resolveCollectionRoot, isCollectionRoot } from '../extension/utils/path';
import { generateUidBasedOnHash } from '../extension/utils/common';
import { showSaveRequestPicker } from '../extension/utils/folder-picker';
import { getRuntimeVariables } from '../extension/utils/script-runner';
import { log } from './log';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { stringifyRequest } = require('@usebruno/filestore') as {
  stringifyRequest: (item: unknown, opts: { format: string }) => string | Promise<string>;
};

export type ViewType =
  | 'request' | 'collection-settings' | 'folder-settings' | 'collection-runner'
  | 'global-environments' | 'environment-settings' | 'variables'
  | 'create-collection' | 'new-request' | 'export-collection' | 'clone-collection' | 'import-collection';

/** What the webview's ViewContainer renders; same shape as src/webview/views/types.ts. */
export interface ViewData {
  viewType: ViewType;
  collectionUid?: string;
  collectionPath?: string;
  itemUid?: string | null;
  itemPath?: string | null;
  folderUid?: string;
  /** Unsaved "Untitled" request living only in memory (see transientItems). */
  transient?: boolean;
  itemName?: string;
  /** VS Code-style preview editor: italic title, replaced by the next preview open. */
  preview?: boolean;
}

export interface ShellHost {
  openView(viewData: ViewData): Promise<void>;
  closeView(webview: vscode.Webview): void;
  /** Turn a preview view into a permanent one. */
  pinView(webview: vscode.Webview): void;
  viewDataFor(webview: vscode.Webview): ViewData | undefined;
  /** The vault is the one and only collection in Obsidian. */
  vault: { root: string; name: string; configDir: string };
}

// Transient requests exist only in the sidebar's Redux store and here, until
// saved (mirrors transient-request-panel.ts, minus the 10s undo grace).
const transientItems = new Map<string, Record<string, unknown>>();
export const hasTransientItem = (itemUid: string): boolean => transientItems.has(itemUid);

export function closeTransient(viewData: ViewData): void {
  if (!viewData.transient || !viewData.itemUid) { return; }
  transientItems.delete(viewData.itemUid);
  stateManager.broadcast('main:transient-request-closed', { collectionUid: viewData.collectionUid, itemUid: viewData.itemUid });
}

/** Make `root` a Bruno collection if it is not one yet; returns true when created. */
export async function initCollection(root: string, name: string, ignore: string[]): Promise<boolean> {
  if (isCollectionRoot(root)) { return false; }
  // bru format: the user's own request files are .bru, and an opencollection.yml
  // next to a bruno.json would win and make Bruno ignore every .bru file.
  const brunoConfig = { version: '1', name, type: 'collection', ignore: ['node_modules', '.git', ...ignore] };
  await fs.promises.writeFile(path.join(root, 'bruno.json'), JSON.stringify(brunoConfig, null, 2) + '\n');
  return true;
}

type Sender = (channel: string, ...args: unknown[]) => void;

/** Hand a freshly loaded webview the runtime variables scripts set before it existed. */
export function seedRuntimeVariables(collectionUid: string, sender: Sender): void {
  const runtimeVariables = getRuntimeVariables(collectionUid);
  if (runtimeVariables) { sender('main:script-environment-update', { collectionUid, runtimeVariables }); }
}

export function viewKey(v: ViewData): string {
  return [v.viewType, v.collectionPath ?? '', v.itemPath ?? v.itemUid ?? v.folderUid ?? ''].join('|');
}

export function viewTitle(v: ViewData | null): string {
  if (!v) { return 'Bruno'; }
  const collection = v.collectionPath ? path.basename(v.collectionPath) : '';
  if (v.viewType === 'request' && v.itemPath) { return path.basename(v.itemPath).replace(/\.(bru|yml)$/, ''); }
  const label = v.viewType.replace(/-/g, ' ');
  return collection ? `${collection}: ${label}` : `Bruno: ${label}`;
}

/** Which view a file inside a collection stands for (mirrors BrunoEditorProvider). */
export function viewDataForFile(filePath: string): ViewData | null {
  const root = findCollectionRoot(filePath);
  if (!root) { return null; }
  const collectionUid = generateUidBasedOnHash(root);
  if (isCollectionRootFile(filePath, root)) {
    return { viewType: 'collection-settings', collectionUid, collectionPath: root };
  }
  if (isFolderRootFile(filePath, root)) {
    return { viewType: 'folder-settings', collectionUid, collectionPath: root, folderUid: generateUidBasedOnHash(path.dirname(filePath)) };
  }
  return { viewType: 'request', collectionUid, collectionPath: root, itemUid: generateUidBasedOnHash(filePath), itemPath: filePath };
}

/**
 * Stream the collection a view needs into that view's webview only. Requests
 * take the single-file fast path; everything else gets metadata first (so the
 * UI appears) and then the tree and environments.
 */
export async function loadCollectionInto(viewData: ViewData, sender: Sender): Promise<void> {
  const root = viewData.collectionPath;
  if (!root) { return; }
  const uid = generateUidBasedOnHash(root);

  if (viewData.viewType === 'request' && viewData.itemPath) {
    await openCollectionForSingleRequest(collectionWatcher, root, viewData.itemPath, {}, sender);
    seedRuntimeVariables(uid, sender);
    await defaultWorkspaceManager.addCollectionToWorkspace(root);
    return;
  }

  await loadCollectionMetadata(root, sender);
  seedRuntimeVariables(uid, sender);
  if (viewData.viewType === 'new-request') { return; }

  if (viewData.transient && viewData.itemUid) {
    const item = transientItems.get(viewData.itemUid);
    if (item) {
      stateManager.broadcast('main:add-transient-request', { collectionUid: uid, item });
      sender('main:set-view', { viewType: 'request', collectionUid: uid, itemUid: viewData.itemUid });
    }
  }

  if (collectionWatcher.hasWatcher(root)) {
    await collectionWatcher.loadEnvironments(root, uid, sender);
    await collectionWatcher.loadFullCollection(root, uid, sender);
    return;
  }

  // First open anywhere: route the initial scan to this webview, then let the
  // watcher broadcast as usual.
  const broadcast: Sender = (channel, ...args) => stateManager.broadcast(channel, ...args);
  setCollectionsMessageSender(sender);
  setWatcherMessageSender(sender);
  try {
    await openCollection(collectionWatcher, root);
    await collectionWatcher.loadEnvironments(root, uid, sender);
  } finally {
    setCollectionsMessageSender(broadcast);
    setWatcherMessageSender(broadcast);
  }
}

const nonEmpty = (value: string) => (!value || !value.trim() ? 'Name cannot be empty' : null);

export function registerShellHandlers(host: ShellHost): void {
  const uidOf = (p: string) => generateUidBasedOnHash(p);
  const arg = <T extends object>(args: unknown[]): Partial<T> => (typeof args[0] === 'object' && args[0] ? args[0] : {}) as Partial<T>;
  type WithCollection = { collectionPath?: string; collectionUid?: string; folderUid?: string; folderPath?: string; itemUid?: string | null; itemPath?: string | null };

  const openForCollection = (viewType: ViewType) => async (args: unknown[]) => {
    const { collectionPath, folderUid } = arg<WithCollection>(args);
    if (!collectionPath) { return; }
    const root = resolveCollectionRoot(collectionPath) ?? collectionPath;
    await host.openView({ viewType, collectionUid: uidOf(root), collectionPath: root, folderUid });
  };
  const openWithUid = (viewType: ViewType) => async (args: unknown[]) => {
    const { collectionUid, collectionPath, itemUid, itemPath } = arg<WithCollection>(args);
    if (!collectionUid || !collectionPath) { return; }
    await host.openView({ viewType, collectionUid, collectionPath, itemUid: itemUid ?? null, itemPath: itemPath ?? null });
  };
  const openFile = async (args: unknown[]) => {
    // findCollectionRoot never terminates on a relative path.
    const viewData = typeof args[0] === 'string' && path.isAbsolute(args[0]) ? viewDataForFile(args[0]) : null;
    if (viewData) { await host.openView({ ...viewData, preview: !!(args[1] as { preview?: boolean } | undefined)?.preview }); }
  };
  registerHandler('editor:tab-permanent', async () => {
    const webview = getCurrentWebview();
    if (webview) { host.pinView(webview); }
  });
  const reveal = async (args: unknown[]): Promise<null> => {
    if (typeof args[0] === 'string') { await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(args[0])); }
    return null;
  };

  // --- navigation (send channels) -----------------------------------------
  /** Drop every webview's copy of the open collections and rescan from disk. */
  registerHandler('sidebar:refresh-collections', async () => {
    for (const root of collectionWatcher.getWatchedCollectionPaths()) {
      const uid = collectionWatcher.getCollectionUidForPath(root) ?? uidOf(root);
      stateManager.broadcast('main:collection-removed', { collectionUid: uid });
      collectionWatcher.removeWatcher(root, uid);
      await openCollection(collectionWatcher, root);
    }
  });

  registerHandler('sidebar:init-collection', async () => {
    const { root, name, configDir } = host.vault;
    await initCollection(root, name, [configDir, '.trash']);
    await openCollection(collectionWatcher, root);
  });
  registerHandler('sidebar:open-request', openFile);
  registerHandler('sidebar:open-app', openFile);
  registerHandler('sidebar:open-folder', async (args) => {
    if (typeof args[0] !== 'string') { return; }
    const root = resolveCollectionRoot(args[0]);
    if (!root) { return; }
    const folderUid = root === args[0] ? undefined : uidOf(args[0]);
    await host.openView({ viewType: 'collection-runner', collectionUid: uidOf(root), collectionPath: root, folderUid });
  });
  registerHandler('sidebar:open-collection-runner', openForCollection('collection-runner'));
  registerHandler('sidebar:open-collection-settings', openForCollection('collection-settings'));
  registerHandler('sidebar:open-collection-variables', openForCollection('variables'));
  registerHandler('sidebar:open-environment-settings', openForCollection('environment-settings'));
  registerHandler('sidebar:open-folder-settings', async (args) => {
    const { folderPath, collectionPath, preview } = arg<WithCollection & { preview?: boolean }>(args);
    if (!folderPath) { return; }
    const root = collectionPath ?? findCollectionRoot(folderPath);
    if (!root) { return; }
    await host.openView({ viewType: 'folder-settings', collectionUid: uidOf(root), collectionPath: root, folderUid: uidOf(path.resolve(folderPath)), preview: !!preview });
  });
  registerHandler('sidebar:open-global-environments', async () => host.openView({ viewType: 'global-environments' }));
  registerHandler('sidebar:open-create-collection', async () => host.openView({ viewType: 'create-collection' }));
  registerHandler('sidebar:open-import-collection', async () => host.openView({ viewType: 'import-collection' }));
  registerHandler('sidebar:open-new-request', openWithUid('new-request'));
  registerHandler('sidebar:open-export-collection', openWithUid('export-collection'));
  registerHandler('sidebar:open-clone-collection', openWithUid('clone-collection'));
  registerHandler('sidebar:open-transient-request', async (args) => {
    const { itemUid, itemName, collectionUid, collectionPath, item } = arg<{
      itemUid: string; itemName: string; collectionUid: string; collectionPath: string; item: Record<string, unknown>;
    }>(args);
    if (!itemUid || !collectionUid || !collectionPath) { return; }
    if (item) { transientItems.set(itemUid, item); }
    await host.openView({ viewType: 'request', collectionUid, collectionPath, itemUid, transient: true, itemName: itemName || 'Untitled' });
  });
  registerHandler('transient:item-updated', async (args) => {
    const { itemUid, item } = arg<{ itemUid: string; item: Record<string, unknown> }>(args);
    if (itemUid && item) { transientItems.set(itemUid, item); }
  });
  registerHandler('transient:item-ready', async (args) => {
    const { itemUid, collectionUid } = arg<{ itemUid: string; collectionUid: string }>(args);
    const webview = getCurrentWebview();
    if (webview && itemUid && collectionUid) {
      stateManager.sendTo(webview, 'main:set-view', { viewType: 'request', collectionUid, itemUid });
    }
  });
  registerHandler('transient:save-request', async (args) => {
    const webview = getCurrentWebview();
    const viewData = webview ? host.viewDataFor(webview) : undefined;
    const itemData = args[0] as Record<string, unknown> | undefined;
    if (!webview || !viewData?.collectionPath || !viewData.itemUid || !itemData) { return; }
    const collectionPath = viewData.collectionPath;

    const picked = await showSaveRequestPicker(collectionPath, viewData.itemName || 'Untitled', {
      title: `Save request to ${path.basename(collectionPath)}`
    });
    if (!picked) { return; }
    const format = fs.existsSync(path.join(collectionPath, 'opencollection.yml')) ? 'yml' : 'bru';
    const filename = `${picked.name}.${format}`;
    const fullPath = path.join(picked.folder, filename);
    if (fs.existsSync(fullPath)) {
      const overwrite = await vscode.window.showWarningMessage(`"${filename}" already exists in this folder. Overwrite?`, 'Overwrite', 'Cancel');
      if (overwrite !== 'Overwrite') { return; }
    }
    try {
      const content = await stringifyRequest({ ...itemData, name: picked.name, filename }, { format });
      await fs.promises.writeFile(fullPath, content, 'utf8');
      transientItems.delete(viewData.itemUid);
      viewData.transient = false; // closing must not broadcast a "closed" for a saved request
      host.closeView(webview);
      const saved = viewDataForFile(fullPath);
      if (saved) { await host.openView(saved); }
      vscode.window.showInformationMessage(`Request saved as "${picked.name}"`);
    } catch (error) {
      log('error', 'shell', 'save transient request failed', error);
      vscode.window.showErrorMessage(`Failed to save request: ${(error as Error).message}`);
    }
  });
  registerHandler('sidebar:show-in-explorer', reveal);
  registerHandler('sidebar:show-in-folder', reveal);

  for (const channel of ['new-request:close', 'create-collection:close', 'import-collection:close', 'clone-collection:close', 'export-collection:close']) {
    registerHandler(channel, async () => {
      const webview = getCurrentWebview();
      if (webview) { host.closeView(webview); }
    });
  }

  // --- prompts the webview delegates to the host (ported verbatim) ---------
  registerHandler('sidebar:ping', async () => 'pong');

  registerHandler('sidebar:prompt-rename', async (args) => {
    const { currentName, itemType } = arg<{ currentName: string; itemType: string }>(args);
    const newName = await vscode.window.showInputBox({
      prompt: `Enter new name for ${itemType}`, value: currentName, validateInput: nonEmpty
    });
    return newName || null;
  });

  registerHandler('sidebar:prompt-new-folder', async () => {
    const folderName = await vscode.window.showInputBox({
      prompt: 'Enter folder name',
      validateInput: (value) => nonEmpty(value) ?? (value.toLowerCase() === 'environments' ? 'The folder name "environments" is reserved' : null)
    });
    return folderName || null;
  });

  registerHandler('sidebar:prompt-new-request', async () => {
    const selected = await vscode.window.showQuickPick(
      [{ label: 'HTTP Request', value: 'http-request' }, { label: 'GraphQL Request', value: 'graphql-request' }],
      { placeHolder: 'Select request type' }
    );
    if (!selected) { return null; }
    const name = await vscode.window.showInputBox({ prompt: 'Enter request name', validateInput: nonEmpty });
    return name ? { name, type: selected.value } : null;
  });

  registerHandler('sidebar:confirm-remove', async (args) => {
    const { collectionName } = arg<{ collectionName: string }>(args);
    const result = await vscode.window.showWarningMessage(
      `Remove "${collectionName}" from workspace?`,
      { modal: true, detail: 'The collection will be removed from the workspace but files will remain on disk.' },
      'Remove'
    );
    return result === 'Remove';
  });

  registerHandler('sidebar:confirm-delete', async (args) => {
    const { itemName, itemType } = arg<{ itemName: string; itemType: string }>(args);
    const result = await vscode.window.showWarningMessage(
      `Delete ${itemType} "${itemName}"?`,
      { modal: true, detail: 'This will permanently delete the file from disk.' },
      'Delete'
    );
    return result === 'Delete';
  });

  registerHandler('sidebar:prompt-clone', async (args) => {
    const { currentName } = arg<{ currentName: string }>(args);
    const name = await vscode.window.showInputBox({
      prompt: 'Enter name for the cloned collection', value: `${currentName} copy`, validateInput: nonEmpty
    });
    if (!name) { return null; }
    const folder = await vscode.window.showOpenDialog({
      canSelectFolders: true, canSelectFiles: false, canSelectMany: false,
      openLabel: 'Select Location', title: 'Select location for cloned collection'
    });
    return folder?.length ? { name, location: folder[0].fsPath } : null;
  });

  registerHandler('clone-collection:browse-location', async () => {
    const folder = await vscode.window.showOpenDialog({
      canSelectFolders: true, canSelectFiles: false, canSelectMany: false,
      openLabel: 'Select Location', title: 'Select location for cloned collection'
    });
    return folder?.length ? folder[0].fsPath : null;
  });

  registerHandler('sidebar:save-file', async (args) => {
    const { defaultFileName, content, filters } = arg<{
      defaultFileName: string; content: string; filters?: { name: string; extensions: string[] }[];
    }>(args);
    const target = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(defaultFileName ?? ''),
      filters: filters ? Object.fromEntries(filters.map(f => [f.name, f.extensions])) : { 'JSON Files': ['json'] }
    });
    if (!target) { return null; }
    await vscode.workspace.fs.writeFile(target, Buffer.from(content ?? '', 'utf8'));
    return target.fsPath;
  });
}
