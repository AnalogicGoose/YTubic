import { useEffect, useRef } from "react";
import { isWindowsWebview } from "@/lib/platform";
import { useSettingsStore } from "@/lib/store/settings";
import { clampGlassBlur } from "@/lib/themes";

const SVG_NS = "http://www.w3.org/2000/svg";
const GLASS_SELECTOR = ".liquid-glass";
const AIR_REFRACTIVE_INDEX = 1;
const PROFILE_SAMPLES = 127;

// Figma Glass preset supplied by the product owner. Keep this as the single
// optics source of truth for players, menus, popovers, and dialogs.
export const FIGMA_GLASS_PRESET = {
  lightAngle: 0,
  lightIntensity: 0.4,
  refraction: 70,
  depth: 30,
  dispersion: 20,
  frost: 6,
  splay: 20,
} as const;

type RefractionProfile = {
  normalized: Float32Array;
  maximumDisplacement: number;
};

type SurfaceRegistration = {
  frame: number | null;
  resizeObserver: ResizeObserver;
  filterId: string | null;
  geometry: string | null;
};

type MapPair = {
  displacement: string;
  maximumDisplacement: number;
};

const mapCache = new Map<string, MapPair>();
// feImage stretches the vector field to the panel's exact dimensions, so
// Full-window rasters only waste memory. Bound map resolution and resize
// history: sixteen worst-case 512-by-512 RGBA maps total roughly 16 MiB.
// 512px keeps ultra-wide player maps tall enough for a clean optical edge;
// small menus remain native-resolution.
const MAX_MAP_RASTER_SIZE = 512;
const MAX_CACHED_MAPS = 16;

function convexSquircle(x: number): number {
  const clamped = Math.min(1, Math.max(0, x));
  return Math.pow(1 - Math.pow(1 - clamped, 4), 0.25);
}

/**
 * Sample one radial slice of a convex-squircle bezel, derive its surface
 * normal, refract an orthogonal ray from air into glass with Snell's law, then
 * normalize the lateral displacement for an 8-bit SVG displacement map.
 */
export function createConvexRefractionProfile(
  refraction: number = FIGMA_GLASS_PRESET.refraction,
): RefractionProfile {
  const strength = Math.min(100, Math.max(0, refraction)) / 100;
  const glassRefractiveIndex = 1 + strength * 4;
  const glassThickness = 10 + strength * 190;
  const raw = new Float32Array(PROFILE_SAMPLES + 1);
  let maximumDisplacement = 0;

  for (let i = 0; i <= PROFILE_SAMPLES; i += 1) {
    const x = i / PROFILE_SAMPLES;
    const delta = 0.001;
    const y1 = convexSquircle(Math.max(0, x - delta));
    const y2 = convexSquircle(Math.min(1, x + delta));
    const derivative = (y2 - y1) / (2 * delta);
    const normalLength = Math.hypot(derivative, 1);
    const normalX = -derivative / normalLength;
    const normalY = -1 / normalLength;
    const dot = normalY;
    const eta = AIR_REFRACTIVE_INDEX / glassRefractiveIndex;
    const k = 1 - eta * eta * (1 - dot * dot);

    if (k > 0) {
      const coefficient = eta * dot + Math.sqrt(k);
      const refractedX = -coefficient * normalX;
      const refractedY = eta - coefficient * normalY;
      const displacement =
        Math.abs(refractedY) > 0.0001
          ? Math.abs((refractedX / refractedY) * glassThickness)
          : 0;
      raw[i] = displacement;
      maximumDisplacement = Math.max(maximumDisplacement, displacement);
    }
  }

  const normalized = raw.map((value) =>
    maximumDisplacement > 0 ? value / maximumDisplacement : 0,
  );
  return { normalized, maximumDisplacement };
}

function roundedRectSdf(
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): number {
  const qx = Math.abs(x - width / 2) - (width / 2 - radius);
  const qy = Math.abs(y - height / 2) - (height / 2 - radius);
  return (
    Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) +
    Math.min(Math.max(qx, qy), 0) -
    radius
  );
}

function sampleProfile(profile: Float32Array, x: number): number {
  const position = Math.min(1, Math.max(0, x)) * PROFILE_SAMPLES;
  const lower = Math.floor(position);
  const upper = Math.min(PROFILE_SAMPLES, lower + 1);
  const mix = position - lower;
  return profile[lower] * (1 - mix) + profile[upper] * mix;
}

