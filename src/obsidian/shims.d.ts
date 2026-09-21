/** Ambient declarations for packages that ship no usable types for this build. */

declare module '@usebruno/common' {
  /** The CJS build exposes a `utils` namespace that the bundled d.ts omits. */
  export const utils: Record<string, (...args: never[]) => unknown>;
}

/** VS Code's Thenable alias, still referenced by ported type signatures. */
type Thenable<T> = PromiseLike<T>;
