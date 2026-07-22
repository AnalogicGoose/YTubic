import { beforeEach, describe, expect, it } from "vitest";
import type { PlaybackState, QueueTrack } from "@/lib/store/playback";
import type { ShelfItem } from "@/lib/innertube/types";

// The store decides at import time whether to wrap itself in
// zustand/persist (main window) or stay plain (floating mirror).
// Present ourselves as the floating window so construction skips
// persist + localStorage (which isn't available under the node test
// env). `next()` — the reducer under test — is identical in both
// variants, so this only sidesteps the storage plumbing.
(globalThis as unknown as { window: unknown }).window = {
  location: { search: "?floating-player" },
};

const { usePlaybackStore } = await import("@/lib/store/playback");

function track(videoId: string): QueueTrack {
  return { videoId, title: videoId, thumbnails: [] };
}

/** Reset to a known "mid-playback" baseline, then apply the overrides. */
function setup(partial: Partial<PlaybackState>): void {
  usePlaybackStore.setState({
    queue: [],
    index: -1,
    repeat: "off",
    shuffle: false,
    playing: true,
    status: "ready",
    streamUrl: "blob:prev",
    backend: "offline",
    webviewReady: false,
    advertisement: false,
    position: 42,
    pendingSeek: undefined,
    loadRevision: 0,
    ...partial,
  });
}

describe("playback next()", () => {
  beforeEach(() => setup({}));

  it("replays the current track in place for repeat-one", () => {
    setup({ queue: [track("a"), track("b")], index: 0, repeat: "one" });
    usePlaybackStore.getState().next();
    const s = usePlaybackStore.getState();
    expect(s.index).toBe(0);
    expect(s.pendingSeek).toBeUndefined();
    expect(s.position).toBe(0);
    expect(s.playing).toBe(true);
    expect(s.status).toBe("loading");
    expect(s.loadRevision).toBe(1);
  });

  it("replays in place for repeat-all on a single-track queue", () => {
    // Regression: terminal delivery is one-shot per native generation. A
    // seek-only loop would play once more but its second end was ignored.
    setup({
      queue: [track("a")],
      index: 0,
      repeat: "all",
      status: "ready",
      streamUrl: "blob:a",
    });
    usePlaybackStore.getState().next();
    const s = usePlaybackStore.getState();
    expect(s.index).toBe(0);
    expect(s.pendingSeek).toBeUndefined();
    expect(s.playing).toBe(true);
    expect(s.status).toBe("loading");
    expect(s.streamUrl).toBeUndefined();
    expect(s.loadRevision).toBe(1);
  });

  it("wraps a multi-track queue back to the first track for repeat-all", () => {
    setup({ queue: [track("a"), track("b")], index: 1, repeat: "all" });
    usePlaybackStore.getState().next();
    const s = usePlaybackStore.getState();
    expect(s.index).toBe(0);
    expect(s.status).toBe("loading");
    expect(s.streamUrl).toBeUndefined();
    expect(s.pendingSeek).toBeUndefined();
    expect(s.playing).toBe(true);
  });

  it("stops at the end of the queue when repeat is off", () => {
    setup({ queue: [track("a"), track("b")], index: 1, repeat: "off" });
    usePlaybackStore.getState().next();
    const s = usePlaybackStore.getState();
    expect(s.index).toBe(1);
    expect(s.playing).toBe(false);
    expect(s.position).toBe(0);
    expect(s.status).toBe("idle");
  });

  it("advances to the next track mid-queue", () => {
    setup({
      queue: [track("a"), track("b"), track("c")],
      index: 0,
      repeat: "off",
    });
    usePlaybackStore.getState().next();
    const s = usePlaybackStore.getState();
    expect(s.index).toBe(1);
    expect(s.status).toBe("loading");
    expect(s.playing).toBe(true);
    expect(s.loadRevision).toBe(1);
  });

  it("is a no-op on an empty queue", () => {
    setup({ queue: [], index: -1, repeat: "all", playing: false });
    usePlaybackStore.getState().next();
    expect(usePlaybackStore.getState().index).toBe(-1);
  });
});

