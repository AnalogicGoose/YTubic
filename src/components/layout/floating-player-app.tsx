import { useEffect } from "react";
import { ThemeProvider } from "next-themes";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { QueryClientProvider } from "@tanstack/react-query";
import { PinIcon } from "lucide-react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";
import {
  PLAYER_GLASS_SURFACE_CLASS,
  STATIC_PLAYER_GLASS_SURFACE_CLASS,
} from "@/components/ui/glass-surface";
import { PlayerBar } from "@/components/layout/player-bar";
import { LiquidGlassDefs } from "@/components/layout/liquid-glass-defs";
import { NowPlayingBackground } from "@/components/layout/now-playing-background";
import { FloatingPlayerSyncReceiver } from "@/components/layout/floating-player-sync";
import { initFloatingPlaybackBridge } from "@/lib/store/playback";
import { initFloatingTrackSourceBridge } from "@/lib/store/track-source";
import { useLayoutStore } from "@/lib/store/layout";
import { cn } from "@/lib/utils";
import { queryClient } from "@/lib/query-client";
import { isWindowsWebview } from "@/lib/platform";
import { useGlassPlatformClasses } from "@/lib/store/settings";

// Wire the store's user-facing actions to emit Tauri events instead of
// mutating local state directly — only the main window's audio engine
// can actually act on them. Done at module-eval time so this runs before
// any of the components below subscribe.
initFloatingPlaybackBridge();
initFloatingTrackSourceBridge();

/**
 * Frontend entrypoint when the same bundle is loaded in the standalone
 * player window (`?floating-player=1`). We deliberately skip
 * `RouterProvider` and `AppShell` — the floating window has no
 * navigation, no audio engine, and no app-wide chrome. It mirrors
 * playback state via Tauri events (wired in step 6) and renders only
 * `<PlayerBar variant="floating">`.
 */
export default function FloatingPlayerApp() {
  useGlassPlatformClasses();
  const nativeMaterial = new URLSearchParams(window.location.search).get(
    "native-player-material",
  );
  const hasNativeMaterial =
    nativeMaterial === "liquid-glass" || nativeMaterial === "visual-effect";
  const windowsGlass = isWindowsWebview() && !hasNativeMaterial;
  return (
    <ThemeProvider
      attribute="class"
      defaultTheme="dark"
      // Dark-only, same as the main window (light mode is deprecated).
      forcedTheme="dark"
      storageKey="ytm-theme"
      disableTransitionOnChange
    >
      {/* Plain (non-persisting) provider: the floating window is a separate
          JS context that would otherwise write its own cache into the shared
          `ytubic-query-cache` key — clobbering the main window and
          resurrecting a previous account's data after a switch. It only
          mirrors live playback via events, so it needs no cold-start cache. */}
      <QueryClientProvider client={queryClient}>
        <TooltipProvider delayDuration={800} skipDelayDuration={0}>
          <div
            className={cn(
              "relative h-screen w-screen overflow-hidden rounded-[16px]",
              hasNativeMaterial ? "bg-transparent" : "bg-background",
            )}
          >
            {windowsGlass ? <NowPlayingBackground /> : null}
            {windowsGlass ? <LiquidGlassDefs /> : null}
            <div
              className={cn(
                // AppKit supplies genuine native material on macOS. Windows
                // uses the same dimension-matched SVG player glass as the
                // main window, over an internal album-derived backdrop;
                // Linux keeps the conservative static fallback.
                hasNativeMaterial || windowsGlass
                  ? PLAYER_GLASS_SURFACE_CLASS
                  : STATIC_PLAYER_GLASS_SURFACE_CLASS,
                "relative z-10 flex h-full w-full flex-col overflow-hidden rounded-[16px] border",
                hasNativeMaterial && "native-player-material",
              )}
            >
              <FloatingPlayerSyncReceiver />
              <FloatingTitleBar />
              <main className="relative flex-1">
                <PlayerBar variant="floating" />
              </main>
            </div>
          </div>
        </TooltipProvider>
        <Toaster />
      </QueryClientProvider>
    </ThemeProvider>
  );
}

/**
 * Slim drag-only title strip with a close button. The floater has
 * `decorations: false` so we draw our own — we keep min/maximize off
 * the bar because the window is small and rarely resized; leaving
 * those out gives the user more horizontal drag area.
 *
 * Closing the window emits `player-window-closed` from Rust (see
 * `lib.rs`), which the main window listens for and uses to revert
 * its layout mode back to "right".
 */
function FloatingTitleBar() {
  const pinned = useLayoutStore((s) => s.floatingPinned);
  const setPinned = useLayoutStore((s) => s.setFloatingPinned);

  // Reflect the persisted pin state on the actual OS window. Runs on
  // mount (so a pinned window stays pinned after a close/reopen)
  // and whenever the toggle flips.
  useEffect(() => {
    void getCurrentWindow()
      .setAlwaysOnTop(pinned)
      .catch((e) => console.error("[floating] setAlwaysOnTop failed:", e));
  }, [pinned]);

  return (
    // `bg-surface` matches the player card below — both layers tint
    // the album-derived mesh with the same translucent black so the
    // strip and the body read as a single uniform card. Without it,
    // the title bar shows the mesh at full saturation while
    // the body dims it via `bg-surface`, leaving a visible seam.
    <header
      data-tauri-drag-region
      className="relative z-30 flex h-(--titlebar-h) shrink-0 select-none items-center justify-end bg-transparent"
    >
      <button
        type="button"
        onClick={() => setPinned(!pinned)}
        aria-label={pinned ? "Unpin from top" : "Pin on top"}
        aria-pressed={pinned}
        className={cn(
          "flex h-full w-11 items-center justify-center transition-colors hover:bg-white/10",
          pinned ? "text-brand" : "text-foreground/85",
        )}
      >
        <PinIcon className={cn("size-4", pinned && "fill-current")} />
      </button>
      <button
        type="button"
        onClick={() => {
          // Use the Tauri-side handler so the close path matches what
          // happens when the user closes via Alt+F4 or the window
          // manager — both routes go through `WindowEvent::CloseRequested`.
          void invoke("close_player_window");
        }}
        aria-label="Close"
        className="flex h-full w-11 items-center justify-center text-foreground/85 transition-colors hover:bg-[#c42b1c] hover:text-white"
      >
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
          <path
            d="M0 0 L10 10 M10 0 L0 10"
            stroke="currentColor"
            strokeWidth="1"
          />
        </svg>
      </button>
    </header>
  );
}
