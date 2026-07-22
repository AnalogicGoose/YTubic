import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import {
  WHATS_NEW,
  whatsNewFor,
  type WhatsNewEntry,
  type WhatsNewSection,
} from "@/lib/whats-new";

/**
 * GitHub Releases as the source of truth for the What's New dialog.
 *
 * Whatever is written in a release's body on GitHub is what the app shows for
 * that version, so release notes are authored in one place instead of being
 * duplicated into `whats-new.ts` by hand. The bundled entries remain as a
 * fallback for versions whose release body carries no real notes and for
 * offline launches — see `resolveWhatsNewEntry`.
 *
 * Routed through `tauri-plugin-http` because the webview's `connect-src` CSP
 * does not list GitHub (and should not: plugin-http goes through Rust and
 * bypasses CSP for the network call). The host is instead allow-listed in
 * `src-tauri/capabilities/default.json`, which is where plugin-http enforces
 * its own scope.
 *
 * Release bodies are remote text. They are parsed into plain strings and
 * rendered as React text nodes — never as HTML — so a release body cannot
 * inject markup into the app.
 */

const RELEASES_URL =
  "https://api.github.com/repos/AnalogicGoose/Goosic/releases?per_page=30";
const REQUEST_TIMEOUT_MS = 8000;

/**
 * Sentences the release workflow writes into every release body. They carry no
 * information for a user reading What's New, so a body that consists only of
 * these counts as having no notes and falls back to the bundled entry. See
 * `releaseBody` in `.github/workflows/release.yml`.
 */
const BOILERPLATE_PATTERNS: RegExp[] = [
  /see the assets below to download and install this version\.?/gi,
  /macos builds are ad-hoc signed and may require a gatekeeper override on first launch\.?/gi,
];

type GitHubRelease = {
  tag_name?: unknown;
  name?: unknown;
  body?: unknown;
  draft?: unknown;
  published_at?: unknown;
  created_at?: unknown;
};

/** `v0.4.7` and `0.4.7` both identify the same app version. */
export function versionFromTag(tag: string): string {
  return tag.trim().replace(/^v/i, "");
}

