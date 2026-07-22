import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ShelfItem } from "@/lib/innertube/types";
import type { OfflineDownloadSnapshot } from "@/lib/store/offline-downloads";

type JobsState = { jobs: Record<string, OfflineDownloadSnapshot> };

const accounts = vi.hoisted(() => {
  type FakeAccount = {
    id: string;
    email: string;
    name: string;
    photoUrl: null;
    pageId: string | null;
    channelName: string | null;
    channelPhotoUrl: null;
    webPlayerIdentityVerified: boolean;
    isActive: boolean;
  };

  const account = (id: string, pageId: string | null = null): FakeAccount => ({
    id,
    email: `${id}@example.test`,
    name: id,
    photoUrl: null,
    pageId,
    channelName: pageId,
    channelPhotoUrl: null,
    webPlayerIdentityVerified: true,
    isActive: true,
  });

  let current = [account("account-a")];
  let queued: FakeAccount[][] = [];
  const invoke = vi.fn(async (command: string) => {
    if (command === "list_accounts") {
      return queued.length ? queued.shift() : current;
    }
    if (command === "list_offline_downloads") return [];
    throw new Error(`Unexpected Tauri command in test: ${command}`);
  });

  return {
    account,
    invoke,
    reset: () => {
      current = [account("account-a")];
      queued = [];
      invoke.mockClear();
    },
    set: (...next: FakeAccount[]) => {
      current = next;
    },
    queue: (...next: FakeAccount[][]) => {
      queued = next;
    },
  };
});

const native = vi.hoisted(() => {
  let jobs: Record<string, OfflineDownloadSnapshot> = {};
  const subscribers = new Set<(state: JobsState) => void>();

  const emit = (snapshot: OfflineDownloadSnapshot) => {
    jobs = { ...jobs, [snapshot.videoId]: snapshot };
    for (const subscriber of subscribers) subscriber({ jobs });
  };

  return {
    initialize: vi.fn<() => Promise<void>>(),
    start: vi.fn(),
    cancel: vi.fn(),
    ownership: vi.fn(),
    emit,
    reset: () => {
      jobs = {};
      subscribers.clear();
    },
    store: {
      getState: () => ({ jobs, upsert: emit }),
      subscribe: (subscriber: (state: JobsState) => void) => {
        subscribers.add(subscriber);
        return () => subscribers.delete(subscriber);
      },
    },
  };
});

const trackSources = vi.hoisted(() => ({
  byVideoId: {} as Record<
    string,
    { song: string; video?: string; selected: "song" | "video" }
  >,
}));

const queryClient = vi.hoisted(() => ({
  invalidateQueries: vi.fn(async () => undefined),
}));

