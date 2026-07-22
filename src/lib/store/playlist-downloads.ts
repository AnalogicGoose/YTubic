import { create } from "zustand";
import { persist } from "zustand/middleware";
import { toast } from "sonner";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { ShelfItem } from "@/lib/innertube/types";
import type { QueueTrack } from "@/lib/store/playback";
import { queryClient } from "@/lib/query-client";
import { OFFLINE_LIBRARY_QUERY_KEY } from "@/lib/offline-library";
import {
  cancelOfflineDownload,
  initializeOfflineDownloads,
  setPlaylistDownloadOwnership,
  startOfflineDownload,
  useOfflineDownloadStore,
  type OfflineDownloadSnapshot,
} from "@/lib/store/offline-downloads";
import {
  resolveStreamId,
  useTrackSourceStore,
  type SourceKind,
} from "@/lib/store/track-source";
import {
  PREMIUM_DOWNLOAD_LIVE_MAX_AGE_MS,
  usePremiumStore,
  verifyPremiumDownloadEntitlement,
} from "@/lib/store/premium";
import type { AccountSummary } from "@/lib/store/accounts";

export type PlaylistDownloadPhase =
  | "preparing"
  | "downloading"
  | "cancelling"
  | "completed"
  | "failed"
  | "cancelled";

export type PreparedPlaylistDownload = {
  streamVideoId: string;
  sourceKind: SourceKind;
  track: Pick<ShelfItem, "id" | "title" | "subtitle" | "artists">;
};

export type PlaylistDownloadBatch = {
  identityKey: string;
  playlistId: string;
  title: string;
  phase: PlaylistDownloadPhase;
  plan: PreparedPlaylistDownload[];
  candidateManifest: OfflinePlaylistManifest;
  completed: number;
  failed: number;
  currentVideoId?: string;
  error?: string;
  retryAt?: number;
};

export type OfflinePlaylistManifest = {
  identityKey: string;
  playlistId: string;
  title: string;
  tracks: QueueTrack[];
  updatedAt: number;
};

type ManifestData = {
  manifestsByIdentity: Record<string, Record<string, OfflinePlaylistManifest>>;
  /**
   * Version-1 manifests had no account/channel owner. Keep them intact for a
   * future explicit import, but never attach them to whichever identity
   * happens to be active now (especially unsafe for the shared LM/VLLM ids).
   */
  legacyManifests: Record<string, OfflinePlaylistManifest>;
};

type ManifestState = {
  save: (identityKey: string, manifest: OfflinePlaylistManifest) => void;
  remove: (identityKey: string, playlistId: string) => void;
} & ManifestData;

export function offlineIdentityKey(
  accountId: string,
  pageId: string | null,
): string {
  return JSON.stringify([accountId, pageId ?? "personal"]);
}

export function playlistDownloadKey(
  identityKey: string,
  playlistId: string,
): string {
  return JSON.stringify([identityKey, playlistId]);
}

export function migrateOfflinePlaylistManifests(
  persisted: unknown,
  version: number,
): ManifestData {
  const value =
    persisted && typeof persisted === "object"
      ? (persisted as Record<string, unknown>)
      : {};
  if (version < 2) {
    const legacy =
      value.manifests && typeof value.manifests === "object"
        ? (value.manifests as Record<string, OfflinePlaylistManifest>)
        : {};
    return { manifestsByIdentity: {}, legacyManifests: legacy };
  }
  return {
    manifestsByIdentity:
      value.manifestsByIdentity && typeof value.manifestsByIdentity === "object"
        ? (value.manifestsByIdentity as ManifestData["manifestsByIdentity"])
        : {},
    legacyManifests:
      value.legacyManifests && typeof value.legacyManifests === "object"
        ? (value.legacyManifests as ManifestData["legacyManifests"])
        : {},
  };
}

