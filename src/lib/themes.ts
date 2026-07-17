import { useEffect } from "react";

/**
 * Visual themes are deliberately data, not scattered component classes.
 * A theme is the "child" of the app's visual master component: it owns the
 * semantic color and material tokens while shared components continue to
 * consume `bg-background`, `text-foreground`, `liquid-glass`, etc.
 *
 * There are two themes, both mirrored from the Figma reference (frames
 * "Default theme" and "Modern"). They share one dark/light token palette —
 * the difference the design draws between them is the bottom player bar's
 * arrangement, carried by the `playerLayout` field and consumed by
 * `PlayerBarBottom`.
 */
export type VisualThemeId = "default" | "modern";

/** How the bottom player bar arranges its sections (see Figma frames). */
export type PlayerLayout = "classic" | "modern";

type ThemeTokens = Record<string, string>;

export type VisualThemeDefinition = {
  id: VisualThemeId;
  label: string;
  description: string;
  /** Bottom-bar arrangement this theme mounts. */
  playerLayout: PlayerLayout;
  swatches: readonly [string, string, string];
  light: ThemeTokens;
  dark: ThemeTokens;
};

const COMMON_LIGHT = {
  "--brand-foreground": "oklch(0.985 0 0)",
  "--primary-foreground": "oklch(0.985 0 0)",
  "--destructive": "oklch(0.577 0.245 27.325)",
  "--destructive-foreground": "oklch(0.985 0 0)",
  "--border": "oklch(0.922 0 0)",
  "--input": "oklch(0.922 0 0)",
  "--ring": "var(--brand)",
  "--sidebar-border": "oklch(0.922 0 0)",
  "--sidebar-ring": "var(--brand)",
  "--surface": "oklch(1 0 0 / 55%)",
  "--surface-hover": "oklch(1 0 0 / 70%)",
  "--surface-active": "oklch(1 0 0 / 85%)",
  "--hairline": "oklch(0 0 0 / 12%)",
  "--titlebar-hover": "oklch(0 0 0 / 7%)",
};

const COMMON_DARK = {
  "--brand-foreground": "oklch(0.985 0 0)",
  "--primary-foreground": "oklch(0.985 0 0)",
  "--destructive": "oklch(0.704 0.191 22.216)",
  "--destructive-foreground": "oklch(0.985 0 0)",
  "--border": "oklch(1 0 0 / 10%)",
  "--input": "oklch(1 0 0 / 10%)",
  "--ring": "var(--brand)",
  "--sidebar-border": "oklch(1 0 0 / 10%)",
  "--sidebar-ring": "var(--brand)",
  "--surface": "oklch(0 0 0 / 30%)",
  "--surface-hover": "oklch(0 0 0 / 50%)",
  "--surface-active": "oklch(0 0 0 / 60%)",
  "--hairline": "oklch(1 0 0 / 10%)",
  "--titlebar-hover": "oklch(1 0 0 / 10%)",
};

const MATERIALS = {
  "--glass-saturation": "120%",
  "--glass-brightness": "1.04",
  // One glass material for every surface (player, menus, popovers, cards).
  // The tint is just an RGB triple; the alpha is a single user-controlled
  // `--glass-opacity` (see `useGlassOpacity` / the Frosted-glass slider),
  // so nothing overrides anyone — surfaces share the exact same recipe.
  "--glass-tint-light": "255 255 255",
  "--glass-tint-dark": "32 32 36",
  // Kept intentionally faint so the panel edge reads as a hairline, not a
  // bright white outline (the "white look" we're removing).
  "--glass-border-light": "rgba(255, 255, 255, 0.30)",
  "--glass-border-dark": "rgba(255, 255, 255, 0.07)",
  "--glass-shadow-light": "0 12px 48px rgba(0, 0, 0, 0.28)",
  "--glass-shadow-dark": "0 12px 48px rgba(0, 0, 0, 0.5)",
  "--app-font-family":
    "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, 'Open Sans', 'Helvetica Neue', sans-serif",
  "--radius": "34px",
};

const makeTokens = (
  mode: "light" | "dark",
  values: ThemeTokens,
): ThemeTokens => ({
  ...MATERIALS,
  ...(mode === "light" ? COMMON_LIGHT : COMMON_DARK),
  ...values,
});

const NEUTRAL_LIGHT: ThemeTokens = {
  "--brand": "#fa1f3e",
  "--background": "oklch(1 0 0)",
  "--foreground": "oklch(0.145 0 0)",
  "--card": "oklch(1 0 0)",
  "--card-foreground": "oklch(0.145 0 0)",
  "--popover": "oklch(1 0 0)",
  "--popover-foreground": "oklch(0.145 0 0)",
  "--secondary": "oklch(0.97 0 0)",
  "--secondary-foreground": "oklch(0.205 0 0)",
  "--muted": "oklch(0.97 0 0)",
  "--muted-foreground": "oklch(0.556 0 0)",
  "--accent": "oklch(0.97 0 0)",
  "--accent-foreground": "oklch(0.205 0 0)",
  "--sidebar": "oklch(0.985 0 0)",
  "--sidebar-foreground": "oklch(0.145 0 0)",
  "--sidebar-primary": "var(--brand)",
  "--sidebar-primary-foreground": "var(--brand-foreground)",
  "--sidebar-accent": "oklch(0.97 0 0)",
  "--sidebar-accent-foreground": "oklch(0.205 0 0)",
};

