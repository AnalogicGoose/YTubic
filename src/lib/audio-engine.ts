import { useEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { fetchRadio } from "@/lib/innertube/radio";
import { prefetchStream, saveTrackMeta, streamUrlFor } from "@/lib/stream";
import { usePlaybackStore, type QueueTrack } from "@/lib/store/playback";
import { usePremiumStore } from "@/lib/store/premium";
import { useSettingsStore } from "@/lib/store/settings";
import { openPremiumGate } from "@/lib/store/premium-gate";
import { resolveStreamId, useTrackSourceStore } from "@/lib/store/track-source";
import { pickThumbnail } from "@/components/shared/thumbnail";

/**
 * AudioEngine binds the playback store to a singleton HTMLAudioElement
 * and drives the OS media controls (Windows SMTC) from Rust via souvlaki (see
 * the media effects below and src-tauri/src/media.rs) rather than the webview's
 * own media session — that one runs in the WebView2 child process and shows up
 * as "Unknown app" in the Windows Now Playing tile.
 *
 * Mount this hook once, near the root. It owns the <audio> element's lifecycle.
 */
export function useAudioEngine() {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  // Guard against stale stream resolutions when the user skips mid-fetch.
  const resolveTokenRef = useRef(0);
  // Counts how many tracks have failed in a row without a successful
  // play in between. Reset to 0 on `playing`. Used to short-circuit
  // auto-skip after a few consecutive failures so we don't burn through
  // the whole queue if e.g. the network is dead.
  const consecutiveErrorsRef = useRef(0);
  // Remembers the `videoId:index` we've already auto-retried once, so a
  // track that keeps failing falls through to the normal error/skip path
  // instead of looping. Cleared on a successful `playing`.
  const retriedTrackRef = useRef<string | null>(null);
  // MediaError and play() rejection usually report the same failed load. Track
  // a generation so only the first signal drives retry/skip state.
  const loadGenerationRef = useRef(0);
  const activeMediaGenerationRef = useRef(-1);
  const handledFailureGenerationRef = useRef(-1);
  const retryTimerRef = useRef<number | null>(null);
  const handlePlaybackFailureRef = useRef<
    (message: string, generation?: number) => void
  >(() => {});
  // Bumping this re-runs the resolve effect for the *current* track
  // without any of its real deps changing — used to re-fetch a fresh
  // stream URL after a transient failure (e.g. a googlevideo 403).
  const [retryNonce, setRetryNonce] = useState(0);

  handlePlaybackFailureRef.current = (message, generation) => {
    const currentGeneration = generation ?? loadGenerationRef.current;
    if (currentGeneration !== loadGenerationRef.current) return;
    if (handledFailureGenerationRef.current === currentGeneration) return;
    handledFailureGenerationRef.current = currentGeneration;

    const store = usePlaybackStore.getState();
    const current = store.index >= 0 ? store.queue[store.index] : undefined;
    const key = current ? `${current.videoId}:${store.index}` : null;
    if (store.playing && key && retriedTrackRef.current !== key) {
      retriedTrackRef.current = key;
      store.setStatus("loading");
      if (retryTimerRef.current !== null) {
        window.clearTimeout(retryTimerRef.current);
      }
      retryTimerRef.current = window.setTimeout(() => {
        retryTimerRef.current = null;
        const latest = usePlaybackStore.getState();
        const latestTrack =
          latest.index >= 0 ? latest.queue[latest.index] : undefined;
        const latestKey = latestTrack
          ? `${latestTrack.videoId}:${latest.index}`
          : null;
        // A delayed retry must never tear down a new track selected while the
        // old source was failing.
        if (latest.playing && latestKey === key) {
          setRetryNonce((nonce) => nonce + 1);
        }
      }, 400);
      return;
    }

    store.setStatus("error", message);
    consecutiveErrorsRef.current += 1;
    const hasNext = store.index >= 0 && store.index + 1 < store.queue.length;
    if (store.playing && hasNext && consecutiveErrorsRef.current <= 3) {
      store.next();
      return;
    }
    if (consecutiveErrorsRef.current > 3) {
      store.setStatus(
        "error",
        "YouTube is limiting this connection, so playback was paused. Try again later or use another network/VPN.",
      );
    }
    store.setPlaying(false);
  };

  // Ensure a single <audio> element exists.
  useEffect(() => {
    if (audioRef.current) return;
    const el = new Audio();
    el.preload = "auto";
    // Note: do NOT set crossOrigin — googlevideo.com doesn't return CORS
    // headers, and setting it makes the media fail to load in the webview.
    audioRef.current = el;
    return () => {
      if (retryTimerRef.current !== null) {
        window.clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
      el.pause();
      el.src = "";
      audioRef.current = null;
    };
  }, []);

  // Wire element → store events.
  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    const store = usePlaybackStore.getState;

    const onTimeUpdate = () => {
      store().setPosition(el.currentTime);
    };
    const syncDuration = () => {
      // A real, finite element duration is authoritative — always take it.
      if (Number.isFinite(el.duration) && el.duration > 0) {
        store().setDuration(el.duration);
        return;
      }
      // Below here we're only filling in an estimate for streams that never
      // report a finite duration. Once one is set, don't re-run the
      // fallbacks (this handler also fires on every `progress` event).
      if (store().duration > 0) return;
      // YouTube audio streams are frequently served as an unbounded /
      // chunked source, so the media element reports `Infinity` (or NaN)
      // for its duration and `durationchange` never yields a real length.
      // Fall back to the track's own duration from the browse/InnerTube
      // metadata so the progress bar has a proper max instead of pinning
      // the thumb to the far right (see ProgressSlider clamp).
      const s = store();
      const cur = s.index >= 0 ? s.queue[s.index] : undefined;
      if (cur?.duration && cur.duration > 0) {
        store().setDuration(cur.duration);
        return;
      }
      // Last resort for tracks whose browse card carried no length (e.g.
      // some home-page shelves): once the stream has buffered, the
      // element's seekable range end reflects the true track length even
      // while `duration` stays Infinity.
      if (el.seekable.length > 0) {
        const end = el.seekable.end(el.seekable.length - 1);
        if (Number.isFinite(end) && end > 0) {
          store().setDuration(end);
        }
      }
    };
    const onEnded = () => {
      if (activeMediaGenerationRef.current !== loadGenerationRef.current) {
        return;
      }
      store().next();
    };
    const onError = () => {
      const mediaErr = el.error;
      const codeLabels: Record<number, string> = {
        1: "MEDIA_ERR_ABORTED",
        2: "MEDIA_ERR_NETWORK",
        3: "MEDIA_ERR_DECODE",
        4: "MEDIA_ERR_SRC_NOT_SUPPORTED",
      };
      const msg = mediaErr
        ? `${codeLabels[mediaErr.code] ?? `code ${mediaErr.code}`}${
            mediaErr.message ? `: ${mediaErr.message}` : ""
          }`
        : "Unknown audio error";
      if (import.meta.env.DEV) {
        console.error("[audio] element error:", msg, "src=", el.currentSrc);
      }

      const generation = activeMediaGenerationRef.current;
      if (generation >= 0) {
        handlePlaybackFailureRef.current(msg, generation);
      }
    };
    const onPlaying = () => {
      if (activeMediaGenerationRef.current !== loadGenerationRef.current) {
        return;
      }
      consecutiveErrorsRef.current = 0;
      // Track played successfully — allow a fresh auto-retry if it later
      // fails again (e.g. a mid-stream drop on a much later replay).
      retriedTrackRef.current = null;
      store().setStatus("ready");
    };
    const onWaiting = () => {
      // buffering — keep status as ready; don't flip to loading on every gap.
    };

    el.addEventListener("timeupdate", onTimeUpdate);
    // `durationchange` fires with the (often Infinity) stream duration;
    // `loadedmetadata` and `progress` re-run the fallbacks as the seekable
    // range fills in for streams that never report a finite duration.
    el.addEventListener("durationchange", syncDuration);
    el.addEventListener("loadedmetadata", syncDuration);
    el.addEventListener("progress", syncDuration);
    el.addEventListener("ended", onEnded);
    el.addEventListener("error", onError);
    el.addEventListener("playing", onPlaying);
    el.addEventListener("waiting", onWaiting);
    return () => {
      el.removeEventListener("timeupdate", onTimeUpdate);
      el.removeEventListener("durationchange", syncDuration);
      el.removeEventListener("loadedmetadata", syncDuration);
      el.removeEventListener("progress", syncDuration);
      el.removeEventListener("ended", onEnded);
      el.removeEventListener("error", onError);
      el.removeEventListener("playing", onPlaying);
      el.removeEventListener("waiting", onWaiting);
    };
  }, []);

  // React to current-track changes → resolve stream → set src.
  const { videoId, track, index } = usePlaybackStore(
    useShallow((s) => {
      const t = s.index >= 0 ? s.queue[s.index] : undefined;
      return { videoId: t?.videoId, track: t, index: s.index };
    }),
  );

  // Substitute the streaming videoId via the user's per-track source
  // preference (Song ↔ Music Video). Subscribing here means the effect
  // below re-runs and re-resolves the stream when the user toggles the
  // source on the currently playing track.
  const streamVideoId = useTrackSourceStore((s) =>
    videoId ? resolveStreamId(videoId, s.byVideoId) : undefined,
  );

  // Reactive Premium check for the gate below. Subscribing (rather than
  // calling isPremium() inside the effect) makes the resolve effect
  // re-run when the status lands after sign-in / the launch-time probe.
  // Without this, a track gated during the "still checking" window would
  // sit silent until the user re-picked it.
  const premiumOk = usePremiumStore((s) => s.status === "premium");

  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    const token = ++resolveTokenRef.current;
    const generation = ++loadGenerationRef.current;
    activeMediaGenerationRef.current = -1;
    handledFailureGenerationRef.current = -1;
    if (retryTimerRef.current !== null) {
      window.clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
    // Stop the previous track immediately. Without this the old src keeps
    // playing through the streamUrlFor() round-trip (~50–500 ms), so the
    // user hears the tail of track A bleed into the start of track B.
    el.pause();
    if (!streamVideoId) {
      el.removeAttribute("src");
      el.load();
      usePlaybackStore.getState().setStreamUrl(undefined);
      return;
    }
    // Premium gate: signed-out / Free accounts browse but don't stream.
    // Every entry path (track clicks, media keys, tray, floating window,
    // restored queues) funnels through this effect, so one check here
    // guarantees no yt-dlp spawn and no cache write happens without
    // Premium. A deliberate play attempt (playing=true) gets the
    // explainer dialog; the silent preload of a restored queue
    // (playing=false) just parks the track.
    if (!premiumOk) {
      el.removeAttribute("src");
      el.load();
      const store = usePlaybackStore.getState();
      store.setStreamUrl(undefined);
      store.setStatus("idle");
      if (store.playing) {
        store.setPlaying(false);
        openPremiumGate();
      }
      return;
    }
    // Drop the previous track's src immediately. Otherwise a paused→playing
    // transition committed together with the track change (playNow/goTo set
    // playing: true) makes the [playing] effect below re-play the OLD src
    // for the duration of the streamUrlFor() round-trip.
    el.removeAttribute("src");

    usePlaybackStore.getState().setStatus("loading");

    // Persist this track's title/artist beside its cache file so the
    // Storage tab can name it without depending on the library walk.
    // Read from the store imperatively (like the rest of this effect) so
    // the track object doesn't have to join the dependency array.
    {
      const st = usePlaybackStore.getState();
      void saveTrackMeta(
        streamVideoId,
        st.index >= 0 ? st.queue[st.index] : undefined,
      );
    }

    // Playback goes through our local streaming HTTP server. The preflight
    // waits for yt-dlp to finish and validates one byte through the same Range
    // path HTMLAudio will use, so resolver failures stay diagnosable and
    // MP4/M4A files have their final metadata before Chromium decodes them.
    const retryKey = videoId ? `${videoId}:${index}` : null;
    streamUrlFor(streamVideoId, {
      refresh: retryKey !== null && retriedTrackRef.current === retryKey,
    })
      .then((src) => {
        if (token !== resolveTokenRef.current) return;
        if (import.meta.env.DEV) {
          console.debug("[audio] setting src for", videoId, "→", src);
        }
        activeMediaGenerationRef.current = generation;
        el.src = src;
        usePlaybackStore.getState().setStreamUrl(src);
        el.load();
        if (usePlaybackStore.getState().playing) {
          void el.play().catch((e) => {
            // AbortError is what we get when a pending play() is
            // interrupted by a new load (e.g. user clicked the next
            // track before the current one started). It's harmless
            // and should never surface to the user.
            if (e?.name === "AbortError") return;
            if (import.meta.env.DEV) {
              console.error("[audio] play() rejected:", e);
            }
            handlePlaybackFailureRef.current(
              e?.message ?? String(e),
              generation,
            );
          });
        }
      })
      .catch((e: Error) => {
        if (token !== resolveTokenRef.current) return;
        handlePlaybackFailureRef.current(e.message, generation);
      });
    // `index` is in the deps so advancing to a different queue slot that
    // holds the *same* videoId (a duplicate in a playlist, radio dupes)
    // still re-resolves and plays instead of stalling on "loading" —
    // videoId/streamVideoId alone wouldn't change. Repeating a *single*
    // track (repeat-one, or repeat-all on a 1-track queue) keeps the same
    // index, so the store replays it via pendingSeek instead — see
    // `next()` in store/playback.ts. `premiumOk` so that gaining Premium
    // (sign-in, status re-check) re-resolves a track the gate parked.
    // `retryNonce` so the error handler can force a fresh stream-URL fetch
    // for the current track after a transient failure without changing id.
  }, [streamVideoId, videoId, index, premiumOk, retryNonce]);

  // Play / pause follow store.
  const playing = usePlaybackStore((s) => s.playing);
  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    if (playing && !premiumOk) {
      // Resume attempts (play button, Space, SMTC play) on a gated track
      // never reach the resolve effect (its deps don't include
      // `playing`), so intercept them here.
      usePlaybackStore.getState().setPlaying(false);
      openPremiumGate();
      return;
    }
    if (!el.src) return;
    if (playing) {
      const generation = activeMediaGenerationRef.current;
      void el.play().catch((e) => {
        if (e?.name === "AbortError") return;
        handlePlaybackFailureRef.current(e?.message ?? String(e), generation);
      });
    } else {
      el.pause();
    }
  }, [playing, premiumOk]);

  // Volume / mute follow store.
  const volume = usePlaybackStore((s) => s.volume);
  const muted = usePlaybackStore((s) => s.muted);
  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    // <audio>.volume is linear amplitude (0..1), but loudness perception
    // is logarithmic — a linear slider crams almost all the perceivable
    // change into the bottom ~20% and 20–100% sounds nearly identical.
    // Apply a cubic curve so the slider tracks perceived loudness.
    const clamped = Math.max(0, Math.min(1, volume));
    el.volume = clamped ** 3;
    el.muted = muted;
  }, [volume, muted]);

  // Handle seek requests.
  const pendingSeek = usePlaybackStore((s) => s.pendingSeek);
  useEffect(() => {
    const el = audioRef.current;
    if (!el || pendingSeek === undefined) return;
    try {
      el.currentTime = pendingSeek;
    } catch {
      /* seek failed — non-fatal */
    }
    usePlaybackStore.getState().clearPendingSeek();
    // repeat-one and error auto-advance re-select the same track and set
    // { pendingSeek: 0, playing: true } without changing `playing` (already
    // true), so the [playing] effect never re-fires. After an `ended` event
    // the element is paused, so seeking to 0 alone leaves it silent. Resume
    // here when the store wants playback but the element is paused.
    if (usePlaybackStore.getState().playing && el.paused && el.src) {
      const generation = activeMediaGenerationRef.current;
      void el.play().catch((e) => {
        if (e?.name === "AbortError") return;
        handlePlaybackFailureRef.current(e?.message ?? String(e), generation);
      });
    }
  }, [pendingSeek]);

  // OS media controls (Windows SMTC) are driven from Rust via souvlaki, not
  // navigator.mediaSession — the webview's own media session shows up as
  // "Unknown app" because it belongs to the WebView2 child process. Metadata /
  // state is pushed by the media_update effect lower down; buttons come back
  // via the media-control listener. See src-tauri/src/media.rs.

  // Tray menu commands come via a Tauri event. `cancelled` flag
  // protects against StrictMode's mount→unmount→mount race that
  // would otherwise leak duplicate listeners and double-call
  // `toggle()` (which would silently no-op the play/pause hotkey).
  useEffect(() => {
    let cancelled = false;
    let dispose: (() => void) | undefined;
    void listen<string>("tray-action", (e) => {
      const store = usePlaybackStore.getState();
      if (e.payload === "play_pause") store.toggle();
      else if (e.payload === "prev") store.prev();
      else if (e.payload === "next") store.next();
    }).then((un) => {
      if (cancelled) un();
      else dispose = un;
    });
    return () => {
      cancelled = true;
      dispose?.();
    };
  }, []);

  // SMTC / media-key button presses arrive from Rust (souvlaki) as a
  // `media-control` event. Drive the store the same way the old
  // navigator.mediaSession action handlers did. `cancelled` guards against
  // StrictMode's mount→unmount→mount double-listen, like the tray listener.
  useEffect(() => {
    let cancelled = false;
    let dispose: (() => void) | undefined;
    void listen<{ action: string; position?: number }>("media-control", (e) => {
      const store = usePlaybackStore.getState();
      switch (e.payload.action) {
        case "play":
          store.setPlaying(true);
          break;
        case "pause":
        case "stop":
          store.setPlaying(false);
          break;
        case "toggle":
          store.toggle();
          break;
        case "next":
          store.next();
          break;
        case "previous":
          store.prev();
          break;
        case "seek":
          if (typeof e.payload.position === "number")
            store.seek(e.payload.position);
          break;
      }
    }).then((un) => {
      if (cancelled) un();
      else dispose = un;
    });
    return () => {
      cancelled = true;
      dispose?.();
    };
  }, []);

  // Prefetch the next queued track in the background while the current
  // one plays. First-time plays take ~2s (yt-dlp resolve + first audio
  // chunk); by the time the user hits "next" the file is cached on
  // disk and playback starts instantly with full seek support.
  const status = usePlaybackStore((s) => s.status);
  const { nextVideoId } = usePlaybackStore(
    useShallow((s) => ({
      nextVideoId:
        s.index >= 0 && s.index + 1 < s.queue.length
          ? s.queue[s.index + 1].videoId
          : undefined,
    })),
  );
  // Substitute via source-prefs for the prefetch too — otherwise we'd
  // warm the cache for the wrong stream when the user has switched the
  // upcoming track to its video version.
  const nextStreamVideoId = useTrackSourceStore((s) =>
    nextVideoId ? resolveStreamId(nextVideoId, s.byVideoId) : undefined,
  );
  useEffect(() => {
    if (status !== "ready") return;
    if (!nextStreamVideoId) return;
    void prefetchStream(nextStreamVideoId);
    // Label the prefetched file too — same reasoning as the play path.
    const st = usePlaybackStore.getState();
    void saveTrackMeta(
      nextStreamVideoId,
      st.index >= 0 && st.index + 1 < st.queue.length
        ? st.queue[st.index + 1]
        : undefined,
    );
  }, [status, nextStreamVideoId]);

  // Auto-extend the queue with radio tracks when we're near the end, so
  // playback continues past the explicit queue.
  const autoRadio = usePlaybackStore((s) => s.autoRadio);
  const { qLen, qIndex, seedVideoId, repeat } = usePlaybackStore(
    useShallow((s) => ({
      qLen: s.queue.length,
      qIndex: s.index,
      seedVideoId: s.index >= 0 ? s.queue[s.index]?.videoId : undefined,
      repeat: s.repeat,
    })),
  );
  const radioFetchedForRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!autoRadio) return;
    if (qIndex < 0 || !seedVideoId) return;
    // Only fire when the current track is the last queued one.
    if (qIndex < qLen - 1) return;
    // Loop takes priority over radio: never extend the queue while repeat
    // is on, so `next()`'s own loop logic wins instead of racing with us.
    if (repeat !== "off") return;
    if (radioFetchedForRef.current === seedVideoId) return;
    radioFetchedForRef.current = seedVideoId;
    fetchRadio(seedVideoId)
      .then((tracks) => {
        // Guard against a stale fetch: the user may have replaced the queue
        // (playNow/setQueue) while the radio request was in flight. Only
        // append if this seed is still the current, last-in-queue track.
        const s = usePlaybackStore.getState();
        const cur = s.index >= 0 ? s.queue[s.index]?.videoId : undefined;
        if (cur !== seedVideoId || s.index < s.queue.length - 1) return;
        const rest = tracks.filter((t) => t.id !== seedVideoId);
        if (rest.length) s.appendToQueue(rest, "autoplay");
      })
      .catch(() => {
        // Allow a retry on transient failure.
        radioFetchedForRef.current = undefined;
      });
  }, [autoRadio, qIndex, qLen, seedVideoId, repeat]);

  // Push metadata + playback state to the OS media controls (Windows SMTC).
  // Windows interpolates the scrubber between pushes while the state is
  // Playing, so we don't push on every timeupdate — just on track / play-state
  // / duration change, plus a light 2s refresh while playing to correct drift
  // and reflect seeks. Live values are read imperatively so this OS sync never
  // re-triggers the resolve / playback effects above.
  const duration = usePlaybackStore((s) => s.duration);
  useEffect(() => {
    const push = () => {
      const s = usePlaybackStore.getState();
      const t = s.index >= 0 ? s.queue[s.index] : undefined;
      if (!t) {
        void invoke("media_clear").catch(() => {});
        return;
      }
      void invoke("media_update", {
        title: t.title,
        artist: buildArtistLabel(t),
        album: t.album ?? "",
        thumbnail: pickThumbnail(t.thumbnails, 512) ?? "",
        duration: Number.isFinite(s.duration) ? s.duration : 0,
        elapsed: s.position,
        paused: !s.playing,
      }).catch(() => {});
    };
    push();
    if (!playing) return;
    const id = window.setInterval(push, 2000);
    return () => window.clearInterval(id);
  }, [track, playing, duration]);

  // Discord Rich Presence mirrors the same metadata, but pushed only on
  // track / play-state / duration change — never the 2s position refresh
  // above. Discord rate-limits activity updates, and it derives its own
  // progress bar from the start/end timestamps, so one push animates the bar
  // for the whole song. The worker + (re)connect lifecycle live in
  // src-tauri/src/discord.rs; the on/off toggle is mirrored separately by
  // useDiscordPresenceSync, which also clears the activity when disabled.
  const discordRp = useSettingsStore((s) => s.discordRichPresence);
  useEffect(() => {
    if (!discordRp) return; // disabled → useDiscordPresenceSync cleared it
    const s = usePlaybackStore.getState();
    const t = s.index >= 0 ? s.queue[s.index] : undefined;
    if (!t) {
      void invoke("discord_clear").catch(() => {});
      return;
    }
    const dur = Number.isFinite(s.duration) ? s.duration : 0;
    // Timestamps (hence the progress bar) only while actually playing: Discord
    // can't freeze a bar, so paused shows none rather than a wrong one. Unix
    // milliseconds, per Discord's Activity spec.
    let startMs: number | null = null;
    let endMs: number | null = null;
    if (s.playing && dur > 0) {
      startMs = Math.round(Date.now() - s.position * 1000);
      endMs = Math.round(startMs + dur * 1000);
    }
    void invoke("discord_update", {
      title: t.title,
      artist: buildArtistLabel(t),
      album: t.album ?? "",
      imageUrl: pickThumbnail(t.thumbnails, 512) ?? "",
      startMs,
      endMs,
    }).catch(() => {});
  }, [track, playing, duration, discordRp]);
}

function buildArtistLabel(track: QueueTrack): string {
  if (track.artists?.length) return track.artists.map((a) => a.name).join(", ");
  return track.subtitle ?? "";
}
