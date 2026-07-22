import { invoke } from "@tauri-apps/api/core";

/**
 * The native loopback server Range-serves finalized offline files. Normal
 * online playback never calls this module and therefore cannot trigger
 * yt-dlp; downloads are started only through the explicit playlist action.
 */

let baseUrlPromise: Promise<string> | null = null;

async function fetchBaseUrl(): Promise<string> {
  // The loopback server starts asynchronously during Tauri setup.
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      return await invoke<string>("get_stream_base_url");
    } catch (error) {
      if (attempt === 19) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error("offline audio server did not start");
}

export function getStreamBaseUrl(): Promise<string> {
  if (!baseUrlPromise) {
    baseUrlPromise = fetchBaseUrl().catch((error) => {
      baseUrlPromise = null;
      throw error;
    });
  }
  return baseUrlPromise;
}

export class StreamPreparationError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "StreamPreparationError";
  }
}

/**
 * Only HTTP 422 proves that bytes exist but failed native container/repair
 * validation. A missing file, loopback startup race, or network failure must
 * never poison an otherwise recoverable download with an `.invalid` marker.
 */
export function isDefinitiveOfflineFileFailure(error: unknown): boolean {
  return error instanceof StreamPreparationError && error.status === 422;
}

async function prepareOfflineStream(url: string): Promise<void> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Range: "bytes=0-0" },
      cache: "no-store",
    });
  } catch (error) {
    throw new StreamPreparationError(
      `Offline audio server unavailable: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).trim();
    throw new StreamPreparationError(
      `Offline file unavailable (HTTP ${response.status})${
        detail ? `: ${detail.slice(0, 600)}` : ""
      }`,
      response.status,
    );
  }
  await response.body?.cancel().catch(() => {});
}

/** Return a URL that can only serve an already-finalized local file. */
export async function offlineStreamUrlFor(videoId: string): Promise<string> {
  const base = await getStreamBaseUrl();
  const url = `${base}/stream/${encodeURIComponent(videoId)}?cache_only=1`;
  await prepareOfflineStream(url);
  return url;
}
