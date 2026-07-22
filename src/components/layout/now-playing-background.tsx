import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { pickHighResThumbnail } from "@/components/shared/thumbnail";
import { currentTrack, usePlaybackStore } from "@/lib/store/playback";

type MeshSample = { color: string; weight: number };
type MeshPalette = readonly [
  MeshSample,
  MeshSample,
  MeshSample,
  MeshSample,
  MeshSample,
];

const paletteCache = new Map<string, Promise<MeshPalette | null>>();

/** Decode `src` into an image the canvas is allowed to read back. */
function decodeImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    // Required for `getImageData`: without it a cross-origin cover taints the
    // canvas. A host that omits CORS headers fails this load outright, which
    // is what `loadSampleableImage` below recovers from.
    image.crossOrigin = "anonymous";
    image.decoding = "async";
    image.onload = () => resolve(image);
    image.onerror = () =>
      reject(new Error("Album artwork could not be loaded"));
    image.src = src;
  });
}

/**
 * Load a cover the canvas can sample, whatever the host's CORS policy.
 *
 * The direct path covers the normal case, including local cached covers whose
 * loopback route already sends permissive CORS. When it fails, the bytes are
 * fetched through `tauri-plugin-http` — that request happens in Rust, so no
 * browser CORS rule applies — and decoded from a same-origin blob URL, which
 * can never taint the canvas.
 *
 * Without this second path an uncooperative host produced no palette at all,
 * and since the mesh is the only ambient treatment that meant no background.
 */
async function loadSampleableImage(url: string): Promise<HTMLImageElement> {
  try {
    return await decodeImage(url);
  } catch {
    const response = await tauriFetch(url, { method: "GET" });
    if (!response.ok) {
      throw new Error(`Album artwork responded ${response.status}`);
    }
    const objectUrl = URL.createObjectURL(await response.blob());
    try {
      return await decodeImage(objectUrl);
    } finally {
      // The decoded bitmap outlives the URL handle, so it is safe to release
      // it as soon as decoding settles rather than leaking one per track.
      URL.revokeObjectURL(objectUrl);
    }
  }
}

async function extractPalette(url: string): Promise<MeshPalette> {
  const image = await loadSampleableImage(url);

  const canvas = document.createElement("canvas");
  canvas.width = 48;
  canvas.height = 48;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("Canvas is unavailable");
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;

  type Bucket = {
    r: number;
    g: number;
    b: number;
    count: number;
  };
  const buckets = new Map<string, Bucket>();

  // Sampling every second pixel is enough for a stable palette while keeping
  // track changes cheap, even for high-resolution cover URLs.
  for (let y = 0; y < canvas.height; y += 2) {
    for (let x = 0; x < canvas.width; x += 2) {
      const offset = (y * canvas.width + x) * 4;
      const alpha = pixels[offset + 3];
      if (alpha < 200) continue;
      const r = pixels[offset];
      const g = pixels[offset + 1];
      const b = pixels[offset + 2];
      const key = `${r >> 4}-${g >> 4}-${b >> 4}`;
      const current = buckets.get(key);
      if (current) {
        current.r += r;
        current.g += g;
        current.b += b;
        current.count += 1;
      } else {
        buckets.set(key, { r, g, b, count: 1 });
      }
    }
  }

  const candidates = [...buckets.values()]
    .map((bucket) => ({
      r: bucket.r / bucket.count,
      g: bucket.g / bucket.count,
      b: bucket.b / bucket.count,
      count: bucket.count,
    }))
    // Frequency matters more than saturation: a mostly white/red cover should
    // remain mostly white/red instead of promoting tiny colorful details.
    .sort((a, b) => b.count - a.count);

  const selected: typeof candidates = [];
  for (const candidate of candidates) {
    const distinct = selected.every((color) => {
      const dr = candidate.r - color.r;
      const dg = candidate.g - color.g;
      const db = candidate.b - color.b;
      return Math.sqrt(dr * dr + dg * dg + db * db) > 36;
    });
    if (distinct) selected.push(candidate);
    if (selected.length === 5) break;
  }

  if (selected.length === 0) throw new Error("Album artwork has no pixels");

  // Keep the sampled RGB values exactly as they occur in the cover. If a very
  // simple cover provides fewer than five distinct clusters, repeat its real
  // colors instead of synthesizing new hues.
  const largestBucket = selected[0].count;
  const samples = selected.map((color) => ({
    color: `rgb(${Math.round(color.r)} ${Math.round(color.g)} ${Math.round(color.b)})`,
    weight: color.count / largestBucket,
  }));
  for (let i = samples.length; i < 5; i += 1) {
    samples.push(samples[i % selected.length]);
  }
  return samples as unknown as MeshPalette;
}