const entitlement = vi.hoisted(() => {
  type Snapshot = {
    status: "premium" | "free" | null;
    source: "live" | "offlineGrace" | null;
  };
  const listeners = new Set<(state: Snapshot) => void>();
  return {
    status: "premium" as Snapshot["status"],
    source: "live" as Snapshot["source"],
    verify: vi.fn(async () => undefined),
    subscribe: (listener: (state: Snapshot) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    reset: () => listeners.clear(),
  };
});

const nativeEvents = vi.hoisted(() => {
  const listeners = new Map<string, Set<() => void>>();
  return {
    listen: vi.fn(async (event: string, callback: () => void) => {
      const callbacks = listeners.get(event) ?? new Set<() => void>();
      callbacks.add(callback);
      listeners.set(event, callbacks);
      return () => callbacks.delete(callback);
    }),
    emit: (event: string) => {
      for (const callback of listeners.get(event) ?? []) callback();
    },
    reset: () => listeners.clear(),
  };
});

vi.mock("@tauri-apps/api/core", () => ({ invoke: accounts.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: nativeEvents.listen }));

vi.mock("zustand/middleware", () => ({
  persist: (initializer: unknown) => initializer,
}));

vi.mock("sonner", () => ({
  toast: {
    loading: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  },
}));

vi.mock("@/lib/query-client", () => ({ queryClient }));

vi.mock("@/lib/store/premium", () => ({
  PREMIUM_DOWNLOAD_LIVE_MAX_AGE_MS: 5 * 60 * 1000,
  verifyPremiumDownloadEntitlement: entitlement.verify,
  usePremiumStore: {
    getState: () => ({
      status: entitlement.status,
      source: entitlement.source,
    }),
    subscribe: entitlement.subscribe,
  },
}));

vi.mock("@/lib/offline-library", () => ({
  OFFLINE_LIBRARY_QUERY_KEY: ["offline-library"],
}));

vi.mock("@/lib/store/offline-downloads", () => ({
  initializeOfflineDownloads: native.initialize,
  startOfflineDownload: native.start,
  cancelOfflineDownload: native.cancel,
  setPlaylistDownloadOwnership: native.ownership,
  useOfflineDownloadStore: native.store,
}));

vi.mock("@/lib/store/track-source", () => ({
  useTrackSourceStore: {
    getState: () => ({ byVideoId: trackSources.byVideoId }),
  },
  resolveStreamId: (
    displayedId: string,
    sources: typeof trackSources.byVideoId,
  ) => {
    const source = sources[displayedId];
    if (!source) return displayedId;
    if (source.selected === "video" && source.video) return source.video;
    return source.song;
  },
}));

const {
  RATE_LIMIT_COOLDOWN_MS,
  cancelPlaylistDownload,
  createOfflinePlaylistManifest,
  migrateOfflinePlaylistManifests,
  offlineIdentityKey,
  playlistDownloadKey,
  preparePlaylistDownloads,
  retryPlaylistDownload,
  startPlaylistDownload,
  useOfflinePlaylistStore,
  usePlaylistDownloadStore,
} = await import("@/lib/store/playlist-downloads");

const PERSONAL_IDENTITY = offlineIdentityKey("account-a", null);

function song(id: string, title = id): ShelfItem {
  return {
    kind: "song",
    id,
    title,
    thumbnails: [],
    artists: [{ name: `Artist ${id}` }],
  };
}

function completed(videoId: string): OfflineDownloadSnapshot {
  return {
    videoId,
    phase: "completed",
    downloadedBytes: 64_000,
    totalBytes: 64_000,
  };
}

function batch(identityKey = PERSONAL_IDENTITY, playlistId = "playlist") {
  return usePlaylistDownloadStore.getState().batches[
    playlistDownloadKey(identityKey, playlistId)
  ];
}

beforeEach(() => {
  accounts.reset();
  native.reset();
  nativeEvents.reset();
  nativeEvents.listen.mockClear();
  native.initialize.mockReset().mockResolvedValue(undefined);
  native.start.mockReset().mockImplementation(async (videoId: string) => {
    const snapshot = completed(videoId);
    native.emit(snapshot);
    return snapshot;
  });
  native.cancel.mockReset().mockResolvedValue(undefined);
  native.ownership.mockReset();
  queryClient.invalidateQueries.mockClear();
  entitlement.status = "premium";
  entitlement.source = "live";
  entitlement.verify.mockReset().mockImplementation(async () => {
    if (entitlement.status !== "premium" || entitlement.source !== "live") {
      throw new Error(
        "YouTube Music Premium is required for offline downloads.",
      );
    }
  });
  entitlement.reset();
  trackSources.byVideoId = {};
  useOfflinePlaylistStore.setState({
    manifestsByIdentity: {},
    legacyManifests: {},
  });
  usePlaylistDownloadStore.setState({ batches: {} });
});

describe("playlist download planning", () => {
  it.each([
    { status: "free" as const, source: "live" as const },
    { status: "premium" as const, source: "offlineGrace" as const },
  ])(
    "rejects $status/$source before native setup",
    async ({ status, source }) => {
      entitlement.status = status;
      entitlement.source = source;

      await expect(
        startPlaylistDownload("playlist", "Mix", [song("one")]),
      ).rejects.toThrow("Premium");
      expect(accounts.invoke).not.toHaveBeenCalled();
      expect(native.initialize).not.toHaveBeenCalled();
      expect(native.start).not.toHaveBeenCalled();
    },
  );

  it("downloads a shared selected source once while preserving playlist duplicates", () => {
    const selectedVideo = {
      song: "song-a",
      video: "video-a",
      selected: "video" as const,
    };
    trackSources.byVideoId = {
      "song-a": selectedVideo,
      "video-a": selectedVideo,
    };
    const album: ShelfItem = {
      kind: "album",
      id: "album-a",
      title: "Album",
      thumbnails: [],
    };
    const tracks = [song("song-a", "First"), song("video-a"), album];

    const plan = preparePlaylistDownloads(tracks);
    const manifest = createOfflinePlaylistManifest(
      PERSONAL_IDENTITY,
      "playlist",
      "Mix",
      tracks,
    );

    expect(plan).toEqual([
      expect.objectContaining({
        streamVideoId: "video-a",
        sourceKind: "video",
        track: expect.objectContaining({ id: "song-a", title: "First" }),
      }),
    ]);
    expect(manifest.tracks).toHaveLength(2);
    expect(manifest.tracks.map((track) => track.offlineVideoId)).toEqual([
      "video-a",
      "video-a",
    ]);
  });

  it("keeps only the best thumbnail in compact persisted manifests", () => {
    const track = song("one");
    track.thumbnails = [
      { url: "small", width: 40, height: 40 },
      { url: "large", width: 400, height: 400 },
    ];

    const manifest = createOfflinePlaylistManifest(
      PERSONAL_IDENTITY,
      "playlist",
      "Mix",
      [track],
    );

    expect(manifest.tracks[0]?.thumbnails).toEqual([
      { url: "large", width: 400, height: 400 },
    ]);
  });

  it("runs each unique download sequentially and saves the scoped manifest", async () => {
    await startPlaylistDownload("playlist", "Mix", [
      song("one"),
      song("one", "Duplicate"),
      song("two"),
    ]);

    expect(native.start.mock.calls.map(([videoId]) => videoId)).toEqual([
      "one",
      "two",
    ]);
    expect(
      useOfflinePlaylistStore.getState().manifestsByIdentity[PERSONAL_IDENTITY]
        ?.playlist.tracks,
    ).toHaveLength(3);
    expect(batch()).toMatchObject({
      identityKey: PERSONAL_IDENTITY,
      phase: "completed",
      completed: 2,
      failed: 0,
      currentVideoId: undefined,
    });
    expect(native.ownership).toHaveBeenNthCalledWith(1, ["one", "two"], true);
    expect(native.ownership).toHaveBeenLastCalledWith(["one", "two"], false);
    expect(entitlement.verify).toHaveBeenCalledWith({ force: true });
    expect(
      entitlement.verify.mock.calls.filter((args) => args.length === 0),
    ).toHaveLength(3);
  });

  it("isolates the same playlist id by account and channel identity", async () => {
    await startPlaylistDownload("LM", "Personal likes", [song("personal")]);

    const channelIdentity = offlineIdentityKey("account-a", "channel-b");
    accounts.set(accounts.account("account-a", "channel-b"));
    await startPlaylistDownload("LM", "Channel likes", [song("channel")]);

    const manifests = useOfflinePlaylistStore.getState().manifestsByIdentity;
    expect(manifests[PERSONAL_IDENTITY]?.LM.title).toBe("Personal likes");
    expect(manifests[channelIdentity]?.LM.title).toBe("Channel likes");
    expect(batch(PERSONAL_IDENTITY, "LM")?.phase).toBe("completed");
    expect(batch(channelIdentity, "LM")?.phase).toBe("completed");
  });

  it("quarantines unscoped v1 manifests instead of attaching them", () => {
    const legacyManifest = {
      playlistId: "LM",
      title: "Unknown owner",
      tracks: [],
      updatedAt: 1,
    };

    const migrated = migrateOfflinePlaylistManifests(
      { manifests: { LM: legacyManifest } },
      1,
    );

    expect(migrated.manifestsByIdentity).toEqual({});
    expect(migrated.legacyManifests).toEqual({ LM: legacyManifest });
  });

  it("revalidates identity before committing or starting native work", async () => {
    accounts.queue(
      [accounts.account("account-a")],
      [accounts.account("account-b")],
    );

    await expect(
      startPlaylistDownload("playlist", "Mix", [song("one")]),
    ).rejects.toThrow("account or channel changed");

    expect(native.initialize).toHaveBeenCalledOnce();
    expect(native.start).not.toHaveBeenCalled();
    expect(useOfflinePlaylistStore.getState().manifestsByIdentity).toEqual({});
  });

  it("enforces a real cooldown after a rate-limit failure", async () => {
    const now = 1_800_000_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(now);
    native.start.mockImplementationOnce(async (videoId: string) => ({
      videoId,
      phase: "failed",
      downloadedBytes: 0,
      totalBytes: null,
      error: "HTTP 429: Too Many Requests",
    }));

    await startPlaylistDownload("playlist", "Mix", [song("one"), song("two")]);

    expect(native.start).toHaveBeenCalledTimes(1);
    expect(batch()).toMatchObject({
      phase: "failed",
      completed: 0,
      failed: 1,
      retryAt: now + RATE_LIMIT_COOLDOWN_MS,
    });
    await expect(
      retryPlaylistDownload(PERSONAL_IDENTITY, "playlist"),
    ).rejects.toThrow("wait before retrying");
    expect(native.start).toHaveBeenCalledTimes(1);

    nowSpy.mockReturnValue(now + RATE_LIMIT_COOLDOWN_MS + 1);
    await retryPlaylistDownload(PERSONAL_IDENTITY, "playlist");
    expect(batch()).toMatchObject({
      phase: "completed",
      completed: 2,
      failed: 0,
      retryAt: undefined,
    });
    nowSpy.mockRestore();
  });
});

describe("playlist cancellation and lifecycle", () => {
  it("does not let a late boundary event overwrite a terminal phase", async () => {
    let releaseInvalidation!: () => void;
    queryClient.invalidateQueries.mockImplementationOnce(
      () =>
        new Promise<undefined>((resolve) => {
          releaseInvalidation = () => resolve(undefined);
        }),
    );

    const running = startPlaylistDownload("playlist", "Mix", [song("one")]);
    await vi.waitFor(() => {
      expect(queryClient.invalidateQueries).toHaveBeenCalledOnce();
      expect(batch()?.phase).toBe("completed");
    });

    nativeEvents.emit("accounts-changed");
    expect(batch()?.phase).toBe("completed");
    releaseInvalidation();
    await running;
    expect(batch()?.phase).toBe("completed");
  });

  it("cancels the active native track, stops the remaining plan, and releases ownership", async () => {
    native.start.mockImplementation(async (videoId: string) => {
      const snapshot: OfflineDownloadSnapshot = {
        videoId,
        phase: "downloading",
        downloadedBytes: 1_024,
        totalBytes: null,
      };
      native.emit(snapshot);
      return snapshot;
    });
    native.cancel.mockImplementation(async (videoId: string) => {
      native.emit({
        videoId,
        phase: "cancelled",
        downloadedBytes: 1_024,
        totalBytes: null,
      });
    });

    const running = startPlaylistDownload("playlist", "Mix", [
      song("one"),
      song("two"),
    ]);
    await vi.waitFor(() => {
      expect(batch()?.currentVideoId).toBe("one");
    });

    await cancelPlaylistDownload(PERSONAL_IDENTITY, "playlist");
    await running;

    expect(native.cancel).toHaveBeenCalledWith("one");
    expect(native.start).toHaveBeenCalledTimes(1);
    expect(batch()).toMatchObject({
      phase: "cancelled",
      completed: 0,
      currentVideoId: undefined,
    });
    expect(native.ownership).toHaveBeenLastCalledWith(["one", "two"], false);
  });

  it.each(["login-success", "accounts-changed"])(
    "cancels immediately on the %s account boundary during an active batch",
    async (boundaryEvent) => {
      native.start.mockImplementation(async (videoId: string) => {
        const snapshot: OfflineDownloadSnapshot = {
          videoId,
          phase: "downloading",
          downloadedBytes: 1_024,
          totalBytes: null,
        };
        native.emit(snapshot);
        return snapshot;
      });
      native.cancel.mockImplementation(async (videoId: string) => {
        native.emit({
          videoId,
          phase: "cancelled",
          downloadedBytes: 1_024,
          totalBytes: null,
        });
      });

      const running = startPlaylistDownload("playlist", "Mix", [
        song("one"),
        song("two"),
      ]);
      await vi.waitFor(() => expect(batch()?.currentVideoId).toBe("one"));

      accounts.set(accounts.account("account-b"));
      nativeEvents.emit(boundaryEvent);
      await running;

      expect(native.cancel).toHaveBeenCalledWith("one");
      expect(native.start).toHaveBeenCalledTimes(1);
      expect(batch()).toMatchObject({
        phase: "cancelled",
        completed: 0,
        currentVideoId: undefined,
      });
      expect(native.ownership).toHaveBeenLastCalledWith(["one", "two"], false);
    },
  );

  it("preserves a known-good manifest and releases ownership when setup fails", async () => {
    const previous = createOfflinePlaylistManifest(
      PERSONAL_IDENTITY,
      "first",
      "Existing",
      [song("old")],
    );
    useOfflinePlaylistStore.getState().save(PERSONAL_IDENTITY, previous);
    native.initialize.mockRejectedValueOnce(new Error("listener unavailable"));

    await expect(
      startPlaylistDownload("first", "Replacement", [song("one")]),
    ).rejects.toThrow("listener unavailable");

    expect(
      useOfflinePlaylistStore.getState().manifestsByIdentity[PERSONAL_IDENTITY]
        ?.first,
    ).toEqual(previous);
    await expect(
      startPlaylistDownload("second", "Second", [song("two")]),
    ).resolves.toBeUndefined();
    expect(native.ownership).toHaveBeenCalledWith(["one"], false);
  });
});
