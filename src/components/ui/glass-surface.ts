import { isLinuxWebview } from "@/lib/platform"

// On Linux, backdrop-filter is a no-op in practice (see platform.ts), so
// the blur-dependent variants below are skipped entirely rather than
// picked by a `supports-[backdrop-filter]` query that misfires there —
// falling through to this opaque-enough-on-its-own base instead.
const BASE_SURFACE_CLASS =
  "relative isolate border-black/15 bg-white/90 text-[#1a1a1a] shadow-[inset_0_40px_10px_-40px_rgba(40,40,40,0.34),inset_0_-40px_10px_-40px_rgba(40,40,40,0.2),0_8px_48px_rgba(0,0,0,0.25)] dark:border-white/20 dark:bg-[#1a1a1a]/95 dark:text-[#f5f5f5] dark:shadow-[inset_0_40px_10px_-40px_rgba(255,255,255,0.16),inset_0_-40px_10px_-40px_rgba(0,0,0,0.55),0_8px_48px_rgba(0,0,0,0.45)]"

const blurRenders = !isLinuxWebview()

export const GLASS_SURFACE_CLASS = blurRenders
  ? `${BASE_SURFACE_CLASS} backdrop-blur-[16px] supports-[backdrop-filter]:bg-white/70 dark:supports-[backdrop-filter]:bg-[rgba(26,26,26,0.72)]`
  : BASE_SURFACE_CLASS

// The player surface is meant to read as a much lighter touch (10% tint)
// than the general glass surface — but that only holds up when blur is
// actually softening whatever's behind it. Without it, 10% opacity is
// close to invisible and the content behind bleeds through sharp, so this
// falls back to the same opaque base as every other glass surface instead.
export const PLAYER_GLASS_SURFACE_CLASS = blurRenders
  ? `${GLASS_SURFACE_CLASS} bg-white/10 supports-[backdrop-filter]:bg-white/10 dark:bg-[#1a1a1a]/10 dark:supports-[backdrop-filter]:bg-[#1a1a1a]/10`
  : BASE_SURFACE_CLASS
