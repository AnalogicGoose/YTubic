# Goosic â€” Complete Codex Handoff

> **Read this file first in every new Codex session.** It is the durable product,
> engineering, UI, release, and troubleshooting context for this repository.
>
> Last verified: **2026-07-22**
> Current app version: **0.5.3**
> Current release candidate: **v0.5.3 macOS playback bridge and queue hardening**
> Latest public release: <https://github.com/AnalogicGoose/Goosic/releases/tag/v0.5.2>

## 1. New-session quick start

Before changing anything:

1. Read this document completely.
2. Run `git status -sb` and preserve any existing user changes.
3. Confirm the current branch and remotes with `git branch --show-current` and
   `git remote -v`.
4. Use `origin` (`AnalogicGoose/YTubic`) for Goosic work. Do **not** push to
   `upstream` unless the user explicitly asks.
5. Use `pnpm tauri dev` for real app testing. `pnpm dev` is frontend-only and
   cannot faithfully exercise Tauri IPC, playback, updater, tray, Discord,
   media controls, login, or the floating player.
6. Before publishing, follow the full release checklist in section 12.

The user speaks informally and often says â€œbro.â€ Keep communication friendly,
direct, and outcome-first. When they ask to implement something, make the
change and verify it rather than stopping for unnecessary clarification.

## 2. Repository identity and Git topology

- **Product name:** Goosic
- **Repository directory:** still named `YTubic` for historical reasons.
- **Primary repository:** <https://github.com/AnalogicGoose/Goosic>
- **Primary remote:** `origin` still uses the historical
  `https://github.com/AnalogicGoose/YTubic.git` URL, which GitHub redirects to
  the canonical `AnalogicGoose/Goosic` repository.
- **Original/upstream project:**
  `upstream = https://github.com/NUber-dev/YTubic.git`
- **Default publishing branch:** `main`
- **License:** GPL-3.0-only
- **Current Windows identifier:** `com.github.ivasy.ytubic`. This legacy
  identifier is intentionally unchanged because changing it would create a
  separate installed application and break the existing updater/app-data path.

Important GitHub CLI detail: because both `origin` and `upstream` exist,
unqualified `gh repo view` can resolve to the wrong repository. For release,
secret, workflow, or issue operations, explicitly use:

```powershell
gh ... -R AnalogicGoose/YTubic
```

There has also been a historical `v0.3.2` tag collision between remotes. A
normal tag fetch may report â€œwould clobber existing tag.â€ Do not force-rewrite
published tags. New releases must always use a new version.

## 3. Product intent

Goosic is a fast native-feeling YouTube Music desktop client for Windows,
macOS, and Linux. Its React interface talks to InnerTube for browsing and
library data, while ordinary audio plays through one persistent, native
YouTube Music WebPlayer. The Tauri/Rust side owns that isolated playback
WebView, account profiles, explicit offline downloads, platform integration,
updater behavior, and native windows.

Core product values:

- Native desktop ergonomics and discoverability.
- Apple-inspired glass materials, spacing, animation, and rounded geometry.
- Fast navigation with prefetching and persistent query caches.
- Direct, clickable metadata: artist names should navigate to artist pages
  wherever structured artist IDs are available.
- A consistent visual language across sidebar, player, queue, lyrics, context
  menus, dropdowns, submenus, and popovers.
- The app must look correct in the **packaged release**, not only in dev mode.
- Privacy-sensitive integrations such as Discord Rich Presence are opt-in.
- Automatic updates must be signed and downloadable from the Goosic fork.

Current major capabilities:

- Home, Explore, Search, Library, Charts, Moods/Genres, New Releases.
- Artist, album, playlist, and category pages.
- Likes, playlists, library mutations, radios, autoplay/recommendations, and
  song/video source switching.
- Right-side, bottom, and separate floating player layouts.
- Synced lyrics from LRCLIB, Musixmatch, and Genius.
- Multiple YouTube account/channel support.
- Google/YouTube sign-in on Windows WebView2 and macOS WKWebView, with
  platform-native browser identities and persistent per-account profiles.
- Official YouTube Music WebPlayer playback for guests, free accounts, and
  Premium accounts, including YouTube's normal advertisements and restrictions.
- Explicit Premium-only playlist downloads and validated local playback.
- Managed yt-dlp, Deno, and PO-token infrastructure used only by those
  explicit offline downloads; account cookies are never passed to yt-dlp.
- Windows SMTC/media keys, tray, autostart, notifications, and single instance.
- Last.fm scrobbling and optional love synchronization.
- Discord Rich Presence.
- Signed self-update flow through GitHub Releases.

## 4. Stack

| Layer            | Technology                                             |
| ---------------- | ------------------------------------------------------ |
| Desktop shell    | Tauri 2                                                |
| Native backend   | Rust                                                   |
| Windows renderer | WebView2                                               |
| Frontend         | React 19 + TypeScript                                  |
| Build            | Vite 7                                                 |
| Styling          | Tailwind CSS v4 + shared CSS tokens                    |
| UI primitives    | Radix/shadcn-style components                          |
| Routing          | TanStack Router, file-based                            |
| Server state     | TanStack Query with persistence                        |
| Client state     | Zustand, often persisted to localStorage               |
| Motion           | Motion for React                                       |
| Music data       | YouTube InnerTube via `youtubei.js` and custom parsers |
| Online playback  | Persistent official YouTube Music WebPlayer            |
| Offline audio    | Managed yt-dlp + Deno + cache-only local Rust proxy    |
| Unit tests       | Vitest                                                 |
| Package manager  | pnpm 10.33.1                                           |

## 5. High-level architecture

```text
YouTube / InnerTube / lyrics providers
                 |
                 v
React + TanStack Query + Zustand
  |              |              |
  |              |              +-- persisted UI/player/settings state
  |              +-- cached feeds, search, library, entity data
  +-- routes, shelves, track lists, menus, player, lyrics
                 |
                 | versioned native commands/events
                 v
Rust/Tauri backend
  |-- persistent official YouTube Music playback WebView
  |-- secret, generation-scoped loopback playback bridge
  |-- account cookie capture, refresh, and per-account WebView profiles
  |-- explicit Premium playlist downloads through managed yt-dlp/Deno/PO
  |-- token-gated cache-only localhost audio proxy
  |-- cover/offline-file management
  |-- tray, windows, autostart, notifications
  |-- Windows SMTC/media keys
  |-- Discord IPC worker
  |-- Last.fm signing, queueing, and retry
  +-- updater/process plugins
```

The same Vite bundle serves two Goosic UI windows:

- The main window uses TanStack Router and `AppShell`.
- The floating player detects its window label and renders
  `FloatingPlayerApp` instead of the router.
- A third native WebView, `youtube-player`, is an offscreen official YouTube
  Music playback surface rather than a Goosic/Vite window. Keep it out of the
  taskbar, Dock, Alt-Tab, normal window persistence, and Tauri capabilities.
  Reuse it across tracks and recreate it when the account profile changes.
  Windows maps it offscreen as a non-activating tool window; macOS maps an
  alpha-zero NSWindow excluded from cycling/Mission Control; Linux maps an
  alpha-zero GTK host, additionally positioning it offscreen on X11/XWayland.
  Honor explicit `GDK_BACKEND=x11` even when `WAYLAND_DISPLAY` is present.
- The current macOS deployment target is **macOS 14.0**. WKWebView's stable
  per-account `WKWebsiteDataStore` identifier is only available there; lowering
  this target would merge account playback cookies into a shared store and is
  not permitted without a different isolation implementation.
- On macOS, `src-tauri/src/native_glass.rs` wraps the floating player's Tauri
  content view in an AppKit-owned material host. macOS 26+ uses
  `NSGlassEffectView` with the WKWebView assigned as its official
  `contentView`; older macOS uses an `NSVisualEffectView` HUD fallback. The
  URL's `native-player-material` flag tells React to keep its web surface
  transparent. Do not restore CSS blur/ambient art on that native-backed
  surface or it will obscure Liquid Glass.

The two Goosic UI windows are separate JavaScript contexts. Cross-window
behavior uses Tauri events plus storage rehydration. Do not assume a Zustand
mutation in one window automatically appears in the other. The remote playback
document is a separate trust domain and communicates only through its narrow
native observer bridge.

## 6. Directory and file map

### Frontend entry and routing

