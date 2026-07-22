import { useEffect, useMemo, useRef, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import {
  AlertCircleIcon,
  ArrowDownAZIcon,
  CheckIcon,
  DownloadIcon,
  HardDriveIcon,
  Loader2Icon,
  PinIcon,
  PinOffIcon,
  SearchIcon,
  SquareIcon,
  XIcon,
} from "lucide-react";
import {
  fetchPlaylistContinuation,
  fetchPlaylistFirstPage,
  fetchPlaylistStrict,
  type PlaylistFirstPage,
  type PlaylistNextPage,
} from "@/lib/innertube/playlist";
import type { ShelfItem } from "@/lib/innertube/types";
import { EntityHeader } from "@/components/shared/entity-header";
import { TrackList } from "@/components/shared/track-list";
import { JumpToCurrentButton } from "@/components/shared/jump-to-current-button";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { usePlaybackStore } from "@/lib/store/playback";
import {
  useIsPinned,
  usePinnedPlaylistsStore,
} from "@/lib/store/pinned-playlists";
import {
  usePlaylistSortStore,
  type PlaylistSortMode,
} from "@/lib/store/playlist-sort";
import { toast } from "sonner";
import { usePremiumStore } from "@/lib/store/premium";
import { useAccounts } from "@/lib/store/accounts";
import { openPremiumGate } from "@/lib/store/premium-gate";
import {
  cancelPlaylistDownload,
  offlineIdentityKey,
  playlistDownloadKey,
  retryPlaylistDownload,
  startPlaylistDownload,
  useOfflinePlaylistStore,
  usePlaylistDownloadStore,
} from "@/lib/store/playlist-downloads";
import {
  availableOfflineQueue,
  listOfflineTracks,
  OFFLINE_LIBRARY_QUERY_KEY,
  offlineQueueForPlaylist,
} from "@/lib/offline-library";

export const Route = createFileRoute("/playlist/$id")({
  component: PlaylistPageView,
});

type AnyPage = PlaylistFirstPage | PlaylistNextPage;

function PlaylistPageView() {
  const { id } = Route.useParams();

  const query = useInfiniteQuery<AnyPage, Error>({
    queryKey: ["playlist-pages", id],
    initialPageParam: undefined,
    queryFn: async ({ pageParam }) => {
      if (!pageParam) return fetchPlaylistFirstPage(id);
      return fetchPlaylistContinuation(pageParam as string);
    },
    getNextPageParam: (lastPage) => lastPage.continuationToken,
  });

  const pinned = useIsPinned(id);
  const pin = usePinnedPlaylistsStore((s) => s.pin);
  const unpin = usePinnedPlaylistsStore((s) => s.unpin);
  const isLikedSongs = id === "LM" || id === "VLLM";
  const premiumStatus = usePremiumStore((state) => state.status);
  const premiumSource = usePremiumStore((state) => state.source);
  const canPlayDownloaded = premiumStatus === "premium";
  const canDownload = canPlayDownloaded && premiumSource === "live";
  const accounts = useAccounts();
  const activeAccount = accounts.data?.find((account) => account.isActive);
  const identityKey = activeAccount
    ? offlineIdentityKey(activeAccount.id, activeAccount.pageId)
    : null;
  const scopedPlaylistKey = identityKey
    ? playlistDownloadKey(identityKey, id)
    : null;
  const batch = usePlaylistDownloadStore((state) =>
    scopedPlaylistKey ? state.batches[scopedPlaylistKey] : undefined,
  );
  const manifest = useOfflinePlaylistStore((state) =>
    identityKey ? state.manifestsByIdentity[identityKey]?.[id] : undefined,
  );
  const [preparingDownload, setPreparingDownload] = useState(false);
  const [preparingOfflinePlayback, setPreparingOfflinePlayback] =
    useState(false);
  const [cooldownClock, setCooldownClock] = useState(() => Date.now());
  const downloadPreparationAbortRef = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      downloadPreparationAbortRef.current?.abort();
    },
    [id],
  );
  const pages = query.data?.pages ?? [];
  const header = pages[0] as PlaylistFirstPage | undefined;
  const tracks = useMemo(() => pages.flatMap((page) => page.tracks), [pages]);
  const offlineLibrary = useQuery({
    queryKey: OFFLINE_LIBRARY_QUERY_KEY,
    queryFn: listOfflineTracks,
    staleTime: 5_000,
  });
  const availableOfflineTracks = useMemo(
    () =>
      manifest
        ? availableOfflineQueue(manifest.tracks, offlineLibrary.data ?? [])
        : offlineQueueForPlaylist(tracks, offlineLibrary.data ?? []),
    [manifest, tracks, offlineLibrary.data],
  );
  const offlineComplete =
    !!manifest &&
    manifest.tracks.length > 0 &&
    availableOfflineTracks.length === manifest.tracks.length;
  const retryRemainingMs = Math.max(
    0,
    (batch?.retryAt ?? 0) - Math.max(cooldownClock, Date.now()),
  );
  const retryCoolingDown = retryRemainingMs > 0;
  useEffect(() => {
    if (!batch?.retryAt || batch.retryAt <= Date.now()) return;
    const timer = window.setInterval(() => setCooldownClock(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [batch?.retryAt]);
  const batchActive =
    batch?.phase === "preparing" ||
    batch?.phase === "downloading" ||
    batch?.phase === "cancelling";

  const sortMode = usePlaylistSortStore(
    (s) => s.modes[id] ?? ("default" as PlaylistSortMode),
  );
  const setSortMode = usePlaylistSortStore((s) => s.setMode);

  const [searchQuery, setSearchQuery] = useState("");
  const normalizedQuery = searchQuery.trim().toLowerCase();

  const sortedTracks = useMemo(
    () => sortTracks(tracks, sortMode),
    [tracks, sortMode],
  );
  const visibleTracks = useMemo(() => {
    if (!normalizedQuery) return sortedTracks;
    return sortedTracks.filter((t) => {
      const haystack = [
        t.title,
        t.album,
        t.subtitle,
        ...(t.artists?.map((a) => a.name) ?? []),
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return haystack.includes(normalizedQuery);
    });
  }, [sortedTracks, normalizedQuery]);

  // Load more whenever the sentinel enters the viewport. `rootMargin`
  // fires ~a screen early so the next page is usually in hand by the
  // time the user actually reaches the end of the current batch.
  const sentinelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    if (!query.hasNextPage) return;
    // Stop auto-loading once a continuation has errored, otherwise the
    // still-visible sentinel re-fires fetchNextPage in an unbounded loop.
    if (query.error) return;
    const obs = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting && !query.isFetchingNextPage) {
            query.fetchNextPage();
          }
        }
      },
      { rootMargin: "600px 0px" },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [
    query.hasNextPage,
    query.isFetchingNextPage,
    query.fetchNextPage,
    query.error,
  ]);

  // When the user picks any non-default sort, eagerly drain all
  // continuations so the sort applies to the whole playlist, not just
  // the prefix that's been scrolled into view. The effect re-runs after
  // each page lands and stops once `hasNextPage` becomes false.
  // Spaced by ~250 ms to keep YouTube from rate-limiting on very large
  // playlists (10k+ tracks ≈ 100+ continuation requests). Without the
  // pause the effect re-fires immediately on every page success and
  // hammers the InnerTube edge synchronously.
  useEffect(() => {
    if (sortMode === "default" && !normalizedQuery) return;
    if (!query.hasNextPage) return;
    if (query.isFetchingNextPage) return;
    // Don't keep draining after an error — it would retry every 250 ms.
    if (query.error) return;
    const t = setTimeout(() => query.fetchNextPage(), 250);
    return () => clearTimeout(t);
  }, [
    sortMode,
    normalizedQuery,
    query.hasNextPage,
    query.isFetchingNextPage,
    query.fetchNextPage,
    query.error,
  ]);

  // Only take over the whole view on error when nothing is loaded yet.
  // A failed *continuation* fetch sets query.error while data still holds
  // the loaded pages — early-returning here would wipe the header and all
  // loaded tracks on one transient network blip (esp. during the eager
  // sort/search drain that fires 100+ continuations).
  if (query.error && !header) {
    return (
      <div className="flex items-start gap-3 rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm">
        <AlertCircleIcon className="size-5 shrink-0 text-destructive" />
        <div className="flex flex-col gap-1">
          <span className="font-medium">Couldn't load playlist</span>
          <span className="text-muted-foreground">{query.error.message}</span>
        </div>
      </div>
    );
  }

  if (!header) return <PlaylistSkeleton />;

  const metadataParts = [
    header.owner,
    header.trackCount ? `${header.trackCount} songs` : undefined,
  ].filter(Boolean) as string[];

  const downloadPlaylist = async () => {
    if (preparingDownload) {
      downloadPreparationAbortRef.current?.abort();
      return;
    }
    // Cancellation is never an entitled operation. Keep it available if the
    // account changes or a live Premium probe expires during a running batch.
    if (batchActive) {
      if (identityKey) {
        await cancelPlaylistDownload(identityKey, id).catch((error) =>
          toast.error(
            `Couldn't cancel playlist download: ${
              error instanceof Error ? error.message : String(error)
            }`,
          ),
        );
      }
      return;
    }
    if (retryCoolingDown) {
      toast.info(
        "YouTube is rate limiting downloads. Please wait before retrying.",
      );
      return;
    }
    if (!canDownload) {
      if (canPlayDownloaded) {
        toast.info(
          "Reconnect so Goosic can verify Premium before downloading more music.",
        );
      } else {
        openPremiumGate();
      }
      return;
    }
    if (batch?.phase === "failed" || batch?.phase === "cancelled") {
      if (!identityKey) {
        toast.error("The active YouTube account is still loading.");
        return;
      }
      await retryPlaylistDownload(identityKey, id).catch((error) =>
        toast.error(
          `Playlist download failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        ),
      );
      return;
    }
    const controller = new AbortController();
    downloadPreparationAbortRef.current = controller;
    setPreparingDownload(true);
    try {
      // The visible route is lazily paginated; offline means the whole
      // playlist, so use the strict continuation drain before starting.
      const full = await fetchPlaylistStrict(id, { signal: controller.signal });
      downloadPreparationAbortRef.current = null;
      setPreparingDownload(false);
      await startPlaylistDownload(id, header.title, full.tracks);
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        toast.info("Playlist download preparation cancelled.");
        return;
      }
      toast.error(
        `Playlist download failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    } finally {
      if (downloadPreparationAbortRef.current === controller) {
        downloadPreparationAbortRef.current = null;
        setPreparingDownload(false);
      }
    }
  };

  const playDownloaded = async () => {
    if (!canPlayDownloaded) {
      openPremiumGate();
      return;
    }
    let playableTracks = availableOfflineTracks;
    let expectedTrackCount = manifest?.tracks.length ?? tracks.length;
    if (!manifest) {
      setPreparingOfflinePlayback(true);
      try {
        const full = await fetchPlaylistStrict(id);
        expectedTrackCount = full.tracks.length;
        playableTracks = offlineQueueForPlaylist(
          full.tracks,
          offlineLibrary.data ?? [],
        );
      } catch (error) {
        toast.error(
          `Couldn't prepare downloaded playlist: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        return;
      } finally {
        setPreparingOfflinePlayback(false);
      }
    }
    if (!playableTracks.length) {
      toast.error("No playable downloaded tracks are available.");
      return;
    }
    const playback = usePlaybackStore.getState();
    playback.setQueue(playableTracks, 0);
    playback.setShuffle(false);
    if (playableTracks.length < expectedTrackCount) {
      toast.info(
        `Playing ${playableTracks.length}/${expectedTrackCount} downloaded tracks.`,
      );
    }
  };

  return (
    <div className="flex flex-col gap-8 px-6 pb-6 pt-3">
      <EntityHeader
        title={header.title}
        metadata={metadataParts.join(" • ")}
        description={header.description}
        thumbnails={header.thumbnails}
        onPlay={() => {
          if (tracks.length > 0) {
            usePlaybackStore.getState().playShelfItems(tracks, 0);
            usePlaybackStore.getState().setShuffle(false);
          }
        }}
        onShuffle={() => {
          if (tracks.length > 0) {
            const start = Math.floor(Math.random() * tracks.length);
            usePlaybackStore.getState().playShelfItems(tracks, start);
            usePlaybackStore.getState().setShuffle(true);
          }
        }}
        actions={
          <>
            <Button
              variant="outline"
              onClick={() => void downloadPlaylist()}
              disabled={batch?.phase === "cancelling" || retryCoolingDown}
            >
              {preparingDownload || batch?.phase === "downloading" ? (
                <SquareIcon />
              ) : batch?.phase === "cancelling" ? (
                <Loader2Icon className="animate-spin" />
              ) : batchActive ? (
                <SquareIcon />
              ) : (
                <DownloadIcon />
              )}
              {preparingDownload
                ? "Cancel preparation"
                : batch?.phase === "downloading"
                  ? `${batch.completed}/${batch.plan.length}`
                  : batch?.phase === "cancelling"
                    ? "Cancelling…"
                    : batch?.phase === "failed" || batch?.phase === "cancelled"
                      ? retryCoolingDown
                        ? `Retry in ${Math.max(
                            1,
                            Math.ceil(retryRemainingMs / 60_000),
                          )}m`
                        : "Retry download"
                      : offlineComplete || batch?.phase === "completed"
                        ? "Update download"
                        : "Download playlist"}
            </Button>
            {availableOfflineTracks.length > 0 ||
            (!manifest &&
              (offlineLibrary.data ?? []).some((entry) => entry.valid)) ? (
              <Button
                variant="outline"
                onClick={() => void playDownloaded()}
                disabled={preparingOfflinePlayback}
              >
                {preparingOfflinePlayback ? (
                  <Loader2Icon className="animate-spin" />
                ) : (
                  <HardDriveIcon />
                )}
                {preparingOfflinePlayback
                  ? "Preparing…"
                  : availableOfflineTracks.length > 0
                    ? "Play downloaded"
                    : "Check downloaded"}
              </Button>
            ) : null}
            {isLikedSongs ? null : pinned ? (
              <Button variant="outline" onClick={() => unpin(id)}>
                <PinOffIcon />
                Unpin
              </Button>
            ) : (
              <Button
                variant="outline"
                onClick={() =>
                  pin({
                    id,
                    title: header.title,
                    thumbnailUrl:
                      header.thumbnails[header.thumbnails.length - 1]?.url,
                  })
                }
              >
                <PinIcon />
                Pin to sidebar
              </Button>
            )}
          </>
        }
      />
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <SearchInput value={searchQuery} onChange={setSearchQuery} />
          <SortMenu
            mode={sortMode}
            onChange={(m) => setSortMode(id, m)}
            isLikedSongs={isLikedSongs}
          />
        </div>
        {(sortMode !== "default" || normalizedQuery) && query.hasNextPage ? (
          <span className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2Icon className="size-3 animate-spin" />
            {normalizedQuery
              ? "Loading full playlist for search…"
              : "Loading full playlist for sort…"}
          </span>
        ) : null}
      </div>

      <JumpToCurrentButton tracks={visibleTracks} />

      {normalizedQuery && visibleTracks.length === 0 && !query.hasNextPage ? (
        <div className="py-6 text-center text-sm text-muted-foreground">
          No tracks match “{searchQuery.trim()}”.
        </div>
      ) : (
        <TrackList
          tracks={visibleTracks}
          playlistId={isLikedSongs ? undefined : id}
        />
      )}

      {query.hasNextPage && (
        <div
          ref={sentinelRef}
          className="flex items-center justify-center py-6 text-sm text-muted-foreground"
        >
          {query.isFetchingNextPage ? (
            <>
              <Loader2Icon className="mr-2 size-4 animate-spin" />
              Loading more…
            </>
          ) : (
            <span className="sr-only">Scroll to load more</span>
          )}
        </div>
      )}
    </div>
  );
}

function sortTracks(tracks: ShelfItem[], mode: PlaylistSortMode): ShelfItem[] {
  if (mode === "default" || tracks.length < 2) return tracks;
  const copy = tracks.slice();
  switch (mode) {
    case "date-added-asc":
      // YT serves Liked / user playlists newest-first. We don't have
      // a parseable timestamp on each row (the visible string is
      // localized — "Apr 23", "Yesterday", etc.), but a simple reverse
      // gives correct oldest-first order.
      copy.reverse();
      break;
    case "title-asc":
      copy.sort((a, b) => a.title.localeCompare(b.title));
      break;
    case "title-desc":
      copy.sort((a, b) => b.title.localeCompare(a.title));
      break;
    case "artist-asc": {
      const key = (t: ShelfItem) => t.artists?.[0]?.name ?? t.subtitle ?? "";
      copy.sort((a, b) => key(a).localeCompare(key(b)));
      break;
    }
    case "duration-asc":
      copy.sort((a, b) => (a.duration ?? 0) - (b.duration ?? 0));
      break;
    case "duration-desc":
      copy.sort((a, b) => (b.duration ?? 0) - (a.duration ?? 0));
      break;
  }
  return copy;
}

const SORT_LABELS: Record<PlaylistSortMode, string> = {
  default: "Date added (newest)",
  "date-added-asc": "Date added (oldest)",
  "title-asc": "Title (A–Z)",
  "title-desc": "Title (Z–A)",
  "artist-asc": "Artist (A–Z)",
  "duration-asc": "Duration (shortest)",
  "duration-desc": "Duration (longest)",
};

function SearchInput({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="relative flex-1">
      <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Search in playlist"
        className="h-8 w-full rounded-md border border-input bg-transparent pl-8 pr-7 text-sm outline-none transition-[color,box-shadow] placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
      />
      {value ? (
        <button
          type="button"
          onClick={() => onChange("")}
          aria-label="Clear search"
          className="absolute right-1.5 top-1/2 grid size-5 -translate-y-1/2 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <XIcon className="size-3.5" />
        </button>
      ) : null}
    </div>
  );
}

function SortMenu({
  mode,
  onChange,
  isLikedSongs,
}: {
  mode: PlaylistSortMode;
  onChange: (m: PlaylistSortMode) => void;
  isLikedSongs: boolean;
}) {
  const options: PlaylistSortMode[] = [
    "default",
    "date-added-asc",
    "title-asc",
    "title-desc",
    "artist-asc",
    "duration-asc",
    "duration-desc",
  ];
  // Non-Liked playlists have a server-defined order that isn't always
  // chronological — relabel "default" to something accurate.
  const labelFor = (m: PlaylistSortMode) =>
    m === "default" && !isLikedSongs ? "Default order" : SORT_LABELS[m];

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm">
          <ArrowDownAZIcon />
          {labelFor(mode)}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-56">
        <DropdownMenuLabel>Sort by</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {options.map((m) => (
          <DropdownMenuItem
            key={m}
            onSelect={() => onChange(m)}
            className="justify-between"
          >
            <span>{labelFor(m)}</span>
            {mode === m ? <CheckIcon className="size-4" /> : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function PlaylistSkeleton() {
  return (
    <div className="flex flex-col gap-8 px-6 pb-6 pt-3">
      <div className="flex flex-col gap-4 md:flex-row md:items-end">
        <Skeleton className="aspect-square w-40 md:w-56" />
        <div className="flex flex-col gap-2">
          <Skeleton className="h-10 w-72" />
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-4 w-24" />
        </div>
      </div>
      {Array.from({ length: 10 }).map((_, i) => (
        <Skeleton key={i} className="h-12 w-full" />
      ))}
    </div>
  );
}
