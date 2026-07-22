import { create, type StateCreator } from "zustand";
import { persist } from "zustand/middleware";
import { emit } from "@tauri-apps/api/event";
import type { ShelfItem, Thumbnail } from "@/lib/innertube/types";
import { isFloatingPlayerWindow } from "@/lib/floating-player";

export type QueueTrack = {
  videoId: string;
  /** Online is the default for old persisted queues and every normal click. */
  playbackMode?: "online" | "offline";
  /**
   * Finalized local file selected by an explicit "Play downloaded" action.
   * Ordinary queue rows never carry this field and therefore always use the
   * official YouTube Music WebPlayer.
   */
  offlineVideoId?: string;
  title: string;
  subtitle?: string;
  artists?: { id?: string; name: string }[];
  album?: string;
  albumId?: string;
  thumbnails: Thumbnail[];
  /** Original duration from browse responses, may be undefined until /player resolves. */
  duration?: number;
  /** Whether this entry was chosen by the user or appended by autoplay. */
  source?: "user" | "autoplay";
};

export type RepeatMode = "off" | "all" | "one";

export type LoadStatus = "idle" | "loading" | "ready" | "error";
export type PlaybackBackend = "webview" | "offline";

export type PlaybackState = {
  // Queue
  queue: QueueTrack[];
  index: number;
  shuffle: boolean;
  repeat: RepeatMode;

  // Current track status
  status: LoadStatus;
  error?: string;
  /** Resolved stream URL for the current track (set by AudioEngine). */
  streamUrl?: string;
  /** Engine currently responsible for the active track. */
  backend: PlaybackBackend;
  webviewReady: boolean;
  advertisement: boolean;
  backendError?: string;
  /**
   * Volatile playback-selection revision. It advances when the intended queue
   * entry changes (including duplicate video IDs), but not when a queue edit
   * merely moves that same entry to another index.
   */
  loadRevision: number;

  // Transport
  playing: boolean;
  /** 0..1 — store as fraction; UI can scale. */
  volume: number;
  muted: boolean;
  /** Current playhead, seconds. */
  position: number;
  /** Real duration (from audio element, once loaded). */
  duration: number;
  /** When the user drags the slider, we seek here on release. */
  pendingSeek?: number;

  /** When true, auto-append radio tracks to the queue when the last one ends. */
  autoRadio: boolean;

  // Actions — queue
  playNow: (track: QueueTrack | ShelfItem, extras?: QueueTrack[]) => void;
  setQueue: (tracks: QueueTrack[], startIndex?: number) => void;
  playShelfItems: (items: ShelfItem[], startIndex: number) => void;
  enqueueNext: (track: QueueTrack | ShelfItem) => void;
  enqueueEnd: (track: QueueTrack | ShelfItem) => void;
  appendToQueue: (
    tracks: (QueueTrack | ShelfItem)[],
    source?: QueueTrack["source"],
  ) => void;
  removeAt: (index: number) => void;
  moveTrack: (from: number, to: number) => void;
  clearQueue: (force?: boolean) => void;
  setAutoRadio: (on: boolean) => void;

  // Actions — transport
  toggle: () => void;
  setPlaying: (playing: boolean) => void;
  next: () => void;
  prev: () => void;
  goTo: (index: number) => void;

  // Actions — status (used by AudioEngine)
  setStatus: (status: LoadStatus, error?: string) => void;
  setStreamUrl: (url?: string) => void;
  setBackend: (backend: PlaybackBackend, error?: string) => void;
  setWebviewState: (ready: boolean, advertisement: boolean) => void;
  setPosition: (position: number) => void;
  setDuration: (duration: number) => void;
  seek: (seconds: number) => void;
  clearPendingSeek: () => void;

  // Actions — volume
  setVolume: (volume: number) => void;
  toggleMute: () => void;
  setShuffle: (on: boolean) => void;
  cycleRepeat: () => void;
};

function normalizeQueueTrack(track: QueueTrack): QueueTrack {
  return {
    ...track,
    thumbnails: Array.isArray(track.thumbnails) ? track.thumbnails : [],
  };
}

function shelfItemToTrack(item: ShelfItem | QueueTrack): QueueTrack | null {
  if ("videoId" in item) {
    return normalizeQueueTrack(item);
  }
  if (item.kind !== "song" && item.kind !== "video") return null;
  return {
    videoId: item.id,
    title: item.title,
    subtitle: item.subtitle,
    artists: item.artists,
    album: item.album,
    albumId: item.albumId,
    thumbnails: Array.isArray(item.thumbnails) ? item.thumbnails : [],
    duration: item.duration,
  };
}