- `src/main.tsx` â€” React entry; suppresses WebView2's native context menu.
- `src/App.tsx` â€” theme/query providers and main-vs-floating window split.
- `src/routes/__root.tsx` â€” route root.
- `src/routes/index.tsx` â€” Home.
- `src/routes/explore.tsx` â€” Explore.
- `src/routes/search.tsx` â€” Search and filters.
- `src/routes/library.tsx` â€” Library.
- `src/routes/artist.$id.tsx` â€” Artist detail.
- `src/routes/album.$id.tsx` â€” Album detail.
- `src/routes/playlist.$id.tsx` â€” Playlist detail.
- `src/routes/charts.tsx`, `moods.tsx`, `moods_.$id.tsx`, and
  `new-releases.tsx` â€” discovery routes.
- `src/routeTree.gen.ts` â€” generated router tree; do not hand-edit.

### Layout and playback UI

- `src/components/layout/app-shell.tsx` â€” main layout coordinator; mounts
  background, sidebar, content, player layouts, sync hooks, and update checks.
- `src/components/layout/top-bar.tsx` â€” custom title bar and app menu.
- `src/components/layout/app-sidebar.tsx` â€” navigation, playlists, accounts,
  settings, and update banner.
- `src/components/layout/player-bar.tsx` â€” right-side player.
- `src/components/layout/player-bar-bottom.tsx` â€” bottom overlay player.
- `src/components/layout/floating-player-app.tsx` â€” separate compact player.
- `src/components/layout/floating-player-sync.tsx` â€” main/floating state bridge.
- `src/components/layout/player-more-menu.tsx` â€” player action menu.
- `src/components/layout/queue-panel.tsx` â€” queue/history surface.
- `src/components/layout/lyrics-view.tsx` â€” synced lyrics and lyric scrolling.
- `src/components/layout/now-playing-background.tsx` â€” the album-derived
  procedural color mesh, the only ambient background.
- `src/components/layout/update-banner.tsx` â€” updater progress/action surface.

### Shared content components

- `src/components/shared/shelf-card.tsx` â€” song/video/album/playlist/artist
  cards and their click behavior.
- `src/components/shared/shelf-carousel.tsx` â€” desktop-friendly horizontal
  shelves, navigation arrows, edge fading, and scrolling.
- `src/components/shared/track-list.tsx` â€” track table/list rendering.
- `src/components/shared/track-context-menu.tsx` â€” track actions and submenus.
- `src/components/shared/artist-links.tsx` â€” reusable clickable artist names.
- `src/components/shared/thumbnail.tsx` â€” image sizing/high-resolution helpers.

### UI primitives and visual system

- `src/index.css` â€” global tokens, the 34px radius system, scrollbars, album
  mesh, lyrics effects, carousel masks, and other global behavior.
- `src/components/ui/glass-surface.ts` â€” canonical glass material class strings.
- `src/components/ui/context-menu.tsx` â€” root and portaled submenu styling.
- `src/components/ui/dropdown-menu.tsx` â€” dropdown and submenu styling.
- `src/components/ui/popover.tsx` â€” shared popover glass treatment.
- Other primitives live under `src/components/ui/`.

### Data, state, and playback

- `src/lib/innertube/` â€” InnerTube clients, parsers, entity queries, mutations,
  radio, and shared data types.
- `src/lib/audio-engine.ts` â€” online WebPlayer/local-offline ownership,
  playback lifecycle, media state, timing, and integration updates.
- `src/lib/web-playback.ts` â€” typed frontend commands and events for the
  native official WebPlayer.
- `src/lib/stream.ts` â€” validated cache-only local audio URL coordination.
- `src/lib/offline-library.ts` â€” offline-file validation and exact
  downloaded-playlist queue construction.
- `src/lib/ytdlp.ts` â€” passive managed-download setup/progress lifecycle.
- `src/lib/query-client.ts` â€” query caching/persistence budgets.
- `src/lib/store/playback.ts` â€” queue, history, repeat, shuffle, autoplay, and
  playback actions. The floating window uses a remote-control bridge. Persisted
  queue rows are normalized on migration so missing legacy/dev artwork becomes
  an empty thumbnail array rather than crashing the player shell.
- `src/lib/store/layout.ts` â€” `right`, `bottom`, and `floating` player layout.
- `src/lib/store/settings.ts` â€” persisted settings and Rust sync hooks,
  including the selected visual child theme.
- `src/lib/themes.ts` â€” the visual-theme registry and token applier. Themes
  are data-driven children of one shared visual contract; components should
  consume semantic Tailwind tokens/material variables instead of branching on
  theme IDs. The current selector offers Default and Modern, which share the
  same neutral tokens but select the classic or modern bottom-player layout.
  The choice persists to the `visualTheme` field in `ytm-settings`; the shared
  glass blur setting applies across the player, menus, and sidebar.
- `src/lib/store/track-source.ts` â€” song/video source pairing and selection.
- `src/lib/store/offline-downloads.ts` â€” native offline-download state mirror.
- `src/lib/store/playlist-downloads.ts` â€” sequential explicit playlist
  download coordinator and persisted playlist manifests.
- `src/lib/updater.ts` and `src/lib/store/update.ts` â€” update state machine.
- `src/lib/lyrics/` â€” lyrics providers, matching, and LRC parsing.
- `src/lib/lastfm.ts` and `lastfm-scrobbler.ts` â€” frontend Last.fm behavior.

### Native backend

- `src-tauri/src/lib.rs` â€” main Tauri application, local proxy, account and
  cookie handling, cache commands, windows, tray, and invoke registration.
- `src-tauri/src/main.rs` â€” release console suppression and `goosic_lib::run()`.
- `src-tauri/src/media.rs` â€” Windows SMTC/media controls.
- `src-tauri/src/discord.rs` â€” Discord IPC worker and Tauri commands.
- `src-tauri/src/lastfm.rs` â€” Last.fm authentication, signing, scrobble queue,
  love sync, and retry.
- `src-tauri/src/ytdlp.rs` â€” managed yt-dlp binary and Deno runtime.
- `src-tauri/src/pot_provider.rs` â€” pinned bgutil PO-token provider install,
  loopback lifecycle, validation, and health checks for explicit downloads.
- `src-tauri/src/web_player.rs` â€” persistent cross-platform official playback
  WebView, secure observer bridge, generation checks, and transport commands.
- `src-tauri/src/appid.rs` â€” Windows AppUserModelID.
- `src-tauri/build.rs` â€” Tauri build plus safe Last.fm credential injection.
- `src-tauri/tauri.conf.json` â€” product/version, windows, CSP, bundle, updater.
- `src-tauri/capabilities/default.json` â€” Tauri permissions/capabilities.

### Playback runtime contract

- Browsing, search, and ordinary playback are available signed out wherever
  YouTube permits guest playback. Signed-in free accounts and Premium accounts
  use the same official playback path. Premium is not a requirement for the
  normal Play action.
- Online playback is exclusively one persistent native YouTube Music WebPlayer:
  WebView2 on Windows, WKWebView on macOS, and WebKitGTK on Linux. It loads the
  official `music.youtube.com/watch` page in a guest profile or the active
  account's persistent profile, so YouTube's advertisements, regional limits,
  account restrictions, and entitlements remain intact.
- The remote YouTube document has no Tauri capability. A versioned observer
  reports playback through a secret per-launch bridge: a loopback HTTP route on
  Windows, the secure `goosicbridge` URI scheme on Linux, and an origin-checked
  `WKScriptMessageHandler` on macOS, where WebKit blocks the network bridge
  routes (see section 13). Native code
  validates the trusted Origin, secret, payload size, generation, expected
  video ID, strictly increasing per-generation sequence, and numeric values
  before emitting readiness, position, duration, volume, buffering,
  advertisement, ended, or error state to React. Never log playback URLs,
  bridge secrets, cookies, tokens, or remote request bodies.
- Commands and events are generation-scoped so a stale page cannot control the
  active track. On a genuine startup failure, Goosic recreates the WebPlayer
  once and retries that track once. A second failure is surfaced to the user;
  ordinary playback never falls back to yt-dlp or a local extractor.
- The playback observer suppresses YouTube Music's `beforeunload` confirmation
  handler at document start. The hidden transport WebView has no user-editable
  form state to preserve, and allowing that handler would expose a browser
  "Leave site?" dialog whenever Goosic navigates it to the next track.