export const useOfflinePlaylistStore = create<ManifestState>()(
  persist(
    (set) => ({
      manifestsByIdentity: {},
      legacyManifests: {},
      save: (identityKey, manifest) =>
        set((state) => ({
          manifestsByIdentity: {
            ...state.manifestsByIdentity,
            [identityKey]: {
              ...state.manifestsByIdentity[identityKey],
              [manifest.playlistId]: manifest,
            },
          },
        })),
      remove: (identityKey, playlistId) =>
        set((state) => {
          const identityManifests = {
            ...state.manifestsByIdentity[identityKey],
          };
          delete identityManifests[playlistId];
          const manifestsByIdentity = { ...state.manifestsByIdentity };
          if (Object.keys(identityManifests).length) {
            manifestsByIdentity[identityKey] = identityManifests;
          } else {
            delete manifestsByIdentity[identityKey];
          }
          return { manifestsByIdentity };
        }),
    }),
    {
      name: "goosic-offline-playlists",
      version: 2,
      migrate: migrateOfflinePlaylistManifests,
      partialize: (state) => ({
        manifestsByIdentity: state.manifestsByIdentity,
        legacyManifests: state.legacyManifests,
      }),
    },
  ),
);

type State = {
  batches: Record<string, PlaylistDownloadBatch>;
  upsert: (batch: PlaylistDownloadBatch) => void;
};

export const usePlaylistDownloadStore = create<State>()((set) => ({
  batches: {},
  upsert: (batch) =>
    set((state) => ({
      batches: {
        ...state.batches,
        [playlistDownloadKey(batch.identityKey, batch.playlistId)]: batch,
      },
    })),
}));

const activeRunners = new Set<string>();
const cancellationRequests = new Set<string>();

type OfflineIdentity = {
  accountId: string;
  pageId: string | null;
  key: string;
};

async function readActiveOfflineIdentity(): Promise<OfflineIdentity> {
  const accounts = await invoke<AccountSummary[]>("list_accounts");
  const active = accounts.find((account) => account.isActive);
  if (!active) {
    throw new Error("Sign in before downloading a playlist for offline use.");
  }
  return {
    accountId: active.id,
    pageId: active.pageId,
    key: offlineIdentityKey(active.id, active.pageId),
  };
}

export function preparePlaylistDownloads(
  tracks: ShelfItem[],
): PreparedPlaylistDownload[] {
  const sources = useTrackSourceStore.getState().byVideoId;
  const unique = new Map<string, PreparedPlaylistDownload>();
  for (const track of tracks) {
    if (track.kind !== "song" && track.kind !== "video") continue;
    const record = sources[track.id];
    const sourceKind: SourceKind =
      record?.selected ?? (track.kind === "video" ? "video" : "song");
    const streamVideoId = resolveStreamId(track.id, sources);
    if (unique.has(streamVideoId)) continue;
    unique.set(streamVideoId, {
      streamVideoId,
      sourceKind,
      track: {
        id: track.id,
        title: track.title,
        subtitle: track.subtitle,
        artists: track.artists,
      },
    });
  }
  return [...unique.values()];
}

export function createOfflinePlaylistManifest(
  identityKey: string,
  playlistId: string,
  title: string,
  tracks: ShelfItem[],
): OfflinePlaylistManifest {
  const sources = useTrackSourceStore.getState().byVideoId;
  const queue: QueueTrack[] = [];
  for (const track of tracks) {
    if (track.kind !== "song" && track.kind !== "video") continue;
    // A playlist manifest must remain useful offline, but persisting every
    // resolution of every thumbnail URL quickly exhausts WebView localStorage.
    // Keep one best available image until manifests move to native storage.
    const thumbnail = track.thumbnails[track.thumbnails.length - 1];
    queue.push({
      videoId: track.id,
      playbackMode: "offline",
      offlineVideoId: resolveStreamId(track.id, sources),
      title: track.title,
      subtitle: track.subtitle,
      artists: track.artists,
      album: track.album,
      albumId: track.albumId,
      thumbnails: thumbnail ? [thumbnail] : [],
      duration: track.duration,
      source: "user",
    });
  }
  return {
    identityKey,
    playlistId,
    title,
    tracks: queue,
    updatedAt: Date.now(),
  };
}

function isTerminal(snapshot: OfflineDownloadSnapshot): boolean {
  return (
    snapshot.phase === "completed" ||
    snapshot.phase === "failed" ||
    snapshot.phase === "cancelled"
  );
}

const DOWNLOAD_WATCHDOG_MS = 15 * 60 * 1_000;
const DOWNLOAD_POLL_MS = 2_000;
const PREMIUM_DOWNLOAD_MONITOR_MS = 60 * 1_000;
export const RATE_LIMIT_COOLDOWN_MS = 15 * 60 * 1_000;

