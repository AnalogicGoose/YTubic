<p align="center">
  <img src="public/goosic-icon.svg" alt="Goosic" width="96" />
</p>

<h1 align="center">Goosic</h1>

<p align="center">
  A fast, responsive YouTube Music desktop client for Windows, macOS, and Linux.
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-GPLv3-blue.svg" alt="License: GPL-3.0" /></a>
  <a href="https://deepwiki.com/AnalogicGoose/Goosic"><img src="https://img.shields.io/badge/DeepWiki-AnalogicGoose%2FGoosic-blue.svg?logo=data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACwAAAAyCAYAAAAnWDnqAAAAAXNSR0IArs4c6QAAA05JREFUaEPtmUtyEzEQhtWTQyQLHNak2AB7ZnyXZMEjXMGeK/AIi+QuHrMnbChYY7MIh8g01fJoopFb0uhhEqqcbWTp06/uv1saEDv4O3n3dV60RfP947Mm9/SQc0ICFQgzfc4CYZoTPAswgSJCCUJUnAAoRHOAUOcATwbmVLWdGoH//PB8mnKqScAhsD0kYP3j/Yt5LPQe2KvcXmGvRHcDnpxfL2zOYJ1mFwrryWTz0advv1Ut4CJgf5uhDuDj5eUcAUoahrdY/56ebRWeraTjMt/00Sh3UDtjgHtQNHwcRGOC98BJEAEymycmYcWwOprTgcB6VZ5JK5TAJ+fXGLBm3FDAmn6oPPjR4rKCAoJCal2eAiQp2x0vxTPB3ALO2CRkwmDy5WohzBDwSEFKRwPbknEggCPB/imwrycgxX2NzoMCHhPkDwqYMr9tRcP5qNrMZHkVnOjRMWwLCcr8ohBVb1OMjxLwGCvjTikrsBOiA6fNyCrm8V1rP93iVPpwaE+gO0SsWmPiXB+jikdf6SizrT5qKasx5j8ABbHpFTx+vFXp9EnYQmLx02h1QTTrl6eDqxLnGjporxl3NL3agEvXdT0WmEost648sQOYAeJS9Q7bfUVoMGnjo4AZdUMQku50McDcMWcBPvr0SzbTAFDfvJqwLzgxwATnCgnp4wDl6Aa+Ax283gghmj+vj7feE2KBBRMW3FzOpLOADl0Isb5587h/U4gGvkt5v60Z1VLG8BhYjbzRwyQZemwAd6cCR5/XFWLYZRIMpX39AR0tjaGGiGzLVyhse5C9RKC6ai42ppWPKiBagOvaYk8lO7DajerabOZP46Lby5wKjw1HCRx7p9sVMOWGzb/vA1hwiWc6jm3MvQDTogQkiqIhJV0nBQBTU+3okKCFDy9WwferkHjtxib7t3xIUQtHxnIwtx4mpg26/HfwVNVDb4oI9RHmx5WGelRVlrtiw43zboCLaxv46AZeB3IlTkwouebTr1y2NjSpHz68WNFjHvupy3q8TFn3Hos2IAk4Ju5dCo8B3wP7VPr/FGaKiG+T+v+TQqIrOqMTL1VdWV1DdmcbO8KXBz6esmYWYKPwDL5b5FA1a0hwapHiom0r/cKaoqr+27/XcrS5UwSMbQAAAABJRU5ErkJggg==" alt="DeepWiki"></a>
</p>

<p align="center">
  <a href="https://github.com/AnalogicGoose/Goosic/releases/latest">
    <img src="https://img.shields.io/badge/%E2%AC%87%20Download%20latest%20release-FF0000?style=for-the-badge&logo=youtube&logoColor=white" alt="Download latest release" height="60" />
  </a>
</p>

Goosic renders its own fast desktop interface and uses InnerTube for browsing,
search, and library data. Audio plays through a persistent official YouTube
Music WebPlayer, so guests and free accounts can listen wherever YouTube
permits it while YouTube's advertisements and account restrictions remain
intact.

![Goosic — artist page with the player and synced lyrics](assets/screenshots/artist-page.jpg)

