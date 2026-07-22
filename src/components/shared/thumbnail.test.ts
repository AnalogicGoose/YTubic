import { describe, expect, it } from "vitest";
import {
  pickHighResThumbnail,
  pickThumbnail,
} from "@/components/shared/thumbnail";

describe("thumbnail fallbacks", () => {
  it("treats missing persisted artwork as an empty source list", () => {
    expect(pickThumbnail(undefined)).toBeNull();
    expect(pickThumbnail(null)).toBeNull();
    expect(pickHighResThumbnail(undefined)).toBeNull();
    expect(pickHighResThumbnail(null)).toBeNull();
  });
});
