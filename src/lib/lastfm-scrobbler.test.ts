import { describe, expect, it } from "vitest";
import { shouldAccrueLastfmPlayback } from "@/lib/lastfm-scrobbler";

describe("Last.fm playback eligibility", () => {
  it("never counts advertisement time as requested-song listening", () => {
    expect(shouldAccrueLastfmPlayback(true, "ready", true)).toBe(false);
    expect(shouldAccrueLastfmPlayback(true, "loading", false)).toBe(false);
    expect(shouldAccrueLastfmPlayback(false, "ready", false)).toBe(false);
    expect(shouldAccrueLastfmPlayback(true, "ready", false)).toBe(true);
  });
});
