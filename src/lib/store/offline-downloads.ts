import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";
import { toast } from "sonner";
import { queryClient } from "@/lib/query-client";
import type { QueueTrack } from "@/lib/store/playback";
import { OFFLINE_LIBRARY_QUERY_KEY } from "@/lib/offline-library";

export type OfflineDownloadPhase =
  "queued" | "downloading" | "completed" | "failed" | "cancelled";

export type OfflineDownloadSnapshot = {
  videoId: string;
  phase: OfflineDownloadPhase;
  downloadedBytes: number;
  totalBytes?: number | null;
  error?: string | null;
};

type State = {
  jobs: Record<string, OfflineDownloadSnapshot>;
  upsert: (snapshot: OfflineDownloadSnapshot) => void;
  remove: (videoIds?: string[]) => void;
};

export const useOfflineDownloadStore = create<State>()((set) => ({
  jobs: {},
  upsert: (snapshot) =>
    set((state) => ({ jobs: { ...state.jobs, [snapshot.videoId]: snapshot } })),
  remove: (videoIds) =>
    set((state) => {
      if (!videoIds?.length) return { jobs: {} };
      const jobs = { ...state.jobs };
      for (const videoId of videoIds) delete jobs[videoId];
      return { jobs };
    }),
}));

let initialized: Promise<void> | null = null;
const playlistOwnedVideoIds = new Set<string>();

/** Suppress per-track toasts while the playlist coordinator owns the batch. */
export function setPlaylistDownloadOwnership(
  videoIds: Iterable<string>,
  owned: boolean,
): void {
  for (const videoId of videoIds) {
    if (owned) playlistOwnedVideoIds.add(videoId);
    else playlistOwnedVideoIds.delete(videoId);
  }
}

/** Start the one global native-event mirror used by both player windows. */
export function initializeOfflineDownloads(): Promise<void> {
  if (initialized) return initialized;
  initialized = (async () => {
    const apply = (snapshot: OfflineDownloadSnapshot, notify = true) => {
      const previous =
        useOfflineDownloadStore.getState().jobs[snapshot.videoId];
      useOfflineDownloadStore.getState().upsert(snapshot);
      if (snapshot.phase === "completed") {
        void queryClient.invalidateQueries({
          queryKey: OFFLINE_LIBRARY_QUERY_KEY,
        });
      }
      const suppressTrackToast = playlistOwnedVideoIds.has(snapshot.videoId);
      if (
        !notify ||
        suppressTrackToast ||
        (previous?.phase === snapshot.phase && snapshot.phase !== "downloading")
      )
        return;
      const toastId = `offline-download:${snapshot.videoId}`;
      if (snapshot.phase === "queued" || snapshot.phase === "downloading") {
        const downloaded = snapshot.downloadedBytes
          ? ` (${(snapshot.downloadedBytes / 1024 / 1024).toFixed(1)} MB)`
          : "";
        toast.loading(`Downloading for offline${downloaded}`, { id: toastId });
      } else if (snapshot.phase === "completed") {
        toast.success("Available offline", { id: toastId });
      } else if (snapshot.phase === "failed") {
        toast.error(snapshot.error || "Offline download failed", {
          id: toastId,
        });
      } else if (snapshot.phase === "cancelled") {
        toast.info("Offline download cancelled", { id: toastId });
      }
    };
    const existing = await invoke<OfflineDownloadSnapshot[]>(
      "list_offline_downloads",
    ).catch(() => []);
    for (const snapshot of existing) apply(snapshot, false);
    await listen<OfflineDownloadSnapshot>(
      "offline-download-state",
      ({ payload }) => apply(payload),
    );
  })().catch((error) => {
    initialized = null;
    throw error;
  });
  return initialized;
}

export async function startOfflineDownload(
  streamVideoId: string,
  track: Pick<QueueTrack, "videoId" | "title" | "subtitle" | "artists">,
  sourceKind: "song" | "video",
  force = false,
): Promise<OfflineDownloadSnapshot> {
  await initializeOfflineDownloads();
  const artist =
    track.artists?.map((entry) => entry.name).join(", ") ||
    track.subtitle ||
    null;
  const snapshot = await invoke<OfflineDownloadSnapshot>(
    "start_offline_download",
    {
      videoId: streamVideoId,
      force,
      title: track.title,
      artist,
      displayVideoId: track.videoId,
      sourceKind,
    },
  );
  useOfflineDownloadStore.getState().upsert(snapshot);
  return snapshot;
}

export async function cancelOfflineDownload(videoId: string): Promise<void> {
  await invoke("cancel_offline_download", { videoId });
}

export function markOfflineDownloadFailed(
  videoId: string,
  error: string,
): void {
  useOfflineDownloadStore.getState().upsert({
    videoId,
    phase: "failed",
    downloadedBytes: 0,
    totalBytes: null,
    error,
  });
  void invoke("mark_offline_file_unplayable", { videoId })
    .then(() =>
      queryClient.invalidateQueries({ queryKey: OFFLINE_LIBRARY_QUERY_KEY }),
    )
    .catch(() => {
      // The in-memory failure remains visible even if shutdown races the
      // best-effort repair marker. Never delete or rename the user's file.
    });
}
