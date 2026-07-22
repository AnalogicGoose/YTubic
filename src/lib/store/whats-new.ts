import { useEffect } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { useQuery } from "@tanstack/react-query";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { queryClient } from "@/lib/query-client";
import { whatsNewFor, type WhatsNewEntry } from "@/lib/whats-new";
import {
  fetchReleaseNotes,
  resolveWhatsNewEntry,
  whatsNewVersionToShow,
} from "@/lib/whats-new-remote";

/**
 * Release notes come from GitHub, so the dialog says whatever the release
 * says. Six hours between revalidations keeps a long-running app well inside
 * GitHub's 60-requests-per-hour unauthenticated budget, and the persisted
 * cache means an offline launch still has the last-known notes.
 */
const releaseNotesQuery = {
  queryKey: ["release-notes"] as const,
  queryFn: fetchReleaseNotes,
  staleTime: 1000 * 60 * 60 * 6,
  gcTime: 1000 * 60 * 60 * 24 * 30,
  retry: 1,
};

/** Subscribe to the GitHub release notes; `undefined` until they resolve. */
export function useReleaseNotes(): WhatsNewEntry[] | undefined {
  return useQuery(releaseNotesQuery).data;
}

/**
 * Release notes for the one-shot flows below. Falls back to whatever is
 * already cached when the request fails, so being offline degrades to the
 * bundled notes rather than to an error.
 */
async function loadReleaseNotes(): Promise<WhatsNewEntry[] | undefined> {
  try {
    return await queryClient.fetchQuery(releaseNotesQuery);
  } catch {
    return queryClient.getQueryData<WhatsNewEntry[]>(
      releaseNotesQuery.queryKey,
    );
  }
}

type State = {
  /**
   * Highest app version whose notes the user has already been shown.
   * The only persisted field; `open`/`version` below are ephemeral and
   * reset on reload so the dialog never reopens by itself.
   */
  lastSeenVersion: string | null;
  open: boolean;
  /** Which entry's version the dialog is currently showing. */
  version: string | null;
  setLastSeen: (v: string) => void;
  setOpen: (open: boolean) => void;
  show: (version: string) => void;
};

export const useWhatsNewStore = create<State>()(
  persist(
    (set) => ({
      lastSeenVersion: null,
      open: false,
      version: null,
      setLastSeen: (lastSeenVersion) => set({ lastSeenVersion }),
      setOpen: (open) => set({ open }),
      show: (version) => set({ open: true, version }),
    }),
    {
      name: "ytm-whats-new",
      partialize: (s) => ({ lastSeenVersion: s.lastSeenVersion }),
    },
  ),
);

/**
 * Open the What's New dialog manually (About dialog's "What's new"
 * link). Shows the entry for the running app version, falling back to
 * the newest entry so the button always shows something. In dev the
 * app version predates the entries, so this lands on the latest.
 */
export async function openWhatsNew(version?: string): Promise<void> {
  const v = version ?? (await getVersion().catch(() => null));
  const target = whatsNewVersionToShow(v, await loadReleaseNotes());
  if (!target) return;
  useWhatsNewStore.getState().show(target);
}

/**
 * Mount once in AppShell. On launch, if the app version changed since
 * the last run and we have notes for the new version, pop the dialog
 * once. Recording the version afterwards means it fires exactly once
 * per release.
 *
 * `lastSeenVersion === null` covers both a fresh install and the very
 * first launch after this feature shipped (0.1.0 predated this store,
 * so the 0.1.0 -> 0.2.0 update reads as null here). In both cases we
 * still want to introduce the current version's notes once.
 *
 * Dev is skipped: the version is a moving target and shouldn't pop the
 * dialog on every reload. Manual open from About still works there.
 */
export function useWhatsNewOnUpdate(): void {
  useEffect(() => {
    if (import.meta.env.DEV) return;
    let cancelled = false;
    void (async () => {
      const current = await getVersion().catch(() => null);
      if (cancelled || !current) return;
      const store = useWhatsNewStore.getState();
      if (store.lastSeenVersion === current) return;
      store.setLastSeen(current);
      // A bundled entry opens immediately; the dialog swaps in the GitHub
      // release body for this version as soon as the query resolves. Only a
      // version with no bundled notes has to wait for the network, and it
      // stays closed if GitHub has nothing to say about it either.
      if (whatsNewFor(current)) {
        store.show(current);
        return;
      }
      const releases = await loadReleaseNotes();
      if (cancelled) return;
      if (resolveWhatsNewEntry(current, releases)) {
        useWhatsNewStore.getState().show(current);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
}