- Goosic's persisted volume/mute state remains authoritative across WebPlayer
  navigations. YouTube assigns its own persisted level (usually `1.0`) to a
  replacement media element the instant it is created, which is earlier than
  any observer sample, `volumechange` listener, or native eval can react —
  that gap was audible as a short full-volume burst on track transitions.
  The observer therefore installs a ceiling on `HTMLMediaElement.prototype`'s
  `volume` accessor at document start and normalizes the element inside a
  wrapped `play()`. The page may still go quieter (WebKit's silent-autoplay
  probing needs that) but can never exceed the requested level, advertisements
  included. Observer samples still pin the exact value; mute remains untouched
  during advertisements. Do not move this enforcement back into the sampling
  loop alone — it is deferred behind a microtask and the in-flight bridge
  fetch, which is precisely the window that was audible.
- The official page runs its own autoplay queue inside the transport document.
  Once it moves past the requested track, that is the requested track's
  completion, not a wrong-track load: the observer reports an ordinary
  terminal event and pauses the page's own pick so it never becomes audible,
  and the native bridge suppresses the unexpected-track error while a terminal
  is pending. Reading that transition as a failure previously tore down and
  reloaded the WebPlayer on the same queue row instead of advancing. The
  advertisement gates matter here: the DOM ad marker can clear one sample
  before the player reports requested content again, so `lastObservedAd` and
  the ad-suppression flag must keep advertisements out of that path.
- Seeking goes through the official player's `seekTo`, never a raw
  `media.currentTime` assignment. The page owns the media source: assigning
  `currentTime` moves only the element, so a target outside the buffered range
  collapses back to whatever is already buffered, and the page's own clock —
  the one driving its progress UI and its next segment requests — keeps
  pointing somewhere else. The element assignment survives only as a fallback
  for a document that never exposes a player API. React additionally holds the
  requested position until an observer sample confirms it, because samples
  already in flight still carry the pre-seek time and would drag the progress
  bar backwards; that hold is bounded so a refused seek cannot freeze the bar.
- Never resume a finished element. Reaching the end fires `pause` before
  `ended`, and `play()` on a finished element rewinds it to zero, so both the
  observer's resume helper and React's ready-state reconciliation used to
  restart the very track Goosic was about to advance past. The observer
  reports `finished` from the moment the requested track is over — including
  the samples before its one-shot `ended` event — and both sides honor it.
- Each replay also receives a new generation. Native terminal delivery is
  exactly once per generation, preventing duplicate bridge samples from
  advancing two rows without breaking repeat-one or replaying an ended row.
- Advertisements are detected only to keep the Goosic UI honest. Do not skip,
  mute, seek through, or otherwise bypass them. Show an Advertisement state and
  temporarily disable controls that the official page cannot safely support.
- Offline acquisition is a separate, explicit Premium feature on playlist
  pages. Goosic drains the requested playlist, downloads it sequentially, and
  exposes aggregate progress, cancellation, and retry. There is no per-track
  download action, automatic playback-time prefetch, or implicit caching from
  normal Play. A 429/not-a-bot result stops the batch rather than retrying it
  aggressively; its 15-minute cooldown is persisted natively and applies to
  every start path across app restarts.
- Download authority is action-scoped and fail-closed. Starting or retrying a
  playlist forces a fresh live Premium probe; a running batch revalidates at a
  bounded cadence and stops on account/channel changes or loss of live
  entitlement. Offline grace permits existing downloaded-file playback only
  and never authorizes new network downloads. Terminal batch states detach
  those boundary listeners before async cache invalidation, so a late account
  event cannot leave the UI permanently stuck on Cancelling.
- yt-dlp, managed Deno, and the pinned `bgutil-ytdlp-pot-provider` **v1.3.1**
  exist only for explicit playlist downloads. They are installed lazily when
  that feature is used, never receive account cookies, and never influence
  online playback. Every child ignores user/system yt-dlp configuration and
  global plugins; only the verified managed provider ZIP is enabled when
  healthy. Provider archives remain SHA-256 pinned, atomic, loopback-only,
  version-checked, and never updated to an unchecked latest release. If the
  provider crashes during a track, Goosic restarts/rechecks it once and retries
  that affected track once; a 429 is never included in that retry path.
- Premium account-menu detection follows YouTube Music's authenticated menu
  shape: Free accounts contain a branded Premium upsell, while Premium
  accounts omit it (or expose an explicit manage-membership entry). Transport
  failures and anonymous menus remain unentitled. While a live probe is still
  pending, the sidebar says `Checking` instead of incorrectly labeling the
  account `Free`.
- **Play downloaded** resolves only an exact, validated local file selected
  from a downloaded-playlist manifest or explicitly from Storage, then serves
  it through the token-gated, cache-only loopback route to `HTMLAudioElement`.
  It never turns a local miss into a network extraction. Downloaded-file
  playback remains Premium-only.
- Existing downloads survive migration. Legacy and invalid entries stay
  visible in Storage (invalid files are marked as needing repair), are excluded
  from playback, and are never silently deleted. Removal remains an explicit
  user action.
- New offline media defaults to the durable app-data
  `offline-media/stream` directory, not the evictable OS cache directory. On
  first startup after migration, finalized files from the old cache location
  are copied without overwriting or deleting either copy. Cover art remains in
  the OS cache because it is disposable.

## 7. Approved visual language

### Geometry and spacing

- The global Figma radius token is **34px**. `src/index.css` maps semantic
  Tailwind radius tokens to `--radius: 34px`.
- Do not blindly enlarge all content just because corners are large. The user
  prefers the newer Apple-like padding/material treatment with the older,
  compact content scale.
- Song cards need enough internal padding that the artwork and text do not
  collide with rounded corners. Keep the artwork slightly inset rather than
  growing the entire card.
- Circular artist art remains circular. Album/playlist/song geometry may use
  semantic radius utilities, which currently resolve through the 34px token.

### Glass surfaces

Use `GLASS_SURFACE_CLASS` for menus/popovers and
`PLAYER_GLASS_SURFACE_CLASS` for player surfaces. This keeps light/dark colors,
hairlines, inset highlights, shadows, and blur consistent.

### Modular visual themes

`src/lib/themes.ts` is the master visual component for interface styles. Each
theme child provides light/dark semantic tokens (`--background`, `--primary`,
`--sidebar`, etc.) plus material tokens (`--glass-*`, `--app-font-family`, and
`--radius`). `useVisualTheme()` mounts the selected token set on the root and
observes the next-themes `dark` class, so a Light/Dark switch re-applies the
same child theme's matching mode. Keep new UI on semantic tokens and shared
material classes; do not add per-theme conditionals to individual components.
The Appearance settings tab is the first consumer-facing selector. Add future
themes by extending `VISUAL_THEMES`, not by copying component CSS.

The player material intentionally uses approximately **10% surface tint** so
the content/album background remains visible beneath it.

### Menus and highlights

- Context menus, dropdown menus, queue/lyrics popovers, player menus, and
  submenus should feel like the same material.
- Support both light and dark themes.
- Menu item highlights are inset rounded pills (`mx-2`, rounded), not full-width
  rectangular bands touching the menu edges.
- Avoid visible separator lines in the Apple-inspired menu treatment unless a
  specific information hierarchy truly requires one.
- Submenus must be separately portaled glass panels with spacing from the
  parent. Do not render them inside an overflow-clipped parent menu.
- Preserve `menu-shell-clip`, `menu-scroll`, and `app-scroll`. They prevent rows
  and native scrollbar paint from escaping 34px menu corners.

### Scrollbars and desktop ergonomics

- Main content and shelves use the custom thin app scrollbar, not the default
  Windows scrollbar.
- Menu tracks use top/bottom margins so the thumb does not intersect rounded
  corners. Dropdown/context-menu portals keep 8px viewport collision padding;
  scrollable submenus cap their height to both 20rem and Radix's available
  viewport height. The menu clip extends 1px beyond the shell so it does not
  shear the directional glass rim.
- Horizontal shelves should retain visible previous/next arrows and mouse/PC
  scrolling behavior.
- Lyrics intentionally hide their native scrollbar.

### Player and content layering

- The bottom player is an overlay above content; content remains visible under
  the translucent blur.
