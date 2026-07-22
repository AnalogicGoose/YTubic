# GitHub release preparation plan

Date: 2026-07-05. Based on an audit of the current code (auth, stream-server, premium-gate, top-bar).

> **Historical document:** This records the original release audit and is not
> the current playback contract. The unreleased `v0.4.7` architecture replaces
> anonymous yt-dlp streaming, playback-time prefetch, and Premium-gated normal
> Play with a persistent official YouTube Music WebPlayer on Windows, macOS,
> and Linux. yt-dlp/Deno/PO tooling is now reserved for explicit Premium
> playlist downloads. See `CODEX_HANDOFF.md` and `README.md` for the current
> behavior and privacy boundary.

---

## Answers to the key questions

### 1. Risk of a ban / suspicious activity from Google

How it works today (and this is a good design):

- **API requests (browsing, search, library, likes)** go through InnerTube with the
  user's cookies + SAPISIDHASH — in form this is indistinguishable from the official
  web client (`clientName: WEB_REMIX`, same UA, same headers, visitorData echo). This is
  exactly what music.youtube.com itself does.
- **Audio streaming is NOT tied to the account**: yt-dlp is invoked anonymously, without
  cookies (a comment in `lib.rs` records this deliberately — Google actively throttles
  authenticated yt-dlp). This means the "downloading" activity cannot be attributed to
  the user's account → account-ban risk is minimal by design.

Realistic risks:

| Risk                                                               | Likelihood                                                                           | Consequence                                            |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------ | ------------------------------------------------------ |
| Google account ban for usage                                       | Very low — no known precedents with third-party players (ytmdesktop, FreeTube, etc.) | —                                                      |
| Streaming breakage (YouTube changes the protocol: PO tokens, SABR) | High, recurring                                                                      | Playability drops until a new yt-dlp version ships     |
| IP rate-limit / temporary 403s during active listening             | Low-medium                                                                           | Temporary playback errors                              |
| Formal YouTube ToS violation                                       | Yes, formally a violation (third-party client, ad bypass)                            | Risk to the project (DMCA/repo takedown), not to users |

Conclusions for the release:

- In the README and About — a disclaimer: _"Unofficial client. Not affiliated with Google/YouTube.
  Use at your own risk"_.
- **yt-dlp must be updatable** without rebuilding the app (see question 2) — this is the
  main safeguard against breakage.
- Don't add any "aggressive" activity (mass likes, scraping) — the current request
  profile mirrors an ordinary session.

### 2. Working on other users' machines / machine binding

Found **one hard binding — a release blocker**:

- `lib.rs` calls `Command::new("yt-dlp")` → yt-dlp is taken from **PATH**. Users don't
  have it → playback won't work at all.
  **Fix:** download `yt-dlp.exe` on first launch (+ a self-update command) into
  AppData, or bundle it as a Tauri sidecar. Recommendation — **download + auto-update
  yt-dlp** (official GitHub releases), because yt-dlp is fixed more often than we'll
  release, and a bundle in the installer goes stale instantly.
- ffmpeg is not required (we download a single audio format without conversion), but it
  must be verified on a clean VM.

What was checked and has NO binding:

- Cookies — only the user's own login (DPAPI encryption, AppData).
- visitorData / Musixmatch token — obtained at runtime, nothing hardcoded.
- No personal API keys in the code.

Other compatibility factors:

- **WebView2** — almost always present on Win10/11; in the bundle config enable
  `webviewInstallMode: downloadBootstrapper` just in case.
- **Windows only**: DPAPI, SMTC, windows-sys — no cross-platform support. Declare the
  first release honestly as Windows-only.
- **SmartScreen**: an unsigned installer will show "Windows protected your PC". Options:
  (a) release unsigned and document it (normal for OSS), (b) Azure Trusted
  Signing (~$10/mo), (c) an OV certificate (~$100+/yr). For the start — (a).
- Antivirus false-positives on yt-dlp are possible — document in the FAQ.

### 3. Login and plan detection

How it works:

1. **Login** (`start_login` in lib.rs): a separate WebView window opens with the real
   accounts.google.com page (a fresh profile per attempt); after a successful sign-in the
   cookies are taken from the webview, encrypted with DPAPI and stored in
   `accounts/<id>/cookies.enc`. The app never sees the password — login is entirely on
   Google's side. This is a safe scheme, no changes needed.