function fisherYates<T>(arr: readonly T[]): T[] {
  const result = arr.slice();
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

const playbackStateCreator: StateCreator<PlaybackState> = (set, get) => ({
  queue: [],
  index: -1,
  shuffle: false,
  repeat: "off",
  autoRadio: false,

  status: "idle",
  error: undefined,
  streamUrl: undefined,
  backend: "webview",
  webviewReady: false,
  advertisement: false,
  backendError: undefined,
  loadRevision: 0,

  playing: false,
  volume: 0.8,
  muted: false,
  position: 0,
  duration: 0,
  pendingSeek: undefined,

  playNow: (track, extras) => {
    if (get().advertisement) return;
    const mapped = shelfItemToTrack(track);
    if (!mapped) return;
    // Re-clicking the current row starts a new playback instance. The native
    // WebPlayer accepts exactly one terminal event per generation, so a pure
    // seek would make the next completion invisible after a replay. Reloading
    // the same row is also the unambiguous behavior for an ended local file.
    const {
      queue: curQueue,
      index: curIndex,
      status,
      streamUrl,
      backend,
      webviewReady,
    } = get();
    const current = curIndex >= 0 ? curQueue[curIndex] : undefined;
    if (
      current?.videoId === mapped.videoId &&
      (current.playbackMode ?? "online") ===
        (mapped.playbackMode ?? "online") &&
      current.offlineVideoId === mapped.offlineVideoId &&
      status !== "error" &&
      (streamUrl || (backend === "webview" && webviewReady))
    ) {
      set({
        position: 0,
        pendingSeek: undefined,
        playing: true,
        status: "loading",
        streamUrl: undefined,
        error: undefined,
        loadRevision: get().loadRevision + 1,
      });
      return;
    }
    let queue = extras?.length
      ? [mapped, ...extras.filter((t) => t.videoId !== mapped.videoId)]
      : [mapped];
    queue = queue.map((t) => ({ ...t, source: "user" }));
    // Honour an active shuffle for the trailing tracks (current stays first).
    if (get().shuffle && queue.length > 1) {
      queue = [queue[0], ...fisherYates(queue.slice(1))];
    }
    set({
      queue,
      index: 0,
      status: "loading",
      streamUrl: undefined,
      position: 0,
      duration: mapped.duration ?? 0,
      playing: true,
      error: undefined,
      loadRevision: get().loadRevision + 1,
    });
  },

  setQueue: (tracks, startIndex = 0) => {
    if (get().advertisement) return;
    if (tracks.length === 0) return;
    const i = Math.max(0, Math.min(startIndex, tracks.length - 1));
    // Honour an active shuffle: keep the chosen track current and shuffle
    // the upcoming portion, matching setShuffle's semantics.
    let queue = tracks.map((track) => ({
      ...normalizeQueueTrack(track),
      source: track.source ?? "user",
    }));
    if (get().shuffle) {
      queue = [...queue.slice(0, i + 1), ...fisherYates(queue.slice(i + 1))];
    }
    set({
      queue,
      index: i,
      status: "loading",
      streamUrl: undefined,
      position: 0,
      duration: queue[i].duration ?? 0,
      playing: true,
      error: undefined,
      loadRevision: get().loadRevision + 1,
    });
  },

  playShelfItems: (items, startIndex) => {
    if (get().advertisement) return;
    const tracks: QueueTrack[] = [];
    for (const it of items) {
      const m = shelfItemToTrack(it);
      if (m) tracks.push(m);
    }
    if (tracks.length === 0) return;
    // If the user clicked a non-playable item, find the nearest playable one.
    const playableOffset =
      items
        .slice(0, startIndex + 1)
        .filter((i) => i.kind === "song" || i.kind === "video").length - 1;
    get().setQueue(tracks, Math.max(0, playableOffset));
  },

  enqueueNext: (track) => {
    const mapped = shelfItemToTrack(track);
    if (!mapped) return;
    mapped.source = "user";
    set((s) => {
      const next = [...s.queue];
      const insertAt = s.index < 0 ? 0 : s.index + 1;
      next.splice(insertAt, 0, mapped);
      return { queue: next };
    });
  },

  enqueueEnd: (track) => {
    const mapped = shelfItemToTrack(track);
    if (!mapped) return;
    set((s) => ({ queue: [...s.queue, { ...mapped, source: "user" }] }));
  },

  appendToQueue: (tracks, source = "user") => {
    const mapped: QueueTrack[] = [];
    for (const t of tracks) {
      const m = shelfItemToTrack(t);
      if (m) mapped.push({ ...m, source });
    }
    if (!mapped.length) return;
    set((s) => ({ queue: [...s.queue, ...mapped] }));
  },

  removeAt: (i) => {
    // Removing the current row or any earlier row changes the active index.
    // Keep current-or-history removal locked during an ad. The current row
    // would select another playback instance, and conservative history locks
    // avoid exposing queue mutations while the official page owns the break.
    if (get().advertisement && i <= get().index) return;
    set((s) => {
      if (i < 0 || i >= s.queue.length) return s;
      const next = s.queue.slice();
      next.splice(i, 1);
      // If we removed the current track, advance to what's now at the same
      // index (or stay if nothing left).
      let newIndex = s.index;
      if (i < s.index) newIndex = s.index - 1;
      else if (i === s.index) {
        if (next.length === 0) {
          return {
            queue: next,
            index: -1,
            playing: false,
            status: "idle",
            streamUrl: undefined,
            position: 0,
            duration: 0,
            loadRevision: s.loadRevision + 1,
          };
        }
        newIndex = Math.min(s.index, next.length - 1);
        // Reload the new current track.
        return {
          queue: next,
          index: newIndex,
          status: "loading",
          streamUrl: undefined,
          position: 0,
          duration: next[newIndex].duration ?? 0,
          loadRevision: s.loadRevision + 1,
        };
      }
      return { queue: next, index: newIndex };
    });
  },

  moveTrack: (from, to) => {
    set((s) => {
      if (from === to) return s;
      if (from < 0 || from >= s.queue.length) return s;
      if (to < 0 || to >= s.queue.length) return s;
      if (
        s.advertisement &&
        (from === s.index ||
          (from < s.index && to >= s.index) ||
          (from > s.index && to <= s.index))
      )
        return s;
      const next = s.queue.slice();
      const [item] = next.splice(from, 1);
      next.splice(to, 0, item);
      // Keep the same track current after reorder. If the active track
      // itself is the one being moved, follow it to its new position.
      // Otherwise, account for items shifting around it.
      let newIndex = s.index;
      if (from === s.index) {
        newIndex = to;
      } else if (from < s.index && to >= s.index) {
        newIndex = s.index - 1;
      } else if (from > s.index && to <= s.index) {
        newIndex = s.index + 1;
      }
      return { queue: next, index: newIndex };
    });
  },

  clearQueue: (force = false) => {
    if (get().advertisement && !force) return;
    set({
      queue: [],
      index: -1,
      status: "idle",
      streamUrl: undefined,
      playing: false,
      position: 0,
      duration: 0,
      loadRevision: get().loadRevision + 1,
    });
  },

  setAutoRadio: (on) => set({ autoRadio: on }),

  toggle: () => {
    const { queue, playing, status } = get();
    if (queue.length === 0) return;
    if (!playing && status === "idle") {
      set({
        playing: true,
        status: "loading",
        loadRevision: get().loadRevision + 1,
      });
      return;
    }
    set({ playing: !playing });
  },

  setPlaying: (playing) => {
    const state = get();
    if (
      playing &&
      !state.playing &&
      state.status === "idle" &&
      state.index >= 0
    ) {
      set({
        playing: true,
        status: "loading",
        loadRevision: state.loadRevision + 1,
      });
      return;
    }
    set({ playing });
  },

  next: () => {
    const { queue, index, repeat, shuffle, advertisement } = get();
    if (advertisement) return;
    if (queue.length === 0) return;
    // Replaying the current slot must create a fresh playback generation.
    // Native terminal delivery is deliberately one-shot per generation; a
    // seek-only replay would make the second completion disappear.
    if (repeat === "one" || (repeat === "all" && queue.length === 1)) {
      set({
        position: 0,
        pendingSeek: undefined,
        playing: true,
        status: "loading",
        streamUrl: undefined,
        loadRevision: get().loadRevision + 1,
      });
      return;
    }
    let nextQueue = queue;
    let nextIndex = index + 1;
    if (nextIndex >= queue.length) {
      if (repeat !== "all") {
        // Mark the exhausted instance idle. A later Play action then takes
        // the WebPlayer's bounded load path and receives a new generation,
        // instead of trying to reuse a terminal generation.
        set({ playing: false, position: 0, status: "idle" });
        return;
      }
      // Looping with shuffle on → reshuffle so the next pass isn't identical.
      nextQueue = shuffle && queue.length > 1 ? fisherYates(queue) : queue;
      nextIndex = 0;
    }
    const track = nextQueue[nextIndex];
    set({
      queue: nextQueue,
      index: nextIndex,
      status: "loading",
      streamUrl: undefined,
      position: 0,
      duration: track.duration ?? 0,
      playing: true,
      error: undefined,
      loadRevision: get().loadRevision + 1,
    });
  },

  prev: () => {
    const { queue, index, position, advertisement } = get();
    if (advertisement) return;
    if (queue.length === 0) return;
    // If >3s in OR already on the first track, just rewind. Without the
    // index===0 guard the old code would set status=loading and re-resolve
    // the same stream, flashing the loader spinner for no reason.
    if (index <= 0 || position > 3) {
      if (index >= 0) set({ position: 0, pendingSeek: 0 });
      return;
    }
    const prevIndex = index - 1;
    const track = queue[prevIndex];
    set({
      index: prevIndex,
      status: "loading",
      streamUrl: undefined,
      position: 0,
      duration: track.duration ?? 0,
      playing: true,
      error: undefined,
      loadRevision: get().loadRevision + 1,
    });
  },

  goTo: (i) => {
    const { queue, index, advertisement, status } = get();
    if (advertisement) return;
    if (i < 0 || i >= queue.length) return;
    if (i === index) {
      if (status === "ready") {
        set((state) => ({
          position: 0,
          pendingSeek: undefined,
          playing: true,
          status: "loading",
          streamUrl: undefined,
          error: undefined,
          loadRevision: state.loadRevision + 1,
        }));
      } else if (status === "loading") {
        set({ playing: true });
      } else {
        set((state) => ({
          status: "loading",
          error: undefined,
          playing: true,
          position: 0,
          loadRevision: state.loadRevision + 1,
        }));
      }
      return;
    }
    const track = queue[i];
    set({
      index: i,
      status: "loading",
      streamUrl: undefined,
      position: 0,
      duration: track.duration ?? 0,
      playing: true,
      error: undefined,
      loadRevision: get().loadRevision + 1,
    });
  },

  setStatus: (status, error) => set({ status, error }),
  setStreamUrl: (streamUrl) => set({ streamUrl }),
  setBackend: (backend, backendError) =>
    set({ backend, backendError, webviewReady: false, advertisement: false }),
  setWebviewState: (webviewReady, advertisement) =>
    set({ webviewReady, advertisement }),
  setPosition: (position) => set({ position }),
  setDuration: (duration) => set({ duration }),
  seek: (seconds) => {
    if (get().advertisement) return;
    set({ pendingSeek: Math.max(0, seconds), position: seconds });
  },
  clearPendingSeek: () => set({ pendingSeek: undefined }),

  setVolume: (volume) => {
    if (get().advertisement) return;
    set({ volume: Math.max(0, Math.min(1, volume)), muted: false });
  },
  toggleMute: () => {
    if (get().advertisement) return;
    set((s) => ({ muted: !s.muted }));
  },
  setShuffle: (on) => {
    set((s) => {
      if (!on) return { shuffle: false };
      if (s.queue.length === 0) return { shuffle: true };
      // Fisher-Yates the upcoming portion. The current track stays put and
      // history is left in original playback order so prev() walks back
      // through tracks the user actually heard.
      const after = Math.max(0, s.index + 1);
      const head = s.queue.slice(0, after);
      const tail = fisherYates(s.queue.slice(after));
      return { shuffle: true, queue: [...head, ...tail] };
    });
  },
  cycleRepeat: () =>
    set((s) => ({
      repeat: s.repeat === "off" ? "all" : s.repeat === "all" ? "one" : "off",
    })),
});

// Persist only in the main window. The floating window is a *mirror* of
// the main store fed by Tauri events — letting it independently rehydrate
// from localStorage would race the main side and clobber the user's real
// state with whatever was last saved before the crash.
export const usePlaybackStore = isFloatingPlayerWindow()
  ? create<PlaybackState>()(playbackStateCreator)
  : create<PlaybackState>()(
      persist(playbackStateCreator, {
        name: "ytm-playback",
        version: 2,
        migrate: (persisted) => {
          const state = persisted as Partial<PlaybackState>;
          const queue = Array.isArray(state.queue)
            ? state.queue.map(normalizeQueueTrack)
            : [];
          const index =
            queue.length === 0
              ? -1
              : Math.max(0, Math.min(state.index ?? 0, queue.length - 1));
          return { ...state, queue, index } as PlaybackState;
        },
        // Only the user-facing settings + the queue itself are saved.
        // Volatile fields (position, status, streamUrl, error,
        // pendingSeek) and `playing` are reset on rehydrate so a fresh
        // launch never auto-blasts audio at you.
        partialize: (s) => ({
          queue: s.queue,
          index: s.index,
          shuffle: s.shuffle,
          repeat: s.repeat,
          autoRadio: s.autoRadio,
          volume: s.volume,
          muted: s.muted,
        }),
        onRehydrateStorage: () => (state) => {
          if (!state) return;
          state.playing = false;
          state.position = 0;
          state.duration = state.queue[state.index]?.duration ?? 0;
          state.status = "idle";
          state.streamUrl = undefined;
          state.backend = "webview";
          state.webviewReady = false;
          state.advertisement = false;
          state.backendError = undefined;
          state.loadRevision = 0;
          state.pendingSeek = undefined;
          state.error = undefined;
        },
      }),
    );

/** Convenience selector for the currently-playing track (or undefined). */
export function currentTrack(state: PlaybackState): QueueTrack | undefined {
  if (state.index < 0 || state.index >= state.queue.length) return undefined;
  return state.queue[state.index];
}

/**
 * Floating-window remote control. The standalone player window can't
 * actually play audio (the engine lives in the main window), so its
 * copy of the store has its user-action callbacks rewritten to emit
 * Tauri events. The main window's `<FloatingPlayerSync>` listens for
 * those, dispatches them against its own (authoritative) store, and
 * the resulting state changes broadcast back as `playback:state`
 * events that overwrite the floater's local mirror.
 *
 * State-mutating actions invoked by the audio engine (`setStatus`,
 * `setPosition`, `setStreamUrl`, `setDuration`, `setPlaying`,
 * `clearPendingSeek`) are left untouched — the engine doesn't run in
 * the floater so nothing in this window ever calls them. The
 * `FloatingPlayerSyncReceiver` writes those fields directly via
 * `setState` when state events arrive.
 *
 * Some actions (`seek`, `setVolume`, `toggleMute`) also do an
 * optimistic local update so the corresponding slider/icon doesn't
 * jump back for the round-trip.
 *
 * Call this from the floating window's entrypoint module before any
 * component reads from the store. Guarded so an accidental call from
 * the main window's bundle (it statically imports the floating module)
 * is a no-op — without this guard the main window's Play/Pause button
 * would emit an unhandled event and silently do nothing.
 */
export function initFloatingPlaybackBridge(): void {
  if (!isFloatingPlayerWindow()) return;
  const sendAction = (action: Record<string, unknown>) => {
    void emit("playback:action", action);
  };
  usePlaybackStore.setState({
    toggle: () => sendAction({ type: "toggle" }),
    next: () => sendAction({ type: "next" }),
    prev: () => sendAction({ type: "prev" }),
    seek: (seconds) => {
      if (usePlaybackStore.getState().advertisement) return;
      usePlaybackStore.setState({ position: Math.max(0, seconds) });
      sendAction({ type: "seek", seconds });
    },
    setVolume: (volume) => {
      if (usePlaybackStore.getState().advertisement) return;
      const clamped = Math.max(0, Math.min(1, volume));
      usePlaybackStore.setState({ volume: clamped, muted: false });
      sendAction({ type: "setVolume", volume: clamped });
    },
    toggleMute: () => {
      if (usePlaybackStore.getState().advertisement) return;
      usePlaybackStore.setState((s) => ({ muted: !s.muted }));
      sendAction({ type: "toggleMute" });
    },
    setShuffle: (on) => sendAction({ type: "setShuffle", on }),
    cycleRepeat: () => sendAction({ type: "cycleRepeat" }),
    goTo: (index) => sendAction({ type: "goTo", index }),
    removeAt: (index) => sendAction({ type: "removeAt", index }),
    moveTrack: (from, to) => sendAction({ type: "moveTrack", from, to }),
    clearQueue: () => sendAction({ type: "clearQueue" }),
    appendToQueue: (tracks) =>
      sendAction({ type: "appendToQueue", tracks: tracks as unknown[] }),
    setAutoRadio: (on) => sendAction({ type: "setAutoRadio", on }),
    // Queue-building actions reachable from the floater's ⋮ menu (Play,
    // Play next, Add to queue, Start radio). Without these overrides they
    // mutated only the floater's mirror store — nothing actually played and
    // the queue silently diverged until the next broadcast overwrote it.
    playNow: (track, extras) =>
      sendAction({
        type: "playNow",
        track: track as unknown,
        extras: extras as unknown,
      }),
    playShelfItems: (items, startIndex) =>
      sendAction({
        type: "playShelfItems",
        items: items as unknown[],
        startIndex,
      }),
    enqueueNext: (track) =>
      sendAction({ type: "enqueueNext", track: track as unknown }),
    enqueueEnd: (track) =>
      sendAction({ type: "enqueueEnd", track: track as unknown }),
  });
}