- Clicking (rather than dragging) the cover in the right or bottom player opens
  the in-window immersive player. It is the existing `PlayerBar` with the
  `fullscreen` variant: cover/metadata/progress/transport on the left, the
  existing synchronized `LyricsBody` on the right, and the existing
  `NowPlayingBackground` behind both. Clicking the large cover, pressing Escape,
  or using the minimize button exits. Do not replace this with a second WebView
  or duplicate player/audio component.
- The right/floating player and bottom player should share the same background
  and glass material decisions where the platform implementation permits it.
  The first native Liquid Glass pass intentionally applies only to the
  standalone macOS floating-player window; the in-main-window right and bottom
  variants remain web glass until they are extracted into native surfaces.
- Playback queue entries preserve album browse IDs and artist browse IDs.
  Clicking now-playing title metadata opens its album, while artist metadata
  opens the artist page. The standalone floating player forwards both routes
  to the main window through `nav:album` and `nav:artist` events.
- Volume controls/popovers must not create a visually conflicting second glass
  material. `VolumeControl` intentionally keeps the original compact pill
  silhouette: a vertical pill above the bottom-player button and a horizontal
  pill beside the right/floating-player button. Both use the shared glass
  material and must render through portaled `PopoverContent`; an absolutely
  positioned child is clipped by the player's overflow and paints under its
  controls.

### Desktop selection behavior

- The application root disables text selection so labels, headings, lyrics,
  cards, and player metadata cannot be accidentally highlighted like a web
  document. Inputs, textareas, and explicit editable regions opt back into
  text selection; preserve that exception for search and settings forms.
- Outer native windows use a dedicated **16px Figma radius**; this does not
  change the internal 34px card/menu geometry. macOS/Linux windows use
  transparent backing surfaces and clip the React root through
  `native-rounded-window`; the floating window's full-size surface also uses
  16px. Keep those clips and the Tauri `transparent` flags in sync or black
  square pixels return outside the UI.
- The macOS main window uses the platform override in
  `src-tauri/tauri.macos.conf.json`: native decorations, an overlay title bar,
  hidden title, and real AppKit traffic lights. `TopBar` reserves their left
  inset and must not render the Windows caption buttons on macOS. Windows and
  Linux retain the custom right-side caption controls.
- **macOS 26 (Tahoe) WKWebView black-window trap (found 2026-07-14):** putting
  `border-radius` + `overflow: hidden` on `#root` (the `native-rounded-window`
  clip) makes WKWebView's compositor drop the entire window's output. The app
  keeps running â€” JS executes, modules load, audio streams â€” but the window
  paints solid black (or, with `transparent: true`, garbled tiny content).
  Therefore `usesRoundedNativeWindow()` in `src/lib/platform.ts` is
  **Linux-only**. macOS needs no CSS clip: AppKit rounds decorated windows
  natively, and the floating player gets its 16px radius from
  `native_glass.rs`. The macOS main window also ships `transparent: false`
  with an opaque `backgroundColor` â€” do not reintroduce the CSS root clip or
  window transparency on macOS without verifying on a Tahoe machine.
- The standalone macOS floating player is an AppKit material host: native
  Liquid Glass on macOS 26+, with native visual-effect fallback on older macOS.
  Its outer radius is the same 16px window token. Keep its WKWebView transparent
  and pass it to `NSGlassEffectView.contentView`; adding an effect as an
  unrelated subview does not provide Apple's supported Liquid Glass behavior.

### Artist navigation

Use `ArtistLinks` wherever structured artist objects are available. Clicking an
artist name should navigate to `/artist/$id` without also activating the parent
song/card. Preserve `stopPropagation()` where the artist link is nested in a
playable card.

### Design references

- Apple-style menu reference in the user's Figma file:
  <https://www.figma.com/design/hgOSUYAeL4TsHWLMpLsE8O/BBTOV-DESINGS?node-id=23-7454&m=dev>
- Album-background technique reference:
  <https://github.com/frigopedro/Apple-Music-Background>

The reference background repository documents a randomized dominant-color grid
under heavy glass blur. It did not expose a visible license when reviewed, so
Goosic uses an independent implementation of the described technique rather
than copied source code.

### Lyrics and clipping

- Long or wrapped lyric lines must not be cut at the bottom/top of the lyrics
  card.
- Keep the lyrics blur overlay, safe zone, and GPU text-layer comments in
  `src/index.css`; they document fixes for clipped/soft/jumping lyric lines.
- The short floating-player viewport intentionally uses
  `lyrics-mask-compact` and omits the compositor-heavy blur overlay. Reusing
  the percentage mask/blur stack there cuts wrapped lines and can paint a hard
  rectangular band in WKWebView.

## 8. Dynamic album mesh

The album mesh is the ambient background. It is no longer an experiment and has
no toggle of its own: the only related preference is

```text
Settings â†’ Appearance â†’ Background   (Ambient | Plain)
```

`background` in `src/lib/store/settings.ts` decides whether an ambient
background renders at all; when it is `ambient`, the mesh is what renders.

The older blurred-cover treatment is **gone** — not demoted to a fallback,
deleted. The cover is a color source only and is never displayed as artwork by
the background, so nothing in `now-playing-background.tsx` scales or blurs the
image. Do not reintroduce it, as either a mode or a fallback.

The retired `dynamicAlbumMesh` preference is stripped from persisted settings by
`stripRetiredSettings`, which both `migrate` and `merge` call. `merge` matters
because it runs on every hydration, including the cross-window `storage`
rehydrate, where `migrate` does not; dropping a key in only one of them lets a
stale value survive. The Experiments tab was removed along with its last
toggle.

Implementation contract:

1. Load the current high-resolution cover so the canvas may read it back.
   `loadSampleableImage` tries a normal `crossOrigin="anonymous"` decode, then
   falls back to fetching the bytes through `tauri-plugin-http` and decoding a
   same-origin blob URL. The fallback exists because a host that omits CORS
   headers fails the first decode outright, and since the mesh is now the only
   ambient treatment, that used to mean no background at all. Keep both paths.
2. Sample it into a 48Ã—48 canvas.
3. Quantize pixels, rank colors by actual frequency, and select up to five
   sufficiently distinct colors.
4. Keep sampled RGB values as they are. **Do not invent, hue-shift, or boost
   synthetic colors.** A white/red/black cover must not become pink/purple.
5. Weight a deterministic 6Ã—6 grid by the colors' observed frequency.
6. Paint each cell as a **soft radial blob** with a transparent falloff, not a
   filled square, and give it a seeded off-center position and radius.
   Overlapping blobs fuse into one fluid field; filled squares read as a
   mosaic and rely entirely on the blur radius to hide their seams. The seeded
   offsets are what keep the field from resolving into a visible lattice.
7. Animate grid drift and cell breathing using transforms/opacity.
8. Crossfade track changes and honor `prefers-reduced-motion`.
9. If sampling still fails, render no ambient background for that track. A fake
   palette is forbidden and there is no blurred-artwork fallback, so the window
   keeps its plain background.

### Critical packaged-build fix

Release `v0.3.5` exposed the raw 6Ã—6 squares across the whole window even
though dev mode looked correct. The packaged WebView2 compositor excluded the
grid sibling layer from the large nested `backdrop-filter`.

Release `v0.3.6` fixed this by applying the primary blur directly to
`.album-mesh-grid`:

```css
filter: blur(clamp(110px, 9vw, 160px)) saturate(108%);
```

The grid also has `inset: -30%` overscan to prevent blurred edge seams. The
frost overlay keeps only a smaller finishing backdrop blur.

**Do not move the primary blur back to only `.album-mesh-frost`.** Dev testing
alone will not catch the regression. Any mesh change must be checked with a
production/Tauri build.

### Linux renders the mesh at quarter scale

Linux runs with WebKitGTK's accelerated DMA-BUF renderer disabled
(`src-tauri/src/main.rs`), so this background's blur is rasterized in software
and was the app's single most expensive thing to paint. Measured with the real
stack at 1600x900 on WebKitGTK 2.52.5:

| Variant                                  | FPS  |
| ---------------------------------------- | ---- |
| As shipped (`blur(clamp(110px,9vw,160px))`) | 4.4  |
| Only the outer grid transform animating  | 4.2  |
| Nothing animating, blur kept             | 14.2 |
| `blur(40px)` instead                     | 13.7 |
| Animated, filter removed entirely        | 57.0 |

