import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import { queryClient } from "@/lib/query-client";
import {
  fetchPremiumStatus,
  type PremiumStatus,
} from "@/lib/innertube/account";

type State = {
  /**
   * Last known Premium status from auto-detection. `null` while we
   * haven't checked yet *or* when the user is not signed in.
   */
  status: PremiumStatus;
  source: "live" | "offlineGrace" | null;
  /** Wall-clock time of the last successful live account-menu probe. */
  verifiedAt: number;
  setStatus: (
    status: PremiumStatus,
    source?: "live" | "offlineGrace" | null,
    verifiedAt?: number,
  ) => void;
};

const ENTITLEMENT_KEY = "goosic-premium-entitlements-v1";
export const OFFLINE_GRACE_MS = 7 * 24 * 60 * 60 * 1000;
/** Downloads fail closed once their last live verification is this old. */
export const PREMIUM_DOWNLOAD_LIVE_MAX_AGE_MS = 5 * 60 * 1000;

export type PremiumProbeResolution = {
  status: PremiumStatus;
  source: "live" | "offlineGrace" | null;
  persist?: "premium" | "free";
};

/**
 * Resolve only terminal probe states. TanStack deliberately retains previous
 * `data` when a background refetch fails, so `data !== undefined` alone must
 * never be interpreted as a fresh live entitlement.
 */
export function resolvePremiumProbe({
  data,
  isSuccess,
  isError,
  verifiedAt,
  now = Date.now(),
}: {
  data: PremiumStatus | undefined;
  isSuccess: boolean;
  isError: boolean;
  verifiedAt: number;
  now?: number;
}): PremiumProbeResolution | null {
  if (isSuccess) {
    if (data === "premium" || data === "free") {
      return { status: data, source: "live", persist: data };
    }
    return { status: null, source: null };
  }
  if (!isError) return null;
  if (verifiedAt > 0 && now - verifiedAt <= OFFLINE_GRACE_MS) {
    return { status: "premium", source: "offlineGrace" };
  }
  return { status: null, source: null };
}

function readEntitlements(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(ENTITLEMENT_KEY) ?? "{}") as Record<
      string,
      number
    >;
  } catch {
    return {};
  }
}

function writeEntitlement(accountId: string, premium: boolean): void {
  const values = readEntitlements();
  if (premium) values[accountId] = Date.now();
  else delete values[accountId];
  localStorage.setItem(ENTITLEMENT_KEY, JSON.stringify(values));
}

/**
 * Premium-status state shared across React and non-React code. The
 * Explicit playlist downloads and downloaded-file playback consult this
 * synchronously. Ordinary online playback is never gated because it belongs
 * to the official YouTube Music WebPlayer.
 *
 * The actual fetching/refresh is owned by the `usePremiumStatusSync`
 * hook mounted in AppShell. Keeping the store dumb means anyone with a
 * cached value (e.g. a freshly opened floating-player window) starts
 * from the conservative `null` and only flips to "premium" once the
 * authoritative check completes.
 *
 * A timestamped entitlement is persisted per account only after a live
 * Premium response. It grants a short grace period for existing downloads
 * when startup is genuinely offline; a live Free response removes it. There
 * is deliberately no user-facing override and ordinary playback is never
 * Premium-gated because it uses the official WebView.
 */
export const usePremiumStore = create<State>()((set) => ({
  status: null,
  source: null,
  verifiedAt: 0,
  setStatus: (
    status,
    source = status ? "live" : null,
    verifiedAt = source === "live" ? Date.now() : 0,
  ) => set({ status, source, verifiedAt }),
}));

/** Synchronous read for explicit offline-download callers. */
export function isPremium(): boolean {
  return usePremiumStore.getState().status === "premium";
}

export function hasFreshLivePremiumDownloadEntitlement(
  entitlement: Pick<State, "status" | "source" | "verifiedAt">,
  now = Date.now(),
): boolean {
  return (
    entitlement.status === "premium" &&
    entitlement.source === "live" &&
    entitlement.verifiedAt > 0 &&
    now - entitlement.verifiedAt <= PREMIUM_DOWNLOAD_LIVE_MAX_AGE_MS
  );
}

/**
 * Revalidate the active account before starting an explicit download and at
 * a bounded cadence while a long batch is running. A cached Zustand value is
 * intentionally insufficient here: the app disables focus refetching and a
 * subscription may be downgraded while Goosic remains open for hours.
 */