describe("queue source labels", () => {
  beforeEach(() => setup({}));

  it("marks an explicit queue as user-selected", () => {
    usePlaybackStore.getState().setQueue([track("a"), track("b")]);
    expect(usePlaybackStore.getState().queue.map((t) => t.source)).toEqual([
      "user",
      "user",
    ]);
  });

  it("keeps autoplay additions distinguishable from the playlist", () => {
    usePlaybackStore.getState().setQueue([track("a")]);
    usePlaybackStore
      .getState()
      .appendToQueue([track("b"), track("c")], "autoplay");
    expect(usePlaybackStore.getState().queue.map((t) => t.source)).toEqual([
      "user",
      "autoplay",
      "autoplay",
    ]);
  });

  it("normalizes missing artwork on malformed legacy queue rows", () => {
    const legacy = { videoId: "legacy", title: "Legacy" } as QueueTrack;

    usePlaybackStore.getState().playNow(legacy);
    expect(usePlaybackStore.getState().queue[0]?.thumbnails).toEqual([]);

    usePlaybackStore.getState().setQueue([legacy]);
    expect(usePlaybackStore.getState().queue[0]?.thumbnails).toEqual([]);
  });
});

describe("shelf item metadata", () => {
  beforeEach(() => setup({}));

  it("preserves album and artist destinations in the playback queue", () => {
    const item: ShelfItem = {
      kind: "song",
      id: "video-1",
      title: "Song",
      thumbnails: [],
      album: "Album",
      albumId: "album-1",
      artists: [{ name: "Artist", id: "artist-1" }],
    };

    usePlaybackStore.getState().playNow(item);

    expect(usePlaybackStore.getState().queue[0]).toMatchObject({
      album: "Album",
      albumId: "album-1",
      artists: [{ name: "Artist", id: "artist-1" }],
    });
  });
});

