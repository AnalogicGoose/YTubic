import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => "http://127.0.0.1:43123/token"),
}));

const {
  isDefinitiveOfflineFileFailure,
  offlineStreamUrlFor,
  StreamPreparationError,
} =
  await import("@/lib/stream");

describe("offlineStreamUrlFor", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("preflights and returns only a cache-only URL", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(new Uint8Array([0x1a]), { status: 206 }));
    vi.stubGlobal("fetch", fetchMock);

    const url = await offlineStreamUrlFor("E7LVi1AA218");

    expect(url).toBe(
      "http://127.0.0.1:43123/token/stream/E7LVi1AA218?cache_only=1",
    );
    expect(fetchMock).toHaveBeenCalledWith(url, {
      headers: { Range: "bytes=0-0" },
      cache: "no-store",
    });
    expect(url).not.toContain("ephemeral");
    expect(url).not.toContain("refresh");
  });

  it("preserves a useful local-file diagnostic", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response("cached audio is unavailable", { status: 422 }),
        ),
    );

    const failure = await offlineStreamUrlFor("E7LVi1AA218").catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(StreamPreparationError);
    expect((failure as Error).message).toContain("HTTP 422");
    expect((failure as Error).message).toContain("cached audio is unavailable");
    expect(isDefinitiveOfflineFileFailure(failure)).toBe(true);
  });

  it("does not classify missing or unreachable loopback audio as bad bytes", () => {
    expect(
      isDefinitiveOfflineFileFailure(
        new StreamPreparationError("Offline file unavailable", 404),
      ),
    ).toBe(false);
    expect(
      isDefinitiveOfflineFileFailure(
        new StreamPreparationError("Offline audio server unavailable"),
      ),
    ).toBe(false);
  });
});
