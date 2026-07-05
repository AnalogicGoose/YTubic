import type { ShelfItem } from "./types";
import { mapPlaylistPanelVideo, rawNext, type YtNode } from "./shared";

/**
 * Fetch a radio station seeded on a single videoId.
 * Equivalent to what YTM does when you click "Start radio" — /next with
 * playlistId `RDAMVM<videoId>` gives back a `playlistPanelRenderer` full
 * of similar tracks.
 *
 * Returns the seed track followed by ~24 recommended tracks.
 */
/** Pull the queue rows out of a /next `playlistPanelRenderer` response. */
function parsePanelTracks(json: YtNode): ShelfItem[] {
  const panelContents: YtNode[] =
    json?.contents?.singleColumnMusicWatchNextResultsRenderer?.tabbedRenderer
      ?.watchNextTabbedResultsRenderer?.tabs?.[0]?.tabRenderer?.content
      ?.musicQueueRenderer?.content?.playlistPanelRenderer?.contents ?? [];

  const tracks: ShelfItem[] = [];
  for (const c of panelContents) {
    // YTM wraps rows that have both a song and a music-video version in a
    // playlistPanelVideoWrapperRenderer; the real row is under primaryRenderer.
    const row =
      c.playlistPanelVideoRenderer ??
      c.playlistPanelVideoWrapperRenderer?.primaryRenderer
        ?.playlistPanelVideoRenderer;
    if (!row) continue;
    const mapped = mapPlaylistPanelVideo(row);
    if (mapped) tracks.push(mapped);
  }
  return tracks;
}

export async function fetchRadio(videoId: string): Promise<ShelfItem[]> {
  const tracks = parsePanelTracks(
    await rawNext({
      videoId,
      playlistId: `RDAMVM${videoId}`,
      isAudioOnly: true,
    }),
  );
  if (import.meta.env.DEV) {
    console.debug("[radio] seed=", videoId, "tracks=", tracks.length);
  }
  return tracks;
}

/**
 * Build a play queue from a watch-playlist id — the kind the search
 * top-result card's Shuffle / Play button hands us: an artist shuffle
 * radio (`RDAO…`), an album (`OLAK…`), or a community playlist (`VL…` /
 * `RDCLAK…`). /next expands it into a `playlistPanelRenderer` of tracks.
 */
export async function fetchWatchQueue(
  playlistId: string,
  videoId?: string,
): Promise<ShelfItem[]> {
  const body: Record<string, unknown> = { playlistId, isAudioOnly: true };
  if (videoId) body.videoId = videoId;
  return parsePanelTracks(await rawNext(body));
}