The animation is therefore not the cost — the number of blurred pixels is.
`MeshLayer` adds `album-mesh-lowres` when `isLinuxWebview()`, which sizes the
`.album-mesh-scaler` host to 25% and upscales it with `transform: scale(4)`
while quartering the blur radius to `clamp(27.5px, 2.25vw, 40px)`. The blur
then runs over 1/16 the pixels, and because the field is pure low-frequency
color the upscale is visually equivalent — verified by snapshotting both paths
with animations paused. Measured against the built CSS: **5.4 -> 60.9 FPS**.

Two invariants:

- The reduced radius must stay exactly a quarter of the full-scale one, or the
  upscaled field stops matching Windows/macOS. `vw` is viewport-relative, not
  element-relative, so `2.25vw` is the correct quarter of `9vw`.
- `.album-mesh-scaler` is always rendered, on every platform, as a
  full-size passthrough. Both paths keep one DOM shape; only CSS differs.

Enabling the DMA-BUF renderer is not an alternative. On this dev machine
(RTX 4070 + hybrid Wayland) `WEBKIT_DISABLE_DMABUF_RENDERER=0` froze WebKit
after the first GPU-heavy paint under Wayland, under XWayland, and with the
iGPU forced — the safeguard in `main.rs` is still required. That is also why
Linux keeps the flat glass fallback: a snapshot of sharp stripes under a
`backdrop-filter` panel showed them completely unblurred even though
`CSS.supports('backdrop-filter', 'blur(10px)')` reports `true`, which is
exactly what `src/lib/platform.ts` documents.

## 8b. Figma Liquid Glass materials and Windows refraction

The source of truth is Figma page `GLASSS` (`49:40801`) in the BBTOV file. Its
`Active=True` and `Active=False` variants are deliberately separate materials:

- **Interactive** (`Active=True`) composes `Fill + Shadow` below `Glass Effect`.
  The outer shell owns geometry and clipping; `::before` owns the luminosity
  fill, outline, side light, and drop shadow; `::after` owns the glass-effect
  inner shadows and small-control interaction light. Only this variant may use
  backdrop blur, SVG refraction, RGB dispersion, or pointer lighting.
- **Static** (`Active=False`) composes `Shadow` below `Fill`. It has no glass
  effect, backdrop blur, refraction, dispersion, or dynamic light. Its separate
  pseudo layers reproduce the Figma outline/side-light stack and multiply fill.
- Small materials use the Figma 6px frost radius and compact shadow recipe.
  Medium/large materials use a 16px frost radius and their heavier shadow
  recipe. The user Glass blur preference scales both values at the same 6:16
  ratio instead of flattening the two Figma sizes into one blur.
- Tinted interactive controls keep Figma's order and blend modes: Fill + Shadow,
  White Backing, the four-paint Tint stack (`plus-darker`, `overlay`,
  `saturation`, `normal`), then Glass Effect. Chromium's standardized blend
  modes are used directly; no legacy red/black gradient fallback remains.

`glassSurfaceClass()` in `src/components/ui/glass-surface.ts` is the canonical
typed material API. It accepts `variant: "interactive" | "static"` and
`scale: "small" | "medium" | "large"`; the exported player, menu, and dialog
constants are built from it. Default/destructive buttons use interactive small
glass, secondary/outline buttons use static small glass, and ghost/link buttons
remain flat so controls nested inside a glass surface do not create glass on
glass. Menus, popovers, dialogs, sidebar, and players reuse these primitives;
do not rebuild their material stack locally.

Interactive materials select the renderer by platform:

- `useGlassPlatformClasses()` adds `liquid-refract` on Windows and
  `macos-backdrop-glass` on macOS. There is no separate experiment preference.
  WebView2 receives the complete SVG renderer. Because WKWebView ignores SVG
  URLs in `backdrop-filter`, macOS interactive surfaces instead use native CSS
  backdrop blur driven by the same 6px/16px frost tokens. Static surfaces stay
  unblurred on every platform.
- `src/components/layout/liquid-glass-defs.tsx` registers only
  `.glass-material-interactive` elements. Its dimension-matched SVG filters
  implement the Figma preset (70% refraction, 30 depth, 25% intensity, -60Â°
  20% dispersion, 20% splay) with a 127-sample
  convex-squircle/Snell-law map and
  separately displaced RGB channels. CSS adds one masked 1px directional rim
  using the supplied 157deg white gradient; there are no other CSS fills,
  shadows, specular fallbacks, or pointer-light layers.
- A MutationObserver + ResizeObserver gives every live surface its own filter;
  detached portals are unregistered. Maps cap their longest raster edge at
  512px, release temporary canvas buffers immediately, and use a 16-entry LRU.
  Fullscreen player controls are portaled to `document.body`, request a fresh
  filter after Queue switches, and write the generated SVG URL directly to
  both backdrop-filter properties. The portal is required because WebView2
  otherwise places Queue's accelerated scroll layer above a sibling backdrop
  sampler even when that sibling has a higher CSS z-index.
  Keep these bounds: the former unbounded 1024px cache could grow the WebView2
  renderer into multiple gigabytes.
- The main SVG host is mounted once in AppShell. On Windows the standalone
  floating-player WebView mounts its own host and an internal album-derived
  backdrop, allowing the interactive SVG material to refract WebView pixels
  without exposing the desktop through the transparent window. The standalone
  macOS player continues to use native `NSGlassEffectView`/`NSVisualEffectView`
  and is explicitly excluded from the CSS blur to prevent double compositing;
  Linux stays static.
- CSS selectors are rooted at `.glass-material-interactive` and
  `.glass-material-static`. Never broaden the SVG selector to `.liquid-glass`,
  or static surfaces will incorrectly acquire the interactive effects.

The Figma hierarchy, exact exposed paints/effects, computed CSS layers, dynamic
registration, and representative sidebar/dialog/menu/button surfaces were
re-verified in Chromium on 2026-07-20. Any compositor change must still be
checked in a production/Tauri build because packaged WebView2 behavior can
differ from Vite dev mode.

## 8c. Background GPU saver (minimized/hidden windows)

`useWindowHidden()` in `src/hooks/use-window-hidden.ts` reports when the main
window is minimized or hidden to tray (document.visibilitychange +
`tauri://resize` â†’ `isMinimized()`). AppShell unmounts `NowPlayingBackground`
while hidden, killing the album mesh's continuously animating blur stack so a
backgrounded app costs near-zero GPU while audio keeps playing. The standalone
floating-player WebView never mounts `NowPlayingBackground` or `LiquidGlassDefs`:
it retains the existing components and classic static web glass, avoiding a
second animated mesh and runtime refraction compositor. Do not "optimize" the
main window into opacity/visibility toggles â€” the compositor keeps animating
hidden layers; unmounting is the point.

The hidden Windows account session-keeper sets WebView2's supported memory
usage target to `Low` after creation. This lets the runtime discard inactive
renderer caches without suspending JavaScript, networking, navigation, or the
periodic cookie refresh. Keep this scoped to the hidden keeper; the visible
main and floating player WebViews remain at the normal target.

## 9. Branding

The user deliberately rebranded the entire product from YTubic to **Goosic**.

Sources of truth:

- `src/lib/branding.ts` exports `APP_NAME` and chooses dev/release art.
- `public/goosic-icon.svg` is the production frontend icon.
- `assets/branding/goosic-icon-dev.svg` is the development frontend icon.
- `src-tauri/icons/icon-dev.png` is the yellow/orange debug taskbar icon.
- `src-tauri/icons/` contains the generated production platform icon set.

Debug builds intentionally show a different yellow/orange icon so the user can
distinguish a dev instance from the installed release. Run:

```powershell
pnpm tauri dev
```

to get the full debug app and dev icon.

When adding user-facing strings, use â€œGoosic,â€ not â€œYTubic.â€ Historical names
may remain in compatibility-only technical identifiers, environment variables,
localStorage keys, repository paths, and the Tauri identifier. Do not rename
those casually because it can break stored user data or integrations.

## 10. Discord Rich Presence

- Backend: `src-tauri/src/discord.rs`
- Public Discord Application ID: `1526113133570293800`
- Preferred build override: `GOOSIC_DISCORD_APP_ID`
- Legacy compatibility override: `YTUBIC_DISCORD_APP_ID`
- Setting: opt-in and off by default.
- Presence type: Listening.
- Shows track, artist, album art, app logo, and timestamps while playing.
- Worker reconnects when Discord opens later and rate-limits/deduplicates pushes.

