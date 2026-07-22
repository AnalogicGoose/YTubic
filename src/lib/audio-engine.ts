import { useEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { fetchRadio } from "@/lib/innertube/radio";
import {
  isDefinitiveOfflineFileFailure,
  offlineStreamUrlFor,
} from "@/lib/stream";
import { usePlaybackStore, type QueueTrack } from "@/lib/store/playback";
import { useSettingsStore } from "@/lib/store/settings";
import { usePremiumStore } from "@/lib/store/premium";
import { resolveStreamId, useTrackSourceStore } from "@/lib/store/track-source";
import { markOfflineDownloadFailed } from "@/lib/store/offline-downloads";
import { pickThumbnail } from "@/components/shared/thumbnail";
import {
  controlWebPlayer,
  isSeekHoldResolved,
  isWebPlayerHealthy,
  loadWebTrack,
  resetWebPlayer,
  type WebPlaybackState,
  type WebSeekHold,
} from "@/lib/web-playback";

/**
 * AudioEngine coordinates the official native WebPlayer for online tracks and
 * a singleton HTMLAudioElement for explicit downloaded-file playback. It also
 * drives OS media controls from Rust via souvlaki; the remote WebView's own
 * media session is deliberately suppressed.
 *
 * Mount this hook once, near the root. It owns the <audio> element's lifecycle.
 */
export function useAudioEngine() {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  // Guard against stale local-file preflights when the user skips mid-fetch.
  const resolveTokenRef = useRef(0);
  // Counts how many tracks have failed in a row without a successful
  // play in between. Reset to 0 on `playing`. Used to short-circuit
  // auto-skip after a few consecutive failures so we don't burn through
  // the whole queue if e.g. the network is dead.
  const consecutiveErrorsRef = useRef(0);
  // Remembers the `videoId:index` we've already auto-retried once, so a
  // track that keeps failing falls through to the normal error/skip path
  // instead of looping. Cleared on a successful `playing`.
  // MediaError and play() rejection usually report the same failed load. Track
  // a generation so only the first signal drives retry/skip state.
  const loadGenerationRef = useRef(0);
  const activeMediaGenerationRef = useRef(-1);
  const handledFailureGenerationRef = useRef(-1);
  const handlePlaybackFailureRef = useRef<
    (
      message: string,
      generation?: number,
      definitiveLocalFileFailure?: boolean,
    ) => void
  >(() => {});
  // Bumping this recreates the official WebPlayer once for a genuine startup
  // or content-process failure without changing the selected queue row.
  const [webRetryNonce, setWebRetryNonce] = useState(0);
  const webGenerationRef = useRef(0);
  const webTrackKeyRef = useRef<string | null>(null);
  const webRetriesRef = useRef(0);
  const webFailureInFlightRef = useRef(false);
  const handledWebEndedGenerationRef = useRef<number | null>(null);
  const webRecoverySeekRef = useRef<number | null>(null);
  // A seek reaches the official page asynchronously, so observer samples that
  // were already in flight still carry the pre-seek position and would drag the
  // progress bar back to it. Hold the requested position until a sample
  // confirms it, the generation changes, or the attempt visibly fails.
  const webSeekTargetRef = useRef<WebSeekHold | null>(null);
  const webStartupTimerRef = useRef<number | null>(null);
  const webStartupPhaseRef = useRef<"content" | "advertisement" | null>(null);
  const failWebPlaybackRef = useRef<(message: string) => void>(() => {});
  const selectionEpochRef = useRef(0);
  const selectionInProgressRef = useRef(false);
  // If the last queued track ends before its autoplay-radio request returns,
  // remember the seed so the newly appended row can actually start. Without
  // this hand-off `next()` stops at the old queue boundary and the later fetch
  // merely adds silent rows behind it.
  const endedRadioSeedRef = useRef<string | null>(null);
  const directActivationSequenceRef = useRef(0);
  const previousDesiredPlayingRef = useRef(false);
  const [directActivation, setDirectActivation] = useState<{
    videoId: string;
    selectionRevision: number;
    backend: "offline";
    sequence: number;
  } | null>(null);

  handlePlaybackFailureRef.current = (
    message,
    generation,
    definitiveLocalFileFailure = false,
  ) => {
    const currentGeneration = generation ?? loadGenerationRef.current;
    if (currentGeneration !== loadGenerationRef.current) return;
    if (handledFailureGenerationRef.current === currentGeneration) return;
    handledFailureGenerationRef.current = currentGeneration;

    const store = usePlaybackStore.getState();
    const current = store.index >= 0 ? store.queue[store.index] : undefined;
    if (store.backend !== "offline" || !current?.offlineVideoId) return;
    if (definitiveLocalFileFailure) {
      markOfflineDownloadFailed(current.offlineVideoId, message);
    }
    consecutiveErrorsRef.current += 1;
    const hasNext = store.index >= 0 && store.index + 1 < store.queue.length;
    if (store.playing && hasNext && consecutiveErrorsRef.current <= 3) {
      store.next();
      return;
    }
    store.setStatus(
      "error",
      definitiveLocalFileFailure
        ? `This downloaded file could not be decoded. It was kept on disk so you can repair or remove it later. ${message}`
        : `This downloaded file could not be opened right now. It remains on disk. ${message}`,
    );
    store.setPlaying(false);
  };

  // Ensure a single <audio> element exists.
  useEffect(() => {
    if (audioRef.current) return;
    const el = new Audio();
    el.preload = "auto";
    // The local loopback server already constrains access through a per-launch
    // path secret; no cross-origin mode is needed for HTMLAudio.
    audioRef.current = el;
    return () => {
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
      const current = store();
      const currentTrack =
        current.index >= 0 ? current.queue[current.index] : undefined;
      endedRadioSeedRef.current =
        current.autoRadio &&
        current.repeat === "off" &&
        current.index === current.queue.length - 1
          ? (currentTrack?.videoId ?? null)
          : null;
      current.next();
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
      if (import.meta.env.DEV) console.error("[audio] element error:", msg);

      const generation = activeMediaGenerationRef.current;
      if (generation >= 0) {
        handlePlaybackFailureRef.current(
          msg,
          generation,
          mediaErr?.code === 3 || mediaErr?.code === 4,
        );
      }
    };
    const onPlaying = () => {
      if (activeMediaGenerationRef.current !== loadGenerationRef.current) {
        return;
      }
      consecutiveErrorsRef.current = 0;
      // Track played successfully — allow a fresh auto-retry if it later
      // fails again (e.g. a mid-stream drop on a much later replay).
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

  // React to current-track changes and choose exactly one playback owner.
  const { videoId, track, index, loadRevision } = usePlaybackStore(
    useShallow((s) => {
      const t = s.index >= 0 ? s.queue[s.index] : undefined;
      return {
        videoId: t?.videoId,
        track: t,
        index: s.index,
        loadRevision: s.loadRevision,
      };
    }),
  );

  // Substitute the WebPlayer videoId via the user's per-track source
  // preference (Song ↔ Music Video). Subscribing here means the effect
  // below reloads the official page when the user toggles the source on the
  // currently playing track.
  const streamVideoId = useTrackSourceStore((s) =>
    videoId ? resolveStreamId(videoId, s.byVideoId) : undefined,
  );
  const playbackMode = track?.playbackMode ?? "online";
  const offlineVideoId =
    playbackMode === "offline" ? track?.offlineVideoId : undefined;
  const backend = usePlaybackStore((s) => s.backend);
  const webviewReady = usePlaybackStore((s) => s.webviewReady);
  const playing = usePlaybackStore((s) => s.playing);
  const premiumOk = usePremiumStore((s) => s.status === "premium");
  const offlinePlaybackAllowed = playbackMode !== "offline" || premiumOk;

  useEffect(() => {
    if (
      endedRadioSeedRef.current !== null &&
      endedRadioSeedRef.current !== videoId
    ) {
      endedRadioSeedRef.current = null;
    }
  }, [videoId, index]);

  failWebPlaybackRef.current = (message) => {
    if (webFailureInFlightRef.current) return;
    webFailureInFlightRef.current = true;
    if (webStartupTimerRef.current !== null) {
      window.clearTimeout(webStartupTimerRef.current);
      webStartupTimerRef.current = null;
    }
    webStartupPhaseRef.current = null;
    if (webRetriesRef.current === 0) {
      webRetriesRef.current = 1;
      selectionInProgressRef.current = true;
      const store = usePlaybackStore.getState();
      if (!store.advertisement && store.position > 0) {
        webRecoverySeekRef.current = store.position;
      }
      const failedGeneration = webGenerationRef.current;
      void resetWebPlayer()
        .then(() => {
          webFailureInFlightRef.current = false;
          const store = usePlaybackStore.getState();
          if (
            failedGeneration === webGenerationRef.current &&
            store.backend === "webview"
          ) {
            setWebRetryNonce((value) => value + 1);
          } else {
            selectionInProgressRef.current = false;
          }
        })
        .catch((error) => {
          webFailureInFlightRef.current = false;
          selectionInProgressRef.current = false;
          const detail = error instanceof Error ? error.message : String(error);
          const store = usePlaybackStore.getState();
          store.setStatus(
            "error",
            `Could not restart the official player: ${detail}`,
          );
          store.setPlaying(false);
        });
      return;
    }
    webFailureInFlightRef.current = false;
    selectionInProgressRef.current = false;
    const store = usePlaybackStore.getState();
    store.setBackend("webview", message);
    store.setStatus(
      "error",
      `The official YouTube Music player could not start. ${message}`,
    );
    store.setPlaying(false);
  };

  // Remote page -> authoritative playback store. The native bridge has
  // already validated origin, payload size, generation, and video ID.
  useEffect(() => {
    let cancelled = false;
    let dispose: (() => void) | undefined;
    void listen<WebPlaybackState>("web-player-state", ({ payload }) => {
      if (payload.generation !== webGenerationRef.current) return;
      const store = usePlaybackStore.getState();
      if (store.backend !== "webview" || selectionInProgressRef.current) return;
      if (payload.error) {
        failWebPlaybackRef.current(payload.error);
        return;
      }
      const recoverySeek =
        payload.ready && !payload.advertisement
          ? webRecoverySeekRef.current
          : null;
      // Drop position samples the official page produced before it applied a
      // requested seek. Without this the bar snaps back to the old time for a
      // few frames and then jumps forward again.
      const seekTarget = webSeekTargetRef.current;
      let positionIsAuthoritative = true;
      if (seekTarget) {
        if (isSeekHoldResolved(seekTarget, payload, Date.now())) {
          webSeekTargetRef.current = null;
        } else {
          positionIsAuthoritative = false;
        }
      }
      store.setWebviewState(payload.ready, payload.advertisement);
      if (!payload.advertisement) {
        if (payload.duration > 0) store.setDuration(payload.duration);
        if (recoverySeek === null && positionIsAuthoritative) {
          store.setPosition(payload.position);
        }
      }
      if (payload.advertisement) {
        // A healthy official-page advertisement has no arbitrary deadline.
        // Reloading after two minutes could terminate a legitimate long or
        // multi-ad break. Heartbeat/error handling still detects a dead page.
        if (webStartupTimerRef.current !== null) {
          window.clearTimeout(webStartupTimerRef.current);
          webStartupTimerRef.current = null;
        }
        webStartupPhaseRef.current = "advertisement";
      } else if (webStartupPhaseRef.current === "advertisement") {
        webStartupPhaseRef.current = "content";
        const generation = payload.generation;
        webStartupTimerRef.current = window.setTimeout(() => {
          if (generation === webGenerationRef.current) {
            failWebPlaybackRef.current(
              "Requested content did not start after the advertisement",
            );
          }
        }, 12_000);
      }
      // Advance before reconciling desired transport. Sending `play` to an
      // ended generation can briefly restart the old page (or the final song)
      // before the queue selection effect loads/stops the next owner.
      if (payload.ended && !payload.advertisement) {
        if (handledWebEndedGenerationRef.current === payload.generation) return;
        handledWebEndedGenerationRef.current = payload.generation;
        const current = store.index >= 0 ? store.queue[store.index] : undefined;
        endedRadioSeedRef.current =
          store.autoRadio &&
          store.repeat === "off" &&
          store.index === store.queue.length - 1
            ? (current?.videoId ?? null)
            : null;
        store.next();
        return;
      }
      if (payload.ready) {
        const startupSucceeded =
          !payload.advertisement && (payload.playing || !store.playing);
        if (startupSucceeded && webStartupTimerRef.current !== null) {
          window.clearTimeout(webStartupTimerRef.current);
          webStartupTimerRef.current = null;
          webStartupPhaseRef.current = null;
        }
        store.setStatus(
          payload.buffering || (store.playing && !payload.playing)
            ? "loading"
            : "ready",
        );
        if (!store.playing && payload.playing) {
          // The user can press Pause while a navigation/load is still in
          // flight. The load request necessarily carries an earlier snapshot
          // of the desired transport, so reconcile both directions once the
          // new document reports ready. Without this symmetric branch the
          // remote page could keep playing while Goosic's UI was paused.
          void controlWebPlayer(payload.generation, "pause").catch(() => {});
        } else if (
          store.playing &&
          !payload.playing &&
          !payload.buffering &&
          // A finished track is paused at its end. Resuming it there rewinds
          // the official page to zero and restarts the song Goosic is about to
          // advance past, so leave the transport alone until `ended` lands.
          !payload.finished
        ) {
          void controlWebPlayer(payload.generation, "play").catch(() => {});
        }
        if (recoverySeek !== null) {
          webRecoverySeekRef.current = null;
          webSeekTargetRef.current = {
            generation: payload.generation,
            position: recoverySeek,
            requestedAt: Date.now(),
          };
          void controlWebPlayer(payload.generation, "seek", recoverySeek)
            .then(() => {
              if (usePlaybackStore.getState().playing) {
                return controlWebPlayer(payload.generation, "play");
              }
            })
            .catch(() => {});
        }
      }
    }).then((unlisten) => {
      if (cancelled) unlisten();
      else dispose = unlisten;
    });
    return () => {
      cancelled = true;
      dispose?.();
    };
  }, []);

  // Account profiles are hard isolation boundaries. `login-success` fires as
  // soon as native code makes the new profile active, before account-menu
  // backfill can emit `accounts-changed`; reset immediately so failed/slow
  // metadata fetching can never leave the old account's player alive.
  useEffect(() => {
    let cancelled = false;
    const disposers: (() => void)[] = [];
    const isolatePlayer = (clearSelection: boolean) => {
      ++selectionEpochRef.current;
      ++webGenerationRef.current;
      ++resolveTokenRef.current;
      activeMediaGenerationRef.current = -1;
      selectionInProgressRef.current = true;
      setDirectActivation(null);
      webTrackKeyRef.current = null;
      webRetriesRef.current = 0;
      webFailureInFlightRef.current = false;
      webRecoverySeekRef.current = null;
      webSeekTargetRef.current = null;
      if (clearSelection) {
        usePlaybackStore.getState().clearQueue(true);
      }
      void resetWebPlayer()
        .then(() => {
          selectionInProgressRef.current = false;
          if (!clearSelection) setWebRetryNonce((value) => value + 1);
        })
        .catch((error) => {
          selectionInProgressRef.current = false;
          const detail = error instanceof Error ? error.message : String(error);
          const store = usePlaybackStore.getState();
          store.setStatus(
            "error",
            `Could not change playback account: ${detail}`,
          );
          store.setPlaying(false);
        });
    };
    void listen("login-success", () => isolatePlayer(true)).then((unlisten) => {
      if (cancelled) unlisten();
      else disposers.push(unlisten);
    });
    void listen("accounts-changed", () => isolatePlayer(true)).then(
      (unlisten) => {
        if (cancelled) unlisten();
        else disposers.push(unlisten);
      },
    );
    return () => {
      cancelled = true;
      for (const dispose of disposers) dispose();
    };
  }, []);

  // Online rows always use the official YouTube Music page. A local audio
  // element is selected only for queue rows created by an explicit
  // "Play downloaded" action and carrying the exact finalized file ID.
  useEffect(() => {
    const selectedVideoId =
      playbackMode === "offline" ? offlineVideoId : streamVideoId;
    const key = selectedVideoId
      ? `${playbackMode}:${selectedVideoId}:${loadRevision}`
      : null;
    if (key !== webTrackKeyRef.current) {
      webTrackKeyRef.current = key;
      webRetriesRef.current = 0;
      webFailureInFlightRef.current = false;
      webRecoverySeekRef.current = null;
      webSeekTargetRef.current = null;
    }
    const selection = ++selectionEpochRef.current;
    // Invalidate every pending local-file preflight before either owner can be
    // selected. A late offline response must never restore its src after an
    // online/account/entitlement transition.
    ++resolveTokenRef.current;
    activeMediaGenerationRef.current = -1;
    selectionInProgressRef.current = true;
    setDirectActivation(null);
    if (webStartupTimerRef.current !== null) {
      window.clearTimeout(webStartupTimerRef.current);
      webStartupTimerRef.current = null;
    }
    webStartupPhaseRef.current = null;
    // Stop both possible owners before probing. Backend is committed only
    // after the losing owner has relinquished audio.
    const el = audioRef.current;
    if (el) {
      el.pause();
      el.removeAttribute("src");
      el.load();
    }
    void controlWebPlayer(webGenerationRef.current, "pause").catch(() => {});
    if (!selectedVideoId || !key) {
      ++webGenerationRef.current;
      void resetWebPlayer()
        .then(() => {
          if (selection === selectionEpochRef.current) {
            selectionInProgressRef.current = false;
          }
        })
        .catch((error) => {
          if (selection !== selectionEpochRef.current) return;
          selectionInProgressRef.current = false;
          const detail = error instanceof Error ? error.message : String(error);
          const store = usePlaybackStore.getState();
          store.setStatus(
            "error",
            `Could not stop the official player: ${detail}`,
          );
          store.setPlaying(false);
        });
      return;
    }

    const store = usePlaybackStore.getState();
    // A persisted queue is restored paused with `status: idle`. Keep its card
    // visible, but do not contact YouTube or instantiate the remote playback
    // document until the user actually presses Play. User-driven selections
    // enter as `loading`, so a deliberately selected paused row still loads.
    if (
      playbackMode === "online" &&
      store.status === "idle" &&
      !store.playing
    ) {
      store.setBackend("webview");
      selectionInProgressRef.current = false;
      return;
    }
    store.setStatus("loading");
    store.setStreamUrl(undefined);
    store.setWebviewState(false, false);
    let disposed = false;
    void (async () => {
      if (playbackMode === "offline") {
        ++webGenerationRef.current;
        await resetWebPlayer();
        if (disposed || selection !== selectionEpochRef.current) return;
        if (!offlinePlaybackAllowed) {
          store.setBackend(
            "offline",
            "Premium is required for offline playback",
          );
          store.setStatus(
            "error",
            "Reconnect and verify YouTube Music Premium to play downloaded music.",
          );
          store.setPlaying(false);
          selectionInProgressRef.current = false;
          return;
        }
        store.setBackend("offline");
        setDirectActivation({
          videoId: selectedVideoId,
          selectionRevision: loadRevision,
          backend: "offline",
          sequence: ++directActivationSequenceRef.current,
        });
        selectionInProgressRef.current = false;
        return;
      }
      if (disposed || selection !== selectionEpochRef.current) return;
      const generation = ++webGenerationRef.current;
      handledWebEndedGenerationRef.current = null;
      store.setBackend("webview");
      await loadWebTrack({
        videoId: selectedVideoId,
        generation,
        playing: store.playing,
        volume: Math.max(0, Math.min(1, store.volume)) ** 3,
        muted: store.muted,
      });
      if (
        disposed ||
        selection !== selectionEpochRef.current ||
        generation !== webGenerationRef.current
      )
        return;
      selectionInProgressRef.current = false;
      // `playing` may have changed while native code was creating or
      // navigating the WebView. Re-apply the latest store intent after the
      // generation is committed instead of trusting the snapshot passed to
      // `loadWebTrack`. The ready-state listener above repeats this check in
      // case this eval lands before the new document's observer initializes.
      const desiredPlaying = usePlaybackStore.getState().playing;
      void controlWebPlayer(
        generation,
        desiredPlaying ? "play" : "pause",
      ).catch((error) => {
        if (
          desiredPlaying &&
          generation === webGenerationRef.current &&
          usePlaybackStore.getState().playing
        ) {
          failWebPlaybackRef.current(
            error instanceof Error ? error.message : String(error),
          );
        }
      });
      if (webStartupTimerRef.current !== null) {
        window.clearTimeout(webStartupTimerRef.current);
      }
      webStartupPhaseRef.current = "content";
      webStartupTimerRef.current = window.setTimeout(() => {
        if (generation === webGenerationRef.current) {
          failWebPlaybackRef.current("Official player startup timed out");
        }
      }, 12_000);
    })().catch((error) => {
      if (disposed || selection !== selectionEpochRef.current) return;
      selectionInProgressRef.current = false;
      const detail = error instanceof Error ? error.message : String(error);
      if (playbackMode === "offline") {
        store.setStatus("error", `Could not open downloaded audio: ${detail}`);
        store.setPlaying(false);
      } else {
        failWebPlaybackRef.current(detail);
      }
    });
    const cleanupResolveTokenRef = resolveTokenRef;
    return () => {
      disposed = true;
      ++cleanupResolveTokenRef.current;
      activeMediaGenerationRef.current = -1;
      if (webStartupTimerRef.current !== null) {
        window.clearTimeout(webStartupTimerRef.current);
        webStartupTimerRef.current = null;
      }
      webStartupPhaseRef.current = null;
    };
  }, [
    streamVideoId,
    offlineVideoId,
    playbackMode,
    loadRevision,
    webRetryNonce,
    offlinePlaybackAllowed,
  ]);

  // A live native window is not enough: an off-screen WebView can suspend or
  // lose its content process while still existing in Tauri. Once bridge state
  // has made the player ready, require a recent generation-scoped heartbeat.
  useEffect(() => {
    if (backend !== "webview" || !playing || !webviewReady) return;
    let cancelled = false;
    let checking = false;
    const check = async () => {
      if (checking) return;
      checking = true;
      const healthy = await isWebPlayerHealthy().catch(() => false);
      checking = false;
      if (cancelled) return;
      const store = usePlaybackStore.getState();
      if (
        !healthy &&
        store.backend === "webview" &&
        store.playing &&
        store.webviewReady
      ) {
        failWebPlaybackRef.current("Official player stopped responding");
      }
    };
    const timer = window.setInterval(() => void check(), 4_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [backend, playing, webviewReady]);

  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    if (
      !directActivation ||
      directActivation.videoId !== offlineVideoId ||
      directActivation.selectionRevision !== loadRevision
    ) {
      ++resolveTokenRef.current;
      activeMediaGenerationRef.current = -1;
      el.pause();
      el.removeAttribute("src");
      el.load();
      return;
    }
    const activeBackend = directActivation.backend;
    if (usePlaybackStore.getState().backend !== activeBackend) return;
    const token = ++resolveTokenRef.current;
    const generation = ++loadGenerationRef.current;
    activeMediaGenerationRef.current = -1;
    handledFailureGenerationRef.current = -1;
    // Stop the previous local file before the cache-only preflight so two
    // downloaded tracks can never overlap during a quick queue change.
    el.pause();
    if (!offlineVideoId) {
      el.removeAttribute("src");
      el.load();
      usePlaybackStore.getState().setStreamUrl(undefined);
      return;
    }
    // Drop the previous track's src immediately. Otherwise a paused→playing
    // transition committed together with the track change (playNow/goTo set
    // playing: true) makes the [playing] effect below re-play the OLD src
    // while the cache-only preflight is still running.
    el.removeAttribute("src");

    usePlaybackStore.getState().setStatus("loading");

    // Playback goes through the cache-only local HTTP route. Its one-byte
    // Range preflight proves the exact finalized file remains valid; this path
    // can never start yt-dlp or repair/download implicitly.
    offlineStreamUrlFor(offlineVideoId)
      .then((src) => {
        if (token !== resolveTokenRef.current) return;
        const currentStore = usePlaybackStore.getState();
        const currentTrack =
          currentStore.index >= 0
            ? currentStore.queue[currentStore.index]
            : undefined;
        if (
          currentStore.backend !== "offline" ||
          (currentTrack?.playbackMode ?? "online") !== "offline" ||
          currentTrack?.offlineVideoId !== offlineVideoId ||
          usePremiumStore.getState().status !== "premium"
        )
          return;
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
              e?.name === "NotSupportedError",
            );
          });
        }
      })
      .catch((e: Error) => {
        if (token !== resolveTokenRef.current) return;
        handlePlaybackFailureRef.current(
          e.message,
          generation,
          isDefinitiveOfflineFileFailure(e),
        );
      });
    const cleanupResolveTokenRef = resolveTokenRef;
    return () => {
      if (cleanupResolveTokenRef.current === token) {
        ++cleanupResolveTokenRef.current;
      }
      activeMediaGenerationRef.current = -1;
    };
  }, [offlineVideoId, loadRevision, directActivation]);

  // Play / pause follow store.
  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    const wasPlaying = previousDesiredPlayingRef.current;
    previousDesiredPlayingRef.current = playing;
    if (selectionInProgressRef.current) return;
    if (backend === "webview") {
      const store = usePlaybackStore.getState();
      if (playing && store.status === "idle") {
        store.setStatus("loading");
        setWebRetryNonce((value) => value + 1);
        return;
      }
      if (playing && store.status === "error") {
        selectionInProgressRef.current = true;
        webRetriesRef.current = 0;
        webFailureInFlightRef.current = false;
        webRecoverySeekRef.current = null;
        webSeekTargetRef.current = null;
        void resetWebPlayer()
          .then(() => {
            selectionInProgressRef.current = false;
            setWebRetryNonce((value) => value + 1);
          })
          .catch((error) => {
            selectionInProgressRef.current = false;
            const detail =
              error instanceof Error ? error.message : String(error);
            store.setStatus(
              "error",
              `Could not restart the official player: ${detail}`,
            );
            store.setPlaying(false);
          });
        return;
      }
      const generation = webGenerationRef.current;
      if (
        playing &&
        !wasPlaying &&
        !store.advertisement &&
        store.status !== "idle" &&
        store.status !== "error"
      ) {
        store.setStatus("loading");
        if (webStartupTimerRef.current !== null) {
          window.clearTimeout(webStartupTimerRef.current);
        }
        webStartupPhaseRef.current = "content";
        webStartupTimerRef.current = window.setTimeout(() => {
          if (
            generation === webGenerationRef.current &&
            usePlaybackStore.getState().playing
          ) {
            failWebPlaybackRef.current(
              "Official player did not resume the requested content",
            );
          }
        }, 12_000);
      }
      void controlWebPlayer(generation, playing ? "play" : "pause").catch(
        (error) => {
          // A rejected resume is actionable; without this, healthy bridge
          // heartbeats could leave the UI loading forever. Pausing and ad
          // transport remain governed by subsequent authoritative samples.
          if (
            playing &&
            generation === webGenerationRef.current &&
            !usePlaybackStore.getState().advertisement
          ) {
            failWebPlaybackRef.current(
              error instanceof Error ? error.message : String(error),
            );
          }
        },
      );
      return;
    }
    if (!el.src) return;
    if (playing) {
      const generation = activeMediaGenerationRef.current;
      void el.play().catch((e) => {
        if (e?.name === "AbortError") return;
        handlePlaybackFailureRef.current(
          e?.message ?? String(e),
          generation,
          e?.name === "NotSupportedError",
        );
      });
    } else {
      el.pause();
    }
  }, [playing, backend]);

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
    if (backend === "webview") {
      void controlWebPlayer(
        webGenerationRef.current,
        "volume",
        clamped ** 3,
      ).catch(() => {});
      void controlWebPlayer(
        webGenerationRef.current,
        "mute",
        muted ? 1 : 0,
      ).catch(() => {});
    }
  }, [volume, muted, backend]);

  // Handle seek requests.
  const pendingSeek = usePlaybackStore((s) => s.pendingSeek);
  useEffect(() => {
    const el = audioRef.current;
    if (!el || pendingSeek === undefined) return;
    if (backend === "webview") {
      if (!usePlaybackStore.getState().advertisement) {
        const generation = webGenerationRef.current;
        webSeekTargetRef.current = {
          generation,
          position: pendingSeek,
          requestedAt: Date.now(),
        };
        void controlWebPlayer(generation, "seek", pendingSeek)
          .then(() => {
            if (usePlaybackStore.getState().playing) {
              return controlWebPlayer(generation, "play");
            }
          })
          .catch(() => {
            // The page never received the seek, so nothing will confirm the
            // held position — let live samples drive the bar again.
            if (webSeekTargetRef.current?.generation === generation) {
              webSeekTargetRef.current = null;
            }
          });
      }
      usePlaybackStore.getState().clearPendingSeek();
      return;
    }
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
        handlePlaybackFailureRef.current(
          e?.message ?? String(e),
          generation,
          e?.name === "NotSupportedError",
        );
      });
    }
  }, [pendingSeek, backend]);

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

  // Auto-extend the queue with radio tracks when we're near the end, so
  // playback continues past the explicit queue.
  const autoRadio = usePlaybackStore((s) => s.autoRadio);
  const { qLen, qIndex, seedVideoId, repeat, radioQueueRevision } =
    usePlaybackStore(
      useShallow((s) => ({
        qLen: s.queue.length,
        qIndex: s.index,
        seedVideoId: s.index >= 0 ? s.queue[s.index]?.videoId : undefined,
        repeat: s.repeat,
        radioQueueRevision: s.loadRevision,
      })),
    );
  const radioFetchedForRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!autoRadio || repeat !== "off") {
      radioFetchedForRef.current = undefined;
      endedRadioSeedRef.current = null;
      return;
    }
    if (qIndex < 0 || !seedVideoId) return;
    // Only fire when the current track is the last queued one.
    if (qIndex < qLen - 1) return;
    // Loop takes priority over radio: never extend the queue while repeat
    // is on, so `next()`'s own loop logic wins instead of racing with us.
    const requestKey = `${seedVideoId}:${radioQueueRevision}`;
    if (radioFetchedForRef.current === requestKey) return;
    radioFetchedForRef.current = requestKey;
    fetchRadio(seedVideoId)
      .then((tracks) => {
        // Guard against a stale fetch: the user may have replaced the queue
        // (playNow/setQueue) while the radio request was in flight. Only
        // append if this seed is still the current, last-in-queue track.
        const s = usePlaybackStore.getState();
        const cur = s.index >= 0 ? s.queue[s.index]?.videoId : undefined;
        if (
          !s.autoRadio ||
          s.repeat !== "off" ||
          s.loadRevision !== radioQueueRevision ||
          cur !== seedVideoId ||
          s.index < s.queue.length - 1
        ) {
          if (radioFetchedForRef.current === requestKey) {
            radioFetchedForRef.current = undefined;
          }
          if (endedRadioSeedRef.current === seedVideoId) {
            endedRadioSeedRef.current = null;
          }
          return;
        }
        const rest = tracks.filter((t) => t.id !== seedVideoId);
        if (rest.length) {
          s.appendToQueue(rest, "autoplay");
          const afterAppend = usePlaybackStore.getState();
          const stillOnSeed =
            afterAppend.index >= 0 &&
            afterAppend.queue[afterAppend.index]?.videoId === seedVideoId;
          if (
            endedRadioSeedRef.current === seedVideoId &&
            stillOnSeed &&
            !afterAppend.playing
          ) {
            endedRadioSeedRef.current = null;
            afterAppend.next();
          }
        } else if (endedRadioSeedRef.current === seedVideoId) {
          endedRadioSeedRef.current = null;
        }
      })
      .catch(() => {
        // Allow a retry on transient failure.
        if (radioFetchedForRef.current === requestKey) {
          radioFetchedForRef.current = undefined;
        }
        if (endedRadioSeedRef.current === seedVideoId) {
          endedRadioSeedRef.current = null;
        }
      });
  }, [autoRadio, qIndex, qLen, seedVideoId, repeat, radioQueueRevision]);

  // Push metadata + playback state to the OS media controls (Windows SMTC).
  // Windows interpolates the scrubber between pushes while the state is
  // Playing, so we don't push on every timeupdate — just on track / play-state
  // / duration change, plus a light 2s refresh while playing to correct drift
  // and reflect seeks. Live values are read imperatively so this OS sync never
  // re-triggers the resolve / playback effects above.
  const duration = usePlaybackStore((s) => s.duration);
  const status = usePlaybackStore((s) => s.status);
  const advertisement = usePlaybackStore((s) => s.advertisement);
  useEffect(() => {
    const push = () => {
      const s = usePlaybackStore.getState();
      const t = s.index >= 0 ? s.queue[s.index] : undefined;
      // The requested song is not the media currently producing sound while
      // YouTube is showing an advertisement or while its document is still
      // buffering. Clear OS metadata instead of falsely claiming that song is
      // playing; it is restored as soon as requested content is ready.
      if (!t || s.advertisement || s.status !== "ready") {
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
    if (!playing || advertisement || status !== "ready") return;
    const id = window.setInterval(push, 2000);
    return () => window.clearInterval(id);
  }, [track, playing, duration, status, advertisement]);

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
    if (!t || s.advertisement || s.status !== "ready") {
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
  }, [track, playing, duration, status, advertisement, discordRp]);
}

function buildArtistLabel(track: QueueTrack): string {
  if (track.artists?.length) return track.artists.map((a) => a.name).join(", ");
  return track.subtitle ?? "";
}