function isRateLimitFailure(error: string): boolean {
  return /429|too many requests|not a bot|rate[ -]?limit/i.test(error);
}

function waitForTerminal(videoId: string): Promise<OfflineDownloadSnapshot> {
  const current = useOfflineDownloadStore.getState().jobs[videoId];
  if (current && isTerminal(current)) return Promise.resolve(current);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (snapshot: OfflineDownloadSnapshot) => {
      if (settled) return;
      settled = true;
      clearInterval(pollTimer);
      clearTimeout(watchdogTimer);
      unsubscribe();
      resolve(snapshot);
    };
    const unsubscribe = useOfflineDownloadStore.subscribe((state) => {
      const snapshot = state.jobs[videoId];
      if (!snapshot || !isTerminal(snapshot)) return;
      finish(snapshot);
    });
    const pollTimer = setInterval(() => {
      void invoke<OfflineDownloadSnapshot[]>("list_offline_downloads")
        .then((snapshots) => {
          if (settled) return;
          const snapshot = snapshots.find((job) => job.videoId === videoId);
          if (!snapshot) return;
          useOfflineDownloadStore.getState().upsert(snapshot);
          if (isTerminal(snapshot)) finish(snapshot);
        })
        .catch(() => {
          // The event listener remains authoritative. Polling only recovers a
          // missed terminal event and may fail transiently during shutdown.
        });
    }, DOWNLOAD_POLL_MS);
    const watchdogTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      clearInterval(pollTimer);
      unsubscribe();
      reject(new Error("Offline download timed out after 15 minutes."));
    }, DOWNLOAD_WATCHDOG_MS);
    const afterSubscribe = useOfflineDownloadStore.getState().jobs[videoId];
    if (afterSubscribe && isTerminal(afterSubscribe)) {
      finish(afterSubscribe);
    }
  });
}

function updateBatch(
  batch: PlaylistDownloadBatch,
  patch: Partial<PlaylistDownloadBatch>,
): PlaylistDownloadBatch {
  const next = { ...batch, ...patch };
  usePlaylistDownloadStore.getState().upsert(next);
  return next;
}

