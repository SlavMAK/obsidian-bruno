import { App, Modal, Setting, SuggestModal, setIcon } from 'obsidian';
import type { InputBoxOptions, QuickPickItem } from './vscode-shim';

/**
 * VS Code's codicon syntax (`$(check)`) is meaningless in Obsidian. Map the few
 * glyphs the ported code uses to Lucide icon names Obsidian can render.
 */
const CODICON_ICONS: Record<string, string> = {
  check: 'check',
  'arrow-up': 'arrow-up',
  'arrow-down': 'arrow-down',
  folder: 'folder',
  'folder-opened': 'folder-open',
  add: 'plus',
  close: 'x',
  trash: 'trash-2',
  edit: 'pencil',
  gear: 'settings',
  search: 'search',
  file: 'file',
  'symbol-file': 'file'
};

/** `$(name) Rest of label` -> `{ icon, text }`; unmapped tokens are dropped from text. */
function splitCodicon(label: string): { icon?: string; text: string } {
  const match = /^\$\(([a-z0-9-]+)\)\s*(.*)$/i.exec(label);
  if (match) {
    const icon = CODICON_ICONS[match[1].toLowerCase()];
    return { icon, text: match[2] ?? '' };
  }
  return { text: label };
}

/** Drop any `$(... )` tokens so search matching ignores the glyph prefix. */
function plainLabel(label: string): string {
  return label.replace(/\$\([a-z0-9-]+\)\s*/gi, '');
}

/**
 * Obsidian patches `instanceOf` onto the *main window's* `Node.prototype` and,
 * before closing a modal, restores focus to whatever element was focused when it
 * opened. When the modal is opened from our editor `iframe`, that element belongs
 * to the iframe's realm, whose `Node.prototype.instanceOf` is `undefined` — so
 * `Modal.close` throws `instanceOf is not a function` and never resolves the
 * prompt. Disabling selection restore skips that code path entirely.
 */
function noSelectionRestore(modal: Modal): void {
  modal.shouldRestoreSelection = false;
}

/** Replacement for `vscode.window.showInputBox`. */
export class PromptModal extends Modal {
  private value: string;
  private settled = false;

  constructor(app: App, private options: InputBoxOptions, private done: (value: string | undefined) => void) {
    super(app);
    this.value = options.value ?? '';
    noSelectionRestore(this);
  }

  onOpen(): void {
    const { contentEl, titleEl } = this;
    titleEl.setText(this.options.title ?? this.options.prompt ?? 'Bruno');

    const error = contentEl.createDiv({ cls: 'mod-warning bruno-prompt-error' });

    const setting = new Setting(contentEl).addText(text => {
      text.setValue(this.value)
        .setPlaceholder(this.options.placeHolder ?? '')
        .onChange(v => { this.value = v; void this.validate(v, error); });
      if (this.options.password) { text.inputEl.type = 'password'; }
      text.inputEl.addClass('bruno-prompt-input');
      text.inputEl.addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); void this.submit(error); }
      });
      text.inputEl.focus();
      text.inputEl.select();
    });
    setting.settingEl.addClass('bruno-prompt-setting');

    new Setting(contentEl)
      .addButton(b => b.setButtonText('Cancel').onClick(() => this.close()))
      .addButton(b => b.setButtonText('OK').setCta().onClick(() => void this.submit(error)));
  }

  private async validate(value: string, error: HTMLElement): Promise<string | null> {
    const message = (await this.options.validateInput?.(value)) ?? null;
    error.setText(message ?? '');
    return message;
  }

  private async submit(error: HTMLElement): Promise<void> {
    if (await this.validate(this.value, error)) { return; }
    this.settled = true;
    this.done(this.value);
    this.close();
  }

  onClose(): void {
    this.contentEl.empty();
    if (!this.settled) { this.done(undefined); }
  }
}

/** Replacement for `vscode.window.show*Message` when it carries action buttons. */
export class ConfirmModal extends Modal {
  private settled = false;

  constructor(app: App, private message: string, private actions: string[], private done: (value: string | undefined) => void) {
    super(app);
    noSelectionRestore(this);
  }

  onOpen(): void {
    this.titleEl.setText('Bruno');
    this.contentEl.createEl('p', { text: this.message });
    const buttons = new Setting(this.contentEl);
    this.actions.forEach((action, i) => {
      buttons.addButton(b => {
        b.setButtonText(action).onClick(() => {
          this.settled = true;
          this.done(action);
          this.close();
        });
        if (i === 0) { b.setCta(); }
      });
    });
  }

  onClose(): void {
    this.contentEl.empty();
    if (!this.settled) { this.done(undefined); }
  }
}

/** Replacement for `vscode.window.showQuickPick` / `createQuickPick`. */
export class PickModal<T extends QuickPickItem> extends SuggestModal<T> {
  private settled = false;
  private heading?: string;

  constructor(app: App, private items: T[], placeholder: string | undefined, private done: (value: T | undefined) => void, heading?: string) {
    super(app);
    if (placeholder) { this.setPlaceholder(placeholder); }
    this.heading = heading;
    noSelectionRestore(this);
  }

  onOpen(): void {
    super.onOpen();
    if (!this.heading) { return; }
    const promptEl = this.inputEl.closest('.prompt');
    if (promptEl) {
      const header = promptEl.createDiv({ text: this.heading, cls: 'bruno-pick-title' });
      promptEl.insertBefore(header, promptEl.firstChild);
    }
  }

  getSuggestions(query: string): T[] {
    const q = query.toLowerCase().trim();
    if (!q) { return this.items; }
    return this.items.filter(i => `${plainLabel(i.label)} ${i.description ?? ''}`.toLowerCase().includes(q));
  }

  renderSuggestion(item: T, el: HTMLElement): void {
    const { icon, text } = splitCodicon(item.label);
    const row = el.createDiv({ cls: 'bruno-pick-row' });
    if (icon) {
      const iconEl = row.createSpan({ cls: 'bruno-pick-icon' });
      setIcon(iconEl, icon);
    }
    row.createSpan({ text, cls: 'bruno-pick-text' });
    if (item.description) { el.createDiv({ text: item.description, cls: 'suggestion-note' }); }
  }

  /**
   * Since Obsidian 1.13 the stock `selectSuggestion` closes the modal (firing
   * `onClose`, i.e. a "cancelled" resolve) *before* `onChooseSuggestion` runs —
   * which would drop every pick as undefined. Resolve first, then close.
   */
  selectSuggestion(item: T, _evt: MouseEvent | KeyboardEvent): void {
    this.settled = true;
    this.done(item);
    this.close();
  }

  onChooseSuggestion(_item: T, _evt: MouseEvent | KeyboardEvent): void {
    // Never reached: `selectSuggestion` is overridden above; required by base.
  }

  onClose(): void {
    super.onClose();
    if (!this.settled) { this.done(undefined); }
  }
}
