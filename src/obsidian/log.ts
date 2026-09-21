/**
 * Append-only diagnostics file next to main.js (`bruno.log`), so a failing
 * session can be handed over without hunting through devtools. Captures the
 * host side (everything console.error/warn'd from this bundle) and the webview
 * side (the iframe's errors, rejections and console.error/warn).
 */
import * as fs from 'fs';
import * as path from 'path';

type Level = 'error' | 'warn' | 'info';

let file = '';
let restoreConsole: (() => void) | null = null;

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_ARG = 4000;

function fmt(arg: unknown): string {
  // `instanceof Error` fails for errors thrown inside the iframe (other realm).
  const err = arg as { stack?: string; message?: string } | null;
  if (err && typeof err === 'object' && typeof err.message === 'string' && ('stack' in err || err instanceof Error)) {
    return err.stack ?? err.message;
  }
  if (typeof arg === 'string') { return arg; }
  try {
    return JSON.stringify(arg, (_k, v) => (v && typeof v === 'object' && typeof v.message === 'string' && 'stack' in v ? { message: v.message, stack: v.stack } : v)).slice(0, MAX_ARG);
  } catch { return String(arg); }
}

export function logPath(): string { return file; }

export function log(level: Level, scope: string, ...args: unknown[]): void {
  if (!file) { return; }
  const line = `${new Date().toISOString()} [${level}] [${scope}] ${args.map(fmt).join(' ')}\n`;
  fs.appendFile(file, line, () => {});
}

/**
 * Obsidian evaluates plugin code with a `plugin:<id>` source URL, so a stack
 * trace tells us whether a console call came from this bundle. Everything
 * that did is mirrored to the file; other plugins are left alone.
 */
export function initLog(pluginDir: string, pluginId: string): void {
  file = path.join(pluginDir, 'bruno.log');
  try {
    if (fs.existsSync(file) && fs.statSync(file).size > MAX_BYTES) { fs.truncateSync(file); }
  } catch { /* logging must never break the plugin */ }

  const marker = `plugin:${pluginId}`;
  const patch = (level: 'error' | 'warn') => {
    const original = console[level];
    console[level] = (...args: unknown[]) => {
      original.apply(console, args);
      if (new Error().stack?.includes(marker)) { log(level, 'host', ...args); }
    };
    return () => { console[level] = original; };
  };
  const undo = [patch('error'), patch('warn')];
  restoreConsole = () => undo.forEach(fn => fn());

  log('info', 'host', `plugin loaded, log at ${file}`);
}

export function disposeLog(): void {
  log('info', 'host', 'plugin unloaded');
  restoreConsole?.();
  restoreConsole = null;
}

/** Mirror a webview document's failures into the log. */
export function attachWebviewLogging(win: Window, scope: string): void {
  win.addEventListener('error', e => log('error', scope, e.message, e.error ?? `${e.filename}:${e.lineno}`));
  win.addEventListener('unhandledrejection', e => log('error', scope, 'unhandled rejection', e.reason));
  const con = (win as unknown as { console: Console }).console;
  for (const level of ['error', 'warn'] as const) {
    const original = con[level];
    con[level] = (...args: unknown[]) => {
      original.apply(con, args);
      log(level, scope, ...args);
    };
  }
}
