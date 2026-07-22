import { describe, expect, it } from "vitest";
import {
  collectFullPlaylistTracks,
  mapPlaylistTrackRow,
  parsePlaylistTrackBatch,
  type PlaylistFirstPage,
  type PlaylistNextPage,
} from "./playlist";
import { removePlaylistEntryFromPages } from "./playlist-cache";
import type { YtNode } from "./shared";
import type { ShelfItem } from "./types";

function playlistRow(
  videoId: string,
  setVideoId?: string,
  title = videoId,
): YtNode {
  return {
    musicResponsiveListItemRenderer: {
      flexColumns: [
        {
          musicResponsiveListItemFlexColumnRenderer: {
            text: { runs: [{ text: title }] },
          },
        },
      ],
      playlistItemData: {
        videoId,
        playlistSetVideoId: setVideoId,
      },
    },
  };
}

function suggestionShelf(...rows: YtNode[]): YtNode {
  return { musicShelfRenderer: { contents: rows } };
}

describe("playlist row parsing", () => {
  it("retains the exact playlist set-video ID", () => {
    const wrapped = playlistRow("video-1", "set-1", "Track one");
    const item = mapPlaylistTrackRow(wrapped.musicResponsiveListItemRenderer);

    expect(item).toMatchObject({
      id: "video-1",
      title: "Track one",
      playlistSetVideoId: "set-1",
    });
  });

  it("falls back to the row's exact remove action ID", () => {
    const wrapped = playlistRow("video-1", undefined, "Track one");
    const raw = wrapped.musicResponsiveListItemRenderer;
    raw.menu = {
      menuRenderer: {
        items: [
          {
            menuServiceItemRenderer: {
              serviceEndpoint: {
                playlistEditEndpoint: {
                  actions: [
                    {
                      action: "ACTION_REMOVE_VIDEO",
                      setVideoId: "menu-set-1",
                    },
                  ],
                },
              },
            },
          },
        ],
      },
    };

    expect(mapPlaylistTrackRow(raw)?.playlistSetVideoId).toBe("menu-set-1");
  });
});

describe("parsePlaylistTrackBatch", () => {
  it("reads only the dedicated playlist shelf, not suggestion rows", () => {
    const response: YtNode = {
      contents: {
        twoColumnBrowseResultsRenderer: {
          tabs: [
            {
              tabRenderer: {
                content: {
                  sectionListRenderer: {
                    contents: [
                      suggestionShelf(
                        playlistRow(
                          "suggested-before",
                          undefined,
                          "Suggestion",
                        ),
                      ),
                      {
                        musicPlaylistShelfRenderer: {
                          contents: [
                            playlistRow(
                              "playlist-video",
                              "set-playlist",
                              "Saved track",
                            ),
                          ],
                          continuations: [
                            {
                              nextContinuationData: {
                                continuation: "PLAYLIST_NEXT",
                              },
                            },
                          ],
                        },
                      },
                    ],
                  },
                },
              },
            },
          ],
        },
      },
      secondaryContents: suggestionShelf(
        playlistRow("suggested-after", undefined, "Another suggestion"),
      ),
    };

    const page = parsePlaylistTrackBatch(response);

    expect(page.hasDedicatedContainer).toBe(true);
    expect(page.continuationToken).toBe("PLAYLIST_NEXT");
    expect(page.tracks.map((track) => track.id)).toEqual(["playlist-video"]);
  });

  it("keeps an empty dedicated shelf empty instead of using suggestions", () => {
    const response: YtNode = {
      contents: {
        musicPlaylistShelfRenderer: { contents: [] },
      },
      suggestions: suggestionShelf(
        playlistRow("suggested-video", undefined, "Suggestion"),
      ),
    };

    const page = parsePlaylistTrackBatch(response);

    expect(page.hasDedicatedContainer).toBe(true);
    expect(page.tracks).toEqual([]);
  });

  it("preserves duplicate videos when their playlist entry IDs differ", () => {
    const response: YtNode = {
      contents: {
        musicPlaylistShelfRenderer: {
          contents: [
            playlistRow("same-video", "set-a"),
            playlistRow("same-video", "set-b"),
          ],
        },
      },
    };

    expect(
      parsePlaylistTrackBatch(response).tracks.map(
        (track) => track.playlistSetVideoId,
      ),
    ).toEqual(["set-a", "set-b"]);
  });

  it("supports append-continuation response layouts", () => {
    const response: YtNode = {
      onResponseReceivedActions: [
        {
          appendContinuationItemsAction: {
            continuationItems: [
              playlistRow("continued-video", "continued-set"),
              {
                continuationItemRenderer: {
                  continuationEndpoint: {
                    continuationCommand: { token: "NEXT_PAGE" },
                  },
                },
              },
            ],
          },
        },
      ],
    };

    const page = parsePlaylistTrackBatch(response);

    expect(page.hasDedicatedContainer).toBe(true);
    expect(page.tracks[0]).toMatchObject({
      id: "continued-video",
      playlistSetVideoId: "continued-set",
    });
    expect(page.continuationToken).toBe("NEXT_PAGE");
  });

  it("prefers a playlist-shelf continuation over unrelated continuation rows", () => {
    const response: YtNode = {
      continuationContents: {
        musicPlaylistShelfContinuation: {
          contents: [playlistRow("playlist-next", "playlist-next-set")],
          continuations: [
            {
              nextContinuationData: { continuation: "PLAYLIST_PAGE_3" },
            },
          ],
        },
      },
      unrelated: suggestionShelf(
        playlistRow("suggested-next", undefined, "Suggestion"),
      ),
    };

    const page = parsePlaylistTrackBatch(response);

    expect(page.tracks.map((track) => track.id)).toEqual(["playlist-next"]);
    expect(page.continuationToken).toBe("PLAYLIST_PAGE_3");
  });
});