## Features

- **Fast and responsive UI** — instant navigation with prefetch and aggressive caching; no page reloads, no spinners on every click
- **Official playback for everyone** — ordinary Play uses YouTube Music's own persistent player for guests, free accounts, and Premium accounts
- **Offline playlists for Premium** — explicitly download a playlist, follow its progress, and play validated local files later
- **Flexible player layouts** — dock the player at the bottom or as a right-side panel
- **Floating player widget** — pop the player out into a compact always-on-top window
- **Synced lyrics** — line-by-line synced lyrics from multiple providers (LRCLIB, Musixmatch, Genius)
- **Hi-res cover art** — upgrades album covers to high-resolution studio art when available
- **Full library support** — your playlists, likes, albums and artists; search with filters; radio/autoplay queues
- **Windows integration** — media keys, System Media Transport Controls, tray icon, single instance
- **Linux integration** — media keys via MPRIS, tray icon (needs an AppIndicator/KStatusNotifierItem extension on vanilla GNOME — see FAQ), autostart, single instance
- **Auto-updates** — the app updates itself from GitHub Releases

> **Disclaimer:** Goosic is an unofficial client. It is not affiliated with,
> endorsed by, or sponsored by Google or YouTube. "YouTube" and "YouTube Music"
> are trademarks of Google LLC. Ordinary playback loads the official YouTube
> Music web player and remains subject to YouTube's advertisements, availability,
> account restrictions, and terms. Use at your own risk.

## Install

