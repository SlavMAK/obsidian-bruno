import { ItemView, WorkspaceLeaf, type ViewStateResult } from 'obsidian';
import { handleInvoke, hasHandler, setCurrentWebview, clearCurrentWebview } from '../extension/ipc/handlers';
import { stateManager } from '../extension/webview/state-manager';
import { applyTheme } from './theme';
import { loadCollectionInto, viewTitle, closeTransient, hasTransientItem, type ViewData } from './shell';
import { log, attachWebviewLogging } from './log';
import type BrunoPlugin from './main';

export const SIDEBAR_VIEW_TYPE = 'bruno-sidebar';
export const EDITOR_VIEW_TYPE = 'bruno-editor';
export type ViewMode = 'sidebar' | 'editor';

interface IpcMessage {
  type: 'invoke' | 'send';
  channel: string;
  args?: unknown[];
  requestId?: string;
}

type PersistedViewState = Record<string, unknown> & { viewData?: ViewData | null };

/**
 * Hosts the Bruno React app in an iframe and bridges its postMessage IPC to the
 * handler registry ported from bruno-vscode. The iframe keeps Bruno's Tailwind
 * and styled-components off Obsidian's own DOM.
 *
 * `sidebar` renders the collections tree; `editor` renders one `ViewData`
 * (a request, runner, settings form, …) and persists it as leaf state.
 */
export class BrunoView extends ItemView {
  viewData: ViewData | null = null;
  private iframe: HTMLIFrameElement | null = null;
  private ready = false;
  /** The iframe document that said `renderer:ready`; a reload (e.g. the leaf was moved) replaces it. */
  private readyDocument: Document | null = null;
  private onMessage = this.handleMessage.bind(this);

  /** Stable `vscode.Webview`-shaped handle the IPC layer posts events to. */
  readonly webview = {
    postMessage: (message: unknown) => {
      const target = this.iframe?.contentWindow;
      if (!target) { return; }
      // Events posted into a document that is not (or no longer) the one
      // listening surface as "Uncaught illegal access" in a dying frame; only
      // responses may go through regardless.
      const isEvent = (message as { type?: string } | null)?.type === 'event';
      if (isEvent && this.iframe?.contentDocument !== this.readyDocument) { return; }
      target.postMessage(message, '*');
    }
  };

  constructor(leaf: WorkspaceLeaf, private plugin: BrunoPlugin, readonly mode: ViewMode) {
    super(leaf);
  }

  getViewType(): string { return this.mode === 'sidebar' ? SIDEBAR_VIEW_TYPE : EDITOR_VIEW_TYPE; }
  getDisplayText(): string { return this.mode === 'sidebar' ? 'Bruno' : viewTitle(this.viewData); }
  getIcon(): string { return 'send'; }

  getState(): PersistedViewState { return { viewData: this.viewData }; }

  async setState(state: PersistedViewState, result: ViewStateResult): Promise<void> {
    this.viewData = state?.viewData ?? null;
    this.setPreview(!!this.viewData?.preview);
    if (this.ready) { this.applyViewData(); }
    await super.setState(state, result);
  }

  private tabHeaderEl(): HTMLElement | undefined {
    // Undocumented but long-stable Obsidian internal; the only handle on the tab title.
    return (this.leaf as unknown as { tabHeaderEl?: HTMLElement }).tabHeaderEl;
  }

  setPreview(preview: boolean): void {
    if (this.viewData) { this.viewData.preview = preview || undefined; }
    this.tabHeaderEl()?.toggleClass('bruno-preview', preview);
  }

