import { beforeEach, describe, expect, it, vi } from "vitest";

const sharedMocks = vi.hoisted(() => ({
  innertubePost: vi.fn(),
  rawBrowse: vi.fn(),
  rawBrowseContinuation: vi.fn(),
}));

vi.mock("./shared", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./shared")>()),
  ...sharedMocks,
}));

import { fetchUserPlaylists, removeFromPlaylist } from "./mutations";

function playlistCard(id: string, title: string) {
  return {
    musicTwoRowItemRenderer: {
      title: { runs: [{ text: title }] },
      navigationEndpoint: { browseEndpoint: { browseId: `VLPL${id}` } },
    },
  };
}

describe("removeFromPlaylist", () => {
  beforeEach(() => {
    sharedMocks.innertubePost.mockReset();
    sharedMocks.innertubePost.mockResolvedValue({
      status: "STATUS_SUCCEEDED",
    });
    sharedMocks.rawBrowse.mockReset();
    sharedMocks.rawBrowseContinuation.mockReset();
  });

  it("sends the exact entry token and normalizes a VL browse ID", async () => {
    await removeFromPlaylist("VLPL123", "video-1", "set-video-1");

    expect(sharedMocks.innertubePost).toHaveBeenCalledWith(
      "browse/edit_playlist",
      {
        playlistId: "PL123",
        actions: [
          {
            action: "ACTION_REMOVE_VIDEO",
            removedVideoId: "video-1",
            setVideoId: "set-video-1",
          },
        ],
      },
    );
  });

  it("refuses to guess when an exact entry token is missing", async () => {
    await expect(removeFromPlaylist("PL123", "video-1", "")).rejects.toThrow(
      "exact identifiers",
    );
    expect(sharedMocks.innertubePost).not.toHaveBeenCalled();
  });

  it("surfaces an edit rejection returned in a successful HTTP response", async () => {
    sharedMocks.innertubePost.mockResolvedValue({ status: "STATUS_FAILED" });

    await expect(
      removeFromPlaylist("PL123", "video-1", "set-video-1"),
    ).rejects.toThrow("STATUS_FAILED");
  });
});

describe("fetchUserPlaylists", () => {
  beforeEach(() => {
    sharedMocks.rawBrowse.mockReset();
    sharedMocks.rawBrowseContinuation.mockReset();
  });

  it("includes an owned playlist delivered on a continuation page", async () => {
    sharedMocks.rawBrowse.mockResolvedValue({
      contents: {
        singleColumnBrowseResultsRenderer: {
          tabs: [
            {
              tabRenderer: {
                content: {
                  sectionListRenderer: {
                    contents: [
                      {
                        gridRenderer: {
                          items: [playlistCard("FIRST", "First")],
                          continuations: [
                            {
                              nextContinuationData: {
                                continuation: "PAGE_2",
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
    });
    sharedMocks.rawBrowseContinuation.mockResolvedValue({
      onResponseReceivedActions: [
        {
          appendContinuationItemsAction: {
            continuationItems: [playlistCard("SECOND", "Second")],
          },
        },
      ],
    });

    await expect(fetchUserPlaylists()).resolves.toEqual([
      { id: "PLFIRST", title: "First" },
      { id: "PLSECOND", title: "Second" },
    ]);
  });
});
