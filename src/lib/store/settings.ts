import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { isWindowsWebview } from "@/lib/platform";
import {
  clampGlassBlur,
  clampGlassOpacity,
  GLASS_BLUR_DEFAULT,
  GLASS_OPACITY_DEFAULT,
  isVisualThemeId,
  type VisualThemeId,
} from "@/lib/themes";

export type CloseButtonAction = "tray" | "quit";
export type CacheAutoCleanPeriod = "off" | "daily" | "weekly" | "monthly";
export type BackgroundMode = "ambient" | "plain";

type State = {
  /** What the title-bar ✕ does: hide to tray (default) or quit. */
  closeAction: CloseButtonAction;
  /** Cadence of the background sweep that deletes cached tracks not
   *  in the user's library (see `lib/cache-cleanup.ts`). */
  cacheAutoClean: CacheAutoCleanPeriod;
  /** Unix ms of the last completed sweep. 0 = never ran. */
  lastCacheCleanAt: number;
  /** Window backdrop: "ambient" tints with blurred album art,
   *  "plain" keeps the flat theme background. */
  background: BackgroundMode;
  /** The semantic visual child theme. Components consume the same token
   *  contract; this value only selects which token set is mounted. */
  visualTheme: VisualThemeId;
  /** Alpha (0–1) of the shared glass tint every surface reads via
   *  `--glass-opacity` — the "Frosted glass" slider. 0 = fully transparent
   *  (frost only), 1 = opaque. See `useGlassOpacity`. */
  glassOpacity: number;
  /** Backdrop blur radius (px) of the shared glass material, via
   *  `--glass-blur` — the "Glass blur" slider. See `useGlassBlur`. */
  glassBlur: number;
  /** Experimental animated mesh derived from the current cover. When false,
   *  Ambient mode uses the original blurred-cover implementation. */
  dynamicAlbumMesh: boolean;
  /** Experimental true backdrop refraction on glass surfaces (menus,
   *  popovers, player). Windows only: Chromium/WebView2 renders SVG filters
   *  inside `backdrop-filter`; WebKit (macOS) doesn't and keeps the classic
   *  blur material regardless of this flag. */
  liquidGlassRefraction: boolean;
  /** System toast on track change while the app is in the background
   *  (see `lib/playback-notifications.ts`). */
  playbackNotifications: boolean;
  /** Broadcast the current track to Discord as a Rich Presence status
   *  ("Listening to Goosic"). Off by default — opt-in for privacy.
   *  The IPC worker lives in `src-tauri/src/discord.rs`. */
  discordRichPresence: boolean;
  /** Scrobble every played track to the connected Last.fm account. Only
   *  meaningful while `lastfmSessionKey` is set; connecting turns it on.
   *  The signed HTTP calls + offline retry queue live in
   *  `src-tauri/src/lastfm.rs`; the play-time timing that decides when to
   *  scrobble lives in `lib/lastfm-scrobbler.ts`. */
  lastfmEnabled: boolean;
  /** Last.fm session key: a permanent bearer credential for the connected
   *  account, or null when not connected. Passed to every scrobble call. */
  lastfmSessionKey: string | null;
  /** Display name of the connected Last.fm account, shown in Settings. */
  lastfmUsername: string | null;
  /** Last.fm profile avatar URL for the connected account (fetched from
   *  user.getInfo, purely cosmetic for the account card), or null. */
  lastfmAvatar: string | null;
  /** Mirror YouTube Music likes to Last.fm as Loved tracks. Separate from
   *  scrobbling and off by default: an opt-in, since people often keep their
   *  likes intentionally different per platform. See `lib/lastfm.ts`. */
  lastfmLoveSync: boolean;
  setCloseAction: (v: CloseButtonAction) => void;
  setCacheAutoClean: (v: CacheAutoCleanPeriod) => void;
  markCacheCleaned: () => void;
  setBackground: (v: BackgroundMode) => void;
  setVisualTheme: (v: VisualThemeId) => void;
  setGlassOpacity: (v: number) => void;
  setGlassBlur: (v: number) => void;
  setDynamicAlbumMesh: (v: boolean) => void;
  setLiquidGlassRefraction: (v: boolean) => void;
  setPlaybackNotifications: (v: boolean) => void;
  setDiscordRichPresence: (v: boolean) => void;
  setLastfmEnabled: (v: boolean) => void;
  setLastfmLoveSync: (v: boolean) => void;
  setLastfmAvatar: (v: string | null) => void;
  /** Store the account returned by the connect flow and enable scrobbling. */
  setLastfmSession: (username: string, sessionKey: string) => void;
  /** Forget the connected account and stop scrobbling. */
  clearLastfmSession: () => void;
};

/**
 * General app preferences editable from the Settings page. Persisted
 * in localStorage like the other stores; anything Rust needs to act on
 * (close behavior) is mirrored over IPC by a sync hook rather than
 * read from disk on the Rust side.
 */