export async function verifyPremiumDownloadEntitlement({
  force = false,
}: {
  force?: boolean;
} = {}): Promise<void> {
  const current = usePremiumStore.getState();
  if (!force && hasFreshLivePremiumDownloadEntitlement(current)) {
    return;
  }

  const accountId = await invoke<string | null>("get_active_account_id");
  if (!accountId) {
    usePremiumStore.getState().setStatus(null, null);
    throw new Error(
      "Sign in with YouTube Music Premium to download playlists.",
    );
  }

  let status: PremiumStatus;
  try {
    // `staleTime: 0` bypasses the hook's 30-minute UI cache for this
    // entitlement-sensitive operation while still deduplicating an in-flight
    // probe for the same account.
    status = await queryClient.fetchQuery({
      queryKey: ["premium-status", accountId],
      queryFn: fetchPremiumStatus,
      staleTime: 0,
    });
  } catch {
    const verifiedAt = readEntitlements()[accountId] ?? 0;
    if (verifiedAt > 0 && Date.now() - verifiedAt <= OFFLINE_GRACE_MS) {
      usePremiumStore
        .getState()
        .setStatus("premium", "offlineGrace", verifiedAt);
    } else {
      usePremiumStore.getState().setStatus(null, null);
    }
    throw new Error(
      "Reconnect so Goosic can verify YouTube Music Premium before downloading.",
    );
  }

  const verifiedAt = Date.now();
  if (status === "premium") {
    writeEntitlement(accountId, true);
    usePremiumStore.getState().setStatus("premium", "live", verifiedAt);
    return;
  }
  if (status === "free") {
    writeEntitlement(accountId, false);
    usePremiumStore.getState().setStatus("free", "live", verifiedAt);
  } else {
    usePremiumStore.getState().setStatus(null, null);
  }
  throw new Error("YouTube Music Premium is required for offline downloads.");
}

/**
 * Mount once near the app root (AppShell). Watches the login state
 * and, when authenticated, fetches Premium status from YT Music, then
 * mirrors it into the Zustand store. Signed-out users get `null`
 * immediately so offline actions stay conservatively locked.
 */
export function usePremiumStatusSync(): void {
  const loggedIn = useQuery({
    queryKey: ["auth-logged-in"],
    queryFn: () => invoke<boolean>("is_logged_in"),
    staleTime: 30_000,
  });

  const activeAccount = useQuery({
    queryKey: ["active-account-id"],
    queryFn: () => invoke<string | null>("get_active_account_id"),
    enabled: loggedIn.data === true,
    staleTime: 30_000,
  });

  const premium = useQuery({
    // Never reuse a terminal result from the previous account while a newly
    // active account is still being checked.
    queryKey: ["premium-status", activeAccount.data],
    queryFn: fetchPremiumStatus,
    enabled: loggedIn.data === true && !!activeAccount.data,
    // Premium membership doesn't churn within a session — 30 min is fine
    // and saves an extra account_menu hit on every settings visit.
    staleTime: 30 * 60 * 1000,
    retry: false,
  });

  useEffect(() => {
    if (loggedIn.data !== true || !activeAccount.data) {
      usePremiumStore.setState({ status: null, source: null, verifiedAt: 0 });
      return;
    }
    const accountId = activeAccount.data;
    const verifiedAt = readEntitlements()[accountId] ?? 0;
    const resolution = resolvePremiumProbe({
      data: premium.data,
      isSuccess: premium.isSuccess,
      isError: premium.isError,
      verifiedAt,
    });
    if (!resolution) {
      // A new account's first probe has no terminal result yet. Clear any
      // previous account's in-memory entitlement during that window.
      if (premium.data === undefined) {
        usePremiumStore.setState({ status: null, source: null, verifiedAt: 0 });
      }
      return;
    }
    if (resolution.persist === "premium") writeEntitlement(accountId, true);
    else if (resolution.persist === "free") writeEntitlement(accountId, false);
    usePremiumStore
      .getState()
      .setStatus(
        resolution.status,
        resolution.source,
        resolution.source === "live" ? Date.now() : verifiedAt,
      );
    if (resolution.source !== "offlineGrace") return;

    // Expire an in-memory grace while the app remains open. Without this
    // timer, a user who never caused another query transition could retain
    // downloaded-file playback beyond the seven-day account-scoped window.
    const remaining = Math.max(0, verifiedAt + OFFLINE_GRACE_MS - Date.now());
    const timer = window.setTimeout(() => {
      const current = usePremiumStore.getState();
      if (current.source === "offlineGrace") {
        current.setStatus(null, null);
      }
    }, remaining + 1);
    return () => window.clearTimeout(timer);
  }, [
    activeAccount.data,
    loggedIn.data,
    premium.data,
    premium.isError,
    premium.isSuccess,
  ]);
}