The client/Application ID is public and safe to ship. Discord's application
public key is not required for local Rich Presence IPC; do not add it to the
client unless a future Discord interaction/OAuth feature actually needs it.

Discord renders the application name configured in the Discord Developer
Portal. If it displays a misspelling, fix the portal app name; code cannot
override that label.

## 11. Update service and release artifacts

The updater is already pointed at the Goosic fork in
`src-tauri/tauri.conf.json`:

```text
https://github.com/AnalogicGoose/Goosic/releases/latest/download/latest.json
```

The updater public key is committed in `tauri.conf.json`; this is expected. The
private signing key must never be committed.

Update behavior:

- `src/lib/updater.ts` checks silently five seconds after startup.
- Manual checks report success/failure.
- Dev mode uses a mock update so the banner flow can be tested.
- Release mode downloads, verifies, installs, and relaunches through Tauri.
- Windows installation mode is passive.

### Release notes drive the in-app What's New

`src/lib/whats-new-remote.ts` reads
`https://api.github.com/repos/AnalogicGoose/Goosic/releases` through
`tauri-plugin-http` and renders whatever a release's body says as that
version's What's New. Write the notes once, on the GitHub release; they need no
matching entry in the app.

- The host is allow-listed in `src-tauri/capabilities/default.json`, not in the
  CSP. plugin-http performs the request in Rust, so the webview `connect-src`
  list stays as narrow as it is.
- Release bodies are remote text. They are parsed to plain strings and rendered
  as React text nodes; markdown becomes headings and bullets and everything
  else, including any HTML, is stripped. Never render a release body as HTML.
