import {
  findContinuationToken,
  rawBrowse,
  rawBrowseContinuation,
  type YtNode,
} from "./shared";

/**
 * A library can span hundreds of cards, but YouTube Music normally returns
 * only the first ~25 in the initial browse response. Keep a generous bound so
 * a malformed/repeating cursor cannot spin forever. Hitting the bound rejects
 * instead of returning a partial library: Storage uses this data to label and
 * preview manual bulk deletion, so incompleteness must be explicit.
 */
const MAX_CONTINUATION_PAGES = 200;

type ParsedLibraryPage = {
  sections: YtNode[];
  nextCursor?: string;
  recognized: boolean;
};

function selectedTabContent(json: YtNode): YtNode | undefined {
  const singleTabs: YtNode[] =
    json?.contents?.singleColumnBrowseResultsRenderer?.tabs ?? [];
  const twoColumnTabs: YtNode[] =
    json?.contents?.twoColumnBrowseResultsRenderer?.tabs ?? [];
  const tabs = singleTabs.length > 0 ? singleTabs : twoColumnTabs;
  const tab = tabs.find((entry) => entry.tabRenderer?.selected) ?? tabs[0];
  return tab?.tabRenderer?.content;
}

function parseInitialPage(json: YtNode): ParsedLibraryPage {
  const content = selectedTabContent(json) ?? json?.contents;
  const sectionList = content?.sectionListRenderer;
  if (sectionList) {
    return {
      sections: Array.isArray(sectionList.contents) ? sectionList.contents : [],
      nextCursor: findContinuationToken(sectionList),
      recognized: true,
    };
  }

  // Some WEB_REMIX variants put the library grid/shelf directly under the
  // selected tab instead of wrapping it in a section list.
  if (
    content?.gridRenderer ||
    content?.musicShelfRenderer ||
    content?.musicCarouselShelfRenderer
  ) {
    return {
      sections: [content],
      nextCursor: findContinuationToken(content),
      recognized: true,
    };
  }

  return { sections: [], recognized: false };
}

function isLooseLibraryItem(node: YtNode): boolean {
  return !!(
    node.musicTwoRowItemRenderer ||
    node.musicResponsiveListItemRenderer ||
    node.musicNavigationButtonRenderer
  );
}

/**
 * Continuations are inconsistent: grid continuations contain raw cards while
 * section-list continuations contain complete shelf wrappers. Group adjacent
 * raw cards into a synthetic shelf without hiding any real wrappers.
 */
function normalizeContinuationItems(items: YtNode[]): YtNode[] {
  const sections: YtNode[] = [];
  let loose: YtNode[] = [];

  const flushLoose = () => {
    if (loose.length === 0) return;
    sections.push({ musicShelfRenderer: { contents: loose } });
    loose = [];
  };

  for (const item of items) {
    if (item.continuationItemRenderer) continue;
    if (isLooseLibraryItem(item)) {
      loose.push(item);
      continue;
    }
    flushLoose();
    sections.push(item);
  }
  flushLoose();
  return sections;
}

function parseContinuationPage(json: YtNode): ParsedLibraryPage {
  const modernItems: YtNode[] = [];
  const modernSources: YtNode[] = [];
  const actionGroups: YtNode[][] = [
    json?.onResponseReceivedActions ?? [],
    json?.onResponseReceivedEndpoints ?? [],
    json?.onResponseReceivedCommands ?? [],
  ];

  for (const actions of actionGroups) {
    for (const action of actions) {
      const append =
        action.appendContinuationItemsAction?.continuationItems ??
        action.reloadContinuationItemsCommand?.continuationItems;
      if (!Array.isArray(append)) continue;
      modernSources.push(action);
      modernItems.push(...append);
    }
  }

  if (modernSources.length > 0) {
    return {
      sections: normalizeContinuationItems(modernItems),
      nextCursor: findContinuationToken(modernSources),
      recognized: true,
    };
  }

  const continuationContents = json?.continuationContents;
  const legacyCandidates: { node: YtNode; items: YtNode[] }[] = [];
  const addLegacy = (node: YtNode | undefined, items: unknown) => {
    if (!node) return;
    legacyCandidates.push({
      node,
      items: Array.isArray(items) ? items : [],
    });
  };

  const grid = continuationContents?.gridContinuation;
  addLegacy(grid, grid?.items ?? grid?.contents);
  const shelf = continuationContents?.musicShelfContinuation;
  addLegacy(shelf, shelf?.contents);
  const playlistShelf = continuationContents?.musicPlaylistShelfContinuation;
  addLegacy(playlistShelf, playlistShelf?.contents);
  const sectionList = continuationContents?.sectionListContinuation;
  addLegacy(sectionList, sectionList?.contents);

  if (legacyCandidates.length > 0) {
    const items = legacyCandidates.flatMap((candidate) => candidate.items);
    return {
      sections: normalizeContinuationItems(items),
      nextCursor: findContinuationToken(
        legacyCandidates.map((candidate) => candidate.node),
      ),
      recognized: true,
    };
  }

  return { sections: [], recognized: false };
}

/**
 * Fetch every section of one authenticated YouTube Music library browse.
 * Any continuation failure or malformed/repeated cursor rejects the whole
 * operation so callers never mistake a truncated library for a complete one.
 */
export async function fetchAllLibraryBrowseSections(
  browseId: string,
): Promise<YtNode[]> {
  const first = parseInitialPage(await rawBrowse(browseId));
  if (!first.recognized) {
    throw new Error(`Unrecognized library browse response for ${browseId}`);
  }

  const sections = [...first.sections];
  const seenCursors = new Set<string>();
  let cursor = first.nextCursor;
  let pageCount = 0;

  while (cursor) {
    if (seenCursors.has(cursor)) {
      throw new Error(`Repeated library continuation for ${browseId}`);
    }
    if (pageCount >= MAX_CONTINUATION_PAGES) {
      throw new Error(`Library continuation limit exceeded for ${browseId}`);
    }
    seenCursors.add(cursor);
    pageCount += 1;

    // Deliberately let network/auth failures reject. Returning what we have
    // would make the Storage tab's manual cleanup preview incomplete.
    const page = parseContinuationPage(await rawBrowseContinuation(cursor));
    if (!page.recognized) {
      throw new Error(`Unrecognized library continuation for ${browseId}`);
    }
    sections.push(...page.sections);
    cursor = page.nextCursor;
  }

  return sections;
}
