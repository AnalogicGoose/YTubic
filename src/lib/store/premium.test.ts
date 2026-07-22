import { describe, expect, it } from "vitest";
import {
  hasFreshLivePremiumDownloadEntitlement,
  PREMIUM_DOWNLOAD_LIVE_MAX_AGE_MS,
  resolvePremiumProbe,
} from "@/lib/store/premium";

describe("resolvePremiumProbe", () => {
  it("grants and persists Premium only after a fresh successful probe", () => {
    expect(
      resolvePremiumProbe({
        data: "premium",
        isSuccess: true,
        isError: false,
        verifiedAt: 0,
        now: 10_000,
      }),
    ).toEqual({ status: "premium", source: "live", persist: "premium" });
  });

  it("records a fresh Free result and removes any persisted entitlement", () => {
    expect(
      resolvePremiumProbe({
        data: "free",
        isSuccess: true,
        isError: false,
        verifiedAt: 5_000,
        now: 10_000,
      }),
    ).toEqual({ status: "free", source: "live", persist: "free" });
  });

  it("clears entitlement after a successful anonymous response", () => {
    expect(
      resolvePremiumProbe({
        data: null,
        isSuccess: true,
        isError: false,
        verifiedAt: 5_000,
        now: 10_000,
      }),
    ).toEqual({ status: null, source: null });
  });

  it("does not treat retained Premium data from a failed refetch as live", () => {
    expect(
      resolvePremiumProbe({
        data: "premium",
        isSuccess: false,
        isError: true,
        verifiedAt: 0,
        now: 10_000,
      }),
    ).toEqual({ status: null, source: null });
  });

  it("uses recent verified Premium only for offline grace after a probe error", () => {
    expect(
      resolvePremiumProbe({
        data: "premium",
        isSuccess: false,
        isError: true,
        verifiedAt: 1_000,
        now: 2_000,
      }),
    ).toEqual({ status: "premium", source: "offlineGrace" });
  });

  it("expires offline grace and ignores nonterminal probe data", () => {
    const eightDays = 8 * 24 * 60 * 60 * 1_000;
    expect(
      resolvePremiumProbe({
        data: "premium",
        isSuccess: false,
        isError: true,
        verifiedAt: 1,
        now: eightDays,
      }),
    ).toEqual({ status: null, source: null });
    expect(
      resolvePremiumProbe({
        data: "premium",
        isSuccess: false,
        isError: false,
        verifiedAt: 1,
        now: 2,
      }),
    ).toBeNull();
  });
});

describe("download entitlement freshness", () => {
  it("accepts only a bounded live Premium verification", () => {
    const now = 1_000_000;
    expect(
      hasFreshLivePremiumDownloadEntitlement(
        {
          status: "premium",
          source: "live",
          verifiedAt: now - PREMIUM_DOWNLOAD_LIVE_MAX_AGE_MS,
        },
        now,
      ),
    ).toBe(true);
    expect(
      hasFreshLivePremiumDownloadEntitlement(
        {
          status: "premium",
          source: "live",
          verifiedAt: now - PREMIUM_DOWNLOAD_LIVE_MAX_AGE_MS - 1,
        },
        now,
      ),
    ).toBe(false);
  });

  it.each([
    { status: "free" as const, source: "live" as const },
    { status: "premium" as const, source: "offlineGrace" as const },
    { status: null, source: null },
  ])("rejects $status/$source even when recent", ({ status, source }) => {
    expect(
      hasFreshLivePremiumDownloadEntitlement({
        status,
        source,
        verifiedAt: Date.now(),
      }),
    ).toBe(false);
  });
});
