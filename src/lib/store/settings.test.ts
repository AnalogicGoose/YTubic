import { describe, expect, it } from "vitest";
import { stripRetiredSettings } from "@/lib/store/settings";

describe("stripRetiredSettings", () => {
  it("drops the retired album-mesh toggle", () => {
    // The mesh is now the only ambient treatment, so an install that had
    // switched it off must not keep a value nothing reads. Whether any
    // ambient background renders is the `background` preference alone.
    const stripped = stripRetiredSettings({
      background: "ambient",
      dynamicAlbumMesh: false,
    });
    expect(stripped).not.toHaveProperty("dynamicAlbumMesh");
    expect(stripped.background).toBe("ambient");
  });

  it("drops the previously retired preferences too", () => {
    expect(
      stripRetiredSettings({
        glassOpacity: 0.4,
        cacheAutoClean: true,
        lastCacheCleanAt: 1234,
      }),
    ).toEqual({});
  });

  it("preserves every live preference", () => {
    const live = {
      closeAction: "quit",
      background: "plain",
      visualTheme: "modern",
      glassBlur: 12,
      playbackNotifications: true,
      discordRichPresence: true,
      lastfmEnabled: true,
      lastfmSessionKey: "key",
      lastfmUsername: "someone",
      lastfmAvatar: null,
      lastfmLoveSync: true,
    };
    expect(stripRetiredSettings(live)).toEqual(live);
  });

  it("does not mutate the object it was given", () => {
    // `merge` receives zustand's persisted object; mutating it in place would
    // reach through to state the caller still holds.
    const persisted = { dynamicAlbumMesh: true, background: "ambient" };
    stripRetiredSettings(persisted);
    expect(persisted.dynamicAlbumMesh).toBe(true);
  });

  it("handles an empty persisted object", () => {
    expect(stripRetiredSettings({})).toEqual({});
  });
});
