let cachedIsLinuxWebview: boolean | null = null;
let cachedIsMacOSWebview: boolean | null = null;

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

/**
 * True on the Windows Tauri build (WebView2/Chromium). Chromium is the only
 * engine that renders SVG filters inside `backdrop-filter` (true liquid-glass
 * refraction); WebKit and WebKitGTK ignore them.
 */
export function isWindowsWebview(): boolean {
  return /Windows NT/.test(navigator.userAgent);
}

/** True for Tauri's WKWebView build on macOS (but not iPhone/iPad WebKit). */
export function isMacOSWebview(): boolean {
  if (cachedIsMacOSWebview === null) {
    cachedIsMacOSWebview =
      /Macintosh|Mac OS X/.test(navigator.userAgent) &&
      !/iPhone|iPad|iPod/.test(navigator.userAgent);
  }
  return cachedIsMacOSWebview;
}

/**
 * Linux does not add rounded corners to undecorated Tauri windows for us.
 * Its native windows are transparent, so the frontend owns the clip.
 *
 * macOS is deliberately excluded: on macOS 26 (Tahoe) WKWebView, putting
 * `border-radius` + `overflow: hidden` on `#root` makes the compositor drop
 * the entire window's output — the app runs (JS, audio, network all fine)
 * but paints solid black. AppKit already rounds/clips decorated windows,
 * and the floating player gets its 16px radius natively from
 * `native_glass.rs`, so no CSS clip is needed there.
 */
export function usesRoundedNativeWindow(): boolean {
  return isLinuxWebview();
}
