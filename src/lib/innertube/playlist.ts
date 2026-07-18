import type { PlaylistPage, ShelfItem } from "./types";
import { parseTrackCount } from "./parse-count";
import {
  collectResponsiveRows,
  deepFindThumbnails,
  findContinuationToken,
  mapPlaylistPanelVideo,
  mapResponsiveListItem,
  rawBrowse,
  rawBrowseContinuation,
  rawNext,
  readRuns,
  readThumbnails,
  type YtNode,
} from "./shared";

/**
 * YTM hides the playlist header under different renderer keys depending
 * on whether the playlist is user-owned (musicEditablePlaylistDetailHeaderRenderer
 * → musicResponsiveHeaderRenderer) or system/community (musicDetailHeaderRenderer
 * → musicResponsiveHeaderRenderer), and where in the response (header,
 * contents.twoColumnBrowseResultsRenderer..., secondaryContents...) the
 * tree puts it. Walk the response and pull the first match instead of
 * enumerating each path.
 */
function extractHeader(json: YtNode): YtNode {
  const HEADER_KEYS = [
    "musicDetailHeaderRenderer",
    "musicResponsiveHeaderRenderer",
  ];
  const seen = new WeakSet<object>();
  let result: YtNode | null = null;
  const walk = (node: unknown) => {
    if (result || !node || typeof node !== "object") return;
    if (seen.has(node as object)) return;
    seen.add(node as object);
    if (Array.isArray(node)) {
      for (const c of node) walk(c);
      return;
    }
    const n = node as YtNode;
    for (const key of HEADER_KEYS) {
      if (n[key] && typeof n[key] === "object") {
        result = n[key];
        return;
      }
    }
    for (const k of Object.keys(n)) walk(n[k]);
  };
  walk(json);
  return result ?? {};
}

/** First page plus the continuation pointer for the next one. */
export type PlaylistFirstPage = PlaylistPage & {
  continuationToken?: string;
};

/** Every subsequent page — only tracks and the next token. */
export type PlaylistNextPage = {
  tracks: ShelfItem[];
  continuationToken?: string;
};

export type PlaylistPageChunk = PlaylistFirstPage | PlaylistNextPage;

export type ParsedPlaylistTrackBatch = PlaylistNextPage & {
  hasDedicatedContainer: boolean;
};

type PlaylistTrackContainer = {
  contents: YtNode[];
  continuationSource: unknown;
};

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

/**
 * Read the opaque ID for this exact playlist occurrence. The normal location
 * is `playlistItemData.playlistSetVideoId`; the edit endpoint in the row menu
 * is a useful fallback for response variants that omit playlistItemData.
 */
export function readPlaylistSetVideoId(raw: YtNode): string | undefined {
  const direct = nonEmptyString(raw.playlistItemData?.playlistSetVideoId);
  if (direct) return direct;

  const menuItems: YtNode[] = raw.menu?.menuRenderer?.items ?? [];
  for (const item of menuItems) {
    const endpoint =
      item.menuServiceItemRenderer?.serviceEndpoint?.playlistEditEndpoint;
    const actions: YtNode[] = endpoint?.actions ?? [];
    const removeAction = actions.find(
      (action) =>
        action.action === "ACTION_REMOVE_VIDEO" &&
        nonEmptyString(action.setVideoId),
    );
    const setVideoId = nonEmptyString(removeAction?.setVideoId);
    if (setVideoId) return setVideoId;
  }
  return undefined;
}

/** Map a playlist row while retaining the edit-only entry identity. */
export function mapPlaylistTrackRow(raw: YtNode): ShelfItem | null {
  const mapped = mapResponsiveListItem(raw);
  if (!mapped || mapped.kind !== "song") return null;
  const playlistSetVideoId = readPlaylistSetVideoId(raw);
  return playlistSetVideoId ? { ...mapped, playlistSetVideoId } : mapped;
}

function findFirstPlaylistShelf(root: unknown): YtNode | undefined {
  const seen = new WeakSet<object>();
  let result: YtNode | undefined;
  const walk = (node: unknown): void => {
    if (result || !node || typeof node !== "object") return;
    if (seen.has(node as object)) return;
    seen.add(node as object);
    if (Array.isArray(node)) {
      for (const child of node) walk(child);
      return;
    }
    const current = node as YtNode;
    if (current.musicPlaylistShelfRenderer) {
      result = current.musicPlaylistShelfRenderer;
      return;
    }
    for (const value of Object.values(current)) walk(value);
  };
  walk(root);
  return result;
}