function createMaps(width: number, height: number, radius: number): MapPair {
  // feImage scales this capped raster back to the exact CSS-pixel size. The
  // radius is scaled with it so the bezel stays physically consistent.
  const rasterScale = Math.min(
    1,
    MAX_MAP_RASTER_SIZE / width,
    MAX_MAP_RASTER_SIZE / height,
  );
  const rasterWidth = Math.max(2, Math.round(width * rasterScale));
  const rasterHeight = Math.max(2, Math.round(height * rasterScale));
  const rasterRadius = Math.max(1, radius * rasterScale);
  const maximumDepth = Math.max(1, Math.min(rasterWidth, rasterHeight) / 2 - 1);
  const bezelWidth = Math.min(
    maximumDepth,
    FIGMA_GLASS_PRESET.depth * rasterScale,
  );
  const profile = createConvexRefractionProfile();

  const displacementCanvas = document.createElement("canvas");
  displacementCanvas.width = rasterWidth;
  displacementCanvas.height = rasterHeight;
  const displacementContext = displacementCanvas.getContext("2d");
  if (!displacementContext) {
    throw new Error("Canvas 2D is unavailable for Liquid Glass maps");
  }

  const displacementImage = displacementContext.createImageData(
    rasterWidth,
    rasterHeight,
  );
  const epsilon = 0.75;

  for (let y = 0; y < rasterHeight; y += 1) {
    for (let x = 0; x < rasterWidth; x += 1) {
      const offset = (y * rasterWidth + x) * 4;
      const px = x + 0.5;
      const py = y + 0.5;
      const sdf = roundedRectSdf(
        px,
        py,
        rasterWidth,
        rasterHeight,
        rasterRadius,
      );
      const distanceFromEdge = -sdf;
      let red = 128;
      let green = 128;

      if (distanceFromEdge >= 0 && distanceFromEdge < bezelWidth) {
        const outwardX =
          roundedRectSdf(
            px + epsilon,
            py,
            rasterWidth,
            rasterHeight,
            rasterRadius,
          ) -
          roundedRectSdf(
            px - epsilon,
            py,
            rasterWidth,
            rasterHeight,
            rasterRadius,
          );
        const outwardY =
          roundedRectSdf(
            px,
            py + epsilon,
            rasterWidth,
            rasterHeight,
            rasterRadius,
          ) -
          roundedRectSdf(
            px,
            py - epsilon,
            rasterWidth,
            rasterHeight,
            rasterRadius,
          );
        const normalLength = Math.hypot(outwardX, outwardY) || 1;
        const inwardX = -outwardX / normalLength;
        const inwardY = -outwardY / normalLength;
        const magnitude = sampleProfile(
          profile.normalized,
          distanceFromEdge / bezelWidth,
        );
        red = Math.round(128 + inwardX * magnitude * 127);
        green = Math.round(128 + inwardY * magnitude * 127);
      }

      displacementImage.data[offset] = red;
      displacementImage.data[offset + 1] = green;
      displacementImage.data[offset + 2] = 128;
      displacementImage.data[offset + 3] = 255;
    }
  }

  displacementContext.putImageData(displacementImage, 0, 0);
  const maps = {
    displacement: displacementCanvas.toDataURL("image/png"),
    // feImage already stretches the lower-resolution vector field to the
    // panel's exact CSS size. Scaling displacement again by 1/rasterScale
    // pulls the optical edge far inside large player surfaces.
    maximumDisplacement: profile.maximumDisplacement,
  };
  // Release the temporary backing store now instead of waiting for renderer
  // GC after every resize or newly opened glass surface.
  displacementCanvas.width = 1;
  displacementCanvas.height = 1;
  return maps;
}

function getCachedMaps(
  key: string,
  width: number,
  height: number,
  radius: number,
): MapPair {
  const cached = mapCache.get(key);
  if (cached) {
    // Refresh insertion order so the first entry remains the least used.
    mapCache.delete(key);
    mapCache.set(key, cached);
    return cached;
  }

  const maps = createMaps(width, height, radius);
  mapCache.set(key, maps);
  while (mapCache.size > MAX_CACHED_MAPS) {
    const oldestKey = mapCache.keys().next().value;
    if (oldestKey === undefined) break;
    mapCache.delete(oldestKey);
  }
  return maps;
}

function svgElement(name: string): SVGElement {
  return document.createElementNS(SVG_NS, name);
}

function setAttributes(
  element: Element,
  attributes: Record<string, string | number>,
): void {
  for (const [name, value] of Object.entries(attributes)) {
    element.setAttribute(name, String(value));
  }
}

