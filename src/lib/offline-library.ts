import { invoke } from "@tauri-apps/api/core";
import type { ShelfItem } from "@/lib/innertube/types";
import type { QueueTrack } from "@/lib/store/playback";
import { resolveStreamId, useTrackSourceStore } from "@/lib/store/track-source";

/** A finalized, validated-or-legacy audio file in Goosic's offline folder. */
export type OfflineTrackEntry = {
  videoId: string;
  size: number;
  modifiedSecs: number;
  title?: string;
  artist?: string;
  displayVideoId?: string;
  sourceKind?: "song" | "video";
  valid: boolean;
};

export const OFFLINE_LIBRARY_QUERY_KEY = ["offline-library"] as const;

export function listOfflineTracks(): Promise<OfflineTrackEntry[]> {
  return invoke<OfflineTrackEntry[]>("list_cache");
}

/**
 * Match playlist rows to files without assuming every old download has a v2
 * metadata sidecar. New files use displayVideoId; legacy files fall back to
 * their filename ID. Unknown legacy alternate-source files remain visible in
 * Storage, but are never guessed into a playlist.
 */
export function offlineQueueForPlaylist(
  tracks: ShelfItem[],
  entries: OfflineTrackEntry[],
): QueueTrack[] {
  const byDisplayId = new Map<string, OfflineTrackEntry[]>();
  const byFileId = new Map<string, OfflineTrackEntry>();
  for (const entry of entries) {
    if (!entry.valid) continue;
    if (entry.displayVideoId) {
      const matches = byDisplayId.get(entry.displayVideoId) ?? [];
      matches.push(entry);
      byDisplayId.set(entry.displayVideoId, matches);
    }
    if (!byFileId.has(entry.videoId)) byFileId.set(entry.videoId, entry);
  }

  const sources = useTrackSourceStore.getState().byVideoId;
  const queue: QueueTrack[] = [];
  for (const track of tracks) {
    if (track.kind !== "song" && track.kind !== "video") continue;
    const source = sources[track.id];
    const selectedKind =
      source?.selected ?? (track.kind === "video" ? "video" : "song");
    const selectedFileId = resolveStreamId(track.id, sources);
    const displayMatches = byDisplayId.get(track.id) ?? [];
    const entry =
      byFileId.get(selectedFileId) ??
      displayMatches.find(
        (candidate) => candidate.sourceKind === selectedKind,
      ) ??
      byFileId.get(track.id) ??
      [...displayMatches].sort((a, b) => a.videoId.localeCompare(b.videoId))[0];
    if (!entry) continue;
    queue.push({
      videoId: track.id,
      playbackMode: "offline",
      offlineVideoId: entry.videoId,
      title: track.title,
      subtitle: track.subtitle,
      artists: track.artists,
      album: track.album,
      albumId: track.albumId,
      thumbnails: track.thumbnails,
      duration: track.duration,
      source: "user",
    });
  }
  return queue;
}

/** Filter a persisted downloaded-playlist queue against files still on disk. */
export function availableOfflineQueue(
  tracks: QueueTrack[],
  entries: OfflineTrackEntry[],
): QueueTrack[] {
  const playable = new Set(
    entries.filter((entry) => entry.valid).map((entry) => entry.videoId),
  );
  return tracks.filter(
    (track) =>
      track.playbackMode === "offline" &&
      !!track.offlineVideoId &&
      playable.has(track.offlineVideoId),
  );
}
