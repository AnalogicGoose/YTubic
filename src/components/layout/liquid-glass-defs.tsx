import { isWindowsWebview } from "@/lib/platform";

/**
 * Displacement map for the liquid-glass lens: red encodes horizontal
 * displacement (0 → pull left, 255 → pull right), green encodes vertical.
 * Two full-bleed gradients combined with `screen` produce a smooth
 * corner-to-corner ramp, which `feDisplacementMap` turns into a subtle
 * magnifying-lens distortion of whatever sits behind the glass panel.
 */
const LENS_MAP =
  "data:image/svg+xml," +
  encodeURIComponent(
    "<svg xmlns='http://www.w3.org/2000/svg' width='128' height='128'>" +
      "<defs>" +
      "<linearGradient id='x' x1='0' y1='0' x2='1' y2='0'>" +
      "<stop offset='0' stop-color='#000'/><stop offset='1' stop-color='#f00'/>" +
      "</linearGradient>" +
      "<linearGradient id='y' x1='0' y1='0' x2='0' y2='1'>" +
      "<stop offset='0' stop-color='#000'/><stop offset='1' stop-color='#0f0'/>" +
      "</linearGradient>" +
      "</defs>" +
      "<rect width='128' height='128' fill='url(#x)'/>" +
      "<rect width='128' height='128' fill='url(#y)' style='mix-blend-mode:screen'/>" +
      "</svg>",
  );

/**
 * Invisible SVG hosting the `#liquid-glass-lens` filter referenced by
 * `.liquid-refract .liquid-glass` in index.css (Windows-only experiment —
 * Chromium is the only engine that renders SVG filters inside
 * `backdrop-filter`). Must be mounted once per window; both AppShell and
 * FloatingPlayerApp render it because they are separate documents.
 */
export function LiquidGlassDefs() {
  if (!isWindowsWebview()) return null;
  return (
    <svg width="0" height="0" aria-hidden className="absolute">
      <filter
        id="liquid-glass-lens"
        x="0%"
        y="0%"
        width="100%"
        height="100%"
        colorInterpolationFilters="sRGB"
      >
        <feImage href={LENS_MAP} preserveAspectRatio="none" result="map" />
        <feDisplacementMap
          in="SourceGraphic"
          in2="map"
          scale="28"
          xChannelSelector="R"
          yChannelSelector="G"
        />
      </filter>
    </svg>
  );
}
