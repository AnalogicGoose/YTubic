import { beforeEach, describe, expect, it, vi } from "vitest";

const sharedMocks = vi.hoisted(() => ({
  rawBrowse: vi.fn(),
  rawBrowseContinuation: vi.fn(),
}));

vi.mock("./shared", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./shared")>()),
  ...sharedMocks,
}));

import { fetchAllLibraryBrowseSections } from "./library-pagination";
import { fetchLibraryPlaylists } from "./library";
import { collectShelfNodes, mapShelfWrapper, type YtNode } from "./shared";

function playlistCard(id: string): YtNode {
  return {
    musicTwoRowItemRenderer: {
      title: { runs: [{ text: `Playlist ${id}` }] },
      navigationEndpoint: {
        browseEndpoint: {
          browseId: `VLPL${id}`,
          browseEndpointContextSupportedConfigs: {
            browseEndpointContextMusicConfig: {
              pageType: "MUSIC_PAGE_TYPE_PLAYLIST",
            },
          },
        },
      },
    },
  };
}

function continuationItem(token: string): YtNode {
  return {
    continuationItemRenderer: {
      continuationEndpoint: { continuationCommand: { token } },
    },
  };
}

function initialGrid(items: YtNode[], token?: string): YtNode {
  return {
    contents: {
      singleColumnBrowseResultsRenderer: {
        tabs: [
          {
            tabRenderer: {
              selected: true,
              content: {
                sectionListRenderer: {
                  contents: [
                    {
                      gridRenderer: {
                        items,
                        continuations: token
                          ? [
                              {
                                nextContinuationData: {
                                  continuation: token,
                                },
                              },
                            ]
                          : [],
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
  };
}

function mappedIds(sections: YtNode[]): string[] {
  return collectShelfNodes(sections).flatMap((wrapper, index) =>
    mapShelfWrapper(wrapper, index).items.map((item) => item.id),
  );
}

describe("fetchAllLibraryBrowseSections", () => {
  beforeEach(() => {
    sharedMocks.rawBrowse.mockReset();
    sharedMocks.rawBrowseContinuation.mockReset();
  });

  it("drains a modern append continuation beyond the initial 25 cards", async () => {
    const first = Array.from({ length: 25 }, (_, i) =>
      playlistCard(`first-${i}`),
    );
    const second = Array.from({ length: 13 }, (_, i) =>
      playlistCard(`second-${i}`),
    );
    sharedMocks.rawBrowse.mockResolvedValue(initialGrid(first, "PAGE_2"));
    sharedMocks.rawBrowseContinuation.mockResolvedValue({
      onResponseReceivedActions: [
        {
          appendContinuationItemsAction: { continuationItems: second },
        },
      ],
    });

    const sections = await fetchAllLibraryBrowseSections(
      "FEmusic_liked_playlists",
    );

    expect(mappedIds(sections)).toEqual([
      ...first.map((_, i) => `VLPLfirst-${i}`),
      ...second.map((_, i) => `VLPLsecond-${i}`),
    ]);
    expect(sharedMocks.rawBrowseContinuation).toHaveBeenCalledOnce();
    expect(sharedMocks.rawBrowseContinuation).toHaveBeenCalledWith("PAGE_2");
  });

  it("supports legacy grid continuation responses", async () => {
    sharedMocks.rawBrowse.mockResolvedValue(
      initialGrid([playlistCard("first")], "LEGACY_PAGE"),
    );
    sharedMocks.rawBrowseContinuation.mockResolvedValue({
      continuationContents: {
        gridContinuation: { items: [playlistCard("legacy-second")] },
      },
    });

    const sections = await fetchAllLibraryBrowseSections(
      "FEmusic_liked_playlists",
    );

    expect(mappedIds(sections)).toEqual(["VLPLfirst", "VLPLlegacy-second"]);
  });

  it("rejects a repeating continuation instead of returning a partial set", async () => {
    sharedMocks.rawBrowse.mockResolvedValue(
      initialGrid([playlistCard("first")], "REPEATED"),
    );
    sharedMocks.rawBrowseContinuation.mockResolvedValue({
      onResponseReceivedActions: [
        {
          appendContinuationItemsAction: {
            continuationItems: [
              playlistCard("second"),
              continuationItem("REPEATED"),
            ],
          },
        },
      ],
    });

    await expect(
      fetchAllLibraryBrowseSections("FEmusic_liked_playlists"),
    ).rejects.toThrow("Repeated library continuation");
  });

  it("propagates a failed continuation instead of exposing page one", async () => {
    sharedMocks.rawBrowse.mockResolvedValue(
      initialGrid([playlistCard("first")], "BROKEN_PAGE"),
    );
    sharedMocks.rawBrowseContinuation.mockRejectedValue(
      new Error("continuation network failure"),
    );

    await expect(
      fetchAllLibraryBrowseSections("FEmusic_liked_playlists"),
    ).rejects.toThrow("continuation network failure");
  });

  it("stable-dedupes cards repeated between shelves and pages", async () => {
    sharedMocks.rawBrowse.mockResolvedValue(
      initialGrid([playlistCard("same")], "PAGE_2"),
    );
    sharedMocks.rawBrowseContinuation.mockResolvedValue({
      onResponseReceivedEndpoints: [
        {
          appendContinuationItemsAction: {
            continuationItems: [playlistCard("same"), playlistCard("new")],
          },
        },
      ],
    });

    const sections = await fetchLibraryPlaylists();

    expect(
      sections.flatMap((section) => section.items).map((item) => item.id),
    ).toEqual(["VLPLsame", "VLPLnew"]);
  });
});