function track(videoId: string, setVideoId: string): ShelfItem {
  return {
    kind: "song",
    id: videoId,
    title: videoId,
    thumbnails: [],
    playlistSetVideoId: setVideoId,
  };
}

describe("removePlaylistEntryFromPages", () => {
  it("removes only the exact duplicate occurrence and updates the count", () => {
    const first: PlaylistFirstPage = {
      id: "VLPL123",
      title: "Playlist",
      thumbnails: [],
      trackCount: 3,
      tracks: [track("same-video", "set-a")],
      continuationToken: "NEXT",
    };
    const next: PlaylistNextPage = {
      tracks: [track("same-video", "set-b"), track("other-video", "set-c")],
    };

    const updated = removePlaylistEntryFromPages([first, next], "set-b");

    expect("trackCount" in updated[0] ? updated[0].trackCount : undefined).toBe(
      2,
    );
    expect(updated.flatMap((page) => page.tracks)).toMatchObject([
      { id: "same-video", playlistSetVideoId: "set-a" },
      { id: "other-video", playlistSetVideoId: "set-c" },
    ]);
    expect(next.tracks).toHaveLength(2);
  });

  it("preserves cache identity when the entry is not loaded", () => {
    const pages: PlaylistNextPage[] = [{ tracks: [track("video", "set-a")] }];
    expect(removePlaylistEntryFromPages(pages, "missing")).toBe(pages);
  });
});

describe("collectFullPlaylistTracks", () => {
  const first: PlaylistFirstPage = {
    id: "VLPL123",
    title: "Playlist",
    thumbnails: [],
    tracks: [track("first", "set-first")],
    continuationToken: "PAGE_2",
  };

  it("rejects a continuation failure in strict mode", async () => {
    const load = async () => {
      throw new Error("page failed");
    };

    await expect(collectFullPlaylistTracks(first, load, true)).rejects.toThrow(
      "page failed",
    );
  });

  it("continues past a duplicate-only page instead of truncating", async () => {
    const load = async (token: string): Promise<PlaylistNextPage> =>
      token === "PAGE_2"
        ? {
            tracks: [track("first", "set-first")],
            continuationToken: "PAGE_3",
          }
        : { tracks: [track("third", "set-third")] };

    await expect(collectFullPlaylistTracks(first, load, true)).resolves.toEqual(
      [track("first", "set-first"), track("third", "set-third")],
    );
  });

  it("rejects a repeated continuation token in strict mode", async () => {
    const load = async (): Promise<PlaylistNextPage> => ({
      tracks: [],
      continuationToken: "PAGE_2",
    });

    await expect(collectFullPlaylistTracks(first, load, true)).rejects.toThrow(
      "Repeated playlist continuation token",
    );
  });

  it("stops a strict continuation drain when playlist preparation is cancelled", async () => {
    const controller = new AbortController();
    const load = async (): Promise<PlaylistNextPage> => {
      controller.abort();
      return {
        tracks: [track("second", "set-second")],
        continuationToken: "PAGE_3",
      };
    };

    await expect(
      collectFullPlaylistTracks(first, load, true, {
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});
