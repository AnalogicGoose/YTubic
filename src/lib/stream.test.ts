import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => "http://127.0.0.1:43123/token"),
}));

const { usePremiumStore } = await import("@/lib/store/premium");
const { StreamPreparationError, streamUrlFor } = await import("@/lib/stream");

describe("streamUrlFor preflight", () => {
  beforeEach(() => {
    usePremiumStore.setState({ status: "premium" });
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("prepares one byte before returning the canonical media URL", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(new Uint8Array([0x1a]), { status: 206 }));
    vi.stubGlobal("fetch", fetchMock);

    const url = await streamUrlFor("E7LVi1AA218");

    expect(url).toBe("http://127.0.0.1:43123/token/stream/E7LVi1AA218");
    expect(fetchMock).toHaveBeenCalledWith(url, {
      headers: { Range: "bytes=0-0" },
      cache: "no-store",
    });
  });

  it("uses refresh only for preparation, never for HTMLAudio's URL", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(new Uint8Array([0x1a]), { status: 206 }));
    vi.stubGlobal("fetch", fetchMock);

    const url = await streamUrlFor("E7LVi1AA218", { refresh: true });

    expect(fetchMock.mock.calls[0][0]).toBe(`${url}?refresh=1`);
    expect(url).not.toContain("refresh");
  });

  it("keeps the ephemeral storage flag across refresh preparation", async () => {
    usePremiumStore.setState({ status: "free" });
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(new Uint8Array([0x1a]), { status: 206 }));
    vi.stubGlobal("fetch", fetchMock);

    const url = await streamUrlFor("E7LVi1AA218", { refresh: true });

    expect(fetchMock.mock.calls[0][0]).toBe(
      "http://127.0.0.1:43123/token/stream/E7LVi1AA218?ephemeral=1&refresh=1",
    );
    expect(url).toBe(
      "http://127.0.0.1:43123/token/stream/E7LVi1AA218?ephemeral=1",
    );
  });

  it("preserves yt-dlp diagnostics instead of a generic media error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("ERROR: Sign in to confirm you're not a bot", {
          status: 502,
        }),
      ),
    );

    const failure = await streamUrlFor("E7LVi1AA218").catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(StreamPreparationError);
    expect((failure as Error).message).toContain("HTTP 502");
    expect((failure as Error).message).toContain("not a bot");
  });
});