function findAppendContinuationItems(resp: YtNode): YtNode[] | undefined {
  const actionGroups: YtNode[][] = [
    resp.onResponseReceivedActions ?? [],
    resp.onResponseReceivedEndpoints ?? [],
    resp.onResponseReceivedCommands ?? [],
  ];
  for (const actions of actionGroups) {
    for (const action of actions) {
      const items = action.appendContinuationItemsAction?.continuationItems;
      if (Array.isArray(items)) return items;
    }
  }
  return undefined;
}

/**
 * Locate only the container owned by the playlist itself. Playlist browse
 * responses also carry recommendation `musicShelfRenderer` rows; a deep walk
 * of the whole response silently appended those suggestions to the playlist.
 */
function findPlaylistTrackContainer(
  resp: YtNode,
): PlaylistTrackContainer | undefined {
  const continuation =
    resp.continuationContents?.musicPlaylistShelfContinuation;
  if (continuation) {
    return {
      contents: Array.isArray(continuation.contents)
        ? continuation.contents
        : [],
      continuationSource: continuation,
    };
  }

  const shelf = findFirstPlaylistShelf(resp);
  if (shelf) {
    return {
      contents: Array.isArray(shelf.contents) ? shelf.contents : [],
      continuationSource: shelf,
    };
  }

  const appended = findAppendContinuationItems(resp);
  if (appended) {
    return { contents: appended, continuationSource: appended };
  }
  return undefined;
}

function responsiveRows(items: YtNode[]): YtNode[] {
  const rows: YtNode[] = [];
  for (const item of items) {
    if (item.musicResponsiveListItemRenderer) {
      rows.push(item.musicResponsiveListItemRenderer);
    }
  }
  return rows;
}

function playlistEntryKey(track: ShelfItem): string {
  return track.playlistSetVideoId
    ? `set:${track.playlistSetVideoId}`
    : `video:${track.id}`;
}

/** Parse one first/continuation response without crossing into suggestions. */
export function parsePlaylistTrackBatch(
  resp: YtNode,
  seenEntries = new Set<string>(),
): ParsedPlaylistTrackBatch {
  const container = findPlaylistTrackContainer(resp);
  // The fallback preserves compatibility with older/less common response
  // layouts, but is used only when no playlist-specific container exists. An
  // empty recognized playlist shelf must remain empty rather than becoming a
  // recommendation list.
  const rows = container
    ? responsiveRows(container.contents)
    : collectResponsiveRows(resp);
  const out: ShelfItem[] = [];
  for (const row of rows) {
    const mapped = mapPlaylistTrackRow(row);
    if (!mapped) continue;
    const key = playlistEntryKey(mapped);
    if (seenEntries.has(key)) continue;
    seenEntries.add(key);
    out.push(mapped);
  }
  return {
    tracks: out,
    continuationToken: findContinuationToken(
      container?.continuationSource ?? resp,
    ),
    hasDedicatedContainer: !!container,
  };
}

/**
 * Fetch a playlist's header + first ~100 tracks. Subsequent pages are
 * loaded lazily via `fetchPlaylistContinuation` as the user scrolls —
 * this keeps first-paint fast and matches how the real YT Music web
 * client paginates long playlists.
 */
export async function fetchPlaylistFirstPage(
  id: string,
): Promise<PlaylistFirstPage> {
  const browseId = id.startsWith("VL") ? id : `VL${id}`;
  const rawId = browseId.slice(2);
  const json = await rawBrowse(browseId);

  if (import.meta.env.DEV) {
    console.debug("[playlist] browse response", browseId, json);
  }

  const header = extractHeader(json);
  const title = readRuns(header.title);
  const description = readRuns(header.description);
  let thumbnails = readThumbnails(
    header.thumbnail?.musicThumbnailRenderer?.thumbnail ??
      header.thumbnail?.croppedSquareThumbnailRenderer?.thumbnail ??
      header.thumbnail?.musicThumbnailRenderer ??
      header.thumbnail,
  );
  if (thumbnails.length === 0) {
    thumbnails = deepFindThumbnails(header.thumbnail);
  }
  const subtitleText = readRuns(header.subtitle);
  const secondText = readRuns(header.secondSubtitle);
  const trackCount = parseTrackCount(secondText);

  const firstBatch = parsePlaylistTrackBatch(json);
  let tracks = firstBatch.tracks;
  let continuationToken = firstBatch.continuationToken;
  const isRadioStyle = /^(RDCLAK5|RDAMPL|RDAT)/.test(rawId);

  // Fallback: "radio-style" community playlists (RDCLAK5..., RDAMPL...,
  // RDAT...) are computed lazily — /browse returns only a header, and
  // tracks live under /next. Radio playlists are short (~25 tracks) so
  // there's no continuation to follow.
  if (
    tracks.length === 0 &&
    (!firstBatch.hasDedicatedContainer || isRadioStyle)
  ) {
    try {
      const nextJson = await rawNext({
        playlistId: rawId,
        isAudioOnly: true,
      });
      const panelContents: YtNode[] =
        nextJson?.contents?.singleColumnMusicWatchNextResultsRenderer
          ?.tabbedRenderer?.watchNextTabbedResultsRenderer?.tabs?.[0]
          ?.tabRenderer?.content?.musicQueueRenderer?.content
          ?.playlistPanelRenderer?.contents ?? [];
      const radioTracks: ShelfItem[] = [];
      for (const c of panelContents) {
        // Unwrap playlistPanelVideoWrapperRenderer (song+MV rows) too.
        const row =
          c.playlistPanelVideoRenderer ??
          c.playlistPanelVideoWrapperRenderer?.primaryRenderer
            ?.playlistPanelVideoRenderer;
        if (!row) continue;
        const mapped = mapPlaylistPanelVideo(row);
        if (mapped) radioTracks.push(mapped);
      }
      tracks = radioTracks;
      continuationToken = undefined;
    } catch (e) {
      if (import.meta.env.DEV) {
        console.debug("[playlist] /next fallback failed:", e);
      }
    }
  }

  return {
    id: browseId,
    title,
    description: description || undefined,
    owner: subtitleText || undefined,
    trackCount,
    thumbnails,
    tracks,
    continuationToken,
  };
}

