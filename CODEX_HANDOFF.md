# Goosic — Complete Codex Handoff

> **Read this file first in every new Codex session.** It is the durable product,
> engineering, UI, release, and troubleshooting context for this repository.
>
> Last verified: **2026-07-13**
> Current app version: **0.4.1**
> Current `main`: **includes the AppImage GStreamer packaging fix prepared on top of `b34ff95`**
> Latest public release: <https://github.com/AnalogicGoose/Goosic/releases/tag/v0.4.1>

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

The user speaks informally and often says “bro.” Keep communication friendly,
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
normal tag fetch may report “would clobber existing tag.” Do not force-rewrite
published tags. New releases must always use a new version.

## 3. Product intent

Goosic is a fast native-feeling YouTube Music desktop client for Windows. It is
not a wrapper around the YouTube Music website: the React frontend talks to the
InnerTube API, while the Tauri/Rust side handles Windows integration, account
cookies, streaming infrastructure, caching, updater behavior, and native
windows.

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
- Local stream proxy and managed yt-dlp.
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
| Audio URLs       | Managed yt-dlp + local Rust proxy                      |
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
                 | Tauri invoke/events
                 v
Rust/Tauri backend
  |-- account cookie capture and refresh
  |-- token-gated localhost stream proxy
  |-- yt-dlp management and stream resolution
  |-- cover/audio cache management
  |-- tray, windows, autostart, notifications
  |-- Windows SMTC/media keys
  |-- Discord IPC worker
  |-- Last.fm signing, queueing, and retry
  +-- updater/process plugins
