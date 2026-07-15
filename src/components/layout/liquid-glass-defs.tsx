import { useEffect, useRef } from "react";
import { isWindowsWebview } from "@/lib/platform";

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
  specular: string;
  maximumDisplacement: number;
};

const mapCache = new Map<string, MapPair>();

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
  const rasterScale = Math.min(1, 1024 / width, 1024 / height);
  const rasterWidth = Math.max(2, Math.round(width * rasterScale));
  const rasterHeight = Math.max(2, Math.round(height * rasterScale));
  const rasterRadius = Math.max(1, radius * rasterScale);
  const maximumDepth = Math.max(1, Math.min(rasterWidth, rasterHeight) / 2 - 1);
  const bezelWidth = Math.min(
    maximumDepth,
    FIGMA_GLASS_PRESET.depth * rasterScale,
  );
  const specularWidth = Math.min(
    maximumDepth,
    bezelWidth * (1 + FIGMA_GLASS_PRESET.splay / 50),
  );
  const profile = createConvexRefractionProfile();

  const displacementCanvas = document.createElement("canvas");
  const specularCanvas = document.createElement("canvas");
  displacementCanvas.width = specularCanvas.width = rasterWidth;
  displacementCanvas.height = specularCanvas.height = rasterHeight;
  const displacementContext = displacementCanvas.getContext("2d");
  const specularContext = specularCanvas.getContext("2d");
  if (!displacementContext || !specularContext) {
    throw new Error("Canvas 2D is unavailable for Liquid Glass maps");
  }

  const displacementImage = displacementContext.createImageData(
    rasterWidth,
    rasterHeight,
  );
  const specularImage = specularContext.createImageData(
    rasterWidth,
    rasterHeight,
  );
  const epsilon = 0.75;
  const lightRadians = (FIGMA_GLASS_PRESET.lightAngle * Math.PI) / 180;
  // Figma's 0° light is at the top of the object.
  const lightX = Math.sin(lightRadians);
  const lightY = -Math.cos(lightRadians);

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
      let specularAlpha = 0;

      if (distanceFromEdge >= 0 && distanceFromEdge < specularWidth) {
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
        if (distanceFromEdge < bezelWidth) {
          const magnitude = sampleProfile(
            profile.normalized,
            distanceFromEdge / bezelWidth,
          );
          red = Math.round(128 + inwardX * magnitude * 127);
          green = Math.round(128 + inwardY * magnitude * 127);
        }

        // Figma-style light wraps the full perimeter. A small baseline keeps
        // the frame visually complete while the directional term makes the
        // top/bottom glints respond to the configured angle.
        const light = Math.abs(inwardX * lightX + inwardY * lightY);
        const spread = Math.max(0, 1 - distanceFromEdge / specularWidth);
        const glint = Math.pow((0.18 + light * 0.82) * spread, 1.5);
        specularAlpha = Math.round(255 * glint);
      }

      displacementImage.data[offset] = red;
      displacementImage.data[offset + 1] = green;
      displacementImage.data[offset + 2] = 128;
      displacementImage.data[offset + 3] = 255;
      specularImage.data[offset] = 255;
      specularImage.data[offset + 1] = 255;
      specularImage.data[offset + 2] = 255;
      specularImage.data[offset + 3] = specularAlpha;
    }
  }

  displacementContext.putImageData(displacementImage, 0, 0);
  specularContext.putImageData(specularImage, 0, 0);
  return {
    displacement: displacementCanvas.toDataURL("image/png"),
    specular: specularCanvas.toDataURL("image/png"),
    maximumDisplacement: profile.maximumDisplacement / rasterScale,
  };
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
  const saturation = svgElement("feColorMatrix");
  setAttributes(saturation, {
    in: "displaced",
    type: "saturate",
    values: 6,
    result: "displaced_saturated",
  });
  const specularImage = svgElement("feImage");
  setAttributes(specularImage, {
    href: maps.specular,
    x: -1,
    y: -1,
    width: width + 2,
    height: height + 2,
    preserveAspectRatio: "none",
    result: "specular_layer",
  });
  const specularSaturated = svgElement("feComposite");
  setAttributes(specularSaturated, {
    in: "displaced_saturated",
    in2: "specular_layer",
    operator: "in",
    result: "specular_saturated",
  });
  const specularFaded = svgElement("feComponentTransfer");
  setAttributes(specularFaded, {
    in: "specular_layer",
    result: "specular_faded",
  });
  const alpha = svgElement("feFuncA");
  setAttributes(alpha, { type: "linear", slope: 0.4 });
  specularFaded.append(alpha);
  const withSaturation = svgElement("feBlend");
  setAttributes(withSaturation, {
    in: "specular_saturated",
    in2: "displaced",
    mode: "normal",
    result: "with_saturation",
  });
  const output = svgElement("feBlend");
  setAttributes(output, {
    in: "specular_faded",
    in2: "with_saturation",
    mode: "normal",
  });
  filter.append(
    blur,
    displacementImage,
    displacement,
    saturation,
    specularImage,
    specularSaturated,
    specularFaded,
    withSaturation,
    output,
  );
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
      const geometry = `${isPlayer ? "player" : "menu"}-${width}x${height}r${Math.round(radius)}`;
      if (registration.geometry === geometry) return;
      registration.geometry = geometry;
      // Keep Kube's clearer moving-player optics, but make compact menus much
      // calmer and more legible: 32px blur plus the article's 0.7 control-like
      // refraction level prevents large cover-art features swallowing labels.
      const blurLevel = isPlayer ? 1 : 32;
      const refractionLevel = isPlayer ? 1 : 0.7;
      // Raster maps stay cached in 8px buckets (feImage stretches them the
      // last few pixels), but the filter geometry itself is exact — a bucket
      // rounded below the panel size leaves an unmapped displacement strip.
      const key = geometryKey(width, height, radius);
      let maps = mapCache.get(key);
      if (!maps) {
        const [size, radiusPart] = key.split("r");
        const [mapWidth, mapHeight] = size.split("x").map(Number);
        maps = createMaps(mapWidth, mapHeight, Number(radiusPart));
        mapCache.set(key, maps);
      }
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
    const mutationObserver = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        mutation.addedNodes.forEach(scan);
        mutation.removedNodes.forEach(unscan);
      }
    });
    mutationObserver.observe(document.body, { childList: true, subtree: true });

    return () => {
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
