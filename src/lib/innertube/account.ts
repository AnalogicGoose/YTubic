import { innertubePost, type YtNode } from "./shared";

export type AccountInfo = {
  name: string;
  email: string;
  photoUrl?: string;
};

/**
 * Tri-state Premium signal:
 *  - null      → user is not signed in (or account_menu failed)
 *  - "free"    → signed in, no Premium subscription detected
 *  - "premium" → signed in, Premium subscription detected
 */
export type PremiumStatus = null | "free" | "premium";

/**
 * Pull the signed-in user's display name, email and avatar from
 * `account/account_menu`. Anonymous calls return a generic sign-in
 * popup with no `activeAccountHeaderRenderer` — we treat that as
 * "not signed in" and return null.
 */
export async function fetchAccountInfo(): Promise<AccountInfo | null> {
  let json: YtNode;
  try {
    json = await innertubePost("account/account_menu", {});
  } catch {
    return null;
  }

  const header: YtNode | undefined =
    json?.actions?.[0]?.openPopupAction?.popup?.multiPageMenuRenderer?.header
      ?.activeAccountHeaderRenderer;
  if (!header) return null;

  const readText = (node: YtNode | undefined): string =>
    node?.simpleText ??
    (node?.runs ?? []).map((r: YtNode) => r?.text ?? "").join("") ??
    "";

  const name = readText(header.accountName);
  const email = readText(header.email);
  const photos: YtNode[] = header.accountPhoto?.thumbnails ?? [];
  const photoUrl = photos[photos.length - 1]?.url as string | undefined;

  if (!name && !email) return null;
  return { name, email, photoUrl };
}

/**
 * Detect YT Music Premium status from `account/account_menu`.
 *
 * Strategy: the menu always contains some "Get / Try / Subscribe to
 * Music Premium" upsell entry for Free users, regardless of locale.
 * For Premium users that entry is absent — instead the menu shows
 * "Manage your Music Premium membership" (or the localized variant).
 * So we collect the visible text of every menu item, then:
 *   - If any item matches an upsell pattern → Free.
 *   - Else if any item matches a manage-membership pattern → Premium.
 *   - Else → Premium. YouTube inserts a branded Premium upsell for signed-in
 *     Free accounts; the live menu for a Premium account omits that entry.
 *
 * Returns `null` when not signed in so the caller can show the right
 * gate ("sign in" vs "upgrade").
 */
export async function fetchPremiumStatus(): Promise<PremiumStatus> {
  // Keep transport failure distinct from an anonymous response. The caller
  // may grant a short, account-scoped offline grace for already-downloaded
  // tracks, but must not treat a real signed-out response as Premium.
  const json: YtNode = await innertubePost("account/account_menu", {});

  return detectPremiumStatusFromMenu(json);
}

/** Pure account-menu classifier kept exported for regression tests. */
export function detectPremiumStatusFromMenu(json: YtNode): PremiumStatus {
  const popup: YtNode | undefined =
    json?.actions?.[0]?.openPopupAction?.popup?.multiPageMenuRenderer;
  const header: YtNode | undefined = popup?.header?.activeAccountHeaderRenderer;
  // No active-account header ⇒ anonymous sign-in prompt.
  if (!header) return null;

  // Collect text from every renderer in the menu. We walk the popup
  // (not just `sections`) because YT periodically reshuffles where the
  // upsell lives (sometimes nested under a `compactLinkRenderer`,
  // sometimes a `multiPageMenuItemRenderer.text`, occasionally a
  // dedicated promo container).
  const labels: string[] = [];
  const stack: unknown[] = [popup];
  const seen = new WeakSet<object>();
  while (stack.length) {
    const cur = stack.pop();
    if (!cur || typeof cur !== "object") continue;
    if (seen.has(cur as object)) continue;
    seen.add(cur as object);
    if (Array.isArray(cur)) {
      for (const v of cur) stack.push(v);
      continue;
    }
    const obj = cur as YtNode;
    if (typeof obj.simpleText === "string") labels.push(obj.simpleText);
    if (Array.isArray(obj.runs)) {
      const text = obj.runs
        .map((r: YtNode) => (typeof r?.text === "string" ? r.text : ""))
        .join("");
      if (text) labels.push(text);
    }
    if (typeof obj.label === "string") labels.push(obj.label);
    for (const k of Object.keys(obj)) stack.push(obj[k]);
  }

  const premiumBrand = /\b(?:music\s*)?premium\b/i;
  const memberSignal =
    /manage|cancel|membership|member|gestionar|gestiona|administrar|administra|membres[ií]a|miembro|suscripci[oó]n|gerenciar|assinatura|membro|управл|подписк/i;
  const freeSignal =
    /get|try|start|join|upgrade|unlock|subscribe|trial|ended|hol\s*dir|obt[eé]n|obtener|prueba|probar|empieza|comienza|[uú]nete|mejora|desbloquea|suscr[ií]bete|assine|experimente|comece|obtenha|получ|оформ|підписат|попроб/i;

  // Positive membership wording wins when the menu includes the Premium
  // brand (for example, English "Manage membership" or Spanish
  // "Gestionar la membresía").
  for (const label of labels) {
    if (premiumBrand.test(label) && memberSignal.test(label)) return "premium";
  }

  // Free accounts receive a Premium upsell. Recognized calls to action are
  // classified first; any other branded Premium entry is conservatively an
  // upsell because the live Premium menu omits the branded entry entirely.
  for (const label of labels) {
    if (premiumBrand.test(label) && freeSignal.test(label)) return "free";
  }
  if (labels.some((label) => premiumBrand.test(label))) return "free";

  // Signed in with no branded upsell. This is YouTube Music's live Premium
  // menu shape and was confirmed against the account-menu response used by
  // the app. Transport failures never reach this branch, and anonymous menus
  // were rejected above.
  return "premium";
}