export const useSettingsStore = create<State>()(
  persist(
    (set) => ({
      closeAction: "tray",
      cacheAutoClean: "off",
      lastCacheCleanAt: 0,
      background: "ambient",
      visualTheme: "default",
      glassOpacity: GLASS_OPACITY_DEFAULT,
      glassBlur: GLASS_BLUR_DEFAULT,
      dynamicAlbumMesh: true,
      liquidGlassRefraction: true,
      playbackNotifications: false,
      discordRichPresence: false,
      lastfmEnabled: false,
      lastfmSessionKey: null,
      lastfmUsername: null,
      lastfmAvatar: null,
      lastfmLoveSync: false,
      setCloseAction: (closeAction) => set({ closeAction }),
      setCacheAutoClean: (cacheAutoClean) => set({ cacheAutoClean }),
      markCacheCleaned: () => set({ lastCacheCleanAt: Date.now() }),
      setBackground: (background) => set({ background }),
      setVisualTheme: (visualTheme) => set({ visualTheme }),
      setGlassOpacity: (v) => set({ glassOpacity: clampGlassOpacity(v) }),
      setGlassBlur: (v) => set({ glassBlur: clampGlassBlur(v) }),
      setDynamicAlbumMesh: (dynamicAlbumMesh) => set({ dynamicAlbumMesh }),
      setLiquidGlassRefraction: (liquidGlassRefraction) =>
        set({ liquidGlassRefraction }),
      setPlaybackNotifications: (playbackNotifications) =>
        set({ playbackNotifications }),
      setDiscordRichPresence: (discordRichPresence) =>
        set({ discordRichPresence }),
      setLastfmEnabled: (lastfmEnabled) => set({ lastfmEnabled }),
      setLastfmLoveSync: (lastfmLoveSync) => set({ lastfmLoveSync }),
      setLastfmAvatar: (lastfmAvatar) => set({ lastfmAvatar }),
      setLastfmSession: (lastfmUsername, lastfmSessionKey) =>
        set({ lastfmUsername, lastfmSessionKey, lastfmEnabled: true }),
      clearLastfmSession: () =>
        set({
          lastfmUsername: null,
          lastfmSessionKey: null,
          lastfmAvatar: null,
          lastfmEnabled: false,
          lastfmLoveSync: false,
        }),
    }),
    {
      name: "ytm-settings",
      // Old installs may have no visualTheme yet — or a since-retired id
      // (goosic/ocean/sunset/mono). `isVisualThemeId` now only accepts
      // default/modern, so any legacy or corrupted value falls back to the
      // current default rather than blocking hydration.
      merge: (persisted, current) => {
        const saved = persisted as Partial<State> | undefined;
        const value = saved?.visualTheme;
        const savedOpacity = saved?.glassOpacity;
        const savedBlur = saved?.glassBlur;
        return {
          ...current,
          ...(persisted as Partial<State>),
          visualTheme: isVisualThemeId(value) ? value : current.visualTheme,
          // Missing on older installs; clamp anything out of range.
          glassOpacity:
            typeof savedOpacity === "number"
              ? clampGlassOpacity(savedOpacity)
              : current.glassOpacity,
          glassBlur:
            typeof savedBlur === "number"
              ? clampGlassBlur(savedBlur)
              : current.glassBlur,
        };
      },
    },
  ),
);

// The main and floating-player windows are separate JS contexts sharing
// the `ytm-settings` localStorage key (same pattern as `ytm-layout`).
// Re-hydrate on the cross-window `storage` event so e.g. switching the
// Background mode in the main window restyles the floating player live.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key === "ytm-settings") {
      void useSettingsStore.persist.rehydrate();
    }
  });
}

/**
 * Mirror the persisted close-button preference into Rust, where the
 * actual `CloseRequested` handling lives (it must cover every close
 * path — title-bar ✕, Alt+F4, taskbar Close). Mounted once in
 * AppShell: pushes the persisted value right after launch, then again
 * on every change from the Settings page.
 */
export function useCloseBehaviorSync(): void {
  const closeAction = useSettingsStore((s) => s.closeAction);
  useEffect(() => {
    invoke("set_close_behavior", {
      quitOnClose: closeAction === "quit",
    }).catch(() => {
      /* plain-vite dev without a Tauri backend — nothing to sync */
    });
  }, [closeAction]);
}

/**
 * Toggle the `liquid-refract` class on <html> from the persisted experiment.
 * The class upgrades every `.liquid-glass` surface to true backdrop
 * refraction via the SVG lens filter (see `LiquidGlassDefs` and index.css).
 * Windows-only: Chromium renders SVG filters in `backdrop-filter`; WebKit
 * ignores the `url()` term, so macOS/Linux never get the class. Mounted in
 * both AppShell and FloatingPlayerApp — separate JS contexts, same rule.
 */
export function useLiquidRefractionClass(): void {
  const enabled = useSettingsStore((s) => s.liquidGlassRefraction);
  useEffect(() => {
    document.documentElement.classList.toggle(
      "liquid-refract",
      enabled && isWindowsWebview(),
    );
  }, [enabled]);
}

/**
 * Mirror the Discord Rich Presence toggle into Rust, where the IPC worker
 * lives (`src-tauri/src/discord.rs`). Turning it off tells the worker to
 * clear the activity and disconnect; turning it on lets the audio engine's
 * push effect populate it on the next track / play-state change. Mounted
 * once in AppShell so the disable path fires even when nothing is playing.
 */
export function useDiscordPresenceSync(): void {
  const enabled = useSettingsStore((s) => s.discordRichPresence);
  useEffect(() => {
    invoke("discord_set_enabled", { enabled }).catch(() => {
      /* plain-vite dev without a Tauri backend — nothing to sync */
    });
  }, [enabled]);
}
