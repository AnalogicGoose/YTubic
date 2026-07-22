import type { ShelfItem } from "./types";
import { collectShelfNodes, mapShelfWrapper } from "./shared";
import { fetchAllLibraryBrowseSections } from "./library-pagination";

/**
 * Fetch the user's library landing page. Returns a list of "shelves"
 * covering playlists / albums / artists / episodes the user follows.
 *
 * Requires authenticated cookies (Settings → Connect account). Without
 * them YouTube redirects to a generic explore page.
 */
export type LibrarySection = {
  id: string;
  title: string;
  items: ShelfItem[];
};

async function browseSections(browseId: string): Promise<LibrarySection[]> {
  const sections = await fetchAllLibraryBrowseSections(browseId);
  const shelfNodes = collectShelfNodes(sections);
  const out: LibrarySection[] = [];
  const seenItems = new Set<string>();
  shelfNodes.forEach((wrapper, i) => {
    const { title, items: mappedItems } = mapShelfWrapper(wrapper, i);
    // Initial library responses can repeat cards across shelves such as
    // "Recently added" and "Playlists". Keep the first occurrence while
    // appending continuation pages in their server order.
    const items = mappedItems.filter((item) => {
      const key = `${item.kind}:${item.id}`;
      if (seenItems.has(key)) return false;
      seenItems.add(key);
      return true;
    });
    if (items.length === 0) return;
    out.push({ id: `${title}-${i}`, title, items });
  });
  return out;
}

export function fetchLibraryPlaylists(): Promise<LibrarySection[]> {
  return browseSections("FEmusic_liked_playlists");
}

export function fetchLibraryAlbums(): Promise<LibrarySection[]> {
  return browseSections("FEmusic_liked_albums");
}

export function fetchLibraryArtists(): Promise<LibrarySection[]> {
  return browseSections("FEmusic_library_corpus_artists");
}

/**
 * Liked songs playlist. YTM uses the magic id `LM` (auto-generated).
 */
export async function fetchLikedSongs(): Promise<ShelfItem[]> {
  const { fetchPlaylist } = await import("./playlist");
  const page = await fetchPlaylist("LM");
  return page.tracks;
}

/**
 * Union of every track the user's library pins: Liked Songs, every
 * saved/created playlist, and saved albums. Deduped by videoId.
 *
 * The Storage tab uses this complete set for its Library/Other labels and
 * manual bulk-delete preview. Any source or nested playlist page failing to
 * load throws instead of presenting a dangerously partial deletion set.
 */
export async function fetchLibraryTracks(): Promise<ShelfItem[]> {
  const { fetchPlaylistStrict } = await import("./playlist");
  const { fetchAlbum } = await import("./album");

  const [playlistSections, albumSections] = await Promise.all([
    fetchLibraryPlaylists(),
    fetchLibraryAlbums(),
  ]);

  // Liked Songs (`LM`) also shows up in the playlists shelf — skip the
  // duplicate so its continuations aren't walked twice.
  const playlistIds = playlistSections
    .flatMap((s) => s.items)
    .map((p) => p.id.replace(/^VL/, ""))
    .filter((id) => id && id !== "LM");
  const albumIds = albumSections
    .flatMap((s) => s.items)
    .map((a) => a.id)
    .filter(Boolean);

  const byId = new Map<string, ShelfItem>();
  const add = (tracks: ShelfItem[]) => {
    for (const t of tracks) {
      if (t.id && !byId.has(t.id)) byId.set(t.id, t);
    }
  };

  add(await fetchPlaylistStrict("LM").then((p) => p.tracks));

  // Small worker pool: libraries can hold dozens of playlists/albums
  // and each costs at least one InnerTube round-trip. Four in flight
  // keeps total latency sane without hammering the endpoint.
  const jobs: (() => Promise<ShelfItem[]>)[] = [
    ...playlistIds.map(
      (id) => () => fetchPlaylistStrict(id).then((p) => p.tracks),
    ),
    ...albumIds.map((id) => () => fetchAlbum(id).then((a) => a.tracks)),
  ];
  let next = 0;
  const workers = Array.from({ length: Math.min(4, jobs.length) }, async () => {
    while (next < jobs.length) {
      const job = jobs[next++];
      add(await job());
    }
  });
  await Promise.all(workers);

  return [...byId.values()];
}
