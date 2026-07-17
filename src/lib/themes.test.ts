import { describe, expect, it } from "vitest";
import { getVisualTheme, isVisualThemeId, VISUAL_THEMES } from "@/lib/themes";

describe("visual theme registry", () => {
  it("keeps every child theme on the shared semantic/material contract", () => {
    for (const theme of VISUAL_THEMES) {
      expect(theme.light["--brand"]).toBeTruthy();
      expect(theme.dark["--brand"]).toBeTruthy();
      // Glass tint is a shared material; blur/opacity are user-driven and
      // deliberately NOT baked into the per-theme token set.
      expect(theme.light["--glass-tint-light"]).toBeTruthy();
      expect(theme.dark["--glass-tint-dark"]).toBeTruthy();
      expect(theme.light["--glass-blur"]).toBeUndefined();
      expect(theme.light["--radius"]).toBe("34px");
      expect(theme.dark["--radius"]).toBe("34px");
    }
  });

  it("exposes exactly the Default and Modern themes", () => {
    expect(VISUAL_THEMES.map((t) => t.id)).toEqual(["default", "modern"]);
    expect(getVisualTheme("default").playerLayout).toBe("classic");
    expect(getVisualTheme("modern").playerLayout).toBe("modern");
  });

  it("validates persisted IDs and falls back safely", () => {
    expect(isVisualThemeId("modern")).toBe(true);
    // Retired ids from older installs must no longer validate.
    expect(isVisualThemeId("ocean")).toBe(false);
    expect(isVisualThemeId("not-a-theme")).toBe(false);
    expect(getVisualTheme("not-a-theme" as never).id).toBe("default");
  });
});
