import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { currentTrack, usePlaybackStore } from "@/lib/store/playback";
import { useSettingsStore } from "@/lib/store/settings";

/**
 * System toast on track change (Settings → General → Playback
 * notifications). Mounted once in AppShell — playback state lives in
 * the main window, so this is the only place a change can originate.
 *
 * The "is the user already looking at the app?" suppression lives in
 * the Rust `notify_track` command, where every window's focus state is
 * visible — toasts only show while Goosic sits in the background or
 * the tray.
 */
export function usePlaybackNotifications(): void {
  const enabled = useSettingsStore((s) => s.playbackNotifications);
  const track = usePlaybackStore(currentTrack);
  const videoId = track?.videoId ?? null;
  const index = usePlaybackStore((s) => s.index);
  const loadRevision = usePlaybackStore((s) => s.loadRevision);
  const playing = usePlaybackStore((s) => s.playing);
  const status = usePlaybackStore((s) => s.status);
  const advertisement = usePlaybackStore((s) => s.advertisement);
  const selectionKey = videoId ? `${index}:${videoId}:${loadRevision}` : null;
  const selectedRef = useRef<string | null>(null);
  const handledRef = useRef<string | null>(null);

  useEffect(() => {
    if (selectionKey === null) {
      // Queue cleared / nothing playing — reset so the next track
      // (even a replay of the same id) notifies again.
      selectedRef.current = null;
      handledRef.current = null;
      return;
    }
    if (selectedRef.current !== selectionKey) {
      selectedRef.current = selectionKey;
      handledRef.current = enabled ? null : selectionKey;
    }
    // Treat a disabled selection as already handled: flipping the toggle
    // mid-song shouldn't retroactively toast it.
    if (!enabled) {
      handledRef.current = selectionKey;
      return;
    }
    // A queued song is not yet "now playing" while YouTube is presenting an
    // advertisement or while its requested document is still buffering.
    if (!playing || status !== "ready" || advertisement) return;
    if (handledRef.current === selectionKey) return;
    handledRef.current = selectionKey;

    const artists =
      track?.artists?.map((a) => a.name).join(", ") || track?.subtitle || "";
    invoke("notify_track", {
      title: track?.title ?? "Now playing",
      body: artists,
    }).catch(() => {
      /* best-effort: plain-vite dev or toast backend failure */
    });
  }, [selectionKey, enabled, playing, status, advertisement, track]);
}
