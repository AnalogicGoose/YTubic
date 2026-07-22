import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ShelfItem } from "@/lib/innertube/types";
import type { QueueTrack } from "@/lib/store/playback";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

const { availableOfflineQueue, offlineQueueForPlaylist } =
  await import("@/lib/offline-library");
const { useTrackSourceStore } = await import("@/lib/store/track-source");

beforeEach(() => {
  useTrackSourceStore.setState({ byVideoId: {} });
});

function song(id: string, title = id): ShelfItem {
  return {
    kind: "song",
    id,
    title,
    thumbnails: [],
    artists: [{ id: `artist-${id}`, name: `Artist ${id}` }],
  };
}

function offlineTrack(
  videoId: string,
  offlineVideoId: string | undefined,
): QueueTrack {
  return {
    videoId,
    offlineVideoId,
    playbackMode: "offline",
    title: videoId,
    thumbnails: [],
  };
}

describe("offlineQueueForPlaylist", () => {
  it("matches old downloads by their filename video ID", () => {
    const queue = offlineQueueForPlaylist(
      [song("legacy-id")],
      [
        {
          videoId: "legacy-id",
          size: 48_000,
          modifiedSecs: 10,
          valid: true,
        },
      ],
    );

    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({
      videoId: "legacy-id",
      offlineVideoId: "legacy-id",
      playbackMode: "offline",
    });
  });

  it("uses v2 display metadata to match an explicitly downloaded alternate source", () => {
    const queue = offlineQueueForPlaylist(
      [song("display-song")],
      [
        {
          videoId: "alternate-video",
          displayVideoId: "display-song",
          sourceKind: "video",
          size: 80_000,
          modifiedSecs: 20,
          valid: true,
        },
      ],
    );

    expect(queue[0]).toMatchObject({
      videoId: "display-song",
      offlineVideoId: "alternate-video",
    });
  });

  it("chooses the user's selected source deterministically when both files exist", () => {
    const sources = {
      song: "display-song",
      video: "alternate-video",
      selected: "video" as const,
    };
    useTrackSourceStore.setState({
      byVideoId: {
        "display-song": sources,
        "alternate-video": sources,
      },
    });

    const queue = offlineQueueForPlaylist(
      [song("display-song")],
      [
        {
          videoId: "display-song",
          displayVideoId: "display-song",
          sourceKind: "song",
          size: 80_000,
          modifiedSecs: 20,
          valid: true,
        },
        {
          videoId: "alternate-video",
          displayVideoId: "display-song",
          sourceKind: "video",
          size: 80_000,
          modifiedSecs: 21,
          valid: true,
        },
      ],
    );

    expect(queue[0]?.offlineVideoId).toBe("alternate-video");
  });

  it("preserves duplicate playlist occurrences while reusing one downloaded file", () => {
    const queue = offlineQueueForPlaylist(
      [song("repeat", "First occurrence"), song("repeat", "Second occurrence")],
      [
        {
          videoId: "repeat",
          size: 64_000,
          modifiedSecs: 30,
          valid: true,
        },
      ],
    );

    expect(queue.map((track) => track.title)).toEqual([
      "First occurrence",
      "Second occurrence",
    ]);
    expect(queue.map((track) => track.offlineVideoId)).toEqual([
      "repeat",
      "repeat",
    ]);
  });

  it("does not guess invalid or unmatched legacy files into the playlist", () => {
    const queue = offlineQueueForPlaylist(
      [song("wanted")],
      [
        {
          videoId: "wanted",
          size: 64_000,
          modifiedSecs: 30,
          valid: false,
        },
        {
          videoId: "unknown-alternate",
          size: 64_000,
          modifiedSecs: 31,
          valid: true,
        },
      ],
    );

    expect(queue).toEqual([]);
  });

  it("ignores non-playable playlist rows", () => {
    const album: ShelfItem = {
      kind: "album",
      id: "album-id",
      title: "Album",
      thumbnails: [],
    };

    expect(
      offlineQueueForPlaylist(
        [album],
        [
          {
            videoId: "album-id",
            size: 64_000,
            modifiedSecs: 30,
            valid: true,
          },
        ],
      ),
    ).toEqual([]);
  });
});

describe("availableOfflineQueue", () => {
  it("filters a persisted manifest by exact valid files without collapsing duplicates", () => {
    const tracks = [
      offlineTrack("display-a", "file-a"),
      offlineTrack("display-a", "file-a"),
      offlineTrack("display-b", "file-b"),
      offlineTrack("display-c", "file-c"),
      offlineTrack("display-d", undefined),
      { ...offlineTrack("display-e", "file-a"), playbackMode: undefined },
    ];

    const queue = availableOfflineQueue(tracks, [
      {
        videoId: "file-a",
        size: 64_000,
        modifiedSecs: 1,
        valid: true,
      },
      {
        videoId: "file-b",
        size: 64_000,
        modifiedSecs: 2,
        valid: false,
      },
      {
        videoId: "file-c",
        displayVideoId: "display-c",
        size: 64_000,
        modifiedSecs: 3,
        valid: true,
      },
    ]);

    expect(queue.map((track) => track.videoId)).toEqual([
      "display-a",
      "display-a",
      "display-c",
    ]);
  });
});