function appendFilter(
  defs: SVGDefsElement,
  id: string,
  width: number,
  height: number,
  maps: MapPair,
  blurLevel: number,
  refractionLevel: number,
): void {
  const filter = svgElement("filter");
  setAttributes(filter, {
    id,
    x: -blurLevel * 3,
    y: -blurLevel * 3,
    width: width + blurLevel * 6,
    height: height + blurLevel * 6,
    filterUnits: "userSpaceOnUse",
    primitiveUnits: "userSpaceOnUse",
    colorInterpolationFilters: "sRGB",
  });
  const blur = svgElement("feGaussianBlur");
  setAttributes(blur, {
    in: "SourceGraphic",
    stdDeviation: blurLevel,
    result: "blurred_source",
  });
  // Both maps overdraw the panel by 1px per side: layout sizes can be
  // fractional while offsetWidth/Height round down, and any backdrop pixel
  // left outside the displacement map is treated as (0,0) — a huge negative
  // displacement that renders as a hard garbage seam.
  const displacementImage = svgElement("feImage");
  setAttributes(displacementImage, {
    href: maps.displacement,
    x: -1,
    y: -1,
    width: width + 2,
    height: height + 2,
    preserveAspectRatio: "none",
    result: "displacement_map",
  });
  const displacement = svgElement("feDisplacementMap");
  setAttributes(displacement, {
    in: "blurred_source",
    in2: "displacement_map",
    scale: maps.maximumDisplacement * refractionLevel,
    xChannelSelector: "R",
    yChannelSelector: "G",
    result: "displaced",
  });
  // The refracted, blurred backdrop IS the output — no saturation lift and
  // no specular rim. The old 6× saturate blew the backdrop into a vivid,
  // over-saturated smear; showing true colors reads as clean glass. The
  // last appended primitive is the filter's result, so `displacement`
  // (result "displaced") is what paints.
  filter.append(blur, displacementImage, displacement);
  defs.append(filter);
}

function geometryKey(width: number, height: number, radius: number): string {
  // Buckets avoid regenerating hundreds of near-identical raster maps during
  // resize; the maps are stretched by feImage to each panel's exact size.
  return `${Math.max(8, Math.round(width / 8) * 8)}x${Math.max(8, Math.round(height / 8) * 8)}r${Math.max(1, Math.round(radius))}`;
}

/**
 * Invisible SVG host plus a Windows-only observer. Every glass panel receives
 * a filter generated for its measured dimensions; fixed filter images do not
 * resize automatically when used as Chromium backdrop filters.
 */