Download the latest package from the [Releases](https://github.com/AnalogicGoose/Goosic/releases) page and run it.

- **Windows**: `.exe` installer (NSIS), Windows 10/11.
- **macOS**: macOS 14 or newer, with a universal `.dmg` for Apple Silicon and
  Intel. The current build is ad-hoc signed, so macOS may require a Gatekeeper
  override on first launch.
- **Linux**: `.AppImage` (no install step, just `chmod +x` and run), `.deb`
  (Debian/Ubuntu), or `.rpm` (Fedora/openSUSE). Only the AppImage build
  auto-updates itself; the `.deb`/`.rpm` packages need a manual re-download.
- Browsing, search, and ordinary playback work signed out wherever YouTube
  permits guest playback. Signing in adds library, likes, playlists, and the
  benefits attached to that YouTube account; Premium is not required for the
  normal Play action.
- The managed yt-dlp, Deno, and PO-token tools are installed only when an active
  Premium user explicitly downloads a playlist. Normal playback never invokes
  those tools and never downloads tracks in the background.

### FAQ

**Windows says "Windows protected your PC" (SmartScreen).**
The installer is not code-signed (certificates are expensive for a free
open-source project). Click "More info" → "Run anyway". The source code is
public — you can audit it or build it yourself.

**My antivirus flags the app / yt-dlp / Deno.**
yt-dlp is a widely-used open-source downloader that some AV vendors
false-positive on. The binary is downloaded directly from yt-dlp's official
GitHub releases. Deno is an MIT-licensed JavaScript runtime downloaded from
the official `denoland/deno` GitHub releases. Goosic uses both only for an
explicit Premium playlist download, not ordinary playback.

**Will Google ban my account for using this?**
Ordinary audio comes from YouTube Music's official page in a dedicated native
WebView, including its normal ads and restrictions. Goosic does not promise
that Google will permit every account or region to use an unofficial client,
so the disclaimer still applies. Account cookies are never passed to yt-dlp,
Deno, or the PO-token provider used for explicit playlist downloads.

**Playback suddenly stopped working.**
Goosic retries a failed official WebPlayer once with a fresh playback WebView.
If it still fails, check that `music.youtube.com` plays in your region/account,
then restart Goosic and report the issue with the built-in diagnostics. Goosic
does not silently switch ordinary playback to yt-dlp.

**The AppImage won't run / complains about FUSE.**
Some distros no longer ship `libfuse2` by default, which older AppImages need
to mount themselves. Either install `libfuse2` (or `fuse`) from your distro's
package manager, or run the AppImage with `--appimage-extract-and-run`.

**No tray icon shows up on GNOME.**
Vanilla GNOME Shell doesn't show any application tray icons without an
AppIndicator/KStatusNotifierItem extension installed (this isn't
Goosic-specific — it affects every app that uses a tray icon on GNOME).

## Playback privacy

- Online playback loads `music.youtube.com` in a native WebView profile. Google
  and YouTube receive the page, account, playback, and advertising information
  their official web player normally receives.
- The remote YouTube page cannot invoke unrestricted Tauri commands. Goosic
  accepts only a small, secret, per-launch loopback playback-state bridge and
  does not log its secret, playback URLs, cookies, tokens, or request bodies.
- Signed-in WebView profiles and account cookies stay in Goosic's local app data.
  They are never supplied to yt-dlp, Deno, or the PO-token provider.
- Explicit playlist downloads are Premium-only. Legacy and invalid local files
  remain visible through migration; invalid files are marked as needing repair
  rather than silently removed.
- Each download action re-verifies live Premium status. Its managed yt-dlp
  process ignores user/system configuration and global plugins, so browser
  cookies cannot be injected by a local yt-dlp config.
- Offline audio is stored in durable application data by default; disposable
  cover art stays in the operating system cache. Goosic non-destructively
  imports finalized files from its legacy cache location.
- Discord Rich Presence and playback notifications remain opt-in.

## Stack

- **Shell:** Tauri 2 (Rust backend, system webview — WebView2 on Windows,
  WKWebView on macOS, WebKitGTK on Linux)
- **Playback:** persistent official YouTube Music WebPlayer; managed yt-dlp only
  for explicit Premium playlist downloads
- **Frontend:** React 19 + TypeScript
- **Build:** Vite 7
- **Styling:** Tailwind CSS v4
- **Components:** shadcn/ui (new-york style, neutral base, YouTube red accent)
- **Routing:** TanStack Router (file-based, type-safe, prefetch on intent)
- **Data:** TanStack Query
- **Client state:** Zustand
- **Icons:** lucide-react

## Dev

```bash
pnpm install
pnpm tauri dev
```

Frontend-only dev (no Tauri window): `pnpm dev`.

## Quality checks

```bash
pnpm test         # vitest unit tests (pure parsers/matchers)
pnpm lint         # eslint
pnpm format       # prettier --write
pnpm build        # tsc + vite production build
```

CI (`.github/workflows/ci.yml`) runs typecheck, lint, tests, build and
`cargo check` on every push / PR.

## Project layout

```
src/
├── routes/              # TanStack Router file-based routes
├── components/
│   ├── ui/              # shadcn primitives
│   ├── layout/          # AppShell, sidebar, topbar, player bar, floating player, lyrics
│   └── shared/          # Track list/rows, cards, shelves, context menus
├── lib/
│   ├── innertube/        # Raw InnerTube client + parsers
│   ├── lyrics/          # LRCLIB / Musixmatch / Genius sources + LRC parser
│   ├── store/           # Zustand stores
│   ├── audio-engine.ts  # Playback engine
│   ├── web-playback.ts  # Native official WebPlayer bridge
│   ├── stream.ts        # Validated cache-only local playback URLs
│   ├── offline-library.ts # Downloaded playlist/local-file mapping
│   └── utils.ts         # cn() and friends
└── hooks/
src-tauri/               # Rust backend (WebPlayer, offline proxy, cookies, tray)
```

## Credits

- [yt-dlp](https://github.com/yt-dlp/yt-dlp) — explicit offline playlist downloads
- [bgutil-ytdlp-pot-provider](https://github.com/Brainicism/bgutil-ytdlp-pot-provider) — PO tokens for explicit downloads
- [Deno](https://github.com/denoland/deno) — MIT-licensed challenge runtime for explicit downloads
- [LRCLIB](https://lrclib.net) — synced lyrics
- Musixmatch and Genius — lyrics sources
- [Tauri](https://tauri.app), [shadcn/ui](https://ui.shadcn.com),
  [TanStack](https://tanstack.com), and the rest of the stack above

## License

[GPL-3.0](LICENSE) — free to use, modify, and redistribute; derivative works
must stay open source under the same license.