```

The same Vite bundle serves two native windows:

- The main window uses TanStack Router and `AppShell`.
- The floating player detects its window label and renders
  `FloatingPlayerApp` instead of the router.

The two windows are separate JavaScript contexts. Cross-window behavior uses
Tauri events plus storage rehydration. Do not assume a Zustand mutation in one
window automatically appears in the other.

## 6. Directory and file map

### Frontend entry and routing

- `src/main.tsx` — React entry; suppresses WebView2's native context menu.
- `src/App.tsx` — theme/query providers and main-vs-floating window split.
- `src/routes/__root.tsx` — route root.
- `src/routes/index.tsx` — Home.
- `src/routes/explore.tsx` — Explore.
- `src/routes/search.tsx` — Search and filters.
- `src/routes/library.tsx` — Library.
- `src/routes/artist.$id.tsx` — Artist detail.
- `src/routes/album.$id.tsx` — Album detail.
- `src/routes/playlist.$id.tsx` — Playlist detail.
- `src/routes/charts.tsx`, `moods.tsx`, `moods_.$id.tsx`, and
  `new-releases.tsx` — discovery routes.
- `src/routeTree.gen.ts` — generated router tree; do not hand-edit.

### Layout and playback UI

- `src/components/layout/app-shell.tsx` — main layout coordinator; mounts
  background, sidebar, content, player layouts, sync hooks, and update checks.
- `src/components/layout/top-bar.tsx` — custom title bar and app menu.
- `src/components/layout/app-sidebar.tsx` — navigation, playlists, accounts,
  settings, and update banner.
- `src/components/layout/player-bar.tsx` — right-side player.
- `src/components/layout/player-bar-bottom.tsx` — bottom overlay player.
- `src/components/layout/floating-player-app.tsx` — separate compact player.
- `src/components/layout/floating-player-sync.tsx` — main/floating state bridge.
- `src/components/layout/player-more-menu.tsx` — player action menu.
- `src/components/layout/queue-panel.tsx` — queue/history surface.
- `src/components/layout/lyrics-view.tsx` — synced lyrics and lyric scrolling.
- `src/components/layout/now-playing-background.tsx` — dynamic album mesh and
  legacy blurred-cover fallback.
- `src/components/layout/update-banner.tsx` — updater progress/action surface.

### Shared content components

- `src/components/shared/shelf-card.tsx` — song/video/album/playlist/artist
  cards and their click behavior.
- `src/components/shared/shelf-carousel.tsx` — desktop-friendly horizontal
  shelves, navigation arrows, edge fading, and scrolling.
- `src/components/shared/track-list.tsx` — track table/list rendering.
- `src/components/shared/track-context-menu.tsx` — track actions and submenus.
- `src/components/shared/artist-links.tsx` — reusable clickable artist names.
- `src/components/shared/thumbnail.tsx` — image sizing/high-resolution helpers.

### UI primitives and visual system

- `src/index.css` — global tokens, the 34px radius system, scrollbars, album
  mesh, lyrics effects, carousel masks, and other global behavior.
- `src/components/ui/glass-surface.ts` — canonical glass material class strings.
- `src/components/ui/context-menu.tsx` — root and portaled submenu styling.
- `src/components/ui/dropdown-menu.tsx` — dropdown and submenu styling.
- `src/components/ui/popover.tsx` — shared popover glass treatment.
- Other primitives live under `src/components/ui/`.

### Data, state, and playback

- `src/lib/innertube/` — InnerTube clients, parsers, entity queries, mutations,
  radio, and shared data types.
- `src/lib/audio-engine.ts` — playback lifecycle, media state, Discord updates,
  timing, and stream changes.
- `src/lib/stream.ts` — local stream URL coordination and cache metadata.
- `src/lib/ytdlp.ts` — managed yt-dlp lifecycle hooks.
- `src/lib/query-client.ts` — query caching/persistence budgets.
- `src/lib/store/playback.ts` — queue, history, repeat, shuffle, autoplay, and
  playback actions. The floating window uses a remote-control bridge.
- `src/lib/store/layout.ts` — `right`, `bottom`, and `floating` player layout.
- `src/lib/store/settings.ts` — persisted settings and Rust sync hooks.
- `src/lib/store/track-source.ts` — song/video source pairing and selection.
- `src/lib/updater.ts` and `src/lib/store/update.ts` — update state machine.
- `src/lib/lyrics/` — lyrics providers, matching, and LRC parsing.
- `src/lib/lastfm.ts` and `lastfm-scrobbler.ts` — frontend Last.fm behavior.

### Native backend

- `src-tauri/src/lib.rs` — main Tauri application, local proxy, account and
  cookie handling, cache commands, windows, tray, and invoke registration.
- `src-tauri/src/main.rs` — release console suppression and `goosic_lib::run()`.
- `src-tauri/src/media.rs` — Windows SMTC/media controls.
- `src-tauri/src/discord.rs` — Discord IPC worker and Tauri commands.
- `src-tauri/src/lastfm.rs` — Last.fm authentication, signing, scrobble queue,
  love sync, and retry.
- `src-tauri/src/ytdlp.rs` — managed yt-dlp binary.
- `src-tauri/src/appid.rs` — Windows AppUserModelID.
- `src-tauri/build.rs` — Tauri build plus safe Last.fm credential injection.
- `src-tauri/tauri.conf.json` — product/version, windows, CSP, bundle, updater.
- `src-tauri/capabilities/default.json` — Tauri permissions/capabilities.

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
  corners.
- Horizontal shelves should retain visible previous/next arrows and mouse/PC
  scrolling behavior.
- Lyrics intentionally hide their native scrollbar.

### Player and content layering

- The bottom player is an overlay above content; content remains visible under
  the translucent blur.
- The right/floating player and bottom player should share the same background
  and glass material decisions.
- Volume controls/popovers must not create a visually conflicting second glass
  material.

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

## 8. Dynamic album mesh experiment

The new ambient background is enabled by default and can be disabled in:

```text
Settings → Experiments → Dynamic album mesh
```

The preference is `dynamicAlbumMesh` in `src/lib/store/settings.ts`. When off,
the app returns to the legacy blurred-cover background.

Implementation contract:

1. Load the current high-resolution cover.
2. Sample it into a 48×48 canvas.
3. Quantize pixels, rank colors by actual frequency, and select up to five
   sufficiently distinct colors.
4. Keep sampled RGB values as they are. **Do not invent, hue-shift, or boost
   synthetic colors.** A white/red/black cover must not become pink/purple.
5. Weight a deterministic 6×6 grid by the colors' observed frequency.
6. Animate grid drift and cell breathing using transforms/opacity.
7. Crossfade track changes and honor `prefers-reduced-motion`.
8. If CORS/canvas sampling fails, use the legacy blurred artwork instead of a
   fake palette.

### Critical packaged-build fix

Release `v0.3.5` exposed the raw 6×6 squares across the whole window even
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

When adding user-facing strings, use “Goosic,” not “YTubic.” Historical names
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

Only stage the intended work. When the user explicitly says “push all,” the
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

Do not tell the user the release is downloadable until both Windows and Linux
jobs are green and all expected assets are in the public release.

## 13. Development commands

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

Building an AppImage locally on Arch/CachyOS has a separate `linuxdeploy`
`strip`/`.relr.dyn` incompatibility. See
`docs/linux-appimage-local-build-workaround.md`; it does not apply to the
Ubuntu GitHub runner.

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
- Dynamic album mesh on and off.
- A mostly white cover and a dark/saturated cover.
- Window resize at the 900×600 minimum and a large desktop viewport.

## 15. Known warnings and traps

These were present and non-blocking at the `v0.3.6` release:

- ESLint reports **8 warnings and 0 errors**:
  - one unused assignment warning in `animated-tabs.tsx`;
  - two missing error causes in `innertube/player.ts`;
  - hook dependency warnings in Library and Playlist routes.
- Vite warns that the main bundle is over 500 kB.
- Vite warns that `innertube/album.ts` is both statically and dynamically
  imported.
- Git often prints LF→CRLF conversion warnings on Windows; `git diff --check`
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
- cache auto-clean off;
- ambient background;
- dynamic album mesh on;
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
- The Rust stream server nests routes under a random per-launch 128-bit token.
  Preserve that token gate.
- Account cookies are handled by native code and refreshed periodically.
- The CSP in `tauri.conf.json` explicitly allows the image/media/network hosts
  needed by the app. Add domains narrowly rather than disabling CSP.
- Rich Presence and notification behavior should remain user-controlled.

## 18. Recent release history

- `v0.4.1` / `ef4bff1` — added the Linux DMABUF renderer safeguard. The
  initially failed Linux job succeeded on retry and published all Linux
  assets, but this AppImage predates the GStreamer media-framework fix.
- `v0.4.0` / `65a2b34` — first public Linux AppImage/deb/rpm release. Its
  AppImage reproduced a missing-GStreamer WebKit crash on CachyOS/KDE.
- `v0.3.6` / `60de5f0` — fixed album mesh squares in packaged WebView2 builds
  by directly blurring the mesh source.
- `v0.3.5` / `482059a` — Goosic branding launch, icon set, Apple-inspired glass
  menus/player, dynamic album mesh experiment, Discord app migration, clipping
  and spacing updates. This build had the release-only raw mesh-grid bug and
  should not be recommended.
- `v0.3.4` / `274040c` — previous stable release baseline.
- `v0.3.3` / `d076f97` — signed automatic updater enabled.

## 19. Current handoff state

At the time this document was last refreshed:

- Work began from `main`/`origin/main` at `b34ff95`; check `git log -1` and
  `git status -sb` for the fix commit's current push state.
- Public latest release was Goosic `v0.4.1`.
- The rerun release workflow completed successfully for Windows and Linux.
- Public assets included Windows NSIS, Linux AppImage/deb/rpm, signatures, and
  a cross-platform `latest.json`.
- The v0.4.1 AppImage is still affected by the missing-GStreamer runtime bug;
  the fix is pending the next release and real CachyOS/KDE validation.
- The pending fix passed Tauri config inspection, 53/53 Vitest tests, frontend
  production build/typecheck, Rust check, lint with the same eight historical
  warnings and zero errors, and a local optimized Windows Tauri build.
- `CODEX_HANDOFF.md` and its `AGENTS.md` discovery pointer are new local changes
  until committed in a later step.

When this snapshot becomes stale, update this section, the header version, and
the recent release history as part of the next release.
