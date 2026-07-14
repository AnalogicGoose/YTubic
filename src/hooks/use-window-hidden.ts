import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

const IS_TAURI =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/**
 * True while this window is not visible to the user — minimized, or hidden
 * to the tray. Consumers use it to stop rendering continuously-animating
 * surfaces (the album mesh burns GPU on every frame through its blur +
 * animation stack) so a backgrounded app costs near-zero GPU/CPU while
 * audio keeps playing.
 *
 * Two signals, belt and suspenders:
 * - `document.visibilitychange` — WebView2/WKWebView flip `document.hidden`
 *   when the native window is hidden (tray) and usually on minimize.
 * - Tauri `tauri://resize` + `isMinimized()` — minimize on Windows arrives
 *   as a resize event; some WebView2 versions don't flip visibility for it.
 */
export function useWindowHidden(): boolean {
  const [hidden, setHidden] = useState(() => document.hidden);

  useEffect(() => {
    let minimized = false;
    let docHidden = document.hidden;
    const apply = () => setHidden(minimized || docHidden);

    const onVisibility = () => {
      docHidden = document.hidden;
      apply();
    };
    document.addEventListener("visibilitychange", onVisibility);

    let cancelled = false;
    let dispose: (() => void) | undefined;
    if (IS_TAURI) {
      const win = getCurrentWindow();
      const check = () => {
        void win
          .isMinimized()
          .then((value) => {
            minimized = value;
            apply();
          })
          .catch(() => {
            /* window handle gone — leave the visibility signal in charge */
          });
      };
      void win.listen("tauri://resize", check).then((un) => {
        if (cancelled) un();
        else dispose = un;
      });
      check();
    }

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisibility);
      dispose?.();
    };
  }, []);

  return hidden;
}
