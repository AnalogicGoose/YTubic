import { isLinuxWebview } from "@/lib/platform";

// On Linux, backdrop-filter is a no-op in practice (see platform.ts), so
// the blur-dependent variants below are skipped entirely rather than
// picked by a `supports-[backdrop-filter]` query that misfires there —
// falling through to this opaque-enough-on-its-own base instead.
// No inset highlights — just a soft outer drop shadow. The old inset
// top-edge glow (white in dark mode) read as a harsh rim the design didn't
// want; every glass surface now stays flat-faced.
const BASE_SURFACE_CLASS =
  "relative isolate border-border bg-background/90 text-foreground shadow-[0_8px_48px_rgba(0,0,0,0.25)] dark:shadow-[0_8px_48px_rgba(0,0,0,0.45)]";

const blurRenders = !isLinuxWebview();

// Where blur actually composites (Windows WebView2, macOS WKWebView), the
// material is the `.liquid-glass` class in index.css — an Apple Liquid
// Glass approximation (blur + saturation lift, specular rim, edge-lens
// glow). True refraction needs `backdrop-filter: url(#svg)` displacement,
// which WebKit doesn't support, so this is as close as the webview gets.
export const GLASS_SURFACE_CLASS = blurRenders
  ? "relative isolate liquid-glass text-foreground"
  : BASE_SURFACE_CLASS;

// The player surface is meant to read as a much lighter touch (10% tint)
// than the general glass surface — but that only holds up when blur is
// actually softening whatever's behind it. Without it, 10% opacity is
// close to invisible and the content behind bleeds through sharp, so this
// falls back to the same opaque base as every other glass surface instead.
// The Tailwind bg-* utilities override .liquid-glass's background-color
// (utilities layer wins over the base-layer class), keeping the documented
// 10% player tint.
// Every glass surface now shares ONE material: the same `.liquid-glass`
// tint + blur, with a single user-tunable `--glass-opacity`. The player
// keeps the extra `liquid-glass-player` marker, but that no longer changes
// its background — it's only a hint to the Windows refraction lens
// (liquid-glass-defs.tsx) so the moving player gets its bolder optics while
// menus stay calm and legible.
export const PLAYER_GLASS_SURFACE_CLASS = blurRenders
  ? `${GLASS_SURFACE_CLASS} liquid-glass-player`
  : BASE_SURFACE_CLASS;

// Menus, dropdowns and popovers use the shared surface unchanged — no
// per-surface tint override, so they track the Frosted-glass slider like
// everything else.
export const MENU_GLASS_SURFACE_CLASS = GLASS_SURFACE_CLASS;
