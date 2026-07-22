import { describe, expect, it } from "vitest";
import {
  isSeekHoldResolved,
  WEB_SEEK_SETTLE_TIMEOUT_MS,
  WEB_SEEK_TOLERANCE_SECONDS,
  type WebSeekHold,
} from "@/lib/web-playback";

const hold: WebSeekHold = { generation: 7, position: 198, requestedAt: 1_000 };
const sample = (position: number, generation = 7) => ({
  generation,
  position,
});

describe("isSeekHoldResolved", () => {
  it("holds the requested position against pre-seek samples", () => {
    // The official page is still reporting where the track was before the seek
    // reached it. Accepting these snaps the progress bar back to the old time.
    expect(isSeekHoldResolved(hold, sample(92), 1_010)).toBe(false);
    expect(isSeekHoldResolved(hold, sample(160), 1_100)).toBe(false);
  });

  it("releases as soon as a sample corroborates the seek", () => {
    expect(isSeekHoldResolved(hold, sample(198), 1_010)).toBe(true);
    expect(isSeekHoldResolved(hold, sample(198.4), 1_010)).toBe(true);
    // Playback keeps advancing while the seek settles, so the confirming
    // sample lands slightly past the target rather than exactly on it.
    expect(
      isSeekHoldResolved(
        hold,
        sample(hold.position + WEB_SEEK_TOLERANCE_SECONDS),
        1_010,
      ),
    ).toBe(true);
    expect(
      isSeekHoldResolved(
        hold,
        sample(hold.position + WEB_SEEK_TOLERANCE_SECONDS + 0.01),
        1_010,
      ),
    ).toBe(false);
  });

  it("holds a backward seek against samples from further ahead", () => {
    const backward: WebSeekHold = { ...hold, position: 30 };
    expect(isSeekHoldResolved(backward, sample(198), 1_010)).toBe(false);
    expect(isSeekHoldResolved(backward, sample(30.2), 1_010)).toBe(true);
  });

  it("gives up after the settle budget so a refused seek cannot freeze the bar", () => {
    const justBefore = 1_000 + WEB_SEEK_SETTLE_TIMEOUT_MS - 1;
    expect(isSeekHoldResolved(hold, sample(92), justBefore)).toBe(false);
    expect(
      isSeekHoldResolved(hold, sample(92), 1_000 + WEB_SEEK_SETTLE_TIMEOUT_MS),
    ).toBe(true);
  });

  it("never holds a position across playback generations", () => {
    // A hold left over from the previous track must not suppress the new
    // track's position, which legitimately starts nowhere near the target.
    expect(isSeekHoldResolved(hold, sample(0, 8), 1_010)).toBe(true);
  });
});