- `.github/workflows/release.yml` writes a fixed `releaseBody` ("See the assets
  below to download and install this version."). A body that reduces to only
  that boilerplate counts as having no notes, and the bundled entry in
  `src/lib/whats-new.ts` is shown instead. **Every release published through
  v0.4.7 is in that state**, so the bundled entries are still what users see
  until someone writes real notes on a release. Editing a release's body on
  GitHub is enough; the app picks it up within its six-hour revalidation.
- `src/lib/whats-new.ts` remains the fallback for those versions and for
  offline launches. The query is persisted, so the notes for the version a user
  just updated to survive a cold start without network.
- The unauthenticated GitHub API allows 60 requests an hour per IP. Keep the
  six-hour `staleTime`; do not add a poll.

Required GitHub Actions secrets:

- `TAURI_SIGNING_PRIVATE_KEY`
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`
- `YTUBIC_LASTFM_API_KEY` (optional; integration disabled if absent)
- `YTUBIC_LASTFM_API_SECRET` (optional; integration disabled if absent)

Never print or copy private secret values into documentation, source, commits,
logs, or chat. `src-tauri/build.rs` validates Last.fm credentials and strips a
PowerShell-added UTF-8 BOM. When setting those secrets, prefer:

```powershell
gh secret set SECRET_NAME --body "value" -R AnalogicGoose/Goosic
```

Do not pipe the value from Windows PowerShell 5.1; the historical BOM issue
caused invalid release credentials.

Each successful release should contain:

- `Goosic_<version>_x64-setup.exe`
- `Goosic_<version>_x64-setup.exe.sig`
- `Goosic_<version>_amd64.AppImage` and `.sig`
- `Goosic_<version>_amd64.deb` and `.sig`
- `Goosic-<version>-1.x86_64.rpm` and `.sig`
- `Goosic_<version>_universal.dmg`
- `Goosic.app.tar.gz` and `.sig` (macOS updater artifact)
- `latest.json`

## 12. Exact release procedure

The release workflow is `.github/workflows/release.yml` and runs only when a
new `v*` tag is pushed. It publishes a non-draft, non-prerelease GitHub Release.

### Version bump

Keep the version synchronized in all three manifests:

- `package.json`
- `src-tauri/Cargo.toml`
- `src-tauri/tauri.conf.json`

Then run `cargo check --manifest-path src-tauri/Cargo.toml` so the root package
entry in `src-tauri/Cargo.lock` updates too.

### Required checks

```powershell
pnpm lint
pnpm test
pnpm build
cargo check --manifest-path src-tauri/Cargo.toml
pnpm tauri build --no-bundle
git diff --check
```

`pnpm tauri build --no-bundle` validates the optimized native executable while
avoiding a local signed-updater bundle requirement. For UI/compositor changes,
this production build is mandatory even if `pnpm tauri dev` looks correct.

### Commit, push, and trigger

Only stage the intended work. When the user explicitly says â€œpush all,â€ the
whole inspected worktree is in scope.

```powershell
git add -A
git diff --cached --check
git commit -m "<clear description>"
git push origin main
git tag -a vX.Y.Z -m "Goosic vX.Y.Z"
git push origin vX.Y.Z
```

Never reuse or force-move a published release tag.

### Monitor and verify

```powershell
gh run list -R AnalogicGoose/Goosic --workflow Release --branch vX.Y.Z --limit 1
gh run watch <run-id> -R AnalogicGoose/Goosic --exit-status
gh release view vX.Y.Z -R AnalogicGoose/Goosic --json name,url,assets
```

Do not tell the user the release is downloadable until Windows, Linux, and
macOS jobs are green and all expected assets are in the public release.

## 13. Development commands

### Node version requirement (macOS trap)

Use **Node 20 or 22**, matching CI (`node-version: 20` in the workflows).
**Node 24 breaks `pnpm dev` / `pnpm tauri dev`:** Vite hangs silently before
printing anything â€” importing `@tanstack/router-plugin/vite` deadlocks inside
Node 24's ESM/CJS module evaluation, so Tauri loops forever on
"Waiting for your frontend dev server to start on http://localhost:1420/".
Verified 2026-07-14 on macOS with Node v24.14.1 (hangs) vs Node v22.23.1 (works).

On the user's MacBook, Homebrew `node@22` is installed but keg-only. Prefix it
before running anything:

```bash
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
```

Install dependencies:

```powershell
pnpm install
```

Run the real desktop app with the yellow/orange dev icon:

```powershell
pnpm tauri dev
```

Run frontend only:

```powershell
pnpm dev
```

Quality checks:

```powershell
pnpm test
pnpm lint
pnpm build
cargo check --manifest-path src-tauri/Cargo.toml
```

Format touched files instead of mechanically rewriting the entire dirty tree:

```powershell
pnpm exec prettier --write <file1> <file2>
```

Build the optimized executable without bundling:

```powershell
pnpm tauri build --no-bundle
```

Expected output:

```text
src-tauri/target/release/goosic.exe
```

### Linux/AppImage build contract

Goosic plays audio through WebKitGTK/GStreamer. The AppImage must keep
`bundle.linux.appimage.bundleMediaFramework: true` in `tauri.conf.json`, and
the Ubuntu release runner must install the base, good, bad, and libav
GStreamer plugin sets before bundling. Without them the isolated AppImage
cannot find `appsink` or `autoaudiosink`; its `WebKitWebProcess` crashes and
the window freezes or turns black.

The release workflow verifies `appsink`/`autoaudiosink` on the build host and
checks for `libgstapp.so`, `libgstautodetect.so`, and `libgstlibav.so` inside
the final AppImage. Do not remove these checks as an optimization.

**GTK realization order (found 2026-07-22, aborted every v0.5.0 Linux play).**
`configure_background_window`'s Linux path must call
`set_ignore_cursor_events(true)` **after** `window.show()`, and it must stay
last. Tao services that request with `gtk_widget_get_window(...).unwrap()`, and
`gtk_widget_get_window` returns NULL until the widget is realized. The hidden
playback window is built `visible(false)`, so asking before `show()` unwrapped
`None` — inside a glib dispatch callback, where unwinding is forbidden, so the
process aborted with SIGABRT rather than returning an error. It reproduced the
first time a track was played, because that is when the window is created. The
same function backs the account-verification window, so the ordering protects
both. Windows and macOS are unaffected: neither uses GTK realization, and their
`cfg` blocks legitimately call it before `show()`.

**The hidden playback window is NOT hidden on KDE (open, found 2026-07-22).**
`configure_background_window` hides the transport WebView with three
mechanisms, and on KDE none of them work. The user sees the official YouTube
Music page as a real, uninteractable window in Alt-Tab while Goosic plays.
Measured on this CachyOS/KDE machine:

- The session runs `GDK_BACKEND=wayland`, so `linux_uses_x11_backend()`
  returns false and the offscreen `set_position(-32000, -32000)` is never
  attempted.
- `gtk_window.set_opacity(0.0)` is a **no-op on Wayland**. GTK stores the
  value and reads it back as `0.0`, but GDK's Wayland backend has no protocol
  to apply surface opacity, so the window paints fully opaque.
- Forcing XWayland does not rescue it either: under `GDK_BACKEND=x11`, KWin
  reported the window's position back as `(0, 0)`, not `-32000` — it clamps
  windows into the visible area. The offscreen path has therefore probably
  never worked on KDE on either backend.
- `set_skip_taskbar` has no Wayland protocol and does not remove it from the
  window switcher.

Two constraints bound any fix, both verified against real `music.youtube.com`:

- **The surface must be mapped.** With the window never mapped, YouTube Music
  never creates its media element at all (twelve consecutive samples reporting
  none); mapped, advertisements and then the track play normally. The
  "a mapped GTK surface is required" comment in that function is accurate.
- **Hiding after startup is not enough.** Playback *does* survive unmapping
  once it has started — `currentTime` keeps advancing with
  `document.visibilityState === "hidden"` — but a fresh navigation performed
  while unmapped initializes nothing, and Goosic navigates this WebView on
  every track. "Show once, then hide forever" therefore does not fit.

So there is no client-side way on KDE to keep this toplevel both mapped and
hidden. Any real fix is a trade-off (a 1×1 mapped window, a documented KWin
rule, or reparenting the transport as a child webview) and none is implemented
yet. Playback itself is unaffected — this is a visibility bug only.

This whole function is `cfg(target_os = "linux")` and therefore **cannot be
compile-checked from a Windows or macOS dev box** — `cargo check` there skips
it entirely. The Ubuntu release job is the first real compile. Prefer changes
that reuse calls already present in the file over introducing new `gdk`/`cairo`
API surface that no local check can validate.

**The observer bridge cannot rely on loopback HTTP in WebKit (found
2026-07-22).** WebKitGTK blocks an `http://127.0.0.1` subresource of an HTTPS
document as mixed content, so the observer's `fetch` to the loopback bridge
never left the official page. Verified against real `music.youtube.com` in a
WebKitWebView:
`[blocked] The page at https://music.youtube.com/ requested insecure content
from http://127.0.0.1:PORT/web-player/state`, and the server recorded zero
requests. WKWebView historically treated loopback as potentially trustworthy,
but newer macOS/WebKit builds can withhold the same request behind
private-network policy. Chromium remains on the loopback route.

The symptom is not a silent failure: the track is *audible* while React never
receives `ready`, so the 12-second startup timer in `audio-engine.ts` fires,
`failWebPlayback` recreates the WebPlayer and restarts the same song, and the
second timeout surfaces "Official player startup timed out."

Linux therefore carries the identical envelope over the custom URI scheme
`goosicbridge` (`web_player::BRIDGE_SCHEME`), registered through Tauri's
`register_asynchronous_uri_scheme_protocol`. WebKitGTK marks that scheme secure
to lift its mixed-content block, and its `linux-body` support preserves the
request body. macOS cannot use that fetch either because the official page's
CSP rejects the custom scheme before wry sees a request. Its observer uses a
`WKScriptMessageHandler` installed only on the `youtube-player` WebView. Native
code verifies WebKit-attested main-frame origin, payload size, per-launch token,
and route before calling the same `apply_state_event`/`apply_identity_event`
validators used by the HTTP and Linux transports.

Two details that are load-bearing:

- The response must carry `Access-Control-Allow-Origin`. The scheme is
  cross-origin to the page, and the observer reads `response.ok` to confirm a
  terminal `ended` event was delivered; without the header the fetch rejects
  and that bookkeeping never runs.
- `WebKitSettings:allow-running-of-insecure-content` is **gone** from current
  WebKitGTK (verified absent on 2.52.5). Do not reach for it as a shortcut.

Building an AppImage locally on Arch/CachyOS has a separate `linuxdeploy`
`strip`/`.relr.dyn` incompatibility. See
`docs/linux-appimage-local-build-workaround.md`; it does not apply to the
Ubuntu GitHub runner.

### macOS build contract

The release workflow builds `universal-apple-darwin` on `macos-15`, combining
Apple Silicon and Intel targets into one app/DMG. Platform jobs remain
sequential so their `tauri-action` invocations append safely to one release.

No Apple Developer certificate or notarization credentials are currently
configured. The workflow uses `APPLE_SIGNING_IDENTITY: "-"` for an ad-hoc code
signature; users may need to approve Goosic through macOS Privacy & Security on
first launch. Replace this with Apple signing/notarization secrets when they
become available. Account cookie jars are AES-256-GCM encrypted and their key
is stored in the native login Keychain; do not restore plaintext passthrough on
macOS.

The macOS login follows the native pattern proven by Kaset: an embedded
`WKWebView` uses a Safari 17/macOS user agent and Google's YouTube desktop
continuation URL (`www.youtube.com/signin` â†’ `music.youtube.com`). Do not reuse
the Windows Chrome user agent on macOS; Google rejects that mismatched embedded
identity as an insecure browser. The login and hidden session keeper share the
same persistent per-account WebKit data directory, and captured cookies are
still encrypted through the Keychain-backed `secure_store` path.

## 14. Test and review matrix

For ordinary logic changes, run the automated checks above. For UI/player work,
also manually review the relevant states in `pnpm tauri dev` and, when
compositing or build-mode behavior is involved, an optimized build.

Minimum visual matrix:

- Light and dark theme.
- Right, bottom, and floating player layouts.
- Playing, paused, and no-track states.
- Queue and history tabs.
- Lyrics with long wrapped lines and manual scrolling.
- Volume popover.
- Root context menu plus at least one submenu.
- Long menu with scrollbar near rounded corners.
- Song, album, playlist, video, and artist shelf cards.
- Artist-name clicks inside playable cards/rows.
- Home, Search, Library, Album, Artist, and Playlist routes.
- Background set to Ambient and to Plain.
- A mostly white cover and a dark/saturated cover.
- Window resize at the 900Ã—600 minimum and a large desktop viewport.

## 15. Known warnings and traps

These were present and non-blocking at the `v0.3.6` release:

- ESLint reports **6 warnings and 0 errors**:
  - one unused assignment warning in `animated-tabs.tsx`;
  - hook dependency warnings in Library and Playlist routes.
- Vite warns that the main bundle is over 500 kB.
- Vite warns that `innertube/album.ts` is both statically and dynamically
  imported.
- Git often prints LFâ†’CRLF conversion warnings on Windows; `git diff --check`
  should still pass.
- GitHub Actions currently warns that Node.js 20 actions are being forced onto
  Node.js 24. Releases still succeed, but workflow action versions should be
  upgraded when official compatible majors are available.
- Frontend-only browser testing logs Tauri event/transform callback errors
  because no native event bridge exists. This does not reproduce the complete
  app and is not evidence that the Tauri build is broken.
- WebView2 compositor behavior can differ between dev and packaged release.
  The album mesh issue is the concrete example; always production-build visual
  effects involving `filter`, `backdrop-filter`, isolation, or large layers.
- The Windows installer is not Authenticode code-signed, so SmartScreen may
  warn. Updater artifacts are separately signed with Tauri's signing key.
- On Linux the console prints two harmless third-party messages that are not
  Goosic's and are not playback failures. `libayatana-appindicator is
  deprecated` comes from the library itself, pulled in by Tauri's `tray-icon`
  feature. Bursts of `gst_value_collect_int_range: assertion ... failed` /
  `range start is not smaller than end` come from `WebKitWebProcess` building a
  degenerate `GstIntRange` (min >= max) while enumerating codecs; GStreamer
  drops that caps field and continues. Goosic links no GStreamer code, and
  `gst-inspect-1.0 -a` over the installed plugins reports none of these, so
  there is nothing to fix in this repository. Do not read them as the
  `appsink`/`autoaudiosink` packaging failure below — that one has a different
  signature and does break playback.
- AppImage media playback requires bundled GStreamer plugins. The exact
  `appsink not found` / `autoaudiosink not found` plus GLib null-pointer
  signature is a packaging failure, not harmless MPRIS noise. See
  `docs/linux-appimage-black-screen.md`.

## 16. State and persistence contracts

Several persisted storage keys intentionally retain the historical `ytm-`
prefix. Changing them resets user preferences/data and can break cross-window
sync.

Important examples:

- `ytm-theme`
- `ytm-settings`
- `ytm-layout`
- `ytm-track-source`

`useSettingsStore` defaults include:

- close button hides to tray;
- offline media changes only through explicit playlist downloads or Storage
  removal actions;
- ambient background (the album mesh; there is no separate mesh toggle);
- playback notifications off;
- Discord Rich Presence off;
- Last.fm off until connected.

The layout default is the right-side player. Floating layout and pin state are
persisted and synchronized across native windows.

## 17. Security and privacy notes

- Never commit signing keys, Last.fm shared secrets, cookies, session keys, or
  generated account data.
- The Discord client ID and updater public key are public identifiers, not
  secrets.
- The Rust stream server nests routes under a random per-launch 256-bit token.
  Preserve that token gate. Its audio route is cache-only and must never become
  a general online extractor again.
- The official playback page runs in a native WebView profile. Google/YouTube
  receive the same page, account, playback, and advertising data that their
  own web player normally receives. Goosic does not suppress advertisements or
  account restrictions.
- The remote playback document receives no Tauri IPC capability. Its loopback
  observer bridge is per-launch secret, Origin-checked, size-limited, and
  generation/sequence-scoped; bridge secrets and playback URLs must not be
  logged.
- `src-tauri/build.rs` registers every custom command in Tauri's application
  manifest and fails the build on invoke/ACL drift. Only the bundled `main` and
  `player` labels receive local capabilities; the remote playback, login, and
  session-keeper documents receive none.
- Account cookies are handled by native code, stored in per-account profiles,
  and refreshed periodically. They are never passed to yt-dlp, Deno, or the
  PO-token provider used for explicit playlist downloads.
- Existing and legacy offline files are not silently removed during migration.
  Storage surfaces invalid files for repair or explicit deletion.
- The CSP in `tauri.conf.json` explicitly allows the image/media/network hosts
  needed by the app. Add domains narrowly rather than disabling CSP.
- Rich Presence and notification behavior should remain user-controlled.

## 18. Recent release history

- **`v0.5.3`** â€” moves WKWebView observer envelopes
  from blocked network fetches to an origin-checked native script-message
  handler. This fixes audio playing while readiness/timeline events are absent,
  followed by the 12-second restart and final official-player error.
- **`v0.5.2`** â€” makes Linux playback actually work. The observer bridge moves
  to a secure custom URI scheme because WebKitGTK blocks its loopback HTTP as
  mixed content (section 13), which had left every track audible but stuck on a
  loading spinner until it timed out and restarted. The album mesh rasterizes at
  quarter scale on Linux (5.4 -> 60.9 FPS, section 8), and Settings shows the
  running version. Ships with the open KDE stray-window bug in section 13.
- `v0.5.1` â€” fixed the Linux SIGABRT on first play (GTK realization order) and
  the macOS stuck loading spinner.
- `v0.5.0` â€” official YouTube Music WebPlayer as the sole online backend,
  album mesh background, and GitHub-driven release notes.
- **`v0.4.7`** â€” moved ordinary playback to an official persistent
  YouTube Music WebPlayer on Windows, macOS, and Linux, opening playback to
  guests and free accounts while preserving advertisements and restrictions.
  Offline audio becomes an explicit Premium-only playlist download with
  validated local playback; automatic prefetch and per-track downloads are
  removed, and existing files are preserved.
- `v0.4.6` â€” adds the shared configurable glass material to the sidebar,
  prevents native image/link dragging, bounds WebView2 refraction memory, and
  lowers the hidden authenticated session keeper's Windows memory target.
- `v0.4.5` â€” Figma Glass preset across menus/player, complete pixel-matched
  frames, capped WebView2 refraction, immersive player mode, and lower-cost
  floating-player WebView.
- `v0.4.4` â€” macOS native window/login improvements, native Liquid Glass
  floating player, and cross-platform UI polish.
- `v0.4.3` â€” adds a universal Apple Silicon/Intel macOS DMG and updater
  artifact, plus native Keychain-backed account-cookie encryption. The initial
  macOS build is ad-hoc signed until Apple Developer credentials are provided.
- `v0.4.2` â€” bundles the complete GStreamer media framework into the Linux
  AppImage and verifies required plugins in GitHub Actions, fixing the packaged
  WebKit process crash caused by missing `appsink`/`autoaudiosink`.
- `v0.4.1` / `ef4bff1` â€” added the Linux DMABUF renderer safeguard. The
  initially failed Linux job succeeded on retry and published all Linux
  assets, but this AppImage predates the GStreamer media-framework fix.
- `v0.4.0` / `65a2b34` â€” first public Linux AppImage/deb/rpm release. Its
  AppImage reproduced a missing-GStreamer WebKit crash on CachyOS/KDE.
- `v0.3.6` / `60de5f0` â€” fixed album mesh squares in packaged WebView2 builds
  by directly blurring the mesh source.
- `v0.3.5` / `482059a` â€” Goosic branding launch, icon set, Apple-inspired glass
  menus/player, dynamic album mesh experiment, Discord app migration, clipping
  and spacing updates. This build had the release-only raw mesh-grid bug and
  should not be recommended.
- `v0.3.4` / `274040c` â€” previous stable release baseline.
- `v0.3.3` / `d076f97` â€” signed automatic updater enabled.

## 19. Current handoff state

At the time this document was last refreshed:

- The unreleased working tree makes the official persistent YouTube Music
  WebPlayer the sole online playback backend on Windows, macOS, and Linux.
  Guests, free accounts, and Premium accounts use YouTube's own page, including
  its advertisements and restrictions. A native generation-scoped loopback
  observer drives the existing Goosic queue/player UI without exposing Tauri
  IPC to the remote document. A genuine load failure receives one WebPlayer
  recreation/retry; there is deliberately no yt-dlp playback fallback.
- yt-dlp, managed Deno, and the checksum-pinned bgutil PO-token provider v1.3.1
  are retained only for explicit Premium playlist downloads. Playlist batches
  run sequentially with aggregate progress, cancellation, retry, account and
  freshly revalidated entitlement boundaries, one provider-crash recovery,
  hermetic yt-dlp config/plugin isolation, and a durable 429 cooldown. Normal
  playback no longer prefetches or creates local files, and the track context
  menu has no individual download action.
- **Play downloaded** uses only exact, validated files from a persisted playlist
  manifest or an explicit Storage selection through the cache-only local proxy.
  Existing downloads remain intact and visible; invalid/legacy entries are
  marked for repair or explicit
  deletion instead of being silently removed. The app version remains `0.4.7`
  until an explicit release is prepared.
- `v0.4.6` is public with Windows, Linux, and universal macOS artifacts. It
  adds shared sidebar glass, Default/Modern bottom-player layouts, global glass
  material controls, native drag prevention, and lower WebView2 memory use.
- `v0.4.5` introduced the Figma Glass preset,
  pixel-exact menu filters, capped refraction/dispersion, immersive player
  mode, and floating-player GPU safeguards. It also includes the Safari-
  identified macOS
  WKWebView login flow, transparent 16px native windows and traffic lights,
  AppKit-backed Liquid Glass for the standalone floating player on macOS 26+
  (`NSVisualEffectView` fallback on older releases), plus the related UI polish
  and performance safeguards. It has no Apple certificate/notarization
  credentials yet, so macOS remains ad-hoc signed.
- The Liquid Glass implementation now mirrors the BBTOV Figma `GLASSS` page's
  explicit material hierarchy. Interactive and static variants share typed
  primitives but retain separate layer stacks; only interactive surfaces get
  blur, dimension-matched refraction, and RGB dispersion. Dialogs, menus,
  sidebar, players,
  and button variants use the same compositing contract, with safe WebView2
  raster/cache bounds preserved.
- The modular visual-theme foundation is now in place. Appearance exposes
  Default and Modern styles backed by `src/lib/themes.ts`; they share one
  neutral semantic component/material contract and select the classic or
  modern bottom-player layout. The shared blur control drives the player,
  menus, and sidebar through `ytm-settings`; the retired frosted-opacity value
  is removed from persisted settings during migration. Future styles should
  be added as registry children rather than copied component CSS.

When this snapshot becomes stale, update this section, the header version, and
the recent release history as part of the next release.