async function runPlaylistDownload(
  initial: PlaylistDownloadBatch,
): Promise<void> {
  const runnerKey = playlistDownloadKey(
    initial.identityKey,
    initial.playlistId,
  );
  const otherRunner = [...activeRunners].find((key) => key !== runnerKey);
  if (otherRunner) {
    throw new Error("Finish or cancel the current playlist download first.");
  }
  if (activeRunners.has(runnerKey)) return;
  activeRunners.add(runnerKey);
  cancellationRequests.delete(runnerKey);
  const videoIds = initial.plan.map((item) => item.streamVideoId);
  setPlaylistDownloadOwnership(videoIds, true);
  let batch = updateBatch(initial, {
    phase: "preparing",
    completed: 0,
    failed: 0,
    currentVideoId: undefined,
    error: undefined,
    retryAt: undefined,
  });
  const toastId = `playlist-download:${runnerKey}`;
  let acceptBoundaryEvents = true;
  const stopAccountListeners: (() => void)[] = [];
  let stopEntitlementListener: (() => void) | undefined;
  let entitlementVerificationTimer: ReturnType<typeof setInterval> | undefined;
  let entitlementVerificationInFlight = false;
  const stopBoundaryMonitoring = () => {
    if (!acceptBoundaryEvents) return;
    acceptBoundaryEvents = false;
    for (const stopAccountListener of stopAccountListeners.splice(0)) {
      stopAccountListener();
    }
    stopEntitlementListener?.();
    stopEntitlementListener = undefined;
    if (entitlementVerificationTimer !== undefined) {
      clearInterval(entitlementVerificationTimer);
      entitlementVerificationTimer = undefined;
    }
  };
  const cancelForBoundaryChange = (reason: string) => {
    if (!acceptBoundaryEvents || cancellationRequests.has(runnerKey)) return;
    cancellationRequests.add(runnerKey);
    batch = updateBatch(batch, {
      phase: "cancelling",
      error: reason,
    });
    if (batch.currentVideoId) {
      void cancelOfflineDownload(batch.currentVideoId).catch(() => undefined);
    }
  };
  toast.loading(`Downloading ${initial.title} · 0/${initial.plan.length}`, {
    id: toastId,
  });

  try {
    // Account/channel changes are hard ownership boundaries. Register before
    // committing the manifest or starting native work so a slow metadata
    // refresh cannot leave an old Premium batch running invisibly.
    const cancelForAccountBoundary = () =>
      cancelForBoundaryChange(
        "The active YouTube account or channel changed during the download.",
      );
    // `login-success` is the earliest native boundary. Metadata backfill may
    // delay or prevent the later `accounts-changed` event, so both must stop
    // the active anonymous downloader immediately.
    stopAccountListeners.push(
      await listen("login-success", cancelForAccountBoundary),
      await listen("accounts-changed", cancelForAccountBoundary),
    );
    stopEntitlementListener = usePremiumStore.subscribe((entitlement) => {
      if (entitlement.status !== "premium" || entitlement.source !== "live") {
        cancelForBoundaryChange(
          "Live YouTube Music Premium verification was lost during the download.",
        );
      }
    });
    // A live Premium result is an expiring capability, not a session-long
    // boolean. Re-check on a bounded cadence so a downgrade or logout cannot
    // keep a long-running playlist batch authorized indefinitely. The helper
    // skips network work while the last successful probe remains fresh.
    entitlementVerificationTimer = setInterval(() => {
      if (entitlementVerificationInFlight || !acceptBoundaryEvents) return;
      entitlementVerificationInFlight = true;
      void verifyPremiumDownloadEntitlement()
        .catch((error) => {
          cancelForBoundaryChange(
            error instanceof Error
              ? error.message
              : "Live YouTube Music Premium verification was lost.",
          );
        })
        .finally(() => {
          entitlementVerificationInFlight = false;
        });
    }, Math.min(PREMIUM_DOWNLOAD_MONITOR_MS, PREMIUM_DOWNLOAD_LIVE_MAX_AGE_MS));
    await initializeOfflineDownloads();
    await verifyPremiumDownloadEntitlement();
    const activeIdentity = await readActiveOfflineIdentity();
    if (activeIdentity.key !== initial.identityKey) {
      throw new Error(
        "The active YouTube account or channel changed before the download started.",
      );
    }
    if (cancellationRequests.has(runnerKey)) {
      updateBatch(batch, { phase: "cancelled", currentVideoId: undefined });
      toast.info(`Cancelled ${initial.title}`, { id: toastId });
      return;
    }
    // Commit only after this runner owns the batch, native event setup is
    // ready, and the account/channel identity has been revalidated. A rejected
    // concurrent run or setup failure therefore cannot replace a known-good
    // manifest.
    useOfflinePlaylistStore
      .getState()
      .save(initial.identityKey, initial.candidateManifest);
    batch = updateBatch(batch, { phase: "downloading" });

    for (const item of initial.plan) {
      if (cancellationRequests.has(runnerKey)) break;
      try {
        await verifyPremiumDownloadEntitlement();
        const currentIdentity = await readActiveOfflineIdentity();
        if (currentIdentity.key !== initial.identityKey) {
          cancelForBoundaryChange(
            "The active YouTube account or channel changed during the download.",
          );
        }
      } catch (error) {
        cancelForBoundaryChange(
          error instanceof Error
            ? error.message
            : "Offline download entitlement changed.",
        );
      }
      if (cancellationRequests.has(runnerKey)) break;
      batch = updateBatch(batch, { currentVideoId: item.streamVideoId });
      let snapshot: OfflineDownloadSnapshot;
      try {
        snapshot = await startOfflineDownload(
          item.streamVideoId,
          {
            videoId: item.track.id,
            title: item.track.title,
            subtitle: item.track.subtitle,
            artists: item.track.artists,
          },
          item.sourceKind,
        );
        if (!isTerminal(snapshot))
          snapshot = await waitForTerminal(item.streamVideoId);
      } catch (error) {
        if (error instanceof Error && /timed out/i.test(error.message)) {
          await cancelOfflineDownload(item.streamVideoId).catch(
            () => undefined,
          );
        }
        snapshot = {
          videoId: item.streamVideoId,
          phase: "failed",
          downloadedBytes: 0,
          totalBytes: null,
          error: error instanceof Error ? error.message : String(error),
        };
      }

      if (snapshot.phase === "completed") {
        batch = updateBatch(batch, { completed: batch.completed + 1 });
      } else if (
        snapshot.phase === "cancelled" &&
        cancellationRequests.has(runnerKey)
      ) {
        break;
      } else {
        const error = snapshot.error || "A track could not be downloaded";
        batch = updateBatch(batch, {
          failed: batch.failed + 1,
          error,
          retryAt: isRateLimitFailure(error)
            ? Date.now() + RATE_LIMIT_COOLDOWN_MS
            : undefined,
        });
        // A rate limit is a cooldown signal, not a reason to hammer every
        // remaining track in the playlist.
        if (isRateLimitFailure(error)) break;
      }

      toast.loading(
        `Downloading ${initial.title} · ${batch.completed}/${initial.plan.length}`,
        { id: toastId },
      );
    }

    // No account/entitlement event may overwrite a terminal state while the
    // following query invalidation yields. Tear down those listeners before
    // publishing the terminal phase; `finally` repeats this idempotently for
    // early-return and error paths.
    stopBoundaryMonitoring();
    if (cancellationRequests.has(runnerKey)) {
      batch = updateBatch(batch, {
        phase: "cancelled",
        currentVideoId: undefined,
      });
      toast.info(`Cancelled ${initial.title}`, { id: toastId });
    } else if (batch.failed > 0 || batch.completed < initial.plan.length) {
      batch = updateBatch(batch, {
        phase: "failed",
        currentVideoId: undefined,
      });
      toast.error(
        batch.error ||
          `${initial.title} stopped after ${batch.completed}/${initial.plan.length} tracks`,
        { id: toastId },
      );
    } else {
      updateBatch(batch, { phase: "completed", currentVideoId: undefined });
      toast.success(`${initial.title} is available offline`, { id: toastId });
    }
    await queryClient.invalidateQueries({
      queryKey: OFFLINE_LIBRARY_QUERY_KEY,
    });
  } catch (error) {
    stopBoundaryMonitoring();
    updateBatch(batch, {
      phase: "failed",
      currentVideoId: undefined,
      error: error instanceof Error ? error.message : String(error),
    });
    toast.error(
      error instanceof Error ? error.message : "Playlist download failed",
      { id: toastId },
    );
    throw error;
  } finally {
    stopBoundaryMonitoring();
    activeRunners.delete(runnerKey);
    cancellationRequests.delete(runnerKey);
    setPlaylistDownloadOwnership(videoIds, false);
  }
}