describe("WebView playback coordination", () => {
  beforeEach(() => setup({}));

  it("restarts an already-ready WebView track with a fresh generation", () => {
    setup({
      queue: [track("a")],
      index: 0,
      backend: "webview",
      webviewReady: true,
      streamUrl: undefined,
      position: 34,
    });

    usePlaybackStore.getState().playNow(track("a"));

    expect(usePlaybackStore.getState()).toMatchObject({
      index: 0,
      position: 0,
      pendingSeek: undefined,
      playing: true,
      status: "loading",
      loadRevision: 1,
    });
  });

  it("requests a fresh native load when the failed current row is clicked", () => {
    setup({
      queue: [track("a")],
      index: 0,
      backend: "webview",
      status: "error",
      webviewReady: false,
      playing: false,
      loadRevision: 7,
    });

    usePlaybackStore.getState().playNow(track("a"));

    expect(usePlaybackStore.getState()).toMatchObject({
      status: "loading",
      playing: true,
      loadRevision: 8,
    });
  });

  it.each(["toggle", "setPlaying"] as const)(
    "creates a new generation when %s restarts an exhausted row",
    (action) => {
      setup({
        queue: [track("a")],
        index: 0,
        backend: "webview",
        status: "idle",
        playing: false,
        loadRevision: 8,
      });

      if (action === "toggle") usePlaybackStore.getState().toggle();
      else usePlaybackStore.getState().setPlaying(true);

      expect(usePlaybackStore.getState()).toMatchObject({
        playing: true,
        status: "loading",
        loadRevision: 9,
      });
    },
  );

  it("restarts the current queue row with a fresh WebView generation", () => {
    setup({
      queue: [track("a")],
      index: 0,
      backend: "webview",
      status: "ready",
      webviewReady: true,
      position: 34,
      loadRevision: 4,
    });

    usePlaybackStore.getState().goTo(0);

    expect(usePlaybackStore.getState()).toMatchObject({
      index: 0,
      position: 0,
      pendingSeek: undefined,
      playing: true,
      status: "loading",
      streamUrl: undefined,
      loadRevision: 5,
    });
  });

  it("requests a new load when the current idle row is activated", () => {
    setup({
      queue: [track("a")],
      index: 0,
      backend: "webview",
      status: "idle",
      webviewReady: false,
      playing: false,
      loadRevision: 4,
    });

    usePlaybackStore.getState().goTo(0);

    expect(usePlaybackStore.getState()).toMatchObject({
      status: "loading",
      playing: true,
      position: 0,
      loadRevision: 5,
    });
  });

  it("does not expose skip, seek, source-reload, or mute paths during ads", () => {
    setup({
      queue: [track("a"), track("b")],
      index: 0,
      backend: "webview",
      webviewReady: true,
      advertisement: true,
      streamUrl: undefined,
      position: 12,
      volume: 0.8,
      muted: false,
    });
    const store = usePlaybackStore.getState();

    store.next();
    store.prev();
    store.goTo(1);
    store.seek(50);
    store.playNow(track("b"));
    store.setVolume(0);
    store.toggleMute();

    expect(usePlaybackStore.getState()).toMatchObject({
      index: 0,
      position: 12,
      volume: 0.8,
      muted: false,
      pendingSeek: undefined,
    });
  });

  it("does not let queue edits reload the active WebView during ads", () => {
    setup({
      queue: [track("a"), track("b"), track("c"), track("d")],
      index: 2,
      backend: "webview",
      advertisement: true,
    });
    const store = usePlaybackStore.getState();

    store.removeAt(0);
    store.moveTrack(2, 3);
    store.moveTrack(0, 3);

    expect(
      usePlaybackStore.getState().queue.map((item) => item.videoId),
    ).toEqual(["a", "b", "c", "d"]);
    expect(usePlaybackStore.getState().index).toBe(2);

    // Editing strictly after the active row cannot change its index and is
    // therefore safe while the official page owns an advertisement.
    store.removeAt(3);
    expect(
      usePlaybackStore.getState().queue.map((item) => item.videoId),
    ).toEqual(["a", "b", "c"]);
    expect(usePlaybackStore.getState().index).toBe(2);
  });

  it("keeps the selection revision when history removal only shifts the active index", () => {
    const current = track("current");
    setup({
      queue: [track("history"), current, track("next")],
      index: 1,
      loadRevision: 9,
    });

    usePlaybackStore.getState().removeAt(0);

    expect(usePlaybackStore.getState()).toMatchObject({
      index: 0,
      loadRevision: 9,
    });
    expect(usePlaybackStore.getState().queue[0]).toBe(current);
  });

  it("keeps the selection revision when reordering preserves the active entry", () => {
    const current = track("current");
    setup({
      queue: [track("a"), current, track("b")],
      index: 1,
      loadRevision: 9,
    });

    usePlaybackStore.getState().moveTrack(1, 2);

    expect(usePlaybackStore.getState()).toMatchObject({
      index: 2,
      loadRevision: 9,
    });
    expect(usePlaybackStore.getState().queue[2]).toBe(current);
  });

  it("advances the selection revision when current removal reveals a duplicate", () => {
    setup({
      queue: [track("same"), track("same")],
      index: 0,
      loadRevision: 9,
    });

    usePlaybackStore.getState().removeAt(0);

    expect(usePlaybackStore.getState()).toMatchObject({
      index: 0,
      status: "loading",
      loadRevision: 10,
    });
  });

  it("advances the selection revision between duplicate queue entries", () => {
    setup({
      queue: [track("same"), track("same")],
      index: 0,
      loadRevision: 9,
    });

    usePlaybackStore.getState().next();

    expect(usePlaybackStore.getState()).toMatchObject({
      index: 1,
      status: "loading",
      loadRevision: 10,
    });
  });
});
