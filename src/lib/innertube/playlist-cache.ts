import type { PlaylistPageChunk } from "./playlist";

export type { PlaylistPageChunk } from "./playlist";

/**
 * Remove one exact playlist entry from already-loaded infinite-query pages.
 * Matching on the opaque set-video ID preserves other occurrences of the same
 * video. The server refetch that follows remains the final source of truth.
 */
export function removePlaylistEntryFromPages(
  pages: PlaylistPageChunk[],
  playlistSetVideoId: string,
): PlaylistPageChunk[] {
  const hasEntry = pages.some((page) =>
    page.tracks.some(
      (track) => track.playlistSetVideoId === playlistSetVideoId,
    ),
  );
  if (!hasEntry) return pages;

  return pages.map((page, index) => {
    const tracks = page.tracks.filter(
      (track) => track.playlistSetVideoId !== playlistSetVideoId,
    );
    const count =
      index === 0 && "trackCount" in page && page.trackCount !== undefined
        ? Math.max(0, page.trackCount - 1)
        : undefined;
    return count === undefined
      ? { ...page, tracks }
      : { ...page, tracks, trackCount: count };
  });
}
