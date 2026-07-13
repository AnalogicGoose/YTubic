let cachedIsLinuxWebview: boolean | null = null;

/**
 * True on the Linux Tauri build (WebKitGTK). WebKitGTK recognizes
 * `backdrop-filter` in `@supports` queries, but a large share of real
 * installs (software rendering, no DMA-BUF compositor) never actually
 * paint it — surfaces tuned around blur render as flat, near-transparent
 * panels with whatever's behind them bleeding through sharp instead of
 * blurred. There's no reliable CSS-only way to tell "the property is
 * recognized" apart from "it will actually render", so UI that depends on
 * blur to stay legible (see `glass-surface.ts`) checks this instead of
 * `supports-[backdrop-filter]`.
 */
export function isLinuxWebview(): boolean {
  if (cachedIsLinuxWebview === null) {
    cachedIsLinuxWebview =
      /Linux/.test(navigator.userAgent) && !/Android/.test(navigator.userAgent);
  }
  return cachedIsLinuxWebview;
}
