/**
 * Placeholder replaced at build time by the `embed-webview` esbuild plugin.
 *
 * Keeping it a real module (rather than a virtual one) lets `tsc` typecheck the
 * unpacker against the same shape the bundler injects. In watch builds, and
 * whenever `webview/` has not been built yet, the values stay null and the
 * unpacker is a no-op.
 */
export const buildId: string | null = null;
export const payload: string | null = null;
