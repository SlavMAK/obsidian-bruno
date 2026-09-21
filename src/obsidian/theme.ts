/**
 * The ported Bruno UI reads VS Code's theme CSS variables and keys off a
 * `vscode-dark` / `vscode-light` body class. Obsidian's theme lives in a
 * different document than the iframe, so mirror it in.
 */
const VAR_MAP: Record<string, string> = {
  '--vscode-editor-background': '--background-primary',
  '--vscode-editor-foreground': '--text-normal',
  '--vscode-foreground': '--text-normal',
  '--vscode-descriptionForeground': '--text-muted',
  '--vscode-errorForeground': '--text-error',
  '--vscode-focusBorder': '--interactive-accent',
  '--vscode-font-family': '--font-interface',
  '--vscode-textLink-foreground': '--text-accent',
  '--vscode-widget-border': '--background-modifier-border',
  '--vscode-badge-background': '--interactive-accent',
  '--vscode-badge-foreground': '--text-on-accent',
  '--vscode-button-background': '--interactive-accent',
  '--vscode-button-foreground': '--text-on-accent',
  '--vscode-button-border': '--background-modifier-border',
  '--vscode-button-hoverBackground': '--interactive-accent-hover',
  '--vscode-button-secondaryBackground': '--interactive-normal',
  '--vscode-button-secondaryForeground': '--text-normal',
  '--vscode-button-secondaryHoverBackground': '--interactive-hover',
  '--vscode-input-background': '--background-modifier-form-field',
  '--vscode-input-foreground': '--text-normal',
  '--vscode-input-border': '--background-modifier-border',
  '--vscode-input-placeholderForeground': '--text-faint',
  '--vscode-inputValidation-errorBorder': '--text-error',
  '--vscode-inputValidation-warningBackground': '--background-modifier-error',
  '--vscode-list-hoverBackground': '--background-modifier-hover',
  '--vscode-sideBar-background': '--background-secondary',
  '--vscode-sideBar-foreground': '--text-normal',
  '--vscode-sideBarSectionHeader-border': '--background-modifier-border',
  '--vscode-sideBarSectionHeader-foreground': '--text-muted'
};

const STYLE_ID = 'bruno-obsidian-theme';

export function applyTheme(iframe: HTMLIFrameElement): void {
  const doc = iframe.contentDocument;
  if (!doc?.body) { return; }

  const source = getComputedStyle(document.body);
  // Obsidian colors are often `hsl(calc(...))` chains, which the webview's
  // theme feeds to polished and polished cannot parse. Resolving each one
  // through a real element yields plain `rgb()`/`rgba()`; unresolvable values
  // are dropped so the theme's built-in fallback applies.
  const probe = document.body.createSpan({ cls: 'bruno-color-probe' });
  const declarations = Object.entries(VAR_MAP)
    .map(([target, obsidianVar]) => {
      const raw = source.getPropertyValue(obsidianVar).trim();
      if (!raw) { return null; }
      if (target === '--vscode-font-family') { return `${target}: ${raw};`; }
      probe.style.color = '';
      probe.style.color = raw;
      const color = probe.style.color ? getComputedStyle(probe).color : '';
      return color ? `${target}: ${color};` : null;
    })
    .filter((d): d is string => d !== null)
    .join('\n  ');
  probe.remove();

  let style = doc.getElementById(STYLE_ID);
  if (!style) {
    style = doc.createElement('style');
    style.id = STYLE_ID;
    doc.head.appendChild(style);
  }
  style.textContent = `:root, body {\n  ${declarations}\n}`;

  const isDark = document.body.classList.contains('theme-dark');
  doc.body.classList.toggle('vscode-dark', isDark);
  doc.body.classList.toggle('vscode-light', !isDark);
}