export function LiquidGlassDefs() {
  const defsRef = useRef<SVGDefsElement>(null);
  // The Glass-blur slider drives the shader's Gaussian blur. Held in a ref so
  // the observer effect (mounted once) always reads the live value without
  // being torn down and rebuilt on every slider tick.
  const glassBlur = useSettingsStore((s) => s.glassBlur);
  const blurRef = useRef(glassBlur);
  blurRef.current = clampGlassBlur(glassBlur);
  // Set by the observer effect; lets the slider force a re-measure of every
  // live glass panel so the new blur is baked into fresh per-surface filters.
  const remeasureAllRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    remeasureAllRef.current?.();
  }, [glassBlur]);

  useEffect(() => {
    if (!isWindowsWebview() || !defsRef.current) return;
    const defs = defsRef.current;
    const registrations = new Map<HTMLElement, SurfaceRegistration>();

    let filterSequence = 0;

    const measure = (element: HTMLElement) => {
      const registration = registrations.get(element);
      if (!registration) return;
      registration.frame = null;
      // Layout size, never getBoundingClientRect(): menus and popovers mount
      // mid `zoom-in-95` enter animation, and a transformed rect bakes that
      // shrunken scale into the filter geometry — the maps end short of the
      // panel's real edges and the glass shows a hard seam. offsetWidth/Height
      // ignore transforms, and the ResizeObserver re-measures real layout
      // changes.
      const width = element.offsetWidth;
      const height = element.offsetHeight;
      if (width < 2 || height < 2) return;
      const computed = getComputedStyle(element);
      const radius = Math.min(
        Math.max(1, Number.parseFloat(computed.borderTopLeftRadius) || 34),
        width / 2,
        height / 2,
      );
      const isPlayer = element.classList.contains("liquid-glass-player");
      // A single user-controlled blur for every surface (the Glass-blur
      // slider), baked into the shader here so the refraction path honors it
      // just like the plain CSS backdrop-filter does. The displacement
      // (refraction) strength keeps the player/menu distinction.
      const blurLevel = blurRef.current;
      const geometry = `${isPlayer ? "player" : "menu"}-${width}x${height}r${Math.round(radius)}b${blurLevel}`;
      if (registration.geometry === geometry) return;
      registration.geometry = geometry;
      const refractionLevel = isPlayer ? 1 : 0.7;
      // Raster maps stay cached in 8px buckets (feImage stretches them the
      // last few pixels), but the filter geometry itself is exact — a bucket
      // rounded below the panel size leaves an unmapped displacement strip.
      const key = geometryKey(width, height, radius);
      const [size, radiusPart] = key.split("r");
      const [mapWidth, mapHeight] = size.split("x").map(Number);
      const maps = getCachedMaps(key, mapWidth, mapHeight, Number(radiusPart));
      // Fresh id per geometry change: swapping the url() reference is the
      // repaint signal Chromium reliably honors for backdrop filters. The
      // superseded per-surface filter is dropped right after, so defs holds
      // one filter per live glass panel even through continuous resizes.
      filterSequence += 1;
      const id = `liquid-glass-s${filterSequence}`;
      appendFilter(defs, id, width, height, maps, blurLevel, refractionLevel);
      element.style.setProperty("--liquid-glass-filter", `url("#${id}")`);
      element.dataset.liquidGlassReady = "true";
      if (registration.filterId) {
        defs.querySelector(`#${CSS.escape(registration.filterId)}`)?.remove();
      }
      registration.filterId = id;
    };

    const scheduleMeasure = (element: HTMLElement) => {
      const registration = registrations.get(element);
      if (!registration || registration.frame !== null) return;
      registration.frame = requestAnimationFrame(() => measure(element));
    };
    const register = (element: HTMLElement) => {
      if (registrations.has(element)) return;
      const resizeObserver = new ResizeObserver(() => scheduleMeasure(element));
      registrations.set(element, {
        frame: null,
        resizeObserver,
        filterId: null,
        geometry: null,
      });
      resizeObserver.observe(element);
      scheduleMeasure(element);
    };
    const unregister = (element: HTMLElement) => {
      const registration = registrations.get(element);
      if (!registration) return;
      registration.resizeObserver.disconnect();
      if (registration.frame !== null) cancelAnimationFrame(registration.frame);
      if (registration.filterId) {
        defs.querySelector(`#${CSS.escape(registration.filterId)}`)?.remove();
      }
      element.style.removeProperty("--liquid-glass-filter");
      delete element.dataset.liquidGlassReady;
      registrations.delete(element);
    };
    const scan = (node: Node) => {
      if (!(node instanceof Element)) return;
      if (node.matches(GLASS_SELECTOR)) register(node as HTMLElement);
      node
        .querySelectorAll<HTMLElement>(GLASS_SELECTOR)
        .forEach((element) => register(element));
    };
    const unscan = (node: Node) => {
      if (!(node instanceof Element)) return;
      if (node.matches(GLASS_SELECTOR)) unregister(node as HTMLElement);
      node
        .querySelectorAll<HTMLElement>(GLASS_SELECTOR)
        .forEach((element) => unregister(element));
    };

    scan(document.body);

    // Re-run every live surface's measurement (geometry reset forces a fresh
    // filter) so a Glass-blur slider change repaints the shader immediately.
    remeasureAllRef.current = () => {
      for (const [element, registration] of registrations) {
        registration.geometry = null;
        scheduleMeasure(element);
      }
    };

    const mutationObserver = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        mutation.addedNodes.forEach(scan);
        mutation.removedNodes.forEach(unscan);
      }
    });
    mutationObserver.observe(document.body, { childList: true, subtree: true });

    return () => {
      remeasureAllRef.current = null;
      mutationObserver.disconnect();
      for (const [element, registration] of registrations) {
        registration.resizeObserver.disconnect();
        if (registration.frame !== null)
          cancelAnimationFrame(registration.frame);
        if (registration.filterId) {
          defs.querySelector(`#${CSS.escape(registration.filterId)}`)?.remove();
        }
        element.style.removeProperty("--liquid-glass-filter");
        delete element.dataset.liquidGlassReady;
      }
      registrations.clear();
    };
  }, []);

  if (!isWindowsWebview()) return null;
  return (
    <svg
      width="0"
      height="0"
      aria-hidden
      className="pointer-events-none absolute"
      colorInterpolationFilters="sRGB"
    >
      <defs ref={defsRef} />
    </svg>
  );
}