/**
 * Fetch the next page of a playlist given a continuation token from a
 * previous response. The token is single-use — callers should persist
 * the *new* token returned alongside the tracks.
 */
async function loadPlaylistContinuation(
  token: string,
  failOnRepeatedToken: boolean,
): Promise<PlaylistNextPage> {
  const json = await rawBrowseContinuation(token);
  const page = parsePlaylistTrackBatch(json);
  const next = page.continuationToken;
  if (failOnRepeatedToken && !page.hasDedicatedContainer) {
    throw new Error("Unrecognized playlist continuation response");
  }
  if (next === token && failOnRepeatedToken) {
    throw new Error("Repeated playlist continuation token");
  }
  return {
    tracks: page.tracks,
    continuationToken: next === token ? undefined : next,
  };
}

export function fetchPlaylistContinuation(
  token: string,
): Promise<PlaylistNextPage> {
  return loadPlaylistContinuation(token, false);
}

type PlaylistContinuationLoader = (token: string) => Promise<PlaylistNextPage>;

/** Walk all continuation pages, optionally rejecting any partial result. */
export async function collectFullPlaylistTracks(
  first: PlaylistFirstPage,
  loadContinuation: PlaylistContinuationLoader,
  strict: boolean,
): Promise<ShelfItem[]> {
  const tracks = [...first.tracks];
  const seenEntries = new Set(tracks.map(playlistEntryKey));
  const seenTokens = new Set<string>();
  let token = first.continuationToken;

  for (let i = 0; token; i++) {
    if (seenTokens.has(token)) {
      if (strict) throw new Error("Repeated playlist continuation token");
      break;
    }
    if (i >= 200) {
      if (strict) throw new Error("Playlist continuation limit exceeded");
      break;
    }
    seenTokens.add(token);

    let page: PlaylistNextPage;
    try {
      page = await loadContinuation(token);
    } catch (e) {
      if (strict) throw e;
      if (import.meta.env.DEV) {
        console.debug("[playlist] continuation failed:", e);
      }
      break;
    }
    for (const t of page.tracks) {
      const key = playlistEntryKey(t);
      if (!seenEntries.has(key)) {
        seenEntries.add(key);
        tracks.push(t);
      }
    }
    token = page.continuationToken;
  }

  return tracks;
}

async function fetchPlaylistFully(
  id: string,
  strict: boolean,
): Promise<PlaylistPage> {
  const first = await fetchPlaylistFirstPage(id);
  const tracks = await collectFullPlaylistTracks(
    first,
    strict
      ? (token) => loadPlaylistContinuation(token, true)
      : fetchPlaylistContinuation,
    strict,
  );
  if (import.meta.env.DEV) {
    console.debug("[playlist] full-load parsed:", id, "tracks=", tracks.length);
  }
  const { continuationToken: _drop, ...meta } = first;
  void _drop;
  return { ...meta, tracks };
}

/**
 * Full-load variant that tolerates a failed continuation and returns the pages
 * already fetched. Suitable for display/membership hints, not destructive
 * decisions that require proof the result is complete.
 */
export function fetchPlaylist(id: string): Promise<PlaylistPage> {
  return fetchPlaylistFully(id, false);
}

/**
 * Full-load variant for cache protection and other fail-closed callers. Any
 * continuation failure, repeated cursor, or safety-limit hit rejects instead
 * of exposing a truncated playlist as complete.
 */
export function fetchPlaylistStrict(id: string): Promise<PlaylistPage> {
  return fetchPlaylistFully(id, true);
}