export async function startPlaylistDownload(
  playlistId: string,
  title: string,
  tracks: ShelfItem[],
): Promise<void> {
  await verifyPremiumDownloadEntitlement({ force: true });
  const identity = await readActiveOfflineIdentity();
  const plan = preparePlaylistDownloads(tracks);
  if (!plan.length)
    throw new Error("This playlist has no downloadable tracks.");
  const candidateManifest = createOfflinePlaylistManifest(
    identity.key,
    playlistId,
    title,
    tracks,
  );
  await runPlaylistDownload({
    identityKey: identity.key,
    playlistId,
    title,
    phase: "preparing",
    plan,
    candidateManifest,
    completed: 0,
    failed: 0,
  });
}

export async function retryPlaylistDownload(
  identityKey: string,
  playlistId: string,
): Promise<void> {
  await verifyPremiumDownloadEntitlement({ force: true });
  const activeIdentity = await readActiveOfflineIdentity();
  if (activeIdentity.key !== identityKey) {
    throw new Error("The active YouTube account or channel changed.");
  }
  const key = playlistDownloadKey(identityKey, playlistId);
  const batch = usePlaylistDownloadStore.getState().batches[key];
  if (!batch) throw new Error("The previous playlist download is unavailable.");
  if (batch.retryAt && batch.retryAt > Date.now()) {
    throw new Error(
      "YouTube is rate limiting downloads. Please wait before retrying.",
    );
  }
  await runPlaylistDownload({ ...batch, phase: "preparing" });
}

export async function cancelPlaylistDownload(
  identityKey: string,
  playlistId: string,
): Promise<void> {
  const key = playlistDownloadKey(identityKey, playlistId);
  const batch = usePlaylistDownloadStore.getState().batches[key];
  if (!batch || !activeRunners.has(key)) return;
  cancellationRequests.add(key);
  updateBatch(batch, { phase: "cancelling" });
  if (batch.currentVideoId) await cancelOfflineDownload(batch.currentVideoId);
}