2. **Premium detection** (`fetchPremiumStatus`): a heuristic over `account/account_menu` —
   a "Get Premium" upsell → free; a "Manage membership" → premium; nothing recognized →
   fallback to premium + manual override in settings.

What is actually gated by plan (see `premium.ts`, stream-server):

- Premium → persistent on-disk track cache + prefetch.
- Free → ephemeral cache (wiped on every launch), no prefetch.

**An important honest caveat:** full parity with free YT Music's restrictions
(ads, background-play limits) is not present in the app and technically won't be — the
streams are anonymous, Google itself doesn't push ads into this channel. What we control
and already do right: a free user **does not accumulate an offline library** (that's the
Premium "downloads" feature). Before release:

- Run detection on a free account and a premium account, on en and ru locales.
- Make sure a new user without login has everything working in anonymous mode
  (home, search, playback) — this will be the most common first launch.

### 4. Connecting GitHub (step by step)

1. Pre-publish audit: `.gitignore` (dist, node_modules, target are already ignored —
   verify), the git history must contain no cookies/tokens (there are none — cookies live
   in AppData), remove personal references from `Cargo.toml` (`authors = ["you"]`).
2. **LICENSE** — a required file. Recommendation: MIT (the simplest) or GPL-3.0
   (if we want forks to stay open). Without a license file the code is formally
   "all rights reserved" and can't be forked/contributed to.
3. **Logo/name**: `yt-music-logo-png.png` and icons based on the YT Music logo are
   Google's trademark; for a public repo that's a direct cause for takedown.
   A custom icon is needed. The name `ytm-native` is acceptable (an abbreviation), but
   don't use "YouTube Music" in the product name.
4. Creating the repository (via github.com → New repository, or `gh repo create
ytm-native --public --source . --push`). Description, topics (tauri, youtube-music,
   desktop), screenshots in the README.
