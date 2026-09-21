import { App, Modal, Setting, SuggestModal } from 'obsidian';
import type { InputBoxOptions, QuickPickItem } from './vscode-shim';

/** Replacement for `vscode.window.showInputBox`. */
export class PromptModal extends Modal {
  private value: string;
  private settled = false;

  constructor(app: App, private options: InputBoxOptions, private done: (value: string | undefined) => void) {
    super(app);
    this.value = options.value ?? '';
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

  constructor(app: App, private items: T[], placeholder: string | undefined, private done: (value: T | undefined) => void) {
    super(app);
    if (placeholder) { this.setPlaceholder(placeholder); }
  }

  getSuggestions(query: string): T[] {
    const q = query.toLowerCase();
    return this.items.filter(i => `${i.label} ${i.description ?? ''}`.toLowerCase().includes(q));
  }

  renderSuggestion(item: T, el: HTMLElement): void {
    el.createDiv({ text: item.label });
    if (item.description) { el.createDiv({ text: item.description, cls: 'suggestion-note' }); }
  }

  onChooseSuggestion(item: T): void {
    this.settled = true;
    this.done(item);
  }

  onClose(): void {
    super.onClose();
    if (!this.settled) { this.done(undefined); }
  }
}