const NEUTRAL_DARK: ThemeTokens = {
  "--brand": "#fa1f3e",
  "--background": "oklch(0.145 0 0)",
  "--foreground": "oklch(0.985 0 0)",
  "--card": "oklch(0.205 0 0)",
  "--card-foreground": "oklch(0.985 0 0)",
  "--popover": "oklch(0.205 0 0)",
  "--popover-foreground": "oklch(0.985 0 0)",
  "--secondary": "oklch(0.269 0 0)",
  "--secondary-foreground": "oklch(0.985 0 0)",
  "--muted": "oklch(0.269 0 0)",
  "--muted-foreground": "oklch(0.708 0 0)",
  "--accent": "oklch(1 0 0 / 10%)",
  "--accent-foreground": "oklch(0.985 0 0)",
  "--sidebar": "oklch(0.205 0 0)",
  "--sidebar-foreground": "oklch(0.985 0 0)",
  "--sidebar-primary": "var(--brand)",
  "--sidebar-primary-foreground": "var(--brand-foreground)",
  "--sidebar-accent": "oklch(1 0 0 / 10%)",
  "--sidebar-accent-foreground": "oklch(0.985 0 0)",
};

export const VISUAL_THEMES: readonly VisualThemeDefinition[] = [
  {
    id: "default",
    label: "Default",
    description: "Album art and metadata lead, with the transport centered.",
    playerLayout: "classic",
    swatches: ["#fa1f3e", "#19191d", "#f5f5f5"],
    light: makeTokens("light", NEUTRAL_LIGHT),
    dark: makeTokens("dark", NEUTRAL_DARK),
  },
  {
    id: "modern",
    label: "Modern",
    description:
      "A compact bar: transport on the left, now-playing centered above the scrubber.",
    playerLayout: "modern",
    swatches: ["#fa1f3e", "#19191d", "#f5f5f5"],
    light: makeTokens("light", NEUTRAL_LIGHT),
    dark: makeTokens("dark", NEUTRAL_DARK),
  },
];

export function isVisualThemeId(value: unknown): value is VisualThemeId {
  return VISUAL_THEMES.some((theme) => theme.id === value);
}

export function getVisualTheme(id: VisualThemeId): VisualThemeDefinition {
  return VISUAL_THEMES.find((theme) => theme.id === id) ?? VISUAL_THEMES[0];
}

function applyVisualTheme(id: VisualThemeId): void {
  const root = document.documentElement;
  const theme = getVisualTheme(id);
  const isDark = root.classList.contains("dark");
  const tokens = isDark ? theme.dark : theme.light;

  root.dataset.visualTheme = theme.id;
  for (const [name, value] of Object.entries(tokens)) {
    root.style.setProperty(name, value);
  }
}

/**
 * Mount once per native window. Watching the next-themes class is important:
 * changing Light/Dark must reapply the selected child theme's mode tokens too.
 */
export function useVisualTheme(id: VisualThemeId): void {
  useEffect(() => {
    const root = document.documentElement;
    const apply = () => applyVisualTheme(id);
    const observer = new MutationObserver(apply);

    apply();
    observer.observe(root, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, [id]);
}

/** Slider bounds for the shared glass tint alpha (transparent → opaque). */
export const GLASS_OPACITY_MIN = 0;
export const GLASS_OPACITY_MAX = 1;
export const GLASS_OPACITY_DEFAULT = 0.52;

export function clampGlassOpacity(value: number): number {
  if (!Number.isFinite(value)) return GLASS_OPACITY_DEFAULT;
  return Math.min(GLASS_OPACITY_MAX, Math.max(GLASS_OPACITY_MIN, value));
}

/** Slider bounds for the shared backdrop blur radius, in pixels. */
export const GLASS_BLUR_MIN = 0;
export const GLASS_BLUR_MAX = 60;
export const GLASS_BLUR_DEFAULT = 26;

export function clampGlassBlur(value: number): number {
  if (!Number.isFinite(value)) return GLASS_BLUR_DEFAULT;
  return Math.round(Math.min(GLASS_BLUR_MAX, Math.max(GLASS_BLUR_MIN, value)));
}

/**
 * Drive the single `--glass-opacity` variable every glass surface reads.
 * Kept separate from `applyVisualTheme` on purpose: theme/light-dark changes
 * must never clobber the user's chosen frostiness. Mounted alongside
 * `useVisualTheme` so it applies in both the main and floating windows.
 */
export function useGlassOpacity(opacity: number): void {
  useEffect(() => {
    document.documentElement.style.setProperty(
      "--glass-opacity",
      String(clampGlassOpacity(opacity)),
    );
  }, [opacity]);
}

/**
 * Drive the shared `--glass-blur` radius every glass surface reads. Kept out
 * of `applyVisualTheme` (same reasoning as `useGlassOpacity`) so switching
 * theme or light/dark never resets the user's chosen blur. Mounted in both
 * the main and floating windows.
 */
export function useGlassBlur(blurPx: number): void {
  useEffect(() => {
    document.documentElement.style.setProperty(
      "--glass-blur",
      `${clampGlassBlur(blurPx)}px`,
    );
  }, [blurPx]);
}
