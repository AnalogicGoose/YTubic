import { beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({
  invoke: vi.fn(),
}));

const queries = vi.hoisted(() => ({
  fetchQuery: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }));
vi.mock("@/lib/query-client", () => ({
  queryClient: { fetchQuery: queries.fetchQuery },
}));
vi.mock("@/lib/innertube/account", () => ({
  fetchPremiumStatus: vi.fn(),
}));

const {
  PREMIUM_DOWNLOAD_LIVE_MAX_AGE_MS,
  usePremiumStore,
  verifyPremiumDownloadEntitlement,
} = await import("@/lib/store/premium");

const values = new Map<string, string>();

beforeEach(() => {
  values.clear();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  });
  native.invoke.mockReset().mockResolvedValue("account-a");
  queries.fetchQuery.mockReset().mockResolvedValue("premium");
  usePremiumStore.setState({
    status: null,
    source: null,
    verifiedAt: 0,
  });
});

describe("verifyPremiumDownloadEntitlement", () => {
  it("forces a live account-scoped probe and records its verification time", async () => {
    await verifyPremiumDownloadEntitlement({ force: true });

    expect(native.invoke).toHaveBeenCalledWith("get_active_account_id");
    expect(queries.fetchQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        queryKey: ["premium-status", "account-a"],
        staleTime: 0,
      }),
    );
    expect(usePremiumStore.getState()).toMatchObject({
      status: "premium",
      source: "live",
    });
    expect(usePremiumStore.getState().verifiedAt).toBeGreaterThan(0);
  });

  it("reuses only a still-fresh live verification", async () => {
    usePremiumStore.setState({
      status: "premium",
      source: "live",
      verifiedAt: Date.now() - PREMIUM_DOWNLOAD_LIVE_MAX_AGE_MS + 1,
    });

    await verifyPremiumDownloadEntitlement();
    expect(native.invoke).not.toHaveBeenCalled();
    expect(queries.fetchQuery).not.toHaveBeenCalled();
  });

  it("fails closed and revokes download authority after a live Free result", async () => {
    queries.fetchQuery.mockResolvedValueOnce("free");

    await expect(
      verifyPremiumDownloadEntitlement({ force: true }),
    ).rejects.toThrow("Premium");
    expect(usePremiumStore.getState()).toMatchObject({
      status: "free",
      source: "live",
    });
  });
});