/** Reduce inline markdown to the plain text the dialog renders. */
function inlineText(input: string): string {
  return (
    input
      // Images carry no text worth showing in a release note.
      .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      // Autolinks: <https://example.com> renders as the bare URL.
      .replace(/<(https?:\/\/[^>]+)>/g, "$1")
      .replace(/`([^`]*)`/g, "$1")
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/__([^_]+)__/g, "$1")
      .replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, "$1$2")
      .replace(/(^|[\s(])_([^_\s][^_]*)_/g, "$1$2")
      .replace(/~~([^~]+)~~/g, "$1")
      // Any residual markup is dropped rather than rendered.
      .replace(/<[^>]*>/g, "")
      .replace(/&nbsp;/g, " ")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#3?9;/g, "'")
      .replace(/&amp;/g, "&")
      .replace(/\s+/g, " ")
      .trim()
  );
}

/** Remove the workflow's fixed sentences so only authored notes remain. */
export function stripReleaseBoilerplate(body: string): string {
  let stripped = body;
  for (const pattern of BOILERPLATE_PATTERNS) {
    stripped = stripped.replace(pattern, "");
  }
  return stripped;
}

/**
 * Convert a release body into the dialog's section shape.
 *
 * Supports the subset that release notes actually use: ATX headings, unordered
 * and ordered lists, block quotes, horizontal rules, and paragraphs. Anything
 * else degrades to plain text rather than being rendered as markup.
 */
export function sectionsFromMarkdown(markdown: string): WhatsNewSection[] {
  const sections: WhatsNewSection[] = [];
  let heading: string | undefined;
  let paragraph: string[] = [];
  // The dialog renders either a note panel or a bullet list per section, so a
  // heading whose content mixes the two becomes several sections. They are
  // collected in document order: an auto-generated changelog puts its commit
  // list above its "Full Changelog" line, and reordering them would rewrite
  // what the release actually says.
  let blocks: WhatsNewSection[] = [];

  const endParagraph = () => {
    if (!paragraph.length) return;
    const text = inlineText(paragraph.join(" "));
    if (text) {
      const last = blocks[blocks.length - 1];
      if (last?.body) last.body = `${last.body}\n\n${text}`;
      else blocks.push({ body: text });
    }
    paragraph = [];
  };

  const addItem = (text: string) => {
    const last = blocks[blocks.length - 1];
    if (last?.items) last.items.push(text);
    else blocks.push({ items: [text] });
  };

  const flush = () => {
    endParagraph();
    blocks.forEach((block, index) => {
      sections.push(index === 0 ? { heading, ...block } : block);
    });
    heading = undefined;
    blocks = [];
  };

  const source = markdown
    .replace(/\r\n?/g, "\n")
    .replace(/<!--[\s\S]*?-->/g, "");

  for (const raw of source.split("\n")) {
    const line = raw.trimEnd();
    const headingMatch = /^\s{0,3}(#{1,6})\s+(.*)$/.exec(line);
    if (headingMatch) {
      flush();
      heading = inlineText(headingMatch[2]) || undefined;
      continue;
    }
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flush();
      continue;
    }
    const bulletMatch = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (bulletMatch) {
      endParagraph();
      const text = inlineText(bulletMatch[1]);
      if (text) addItem(text);
      continue;
    }
    if (!line.trim()) {
      endParagraph();
      continue;
    }
    paragraph.push(line.replace(/^\s{0,3}>\s?/, ""));
  }
  flush();

  // A heading with nothing under it is noise once its body turned out to be
  // boilerplate that was stripped away.
  return sections.filter(
    (section) => !!section.body || !!section.items?.length,
  );
}

/** Whether a release body says anything beyond the workflow's boilerplate. */
export function hasAuthoredReleaseNotes(body: string): boolean {
  return sectionsFromMarkdown(stripReleaseBoilerplate(body)).length > 0;
}

function formatReleaseDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(undefined, {
    month: "long",
    year: "numeric",
  });
}

/** Map one GitHub release to an entry, or `undefined` when it has no notes. */
function toEntry(release: GitHubRelease): WhatsNewEntry | undefined {
  if (release.draft === true) return undefined;
  const tag = typeof release.tag_name === "string" ? release.tag_name : "";
  if (!tag) return undefined;
  const body = typeof release.body === "string" ? release.body : "";
  const sections = sectionsFromMarkdown(stripReleaseBoilerplate(body));
  if (!sections.length) return undefined;
  const published =
    typeof release.published_at === "string"
      ? release.published_at
      : typeof release.created_at === "string"
        ? release.created_at
        : "";
  return {
    version: versionFromTag(tag),
    date: published ? formatReleaseDate(published) : "",
    sections,
  };
}

/**
 * Published releases that carry authored notes, newest first.
 *
 * Releases whose body is only workflow boilerplate are omitted so the caller
 * falls back to the bundled entry for those versions instead of showing a
 * download instruction as the release notes.
 */
export async function fetchReleaseNotes(): Promise<WhatsNewEntry[]> {
  const response = await tauriFetch(RELEASES_URL, {
    method: "GET",
    headers: {
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      // GitHub rejects unidentified API clients.
      "user-agent": "Goosic",
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`GitHub releases responded ${response.status}`);
  }
  const payload: unknown = await response.json();
  if (!Array.isArray(payload)) return [];
  const entries: WhatsNewEntry[] = [];
  for (const release of payload) {
    if (!release || typeof release !== "object") continue;
    const entry = toEntry(release as GitHubRelease);
    if (entry) entries.push(entry);
  }
  return entries;
}

/**
 * The notes to display for a version: what GitHub says, falling back to the
 * bundled entry when that release carries no authored notes and when the
 * fetch has not resolved (offline, rate limited, still loading).
 *
 * A `null` version means "whatever is newest", which is what the About
 * dialog's manual What's new link asks for.
 */
export function resolveWhatsNewEntry(
  version: string | null,
  releases: WhatsNewEntry[] | undefined,
): WhatsNewEntry | undefined {
  if (version) {
    return (
      releases?.find((entry) => entry.version === version) ??
      whatsNewFor(version)
    );
  }
  return releases?.[0] ?? WHATS_NEW[0];
}

/**
 * Which version the manual What's new link should open: the running one when
 * either source describes it, otherwise the newest version that has notes, so
 * the link always shows something.
 */
export function whatsNewVersionToShow(
  current: string | null,
  releases: WhatsNewEntry[] | undefined,
): string | null {
  if (current && resolveWhatsNewEntry(current, releases)) return current;
  return resolveWhatsNewEntry(null, releases)?.version ?? null;
}
