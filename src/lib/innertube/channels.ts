import { authHeaders, innertubePost, readRuns, type YtNode } from "./shared";

/**
 * One selectable YouTube identity inside the signed-in Google account:
 * the personal (default) channel or a brand channel. Library, likes,
 * uploads and recommendations are scoped to the channel, so the app
 * lets the user pick which one to act as.
 */
export type ChannelChoice = {
  /** Value for the `X-Goog-PageId` header; null = personal channel. */
  pageId: string | null;
  /**
   * Server-issued identity-switch URL. Credential-bearing and intentionally
   * memory-only: never log it or copy it into persisted account metadata.
   */
  signinUrl: string | null;
  name: string;
  photoUrl?: string;
  /** Secondary line YT ships for the row (email, "Brand Account", …). */
  byline?: string;
  /** What the switcher itself reports as selected (server-side view). */
  selected: boolean;
};

const YOUTUBE_SIGNIN_ORIGIN = "https://www.youtube.com";

/**
 * Resolve and strictly validate an `accountSigninToken.signinUrl` without
 * inspecting or rewriting its credential-bearing query string.
 *
 * YouTube currently returns root-relative URLs, but protocol-relative and
 * already-absolute forms are handled defensively. Only the HTTPS
 * `www.youtube.com/signin` endpoint is accepted.
 */
export function resolveAccountSigninUrl(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length === 0 || raw !== raw.trim()) {
    return null;
  }

  let url: URL;
  try {
    url = new URL(raw, YOUTUBE_SIGNIN_ORIGIN);
  } catch {
    return null;
  }

  if (
    url.protocol !== "https:" ||
    url.hostname !== "www.youtube.com" ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/signin" ||
    url.hash !== ""
  ) {
    return null;
  }

  return url.href;
}

/**
 * List every channel the signed-in Google account can act as. Uses the
 * same endpoint the official web client's account switcher calls.
 * Returns [] when signed out.
 */
export async function fetchChannelList(): Promise<ChannelChoice[]> {
  const auth = await authHeaders();
  if (!auth.Cookie) return [];
  const json = await innertubePost("account/accounts_list", {});
  return parseAccountSwitcher(json);
}

/**
 * Walk the switcher response and collect every `accountItem` node.
 * The exact nesting varies (multiPageMenuRenderer sections wrapped in
 * varying action envelopes), so we scan the whole tree instead of
 * hard-coding a path; identity rows are the only nodes with an
 * `accountItem` key.
 */
export function parseAccountSwitcher(root: unknown): ChannelChoice[] {
  const out: ChannelChoice[] = [];
  const seen = new WeakSet<object>();
  const walk = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    if (seen.has(node as object)) return;
    seen.add(node as object);
    if (Array.isArray(node)) {
      for (const c of node) walk(c);
      return;
    }
    const n = node as YtNode;
    if (n.accountItem && typeof n.accountItem === "object") {
      const mapped = mapAccountItem(n.accountItem as YtNode);
      if (mapped) out.push(mapped);
      return;
    }
    for (const key of Object.keys(n)) walk(n[key]);
  };
  walk(root);
  return out;
}

function mapAccountItem(item: YtNode): ChannelChoice | null {
  // Rows without a select endpoint ("Add account", "View channel",
  // sign-out shortcuts) are not identities; skip them.
  const endpoint = item.serviceEndpoint?.selectActiveIdentityEndpoint;
  if (!endpoint) return null;

  const name = readRuns(item.accountName);
  if (!name) return null;

  // Brand channels carry a pageIdToken among the endpoint's tokens;
  // the personal channel has none. Both identities carry a short-lived
  // signin URL used to pin the playback WebView to that exact identity.
  let pageId: string | null = null;
  let signinUrl: string | null = null;
  const tokens: YtNode[] = endpoint.supportedTokens ?? [];
  for (const t of tokens) {
    const pid = t?.pageIdToken?.pageId;
    if (pageId === null && typeof pid === "string" && pid) {
      pageId = pid;
    }
    if (signinUrl === null) {
      signinUrl = resolveAccountSigninUrl(t?.accountSigninToken?.signinUrl);
    }
  }

  const photos: YtNode[] = item.accountPhoto?.thumbnails ?? [];
  const photoUrl = photos[photos.length - 1]?.url as string | undefined;

  return {
    pageId,
    signinUrl,
    name,
    photoUrl,
    byline: readRuns(item.accountByline) || undefined,
    selected: item.isSelected === true,
  };
}
