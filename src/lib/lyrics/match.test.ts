import { describe, expect, it } from "vitest";
import {
  hitMatches,
  lyricsMetadataMatches,
  normalizeForMatch,
  tokenOverlap,
} from "@/lib/lyrics/match";

describe("normalizeForMatch", () => {
  it("lowercases, strips punctuation and collapses whitespace", () => {
    expect(normalizeForMatch("Hello, World!")).toBe("hello world");
  });

  it("drops parentheticals and featurings", () => {
    expect(normalizeForMatch("Song (Remastered) feat. Someone")).toBe("song");
    expect(normalizeForMatch("Track [Live]")).toBe("track");
  });
});

describe("tokenOverlap", () => {
  it("is 1 for identical token sets and 0 for disjoint", () => {
    expect(tokenOverlap("a b", "a b")).toBe(1);
    expect(tokenOverlap("a b", "c d")).toBe(0);
  });

  it("is measured over the smaller set", () => {
    expect(tokenOverlap("a", "a b c")).toBe(1);
  });
});

describe("hitMatches", () => {
  const norm = normalizeForMatch;

  it("accepts an exact title+artist match", () => {
    expect(
      hitMatches(norm("Bohemian Rhapsody"), norm("Queen"), norm("Bohemian Rhapsody"), norm("Queen")),
    ).toBe(true);
  });

  it("rejects a completely different song (the wrong-lyrics bug)", () => {
    expect(
      hitMatches(norm("Obscure Track"), norm("Small Artist"), norm("Blinding Lights"), norm("The Weeknd")),
    ).toBe(false);
  });

  it("rejects a title match with a mismatched artist", () => {
    expect(
      hitMatches(norm("Hello"), norm("Adele"), norm("Hello"), norm("Someone Else")),
    ).toBe(false);
  });

  it("matches title-only when the artist is unknown", () => {
    expect(hitMatches(norm("Yesterday"), "", norm("Yesterday"), norm("The Beatles"))).toBe(true);
  });

  it("tolerates featurings / parentheticals via normalization", () => {
    expect(
      hitMatches(norm("Blinding Lights"), norm("The Weeknd"), norm("Blinding Lights (Remix)"), norm("The Weeknd feat. X")),
    ).toBe(true);
  });
});

describe("lyricsMetadataMatches", () => {
  it("rejects the same title from another artist", () => {
    expect(
      lyricsMetadataMatches("Real Me", "Future", "Real Me", "Lil Baby"),
    ).toBe(false);
  });

  it("rejects missing candidate artist metadata when the request has an artist", () => {
    expect(lyricsMetadataMatches("Hello", "Adele", "Hello", undefined)).toBe(
      false,
    );
  });

  it("allows punctuation and featured-artist differences", () => {
    expect(
      lyricsMetadataMatches(
        "Blinding Lights (Remix)",
        "The Weeknd feat. Rosalia",
        "Blinding Lights - Remix",
        "The Weeknd, Rosalia",
      ),
    ).toBe(true);
  });
});