  async onOpen(): Promise<void> {
    const header = this.tabHeaderEl();
    if (header) { this.registerDomEvent(header, 'dblclick', () => this.setPreview(false)); }
    this.contentEl.empty();
    this.contentEl.addClass('bruno-view-content');

    const iframe = this.contentEl.createEl('iframe', { cls: 'bruno-iframe' });
    this.registerDomEvent(iframe, 'load', () => this.onIframeLoad(iframe));
    iframe.srcdoc = await this.plugin.webviewHtml(this.mode);
    this.iframe = iframe;

    this.registerEvent(this.app.workspace.on('css-change', () => applyTheme(iframe)));

    stateManager.addWebview(this.webview as never);
    if (this.mode === 'editor') { stateManager.setActiveEditorWebview(this.webview as never); }
    this.registerDomEvent(window, 'message', this.onMessage);
  }

  async onClose(): Promise<void> {
    stateManager.removeWebview(this.webview as never);
    if (this.viewData) { closeTransient(this.viewData); }
    this.iframe = null;
  }

  /**
   * Inactive Obsidian tabs are `display: none`. CodeMirror 5 skips painting in
   * an unmeasurable container, so variable highlights updated while the tab was
   * hidden stay stale until a click. It listens for window resize, so fake one.
   */
  onResize(): void {
    this.iframe?.contentWindow?.dispatchEvent(new Event('resize'));
  }

  send(channel: string, ...args: unknown[]): void {
    stateManager.sendTo(this.webview as never, channel, ...args);
  }

  private onIframeLoad(iframe: HTMLIFrameElement): void {
    applyTheme(iframe);
    const doc = iframe.contentDocument;
    if (!doc || !iframe.contentWindow) { return; }
    attachWebviewLogging(iframe.contentWindow, `webview:${this.mode}`);
    // VS Code's keybinding turned Ctrl+S into `main:trigger-save`; key events
    // inside the iframe never reach Obsidian's hotkeys, so do it here.
    this.registerDomEvent(doc, 'keydown', (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        this.send('main:trigger-save');
      }
    });
  }

  /** The React app is listening; hand it what this leaf shows. */
  private onRendererReady(): void {
    this.ready = true;
    this.readyDocument = this.iframe?.contentDocument ?? null;
    log('info', 'view', `renderer ready (${this.mode})`, this.viewData);
    if (this.mode === 'sidebar') {
      this.send('sidebar:ready');
      return;
    }
    this.applyViewData();
  }

  private applyViewData(): void {
    if (!this.viewData) { return; }
    if (this.viewData.transient && this.viewData.itemUid && !hasTransientItem(this.viewData.itemUid)) {
      // Restored from a previous session: the unsaved request is gone with it.
      this.leaf.detach();
      return;
    }
    this.send('main:set-view', this.viewData);
    void loadCollectionInto(this.viewData, (channel, ...args) => this.send(channel, ...args))
      .catch(error => log('error', 'view', 'failed to load collection into view', this.viewData, error));
  }

  private async handleMessage(event: MessageEvent<IpcMessage>): Promise<void> {
    if (!this.iframe || event.source !== this.iframe.contentWindow) { return; }
    const message = event.data;
    if (!message || (message.type !== 'invoke' && message.type !== 'send')) { return; }

    setCurrentWebview(this.webview as never);
    try {
      if (message.type === 'send') {
        await this.handleSend(message.channel, message.args ?? []);
        return;
      }
      const result = await handleInvoke(message.channel, message.args ?? []);
      if (message.requestId) {
        this.webview.postMessage({ type: 'response', requestId: message.requestId, result });
      }
      if (message.channel === 'renderer:ready') { this.onRendererReady(); }
    } catch (error) {
      log('error', 'ipc', message.channel, message.args, error);
      if (message.requestId) {
        this.webview.postMessage({
          type: 'response',
          requestId: message.requestId,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    } finally {
      clearCurrentWebview();
    }
  }

  private async handleSend(channel: string, args: unknown[]): Promise<void> {
    if (channel === 'open-external' && typeof args[0] === 'string') {
      window.open(args[0], '_blank');
      return;
    }
    if (hasHandler(channel)) {
      await handleInvoke(channel, args);
      return;
    }
    log('warn', 'ipc', 'unhandled send channel', channel, args);
  }
}