5. **GitHub Actions**: a `tauri-action` workflow — builds the NSIS installer on a
   `v*` tag, publishes a draft release with the artifacts. Updater signing secrets (see #5) —
   in repo secrets.
6. Issue templates (bug report / feature request), enable Discussions.

### 5. In-app auto-updates

The standard Tauri 2 path — **tauri-plugin-updater + GitHub Releases**:

1. Add `tauri-plugin-updater` (Rust) + `@tauri-apps/plugin-updater` (JS) and
   `tauri-plugin-process` (for relaunch).
2. Generate signing keys (`pnpm tauri signer generate`) — private in GitHub
   Secrets, public in `tauri.conf.json`.
3. In the config: `createUpdaterArtifacts: true`, endpoint —
   `https://github.com/<user>/ytm-native/releases/latest/download/latest.json`
   (tauri-action generates latest.json and .sig itself).
4. UI: bring the "Updates" item in the top-bar to life — check on startup (silent) + a
   manual check; a "version X available" toast → download with progress → "Restart to update".
5. User flow: the update arrives on its own, no need to visit GitHub. ✔
6. Test: build v0.1.0, install it, release v0.1.1, confirm it's picked up.

Separately: **yt-dlp auto-update** (not the app) — check the version every N days and
download the new binary from github.com/yt-dlp/yt-dlp/releases. This fixes streaming
without an app release.

### 6. About page

The "About" item is currently a disabled placeholder. Build a dialog or page with:

- Name, version (from `getVersion()`), GitHub link, license.
- Disclaimer: unofficial, not affiliated with Google/YouTube.
- **Credits / Powered by:**
  - yt-dlp (audio streaming) — Unlicense
  - LRCLIB (synced lyrics) — open API, they ask for attribution
  - Musixmatch (lyrics; unofficial API) — mention as a source
  - Genius (lyrics) — mention as a source
  - Tauri, React, shadcn/ui, TanStack, Zustand, lucide-react
- A "Check for updates" and "Report issue" button also fit here.
- Optionally: auto-generate the full OSS license list (`pnpm licenses list` /
  cargo-about) into a separate "Third-party licenses" screen.

### 7. Report Issue / feedback with voting

Currently a placeholder dialog (the form goes nowhere). Options:

| Option                          | Voting                     | Cost                                | Infrastructure |
| ------------------------------- | -------------------------- | ----------------------------------- | -------------- |
| **GitHub Issues + Discussions** | 👍 reactions, sort by them | 0                                   | none           |
| Canny (like Raycast-style apps) | yes, full-featured         | free tier very stingy, then $79+/mo | none           |
| Fider (self-hosted, OSS)        | yes                        | hosting ~$5/mo                      | own server     |
| Featurebase / Sleekplan / Nolt  | yes                        | free tier limited                   | none           |

**Recommendation for the start: GitHub Issues + Discussions.** Zero cost, users
vote 👍, the developer replies, everything lives next to the code. Rework the "Report Issue"
button: the form collects title/body + automatically fills in the app version,
OS, yt-dlp version → opens a pre-filled
`github.com/<user>/ytm-native/issues/new?title=...&body=...` in the browser. Requires no
backend and no OAuth. Downside — the reporter needs a GitHub account; if that becomes a
problem, add Fider/Canny later and just change the button's URL.

---

## Phased work plan

### Phase 0 — blockers (can't release without these)

- [x] yt-dlp: download on first launch into AppData + periodic auto-update;
      remove the PATH dependency — **done 2026-07-05**: module
      `src-tauri/src/ytdlp.rs` (managed copy in `<app-data>/bin/`, download from
      official GitHub releases, self-update `-U` every 72 h, PATH — dev-fallback only),
      frontend hook `src/lib/ytdlp.ts` (toasts + retry) in AppShell.
      Still to verify first launch on a clean VM (item below)
- [x] Custom icon + rebranding — **done 2026-07-05**: the app was renamed to
      **YTubic**, icon by Georgy (SVG in `assets/branding/`), the size set was
      generated with `pnpm tauri icon`, all YT Music logos removed from the repo
      (public/, root). Identifier → `com.github.ivasy.ytubic` (dev machine:
      the data folder changed, one re-login needed). The cookie ENTROPY string was
      deliberately left as the old one
- [x] LICENSE file — **GPL-3.0** (chosen 2026-07-05; text in /LICENSE, `license`
      set in package.json and Cargo.toml)
- [x] Disclaimer in README (+ license badge, Install/FAQ/Credits/License sections) —
      done 2026-07-05; `authors` in Cargo.toml — fixed
- [ ] Run on a clean Windows VM: install → first launch without login → login →
      playback (free and premium accounts)

### Phase 1 — GitHub

- [x] Public repository created and pushed — **https://github.com/AnalogicGoose/Goosic**
      (2026-07-05); Discussions enabled, topics added; gh CLI installed and
      authorized
- [ ] README: app screenshots (the rest — installation, FAQ — already done)
- [x] Issue templates (`.github/ISSUE_TEMPLATE/bug_report.yml`,
      `feature_request.yml`)
- [x] CI release: `.github/workflows/release.yml` (tauri-action, draft release on
      a `v*` tag); the `TAURI_SIGNING_PRIVATE_KEY` secret uploaded to the repo

### Phase 2 — updates

- [x] tauri-plugin-updater + tauri-plugin-process; keys: private —
      `C:\Users\ivasy\.tauri\ytubic.key` (**keep safe!**, copy in GitHub Secrets),
      public embedded in tauri.conf.json; endpoint —
      `AnalogicGoose/Goosic/releases/latest/download/latest.json`; targets → ["nsis"],
      createUpdaterArtifacts on
- [x] "Check for Updates" button + silent check on startup (src/lib/updater.ts):
      toasts, download progress, Restart now; disabled in dev mode
- [ ] Verify the v0.1.0 → v0.1.1 chain on a real install

### Phase 3 — About and Report Issue

- [x] About dialog (`src/components/layout/about-dialog.tsx`): version, credits
      (yt-dlp, LRCLIB, Musixmatch, Genius, Tauri, shadcn, TanStack), disclaimer,
      GPL link, GitHub / Check for updates buttons. The last "Soon" menu item
      was removed
- [x] Report Issue → pre-filled GitHub issue with diagnostics (version, OS) —
      opens `AnalogicGoose/Goosic/issues/new` via plugin-opener
- [ ] (opt.) Third-party licenses screen

### Phase 4 — v0.1.0 release

- [x] Tag v0.1.0 → release.yml built a **draft release** (2026-07-05, 8m55s):
      `YTubic_0.1.0_x64-setup.exe` + `.sig` + `latest.json` — the whole
      signing/updater pipeline works
- [ ] Verify the installer on a clean VM (first launch, yt-dlp download,
      login, playback) → **publish the release manually**
- [ ] After publishing v0.1.1 — verify the installed v0.1.0 offers an update
      on its own (latest.json resolves only for published releases)
- [ ] Post-release issue monitoring; a quick-patch plan in case yt-dlp breaks

### Phase 5 — Linux release

- [x] `secure_store` (2026-07-13): DPAPI split into a proper three-way cfg
      (Windows/Linux/other) in the new `src-tauri/src/secure_store.rs`.
      Linux gets real encryption, not the old plaintext fallback: a random
      AES-256 key lives in the OS keyring (`keyring` crate,
      `linux-native-sync-persistent` — secret-service backed by GNOME
      Keyring/KWallet, cached in kernel keyutils), and the cookie blob is
      AES-256-GCM encrypted with that key. A self-describing tag byte keeps
      the old plaintext behavior as a graceful fallback when no keyring
      backend is reachable (headless machines, some minimal WMs), instead
      of hard-failing login.
- [x] Packaging (2026-07-13): `src-tauri/tauri.linux.conf.json` adds
      `appimage`/`deb`/`rpm` bundle targets (Tauri auto-merges per-platform
      config files). No native Arch/AUR package — Arch is covered by the
      AppImage, which needs no install step. Verified locally: `.deb`
      builds, installs cleanly via `apt install`, resolves its
      webkit2gtk/appindicator3/gtk3 runtime deps, and its `.desktop`
      entry + hicolor icons (32/128/256/512) land correctly; the app binary
      itself only fails to launch for the expected reason (no GTK display
      in a headless sandbox).
- [x] CI/release (2026-07-13): `.github/workflows/release.yml` now has a
      `build-linux` job (`needs: build-windows`, sequential — not a
      parallel matrix — to avoid `tauri-action` creating two separate
      GitHub Releases for the same tag) that builds and publishes the
      Linux artifacts alongside the Windows ones. `ci.yml`'s Linux job
      gained `libdbus-1-dev` for the keyring's secret-service backend.
- [x] Also fixed while testing: the "glass" surfaces (dropdown/context
      menus, popover, player bar) relied on `backdrop-filter` staying
      near-invisible until blur softened whatever was behind them.
      WebKitGTK recognizes `backdrop-filter` in `@supports` but doesn't
      reliably paint it, so those surfaces read as barely-tinted glass with
      sharp content bleeding through on Linux. `src/lib/platform.ts` +
      `src/components/ui/glass-surface.ts` now detect the Linux webview at
      runtime and fall back to the opaque base look instead of the
      blur-dependent one.
- [ ] Manual QA pass on a real Linux desktop (not doable from this
      sandbox — no GUI): cookie login/keyring round-trip on GNOME and KDE
      (and the plaintext-fallback path when no secret-service provider is
      running), MPRIS media controls, tray icon (note the GNOME
      AppIndicator-extension caveat), autostart, single-instance, AppImage
      run (incl. distros without `libfuse2`), and the in-app updater
      against the AppImage build specifically.
- [ ] Dry-run the release workflow on a throwaway tag (e.g. `v0.0.0-test1`)
      to confirm `build-linux`'s artifacts land on the same Release the
      Windows job created, then delete the test tag/release.
- [ ] README/roadmap updates — done alongside the code (see README.md,
      docs/feature-roadmap.md)

### Deferred / post-release

- Code signing (Azure Trusted Signing) — once SmartScreen complaints appear
- Fider/Canny for feedback — if a GitHub account turns out to be a barrier
- macOS — will require its own Keychain-backed `secure_store` path (Linux is
  now done, see Phase 5 above)
- Arch/AUR native package (`PKGBUILD`) — optional, maintained separately
  outside the automated release; Arch users are covered by the AppImage
  in the meantime