function getPalette(url: string): Promise<MeshPalette | null> {
  const cached = paletteCache.get(url);
  if (cached) return cached;

  // Never invent colors. A CORS/canvas failure returns null and the component
  // below renders no ambient background for that track, because the only
  // ambient treatment is the sampled mesh.
  const pending = extractPalette(url).catch(() => null);
  paletteCache.set(url, pending);
  if (paletteCache.size > 64) {
    const oldest = paletteCache.keys().next().value;
    if (oldest) paletteCache.delete(oldest);
  }
  return pending;
}

function hashPalette(palette: MeshPalette): number {
  let hash = 2166136261;
  for (const sample of palette) {
    const value = `${sample.color}:${sample.weight.toFixed(4)}`;
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
  }
  return hash >>> 0;
}

/** One blob: which sampled color it paints, and its seeded placement. */
type MeshCell = {
  color: string;
  /** Blob center within its grid slot, as CSS percentages. */
  x: number;
  y: number;
  /** Blob size relative to its slot, so radii vary across the field. */
  scale: number;
};

function createMeshGrid(palette: MeshPalette): MeshCell[] {
  // A seeded generator keeps the mosaic stable between React renders while
  // still giving every cover its own arrangement.
  let seed = hashPalette(palette) || 1;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };

  const totalWeight = palette.reduce(
    (total, sample) => total + sample.weight,
    0,
  );

  const pick = () => {
    let target = random() * totalWeight;
    for (const sample of palette) {
      target -= sample.weight;
      if (target <= 0) return sample;
    }
    return palette[0];
  };

  return Array.from({ length: 36 }, () => ({
    color: pick().color,
    // Offsetting each blob off its slot center is what stops the field from
    // resolving into a visible 6x6 lattice once the blur is applied.
    x: 20 + random() * 60,
    y: 20 + random() * 60,
    scale: 1.05 + random() * 0.45,
  }));
}

function MeshLayer({ palette }: { palette: MeshPalette }) {
  const cells = useMemo(() => createMeshGrid(palette), [palette]);

  return (
    <div
      className="album-mesh-layer absolute inset-0 overflow-hidden"
      style={{ backgroundColor: palette[0].color }}
    >
      <div className="album-mesh-grid">
        {cells.map((cell, index) => (
          <span
            key={`${index}-${cell.color}`}
            className="album-mesh-cell"
            style={
              {
                "--mesh-color": cell.color,
                "--mesh-x": `${cell.x.toFixed(1)}%`,
                "--mesh-y": `${cell.y.toFixed(1)}%`,
                "--mesh-scale": cell.scale.toFixed(3),
                "--mesh-delay": `${-((index * 1.37) % 19).toFixed(2)}s`,
                "--mesh-duration": `${18 + (index % 7) * 2}s`,
              } as CSSProperties
            }
          />
        ))}
      </div>
      <div className="album-mesh-frost" />
    </div>
  );
}

function AlbumMesh({ url }: { url: string }) {
  const reduceMotion = useReducedMotion();
  const [result, setResult] = useState<{
    url: string;
    palette: MeshPalette | null;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    void getPalette(url).then((palette) => {
      if (!cancelled) setResult({ url, palette });
    });
    return () => {
      cancelled = true;
    };
  }, [url]);

  // Sampling failed (CORS-tainted or unreadable canvas). There is no blurred
  // artwork to fall back to any more and inventing a palette is forbidden, so
  // this track simply gets the plain window background.
  if (result?.url === url && result.palette === null) return null;

  const mesh = result?.palette
    ? { url: result.url, palette: result.palette }
    : null;

  return (
    <div
      className="pointer-events-none absolute inset-0 overflow-hidden"
      aria-hidden
    >
      <AnimatePresence initial={false}>
        {mesh && (
          <motion.div
            key={mesh.url}
            className="absolute inset-0"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: reduceMotion ? 0 : 1.15, ease: "easeOut" }}
          >
            <MeshLayer palette={mesh.palette} />
          </motion.div>
        )}
      </AnimatePresence>
      <div className="absolute inset-0 bg-background/20 dark:bg-background/35" />
      <div className="bg-cover-noise absolute inset-0 opacity-60" />
    </div>
  );
}

/**
 * The ambient background: a procedural color mesh sampled from the current
 * cover. Shared by the main and floating windows so both use exactly the same
 * palette and transition.
 *
 * There is no blurred-artwork variant. The cover is a color source only, never
 * something the background displays, so nothing here scales or blurs the image
 * itself. Whether an ambient background renders at all is the Background
 * setting, checked by the caller.
 */
export function NowPlayingBackground() {
  const track = usePlaybackStore(currentTrack);
  const url =
    track?.thumbnails && track.thumbnails.length > 0
      ? pickHighResThumbnail(track.thumbnails)
      : null;

  if (!url) return null;
  return <AlbumMesh url={url} />;
}
