use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::Command as TokioCommand;
use tokio::sync::{Mutex, Notify, Semaphore};

use axum::{
    extract::{Path, Request, State as AxumState},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::get,
    Router,
};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
use tower::ServiceExt;
use tower_http::cors::CorsLayer;
use tower_http::services::ServeFile;

mod appid;
mod discord;
mod lastfm;
mod media;
#[cfg(target_os = "macos")]
mod native_glass;
mod pot_provider;
mod secure_store;
mod web_player;
mod ytdlp;

fn sanitize_video_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() < 32
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

fn validate_account_signin_url(raw: &str) -> Result<tauri::Url, String> {
    if raw.is_empty() || raw != raw.trim() || raw.chars().any(char::is_whitespace) {
        return Err("invalid account verification URL".into());
    }
    let url = raw
        .parse::<tauri::Url>()
        .map_err(|_| "invalid account verification URL".to_string())?;
    if url.scheme() != "https"
        || url.host_str() != Some("www.youtube.com")
        || url.port().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/signin"
        || url.fragment().is_some()
    {
        return Err("invalid account verification URL".into());
    }
    Ok(url)
}

fn validate_page_id(page_id: Option<&str>) -> bool {
    page_id.is_none_or(|value| {
        !value.is_empty()
            && value.len() <= 128
            && value
                .chars()
                .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-')
    })
}

/// Per-account metadata persisted in `accounts.json`. Cookies are NOT
/// stored here — they live encrypted under `accounts/<id>/cookies.enc`.
/// `name` / `email` / `photo_url` start empty for a freshly logged-in
/// account and get backfilled by the frontend once `/account_menu`
/// returns the active user's info (see `update_account_meta`).
#[derive(Clone, Debug, Default, serde::Serialize, serde::Deserialize)]
struct Account {
    id: String,
    #[serde(default)]
    email: String,
    #[serde(default)]
    name: String,
    #[serde(default, rename = "photoUrl")]
    photo_url: Option<String>,
    /// Brand-channel identity within this Google account. `None` means
    /// the personal (default) channel. Sent as `X-Goog-PageId` on
    /// InnerTube requests; library, likes and home are scoped to it.
    #[serde(default, rename = "pageId")]
    page_id: Option<String>,
    /// Display meta for the selected channel so the UI can show it
    /// without a network round-trip.
    #[serde(default, rename = "channelName")]
    channel_name: Option<String>,
    #[serde(default, rename = "channelPhotoUrl")]
    channel_photo_url: Option<String>,
    /// `Some(true)` means the official playback WebView was navigated through
    /// YouTube's server-issued identity URL and its DATASYNC_ID matched this
    /// row. `Some(false)` blocks playback after an interrupted/failed switch.
    /// Legacy personal-channel rows remain `None` and are accepted; legacy
    /// brand rows must be re-selected once before official playback.
    #[serde(default, rename = "webPlayerIdentityVerified")]
    web_player_identity_verified: Option<bool>,
    /// Unix seconds when this account was first added.
    #[serde(default, rename = "addedAt")]
    added_at: i64,
}

/// Root document of `accounts.json`. `active` is the id of the
/// currently-selected account or `None` when the user is signed out
/// of everything.
#[derive(Clone, Debug, Default, serde::Serialize, serde::Deserialize)]
struct AccountsIndex {
    #[serde(default)]
    active: Option<String>,
    #[serde(default)]
    accounts: Vec<Account>,
}

/// What we hand back to the frontend — augments [`Account`] with the
/// derived `isActive` flag so the UI doesn't have to cross-reference
/// against a second field.
#[derive(Clone, Debug, serde::Serialize)]
struct AccountSummary {
    id: String,
    email: String,
    name: String,
    #[serde(rename = "photoUrl")]
    photo_url: Option<String>,
    #[serde(rename = "pageId")]
    page_id: Option<String>,
    #[serde(rename = "channelName")]
    channel_name: Option<String>,
    #[serde(rename = "channelPhotoUrl")]
    channel_photo_url: Option<String>,
    #[serde(rename = "webPlayerIdentityVerified")]
    web_player_identity_verified: Option<bool>,
    #[serde(rename = "isActive")]
    is_active: bool,
}

fn accounts_dir(app: &tauri::AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir())
        .join("accounts")
}

fn accounts_index_path(app: &tauri::AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir())
        .join("accounts.json")
}

fn account_cookies_path(app: &tauri::AppHandle, id: &str) -> PathBuf {
    accounts_dir(app).join(id).join("cookies.enc")
}

/// Per-account persistent WebView2 profile. Unlike the throwaway login
/// profile of old, this survives a successful sign-in: it holds the
/// live, Google-bound browser session. A periodic hidden reload re-
/// extracts fresh cookies from it (see `refresh_account_cookies`) so the
/// snapshot we replay never outlives Google's ~2h leash on *extracted*
/// cookies. That leash is what made libraries silently empty mid-session.
fn account_webview_dir(app: &tauri::AppHandle, id: &str) -> PathBuf {
    accounts_dir(app).join(id).join("webview")
}

/// Stable 128-bit WKWebsiteDataStore identifier for a local account profile.
/// `data_directory` is ignored by WKWebView, while this API gives macOS 14+
/// the same account isolation that WebView2/WebKitGTK get from directories.
#[cfg(target_os = "macos")]
fn account_webview_store_identifier(id: &str) -> [u8; 16] {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(format!("goosic-webview-profile:{id}").as_bytes());
    let mut identifier = [0u8; 16];
    identifier.copy_from_slice(&digest[..16]);
    identifier
}

#[cfg(target_os = "macos")]
async fn remove_account_webview_store(app: &tauri::AppHandle, id: &str) {
    let identifier = account_webview_store_identifier(&format!("account:{id}"));
    if let Err(error) = app.remove_data_store(identifier).await {
        // Custom WKWebsiteDataStore removal is available on macOS 14+. Account
        // deletion must still succeed on older systems, where WebKit uses the
        // shared legacy store and exposes no per-identifier removal API.
        eprintln!("[accounts] could not remove a macOS WebView account store: {error}");
    }
}

#[cfg(not(target_os = "macos"))]
async fn remove_account_webview_store(_app: &tauri::AppHandle, _id: &str) {}

/// Safari UA for macOS WKWebView. Google's sign-in rejects the default
/// embedded-WebKit identity, while the native Safari identity is the same
/// supported pattern used by Kaset's macOS YouTube Music login.
#[cfg(target_os = "macos")]
const YT_LOGIN_UA: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) \
     AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";

/// Chrome UA the Windows WebView2 login and refresh WebViews present to
/// Google. Kept identical so the issued session can be refreshed later.
#[cfg(target_os = "windows")]
const YT_LOGIN_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
     (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36";

#[cfg(target_os = "linux")]
const YT_LOGIN_UA: &str = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 \
     (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36";

/// WebView2 browser args shared by the login window and the session-keeper.
/// Both open the same per-account profile directory, and WebView2 requires
/// every instance on a shared user-data folder to pass identical args, so
/// these have to match. They also stop both windows from grabbing the
/// hardware media keys or running a media session (which would hijack
/// play/pause from Goosic's own media integration). The same persisted profile
/// is reused by the hidden official player, so autoplay must be enabled.
const YT_WEBVIEW_ARGS: &str = "--disable-features=HardwareMediaKeyHandling,MediaSessionService \
     --autoplay-policy=no-user-gesture-required \
     --disable-background-timer-throttling \
     --disable-backgrounding-occluded-windows \
     --disable-renderer-backgrounding";

/// WebView2 browser args for windows on the DEFAULT user-data folder — the
/// main window and the floating player. Must stay byte-identical to
/// `additionalBrowserArgs` in `tauri.conf.json`: WebView2 refuses to create
/// a second webview on the same user-data folder with different args, so a
/// mismatch makes `open_player_window` fail and the floating player never
/// appears. (The first three disabled features are wry's own defaults,
/// which the conf.json value extends.)
const APP_WEBVIEW_ARGS: &str = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,HardwareMediaKeyHandling,MediaSessionService";

/// Legacy single-account path — kept only for migration. New code
/// should resolve cookies via `active_cookies_path`.
fn legacy_cookies_enc_path(app: &tauri::AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir())
        .join("cookies.enc")
}

async fn read_index(app: &tauri::AppHandle) -> AccountsIndex {
    let path = accounts_index_path(app);
    let Ok(bytes) = tokio::fs::read(&path).await else {
        return AccountsIndex::default();
    };
    serde_json::from_slice(&bytes).unwrap_or_default()
}

async fn write_index(app: &tauri::AppHandle, idx: &AccountsIndex) -> Result<(), String> {
    let path = accounts_index_path(app);
    if let Some(dir) = path.parent() {
        tokio::fs::create_dir_all(dir)
            .await
            .map_err(|e| format!("mkdir accounts dir: {e}"))?;
    }
    let bytes = serde_json::to_vec_pretty(idx).map_err(|e| format!("serialize: {e}"))?;
    tokio::fs::write(&path, bytes)
        .await
        .map_err(|e| format!("write index: {e}"))
}

/// Resolve the cookie jar path for the active account, or `None` when
/// nobody is signed in.
async fn active_cookies_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    let idx = read_index(app).await;
    let id = idx.active?;
    Some(account_cookies_path(app, &id))
}

/// One-time migration: if a plaintext `cookies.txt` from a previous
/// version exists, encrypt its contents into `cookies.enc` and remove
/// the original. Best-effort: logs on failure but never blocks startup.
async fn migrate_plaintext_cookies(app: &tauri::AppHandle) {
    let enc_path = legacy_cookies_enc_path(app);
    let old_path = enc_path.with_file_name("cookies.txt");
    if enc_path.exists() || !old_path.exists() {
        return;
    }
    let Ok(plain) = tokio::fs::read(&old_path).await else {
        return;
    };
    let result = tokio::task::spawn_blocking(move || secure_store::encrypt(&plain)).await;
    match result {
        Ok(Ok(enc)) => {
            if let Err(e) = tokio::fs::write(&enc_path, enc).await {
                eprintln!("[auth] migration write failed: {e}");
                return;
            }
            let _ = tokio::fs::remove_file(&old_path).await;
            eprintln!("[auth] migrated plaintext cookies.txt to encrypted cookies.enc");
        }
        Ok(Err(e)) => eprintln!("[auth] migration encrypt failed: {e}"),
        Err(e) => eprintln!("[auth] migration encrypt join failed: {e}"),
    }
}

/// Promote a legacy single-account `cookies.enc` to the new
/// `accounts/<id>/cookies.enc` layout. Runs after the plaintext
/// migration so a fresh install with no state at all hits a clean
/// no-op. Account meta (email / name / photo) is left empty — the
/// frontend backfills it on the first `/account_menu` round-trip.
async fn migrate_to_accounts_layout(app: &tauri::AppHandle) {
    let index_path = accounts_index_path(app);
    if index_path.exists() {
        return; // already migrated
    }
    let legacy = legacy_cookies_enc_path(app);
    if !legacy.exists() {
        // No legacy state and no new state — signed-out fresh install.
        return;
    }
    let new_id = generate_account_id();
    let new_path = account_cookies_path(app, &new_id);
    if let Some(dir) = new_path.parent() {
        if let Err(e) = tokio::fs::create_dir_all(dir).await {
            eprintln!("[auth] migrate accounts: mkdir failed: {e}");
            return;
        }
    }
    if let Err(e) = tokio::fs::rename(&legacy, &new_path).await {
        eprintln!("[auth] migrate accounts: rename failed: {e}");
        return;
    }
    let now_s = time::OffsetDateTime::now_utc().unix_timestamp();
    let idx = AccountsIndex {
        active: Some(new_id.clone()),
        accounts: vec![Account {
            id: new_id.clone(),
            added_at: now_s,
            ..Default::default()
        }],
    };
    if let Err(e) = write_index(app, &idx).await {
        eprintln!("[auth] migrate accounts: write index failed: {e}");
        return;
    }
    eprintln!("[auth] migrated legacy cookie storage into the accounts layout");
}

fn generate_account_id() -> String {
    let nanos = time::OffsetDateTime::now_utc().unix_timestamp_nanos();
    // Unix-nanos is monotone within a process; a stray clock skew on
    // another machine isn't a concern (account ids stay local).
    format!("acct-{:x}", nanos)
}

/// Read the encrypted cookie jar for the active account and decrypt
/// it in memory. Returns `None` when nobody is signed in or
/// decryption fails (treat as logged-out).
async fn read_cookies_plain(app: &tauri::AppHandle) -> Option<String> {
    let path = active_cookies_path(app).await?;
    read_cookies_plain_from_path(&path).await
}

async fn read_cookies_plain_from_path(path: &std::path::Path) -> Option<String> {
    let encrypted = tokio::fs::read(&path).await.ok()?;
    let plain = tokio::task::spawn_blocking(move || secure_store::decrypt(&encrypted))
        .await
        .ok()?
        .ok()?;
    String::from_utf8(plain).ok()
}

/// Serialize a list of cookies into the Netscape cookie-jar format that
/// yt-dlp and our reader expect. Only keeps cookies for google/youtube
/// domains — that's all the auth flow touches.
fn cookies_to_netscape(cookies: &[cookie::Cookie<'static>]) -> String {
    let mut out = String::from("# Netscape HTTP Cookie File\n");
    for c in cookies {
        let Some(domain) = c.domain() else { continue };
        let bare = domain.trim_start_matches('.');
        let allowed = bare == "youtube.com"
            || bare.ends_with(".youtube.com")
            || bare == "google.com"
            || bare.ends_with(".google.com");
        if !allowed {
            continue;
        }
        // Normalize: always emit with leading dot + subdomains=TRUE.
        // Auth cookies are all subdomain-inclusive by design, and modern
        // webviews expose domains inconsistently (with / without the
        // leading dot). Emitting `domain\tFALSE` for `.youtube.com`
        // would make parsers treat it as an exact-host cookie, which
        // would silently skip SAPISID for `music.youtube.com`.
        let dom_out = format!(".{bare}");
        let include_sub = "TRUE";
        let path_str = c.path().unwrap_or("/");
        let secure = if c.secure().unwrap_or(false) {
            "TRUE"
        } else {
            "FALSE"
        };
        let expiry = match c.expires() {
            Some(cookie::Expiration::DateTime(dt)) => dt.unix_timestamp(),
            _ => 0,
        };
        out.push_str(&format!(
            "{}\t{}\t{}\t{}\t{}\t{}\t{}\n",
            dom_out,
            include_sub,
            path_str,
            secure,
            expiry,
            c.name(),
            c.value()
        ));
    }
    out
}

/// One line of a Netscape jar, kept as stored so a rewrite preserves
/// entries we don't touch byte-for-byte.
struct JarEntry {
    domain: String,
    include_sub: String,
    path: String,
    secure: String,
    expiry: i64,
    name: String,
    value: String,
}

/// Apply `Set-Cookie` response headers to a Netscape jar, the way a
/// browser would: update the value/expiry of a cookie we already hold,
/// add cookies we don't, and drop cookies the server expires
/// (`Max-Age=0` / past `Expires`). Only google/youtube domains are
/// accepted — same filter as the login capture.
///
/// Returns `(new_jar, value_changed, needs_write)`:
/// `value_changed` — a cookie value was replaced, added or removed, so
/// cached Cookie headers are stale; `needs_write` additionally covers
/// attribute-only refreshes (expiry bumps) that should persist but
/// don't invalidate caches.
fn merge_set_cookies_into_jar(
    jar: &str,
    set_cookies: &[String],
    host: &str,
    now_ts: i64,
) -> (String, bool, bool) {
    let mut entries: Vec<JarEntry> = Vec::new();
    for line in jar.lines() {
        if line.starts_with('#') || line.trim().is_empty() {
            continue;
        }
        let f: Vec<&str> = line.split('\t').collect();
        if f.len() < 7 {
            continue;
        }
        entries.push(JarEntry {
            domain: f[0].to_string(),
            include_sub: f[1].to_string(),
            path: f[2].to_string(),
            secure: f[3].to_string(),
            expiry: f[4].parse().unwrap_or(0),
            name: f[5].to_string(),
            value: f[6].to_string(),
        });
    }

    let mut value_changed = false;
    let mut needs_write = false;

    for raw in set_cookies {
        let Ok(c) = cookie::Cookie::parse(raw.trim()) else {
            continue;
        };
        // Host-only cookies (no Domain attribute) belong to the
        // responding host.
        let bare = c
            .domain()
            .unwrap_or(host)
            .trim_start_matches('.')
            .to_ascii_lowercase();
        let allowed = bare == "youtube.com"
            || bare.ends_with(".youtube.com")
            || bare == "google.com"
            || bare.ends_with(".google.com");
        if !allowed {
            continue;
        }

        // Max-Age wins over Expires (RFC 6265 §4.1.2.2); either in the
        // past is a deletion.
        let (remove, expiry) = if let Some(ma) = c.max_age() {
            let secs = ma.whole_seconds();
            (secs <= 0, now_ts.saturating_add(secs))
        } else if let Some(cookie::Expiration::DateTime(dt)) = c.expires() {
            let ts = dt.unix_timestamp();
            (ts <= now_ts, ts)
        } else {
            (false, 0) // session cookie
        };

        let pos = entries
            .iter()
            .position(|e| e.name == c.name() && e.domain.trim_start_matches('.') == bare);

        if remove {
            if let Some(i) = pos {
                entries.remove(i);
                value_changed = true;
            }
            continue;
        }

        match pos {
            Some(i) => {
                let e = &mut entries[i];
                if e.value != c.value() {
                    e.value = c.value().to_string();
                    value_changed = true;
                }
                if e.expiry != expiry {
                    e.expiry = expiry;
                    needs_write = true;
                }
            }
            None => {
                entries.push(JarEntry {
                    domain: format!(".{bare}"),
                    include_sub: "TRUE".to_string(),
                    path: c.path().unwrap_or("/").to_string(),
                    secure: if c.secure().unwrap_or(false) {
                        "TRUE"
                    } else {
                        "FALSE"
                    }
                    .to_string(),
                    expiry,
                    name: c.name().to_string(),
                    value: c.value().to_string(),
                });
                value_changed = true;
            }
        }
    }

    needs_write |= value_changed;
    let mut out = String::from("# Netscape HTTP Cookie File\n");
    for e in &entries {
        out.push_str(&format!(
            "{}\t{}\t{}\t{}\t{}\t{}\t{}\n",
            e.domain, e.include_sub, e.path, e.secure, e.expiry, e.name, e.value
        ));
    }
    (out, value_changed, needs_write)
}

/// Stable "same account" key derived from an account's backfilled meta.
/// Prefers the email; when that's empty (brand-channel identities, and
/// some accounts, omit it from `/account_menu`) it falls back to the
/// avatar URL, whose `yt3.ggpht.com/-<token>` base is stable per
/// account. Returns `None` when neither is known, so two accounts we
/// can't tell apart are never merged.
///
/// Cookie values can't serve as the key: every login runs in an
/// isolated WebView profile, so Google mints a fresh SAPISID/SID
/// session each time and the same account lands a different value on
/// each add.
fn meta_identity(email: &str, photo_url: Option<&str>) -> Option<String> {
    let email = email.trim();
    if !email.is_empty() {
        return Some(format!("email:{}", email.to_ascii_lowercase()));
    }
    if let Some(p) = photo_url {
        // Drop the "=s108-c-k-..." sizing suffix so the same avatar at
        // different requested sizes still compares equal.
        let base = p.split('=').next().unwrap_or(p).trim();
        if !base.is_empty() {
            return Some(format!("photo:{base}"));
        }
    }
    None
}

/// Collapse duplicate account rows that are the same Google account.
/// Re-adding an account you already have (or a stale/expired re-login)
/// used to append a fresh row that never merged, because dedup keyed on
/// an email that `/account_menu` often leaves empty. This heals that
/// state from the stored meta: within each set of rows sharing an
/// identity (see `meta_identity`) it keeps the earliest-added one
/// (stable id, so pinned-playlist buckets survive), copies the freshest
/// cookies into it, and drops the rest off disk. A row we can't identify
/// (no email, no avatar) is left untouched rather than risk merging two
/// real accounts.
///
/// Does not emit `accounts-changed`: callers either run it before the
/// UI reads the list (startup) or emit the event themselves.
async fn dedup_accounts_by_identity(app: &tauri::AppHandle) {
    let mut idx = read_index(app).await;
    if idx.accounts.len() < 2 {
        return;
    }

    // Identity per row from its stored meta, same order as idx.accounts.
    let identities: Vec<Option<String>> = idx
        .accounts
        .iter()
        .map(|a| meta_identity(&a.email, a.photo_url.as_deref()))
        .collect();

    // Group row indices by identity.
    let mut groups: std::collections::HashMap<String, Vec<usize>> =
        std::collections::HashMap::new();
    for (i, ident) in identities.iter().enumerate() {
        if let Some(key) = ident {
            groups.entry(key.clone()).or_default().push(i);
        }
    }

    // removed id -> keeper id, so `active` can follow its keeper.
    let mut remap: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    // (source id, keeper id) jars to copy before deleting the source.
    let mut fresh_copies: Vec<(String, String)> = Vec::new();

    for members in groups.values() {
        if members.len() < 2 {
            continue;
        }
        // Keep the earliest-added row: its id is the one pins are keyed
        // to, and it's the account the user has had the longest.
        let keeper = *members
            .iter()
            .min_by_key(|&&i| idx.accounts[i].added_at)
            .unwrap();
        let keeper_id = idx.accounts[keeper].id.clone();

        // Freshest cookies: the jar written most recently. After a
        // re-login that's the keeper itself (login-time dedup refreshed
        // it in place, so no copy happens); when healing a pile of
        // legacy dups it's whichever login was most recent, the one
        // most likely to still authenticate. Falls back to the keeper
        // if no jar's mtime can be read.
        let mut freshest = keeper;
        let mut best_mtime: Option<std::time::SystemTime> = None;
        for &i in members {
            let p = account_cookies_path(app, &idx.accounts[i].id);
            let mtime = tokio::fs::metadata(&p)
                .await
                .ok()
                .and_then(|m| m.modified().ok());
            if let Some(t) = mtime {
                if best_mtime.map_or(true, |b| t > b) {
                    best_mtime = Some(t);
                    freshest = i;
                }
            }
        }
        let fresh_id = idx.accounts[freshest].id.clone();
        if fresh_id != keeper_id {
            fresh_copies.push((fresh_id, keeper_id.clone()));
        }

        for &i in members {
            if i != keeper {
                remap.insert(idx.accounts[i].id.clone(), keeper_id.clone());
            }
        }
    }

    if remap.is_empty() {
        return;
    }

    for (from_id, keeper_id) in &fresh_copies {
        let from_path = account_cookies_path(app, from_id);
        let keep_path = account_cookies_path(app, keeper_id);
        if let Ok(bytes) = tokio::fs::read(&from_path).await {
            let _ = tokio::fs::write(&keep_path, bytes).await;
        }
    }

    if let Some(active) = idx.active.clone() {
        if let Some(keeper) = remap.get(&active) {
            idx.active = Some(keeper.clone());
        }
    }

    idx.accounts.retain(|a| !remap.contains_key(&a.id));

    // Persist the collapsed index BEFORE deleting the losers' jars. If
    // the app dies in between, an orphan dir is invisible litter; the
    // reverse order could leave the index pointing at deleted jars and
    // boot the app signed out.
    let removed = remap.len();
    if let Err(e) = write_index(app, &idx).await {
        eprintln!("[accounts] dedup write index: {e}");
        return;
    }
    for rid in remap.keys() {
        let _ = tokio::fs::remove_dir_all(accounts_dir(app).join(rid)).await;
    }
    eprintln!("[accounts] collapsed {removed} duplicate account row(s) by identity");
}

/// Best-effort cleanup of transient login artifacts, run once per boot:
///
/// - leftover per-login WebView profiles under `login-sessions/`. The
///   post-login `remove_dir_all` regularly loses to WebView2 file locks
///   (the browser subprocess outlives the window for a beat), and each
///   stranded profile holds a signed-in Google session on disk. At boot
///   no login window exists, so the locks are gone and deletion sticks.
/// - the http plugin's `.cookies` store from builds where its `cookies`
///   feature was still on: plaintext session-security cookies, and the
///   shadow copy that fed the rotation-divergence bug.
async fn cleanup_login_artifacts(app: &tauri::AppHandle) {
    let cache = app
        .path()
        .app_cache_dir()
        .unwrap_or_else(|_| std::env::temp_dir());
    if let Ok(mut sessions) = tokio::fs::read_dir(cache.join("login-sessions")).await {
        while let Ok(Some(entry)) = sessions.next_entry().await {
            let _ = tokio::fs::remove_dir_all(entry.path()).await;
        }
    }
    let _ = tokio::fs::remove_file(cache.join(".cookies")).await;
}

/// Open an in-app Google sign-in window in an isolated WebView profile
/// and add the resulting cookies as a new account. Polls the (fresh)
/// webview cookie store until YouTube auth cookies appear, encrypts
/// them, writes them to `accounts/<id>/cookies.enc`, registers the
/// account in `accounts.json`, and marks it active.
///
/// Isolation matters: without it, "add another account" instantly
/// succeeds with whatever Google session is already in the shared
/// WebView2 user data dir — and there's no way for the user to pick a
/// different identity. The temp profile is deleted on close (success
/// or cancellation); our DPAPI-encrypted jar is the canonical store.
///
/// Emits `login-success` (payload: new account id) on success and
/// `login-cancelled` on close-without-auth.
///
/// We deliberately do NOT emit `accounts-changed` here. The newly-
/// added account has empty meta and may not even survive the next
/// step: the frontend's meta backfill calls `update_account_meta`,
/// which is when we find out via an identity lookup (email, or avatar
/// when the email is empty) whether this is genuinely a new account or
/// a re-sign-in of an existing one. That
/// command emits `accounts-changed` for both cases, and the global
/// listener does its full reset there. Firing the event twice was the
/// "double-reset on dedup" UX bug.
#[tauri::command]
async fn start_login(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(existing) = app.get_webview_window("login") {
        let _ = existing.show();
        let _ = existing.set_focus();
        return Ok(());
    }

    // Per-attempt account id, minted up front so the WebView profile can
    // live at its permanent home from the first keystroke. Still fresh
    // per attempt (a unique id), so Google's auth cookies are empty at
    // window open and "add account" starts from a clean sign-in, so
    // identity isolation is preserved. Unlike the old throwaway temp
    // profile, we KEEP this one after a successful login: it holds the
    // live, Google-bound session that `refresh_account_cookies` re-
    // extracts from periodically, so the replayed snapshot never outlives
    // Google's ~2h leash on extracted cookies.
    let account_id = generate_account_id();
    let webview_data = account_webview_dir(&app, &account_id);
    if let Err(e) = tokio::fs::create_dir_all(&webview_data).await {
        eprintln!("[login] mkdir webview-data: {e}");
    }
    // Wiped wholesale on cancel/error (profile + any partial jar); kept
    // on success.
    let account_dir = accounts_dir(&app).join(&account_id);

    #[cfg(target_os = "macos")]
    let login_url = "https://accounts.google.com/ServiceLogin?service=youtube&uilel=3&passive=true&continue=https%3A%2F%2Fwww.youtube.com%2Fsignin%3Faction_handle_signin%3Dtrue%26app%3Ddesktop%26hl%3Den%26next%3Dhttps%253A%252F%252Fmusic.youtube.com%252F";
    #[cfg(not(target_os = "macos"))]
    let login_url = "https://accounts.google.com/ServiceLogin?service=youtube&continue=https%3A%2F%2Fmusic.youtube.com%2F";

    let url = login_url.parse::<tauri::Url>().map_err(|e| e.to_string())?;

    let builder = WebviewWindowBuilder::new(&app, "login", WebviewUrl::External(url))
        .title("Sign in - accounts.google.com")
        .inner_size(500.0, 720.0)
        .min_inner_size(420.0, 560.0)
        .center()
        .data_directory(webview_data.clone())
        .user_agent(YT_LOGIN_UA)
        // Must match the session-keeper's args (shared profile folder).
        .additional_browser_args(YT_WEBVIEW_ARGS)
        // Surface the current origin in the title so the user can spot
        // a redirect to an unexpected host (anti-phishing).
        .on_page_load(|win, payload| {
            let host = payload.url().host_str().unwrap_or("???");
            let _ = win.set_title(&format!("Sign in - {host}"));
        });
    #[cfg(target_os = "macos")]
    let builder = builder.data_store_identifier(account_webview_store_identifier(&format!(
        "account:{account_id}"
    )));
    let win = builder.build().map_err(|e| e.to_string())?;

    let app_poll = app.clone();
    // Failure paths wipe the whole account dir (profile + jar); on
    // success we keep it so the live session can be refreshed later.
    let cleanup_dir = account_dir.clone();
    tauri::async_runtime::spawn(async move {
        // Set to true once we've redirected the webview to YT ourselves.
        // Guards against thrashing if YT auto-sign-in is slow and we
        // catch a Google-auth-only state on multiple ticks.
        let mut nudged_to_yt = false;
        // Ticks spent waiting for the handshake to finish after auth
        // cookies first appear (see below).
        let mut full_set_grace: u8 = 0;
        loop {
            tokio::time::sleep(Duration::from_millis(1500)).await;

            let Some(win) = app_poll.get_webview_window("login") else {
                let _ = app_poll.emit("login-cancelled", ());
                let _ = tokio::fs::remove_dir_all(&cleanup_dir).await;
                return;
            };

            let cookies = match win.cookies() {
                Ok(c) => c,
                Err(e) => {
                    eprintln!("[login] cookies error: {e}");
                    continue;
                }
            };

            let has_yt_auth = cookies.iter().any(|c| {
                let name = c.name();
                (name == "__Secure-1PSID" || name == "SAPISID")
                    && c.domain()
                        .map(|d| d.trim_start_matches('.').ends_with("youtube.com"))
                        .unwrap_or(false)
            });

            if !has_yt_auth {
                // YT cookies aren't set yet. Two ways to land here:
                //   1) User hasn't completed Google sign-in. Keep waiting.
                //   2) Google sign-in succeeded but Google parked the
                //      webview on `myaccount.google.com` (first-time
                //      security review / "stay signed in?" prompt) and
                //      never honored the `continue=music.youtube.com`
                //      hint. The user is stuck on a Google settings
                //      page and YT never gets a chance to handshake.
                //
                // For case (2), force-navigate to music.youtube.com.
                // YT's auto-sign-in flow picks up the .google.com
                // session cookies and exchanges them for .youtube.com
                // cookies that InnerTube actually needs.
                if !nudged_to_yt {
                    let has_google_auth = cookies.iter().any(|c| {
                        let name = c.name();
                        (name == "SAPISID" || name == "SID" || name == "__Secure-1PSID")
                            && c.domain()
                                .map(|d| d.trim_start_matches('.').ends_with("google.com"))
                                .unwrap_or(false)
                    });
                    if has_google_auth {
                        if let Ok(url) = "https://music.youtube.com/".parse::<tauri::Url>() {
                            match win.navigate(url) {
                                Ok(()) => eprintln!(
                                    "[login] google-auth detected without YT cookies; redirected webview to music.youtube.com"
                                ),
                                Err(e) => eprintln!(
                                    "[login] failed to redirect to YT: {e}"
                                ),
                            }
                        }
                        nudged_to_yt = true;
                    }
                }
                continue;
            }

            // SAPISID shows up before YouTube finishes its handshake;
            // capturing at first sight used to miss LOGIN_INFO /
            // VISITOR_INFO1_LIVE / YSC. Those make our replayed traffic
            // look like the browser session Google issued it to, so
            // give the handshake a few ticks to complete. Capture
            // anyway after ~6 s in case the cookie set changes shape.
            let has_login_info = cookies.iter().any(|c| {
                c.name() == "LOGIN_INFO"
                    && c.domain()
                        .map(|d| d.trim_start_matches('.').ends_with("youtube.com"))
                        .unwrap_or(false)
            });
            if !has_login_info && full_set_grace < 4 {
                full_set_grace += 1;
                continue;
            }

            // Same id as the persisted WebView profile created above, so
            // the account row and its live session profile stay paired.
            let new_id = account_id.clone();
            let cookies_path = account_cookies_path(&app_poll, &new_id);
            if let Some(dir) = cookies_path.parent() {
                let _ = tokio::fs::create_dir_all(dir).await;
            }
            let plain = cookies_to_netscape(&cookies).into_bytes();
            let encrypted =
                match tokio::task::spawn_blocking(move || secure_store::encrypt(&plain)).await {
                    Ok(Ok(e)) => e,
                    Ok(Err(e)) => {
                        eprintln!("[login] encrypt cookies: {e}");
                        let _ = win.close();
                        let _ = tokio::fs::remove_dir_all(&cleanup_dir).await;
                        return;
                    }
                    Err(e) => {
                        eprintln!("[login] encrypt join: {e}");
                        let _ = win.close();
                        let _ = tokio::fs::remove_dir_all(&cleanup_dir).await;
                        return;
                    }
                };
            if let Err(e) = tokio::fs::write(&cookies_path, &encrypted).await {
                eprintln!("[login] write account cookies: {e}");
                let _ = win.close();
                let _ = tokio::fs::remove_dir_all(&cleanup_dir).await;
                return;
            }

            let account_session = app_poll.state::<AccountSessionGuard>();
            let session_lock = account_session.inner().mutation.lock().await;
            let refresh_guard = app_poll.state::<RefreshGuard>();
            let _profile_lock = refresh_guard.inner().0.lock().await;
            let mut idx = read_index(&app_poll).await;
            // Switching the active browser profile is an isolation boundary.
            // Close any guest/previous-account playback owner before the new
            // account becomes visible to commands that read `idx.active`.
            let player = app_poll.state::<web_player::WebPlayerState>();
            if let Err(error) = web_player::reset(&app_poll, player.inner()).await {
                eprintln!("[login] could not stop previous playback profile: {error}");
                let _ = app_poll.emit("login-cancelled", ());
                let _ = win.close();
                let _ = tokio::fs::remove_dir_all(&cleanup_dir).await;
                remove_account_webview_store(&app_poll, &new_id).await;
                return;
            }
            let now_s = time::OffsetDateTime::now_utc().unix_timestamp();
            idx.accounts.push(Account {
                id: new_id.clone(),
                added_at: now_s,
                ..Default::default()
            });
            idx.active = Some(new_id.clone());
            if let Err(e) = write_index(&app_poll, &idx).await {
                // We've already written the cookies file; not fatal but
                // visible to the user as "account didn't appear in
                // list". Surface it through the cancel event so the
                // frontend at least flips out of the spinning state.
                eprintln!("[login] write index: {e}");
                let _ = app_poll.emit("login-cancelled", ());
                let _ = tokio::fs::remove_dir_all(
                    &account_cookies_path(&app_poll, &new_id)
                        .parent()
                        .map(|p| p.to_path_buf())
                        .unwrap_or_default(),
                )
                .await;
                let _ = win.close();
                let _ = tokio::fs::remove_dir_all(&cleanup_dir).await;
                return;
            }
            account_session.inner().advance();
            drop(session_lock);

            // `login-success` is the soft signal: the frontend invalidates
            // its auth queries so the meta backfill runs with the new
            // cookies. The follow-up `update_account_meta` call is where
            // dedup happens (by identity, email or avatar) and where
            // `accounts-changed` fires, so we never run the full reset
            // twice for one login flow.
            let _ = app_poll.emit("login-success", &new_id);
            let _ = win.close();
            // Keep the WebView profile: it's the live session the periodic
            // refresh re-extracts from. Only cancel/error paths above (and
            // account removal) delete it.
            return;
        }
    });

    let _ = win;
    Ok(())
}

/// The live "session-keeper" WebView for `id`: a hidden window on
/// music.youtube.com that reuses the account's persisted profile. As a
/// real browser engine it stays authenticated from the stored session and
/// keeps the server-side session (and its rotating cookies) warm, which
/// plain HTTP replay cannot do. Built ONCE and reused; any keeper left
/// over from a previously-active account is closed first, so at most one
/// runs at a time. Returns (window, just_created).
async fn ensure_session_keeper(
    app: &tauri::AppHandle,
    id: &str,
) -> Result<(tauri::WebviewWindow, bool), String> {
    if !account_webview_dir(app, id).exists() {
        return Err(format!("no persisted profile for {id}"));
    }
    let label = format!("keeper-{id}");
    // Close a stale keeper left over from a previously-active account, so
    // at most one keeper (the active account's) ever runs.
    for (l, w) in app.webview_windows() {
        if l.starts_with("keeper-") && l != label {
            let _ = w.close();
        }
    }
    if let Some(win) = app.get_webview_window(&label) {
        return Ok((win, false));
    }
    let url = "https://music.youtube.com/"
        .parse::<tauri::Url>()
        .map_err(|e| e.to_string())?;
    // Hidden, undecorated, focus-less, off-screen, no taskbar entry. Built
    // once and reused (not re-created every cycle), so there is no recurring
    // window creation to flash on screen; the window-state plugin is told to
    // never restore keeper windows (see `with_filter` in `run`), so a saved
    // "visible" state can't drag it back on-screen next launch either. The
    // webview still loads and keeps the session alive regardless of
    // visibility or position.
    let builder = WebviewWindowBuilder::new(app, &label, WebviewUrl::External(url))
        .title("Goosic session keeper")
        .visible(false)
        .decorations(false)
        .focused(false)
        .skip_taskbar(true)
        .position(-32000.0, -32000.0)
        .inner_size(1024.0, 768.0)
        .data_directory(account_webview_dir(app, id))
        .user_agent(YT_LOGIN_UA)
        .additional_browser_args(YT_WEBVIEW_ARGS);
    #[cfg(target_os = "macos")]
    let builder =
        builder.data_store_identifier(account_webview_store_identifier(&format!("account:{id}")));
    let win = builder
        .build()
        .map_err(|e| format!("build session-keeper: {e}"))?;
    // Force-hide on top of visible(false): if WebView2 shows the host window
    // when the external page finishes loading, this puts it straight back to
    // hidden so the user never sees a stray music.youtube.com window.
    let _ = win.hide();
    set_hidden_webview_low_memory(&win);
    Ok((win, true))
}

/// Ask WebView2 to discard non-essential renderer caches for the hidden
/// authenticated session keeper. This is a supported memory-pressure hint,
/// not suspension: navigation, JavaScript, networking, and cookie refreshes
/// continue normally. Older WebView2 runtimes simply reject the newer COM
/// interface and retain their default behavior.
#[cfg(windows)]
fn set_hidden_webview_low_memory(win: &tauri::WebviewWindow) {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2_19, COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW,
    };
    use windows_core::Interface;

    let _ = win.with_webview(|platform_webview| {
        let result = (|| -> windows_core::Result<()> {
            let controller = platform_webview.controller();
            let webview = unsafe { controller.CoreWebView2()? };
            let webview_19 = webview.cast::<ICoreWebView2_19>()?;
            unsafe {
                webview_19.SetMemoryUsageTargetLevel(COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW)?;
            }
            Ok(())
        })();
        if let Err(error) = result {
            eprintln!("[accounts] WebView2 low-memory hint unavailable: {error}");
        }
    });
}

#[cfg(not(windows))]
fn set_hidden_webview_low_memory(_win: &tauri::WebviewWindow) {}

/// Refresh the replayed cookie snapshot for `id` from its live session-
/// keeper WebView. Reloads the keeper to force fresh authenticated
/// requests (which renews the session and rotates its short-lived
/// cookies), reads the full cookie set, and overwrites `cookies.enc`. The
/// keeper window is left OPEN for next time.
///
/// This is what survives Google's ~2h leash on *extracted* cookies: the
/// bound browser session behind the keeper stays live, so the snapshot we
/// replay never goes stale. Errors (leaving the existing snapshot
/// untouched) when the account has no persisted profile or its session is
/// logged out, so we never clobber a usable jar with an empty one.
async fn refresh_account_cookies(app: &tauri::AppHandle, id: &str) -> Result<(), String> {
    // Serialize refreshes so the periodic timer and a manual trigger can't
    // reload the keeper / rewrite the jar on top of each other.
    let guard = app.state::<RefreshGuard>();
    let _lock = guard.inner().0.lock().await;

    // Active playback already keeps the same browser profile warm. Reuse it
    // only when it belongs to this exact account.
    let player_state = app.state::<web_player::WebPlayerState>();
    let player_matches =
        web_player::uses_profile(player_state.inner(), &format!("account:{id}")).await;
    let (win, created, is_player) = if player_matches {
        let player = app
            .get_webview_window("youtube-player")
            .ok_or_else(|| "matching playback profile disappeared".to_string())?;
        (player, false, true)
    } else {
        let (keeper, created) = ensure_session_keeper(app, id).await?;
        (keeper, created, false)
    };
    // A reused keeper is reloaded to force fresh authenticated traffic; a
    // just-created one is already loading the URL from the builder.
    if !created && !is_player {
        if let Ok(u) = "https://music.youtube.com/".parse::<tauri::Url>() {
            let _ = win.navigate(u);
        }
    }

    // Poll the keeper's cookie store until the full authed set is present
    // (LOGIN_INFO lands last, as at login), then snapshot it. The keeper
    // window stays open for the next cycle.
    let mut captured: Option<Vec<u8>> = None;
    for tick in 0..12u8 {
        tokio::time::sleep(Duration::from_millis(1500)).await;
        let Ok(cookies) = win.cookies() else { continue };
        let has_yt_auth = cookies.iter().any(|c| {
            let n = c.name();
            (n == "__Secure-1PSID" || n == "SAPISID")
                && c.domain()
                    .map(|d| d.trim_start_matches('.').ends_with("youtube.com"))
                    .unwrap_or(false)
        });
        if !has_yt_auth {
            continue;
        }
        let has_login_info = cookies.iter().any(|c| {
            c.name() == "LOGIN_INFO"
                && c.domain()
                    .map(|d| d.trim_start_matches('.').ends_with("youtube.com"))
                    .unwrap_or(false)
        });
        // Give the handshake a few ticks to complete, then take what we
        // have so a missing LOGIN_INFO can't stall the refresh forever.
        if !has_login_info && tick < 4 {
            continue;
        }
        captured = Some(cookies_to_netscape(&cookies).into_bytes());
        break;
    }
    let Some(plain) = captured else {
        return Err("no auth cookies after reload (profile logged out?)".into());
    };
    let encrypted = tokio::task::spawn_blocking(move || secure_store::encrypt(&plain))
        .await
        .map_err(|e| format!("encrypt join: {e}"))?
        .map_err(|e| format!("encrypt: {e}"))?;
    let path = account_cookies_path(app, id);
    if let Some(dir) = path.parent() {
        let _ = tokio::fs::create_dir_all(dir).await;
    }
    tokio::fs::write(&path, encrypted)
        .await
        .map_err(|e| format!("write refreshed cookies: {e}"))?;
    Ok(())
}

/// Force an immediate snapshot refresh for the active account. Exposed
/// for the UI (and manual testing) so a session can be renewed on demand
/// instead of only when the periodic timer fires. Returns `false` when
/// nobody is signed in.
#[tauri::command]
async fn refresh_active_session(
    app: tauri::AppHandle,
    session: tauri::State<'_, AccountSessionGuard>,
) -> Result<bool, String> {
    let active = {
        let _session = session.mutation.lock().await;
        read_index(&app).await.active
    };
    let Some(active) = active else {
        return Ok(false);
    };
    match refresh_account_cookies(&app, &active).await {
        Ok(()) => Ok(true),
        Err(e) => {
            eprintln!("[refresh] active account refresh failed: {e}");
            Err(e)
        }
    }
}

/// Parse a Netscape cookie jar and return a `Cookie:` header value
/// containing all cookies that match the given domain (honoring the
/// `include_subdomains` flag). Empty string if no jar or no matches.
async fn read_cookie_header(app: &tauri::AppHandle, host: &str) -> String {
    let Some(content) = read_cookies_plain(app).await else {
        return String::new();
    };
    cookie_header_from_jar(&content, host)
}

async fn read_cookie_header_from_path(path: &std::path::Path, host: &str) -> String {
    let Some(content) = read_cookies_plain_from_path(path).await else {
        return String::new();
    };
    cookie_header_from_jar(&content, host)
}

fn cookie_header_from_jar(content: &str, host: &str) -> String {
    let mut parts: Vec<String> = Vec::new();
    for line in content.lines() {
        if line.starts_with('#') || line.trim().is_empty() {
            continue;
        }
        // domain \t include_subdomains \t path \t secure \t expiry \t name \t value
        let fields: Vec<&str> = line.split('\t').collect();
        if fields.len() < 7 {
            continue;
        }
        let domain = fields[0].trim_start_matches('.');
        let include_sub = fields[1] == "TRUE";
        let matches = host == domain || (include_sub && host.ends_with(&format!(".{domain}")));
        if !matches {
            continue;
        }
        parts.push(format!("{}={}", fields[5], fields[6]));
    }
    parts.join("; ")
}

#[tauri::command]
async fn get_cookie_header(
    app: tauri::AppHandle,
    session: tauri::State<'_, AccountSessionGuard>,
    host: String,
) -> Result<String, String> {
    let _session = session.mutation.lock().await;
    Ok(read_cookie_header(&app, &host).await)
}

#[tauri::command]
async fn is_logged_in(
    app: tauri::AppHandle,
    session: tauri::State<'_, AccountSessionGuard>,
) -> Result<bool, String> {
    let _session = session.mutation.lock().await;
    let header = read_cookie_header(&app, "music.youtube.com").await;
    Ok(header.contains("SAPISID") || header.contains("__Secure-1PSID"))
}

/// Hard-exit the process. The window's close button hides into the tray
/// by default (see `WindowEvent::CloseRequested` below); this command is
/// the frontend's equivalent of the tray's Quit menu item.
#[tauri::command]
fn quit_app(app: tauri::AppHandle) {
    app.exit(0);
}

/// What the title-bar ✕ does, mirrored from the frontend settings store
/// (`useCloseBehaviorSync`). Lives in Rust rather than only in
/// localStorage because the decision point is the `CloseRequested`
/// window event, which must also cover Alt+F4 and the taskbar's Close.
/// Defaults to hide-to-tray until the frontend pushes a value shortly
/// after the webview boots.
#[derive(Default)]
struct CloseBehavior {
    quit_on_close: AtomicBool,
}

#[tauri::command]
fn set_close_behavior(state: tauri::State<'_, CloseBehavior>, quit_on_close: bool) {
    state.quit_on_close.store(quit_on_close, Ordering::Relaxed);
}

/// Register / unregister the app for launch at OS startup. Uses the
/// autostart plugin's Rust API from our own command so the frontend
/// needs no extra capability grants.
#[tauri::command]
fn autostart_set(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    use tauri_plugin_autostart::ManagerExt;
    let autolaunch = app.autolaunch();
    let currently = autolaunch.is_enabled().unwrap_or(false);
    if enabled == currently {
        return Ok(());
    }
    if enabled {
        autolaunch.enable().map_err(|e| e.to_string())
    } else {
        autolaunch.disable().map_err(|e| e.to_string())
    }
}

#[tauri::command]
fn autostart_is_enabled(app: tauri::AppHandle) -> Result<bool, String> {
    use tauri_plugin_autostart::ManagerExt;
    app.autolaunch().is_enabled().map_err(|e| e.to_string())
}

/// Track-change toast (Settings → General → Playback notifications).
/// The focus check lives here rather than in JS so it covers every
/// window at once: a toast is only useful when the user isn't already
/// looking at the app (main window hidden to tray, or another app in
/// the foreground).
#[tauri::command]
fn notify_track(app: tauri::AppHandle, title: String, body: String) -> Result<(), String> {
    use tauri_plugin_notification::NotificationExt;
    let any_focused = app
        .webview_windows()
        .values()
        .any(|w| w.is_focused().unwrap_or(false));
    if any_focused {
        return Ok(());
    }
    app.notification()
        .builder()
        .title(title)
        .body(body)
        .show()
        .map_err(|e| e.to_string())
}

/// Bring the main window to the front. Called from the floating
/// player when the user clicks an in-bar link (e.g. an artist name)
/// — without this, the navigation would fire silently in the
/// background while the floating window keeps focus.
#[tauri::command]
fn focus_main_window(app: tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

/// Spawn (or refocus) the standalone floating-player window. The
/// frontend renders a stripped-down version of itself when it sees
/// `?floating-player=1` in the URL, so the new window hosts only the
/// player UI. Audio playback stays in the main window — the floater
/// mirrors state via Tauri events.
///
/// `x` / `y` are screen coords (CSS / logical pixels, as JS reports
/// them). When provided, the window appears centered horizontally on
/// the cursor with the title bar just under it — the natural landing
/// spot when the user drags the cover out of the main window. When
/// omitted, the window-state plugin's saved position takes over.
#[tauri::command]
async fn open_player_window(
    app: tauri::AppHandle,
    x: Option<f64>,
    y: Option<f64>,
) -> Result<(), String> {
    if let Some(existing) = app.get_webview_window("player") {
        let _ = existing.show();
        let _ = existing.unminimize();
        let _ = existing.set_focus();
        if let (Some(cx), Some(cy)) = (x, y) {
            let _ = existing.set_position(tauri::LogicalPosition::new(cx - 180.0, cy - 18.0));
        }
        return Ok(());
    }
    // The min height is sized so the Play/Pause control stays
    // visible at the narrowest legal window: titlebar (36) + p-4 top
    // (16) + cover (capped at 320 via `max-w-[20rem]` on the cover
    // wrapper) + gap (12) + meta (~36) + gap (12) + progress (~54)
    // + gap (12) + controls (~48) + p-3 bottom (12) ≈ 558. Lyrics
    // and the bottom button row sit below and graciously collapse
    // (lyrics is `flex-1 min-h-0`) when there isn't room.
    #[cfg(target_os = "macos")]
    let player_url = format!(
        "index.html?floating-player=1&native-player-material={}",
        native_glass::material_name()
    );
    #[cfg(not(target_os = "macos"))]
    let player_url = "index.html?floating-player=1".to_owned();

    let win = WebviewWindowBuilder::new(&app, "player", WebviewUrl::App(player_url.into()))
        .title("Goosic — player")
        .decorations(false)
        // The web surface clips itself to the outer 16px window radius. A transparent
        // native window lets those clipped corners reveal the desktop instead of
        // the WebView's otherwise rectangular black backing layer.
        .transparent(true)
        .inner_size(360.0, 720.0)
        .min_inner_size(320.0, 560.0)
        .resizable(true)
        .skip_taskbar(false)
        // Tauri's default drag/drop handler swallows in-page HTML5 drag
        // events on WebView2, breaking the queue reorder. We don't
        // accept dropped files anywhere in the app, so disabling the
        // handler entirely is purely upside. The doc string for this
        // method literally calls out HTML5 DnD on Windows as the use case.
        .disable_drag_drop_handler()
        // Shares the default user-data folder with the main window, so the
        // args must match the main window's `additionalBrowserArgs` exactly.
        .additional_browser_args(APP_WEBVIEW_ARGS)
        .build()
        .map_err(|e| e.to_string())?;
    #[cfg(target_os = "macos")]
    native_glass::install(&win)?;
    // Dev builds: orange taskbar icon, same as the main window.
    #[cfg(debug_assertions)]
    let _ = win.set_icon(runtime_icon(&app));
    if let (Some(cx), Some(cy)) = (x, y) {
        // Override whatever the window-state plugin restored. Centering
        // horizontally on cursor with the 36px-tall title bar just
        // below puts the user's release point on top of the new card,
        // which feels like the window snapped to where they dropped.
        let _ = win.set_position(tauri::LogicalPosition::new(cx - 180.0, cy - 18.0));
    }
    Ok(())
}

#[tauri::command]
async fn close_player_window(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("player") {
        w.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Sign the user out of every account they've added. Wipes the
/// accounts index, removes each per-account cookies dir, and emits
/// `accounts-changed` so the UI can collapse back to the signed-out
/// state. Mirrors the old single-account `clear_cookies` semantics
/// — "the app forgets you entirely" — extended to the multi-account
/// world.
#[tauri::command]
async fn clear_cookies(
    app: tauri::AppHandle,
    session: tauri::State<'_, AccountSessionGuard>,
    refresh_guard: tauri::State<'_, RefreshGuard>,
) -> Result<(), String> {
    let _session = session.mutation.lock().await;
    let _profile = refresh_guard.inner().0.lock().await;
    let account_ids: Vec<String> = read_index(&app)
        .await
        .accounts
        .into_iter()
        .map(|account| account.id)
        .collect();
    let player = app.state::<web_player::WebPlayerState>();
    web_player::reset(&app, player.inner()).await?;
    web_player::close_keepers(&app).await?;
    for id in &account_ids {
        remove_account_webview_store(&app, id).await;
    }
    let dir = accounts_dir(&app);
    if dir.exists() {
        tokio::fs::remove_dir_all(&dir)
            .await
            .map_err(|e| format!("remove accounts dir: {e}"))?;
    }
    let index = accounts_index_path(&app);
    if index.exists() {
        tokio::fs::remove_file(&index)
            .await
            .map_err(|e| format!("remove index: {e}"))?;
    }
    // Sweep any stray legacy file too — defends against a partially-
    // migrated install where someone manually copied state around.
    let legacy = legacy_cookies_enc_path(&app);
    if legacy.exists() {
        let _ = tokio::fs::remove_file(&legacy).await;
    }
    session.advance();
    let _ = app.emit("accounts-changed", ());
    Ok(())
}

#[tauri::command]
async fn list_accounts(
    app: tauri::AppHandle,
    session: tauri::State<'_, AccountSessionGuard>,
) -> Result<Vec<AccountSummary>, String> {
    let _session = session.mutation.lock().await;
    let idx = read_index(&app).await;
    let active = idx.active.clone();
    Ok(idx
        .accounts
        .into_iter()
        .map(|a| {
            let is_active = active.as_deref() == Some(a.id.as_str());
            AccountSummary {
                id: a.id,
                email: a.email,
                name: a.name,
                photo_url: a.photo_url,
                page_id: a.page_id,
                channel_name: a.channel_name,
                channel_photo_url: a.channel_photo_url,
                web_player_identity_verified: a.web_player_identity_verified,
                is_active,
            }
        })
        .collect())
}

/// Switch the active account. The InnerTube client picks up the new
/// cookies on its next request via `get_cookie_header`; the frontend
/// invalidates its query cache on the `accounts-changed` event.
#[tauri::command]
async fn switch_account(
    app: tauri::AppHandle,
    session: tauri::State<'_, AccountSessionGuard>,
    refresh_guard: tauri::State<'_, RefreshGuard>,
    id: String,
) -> Result<(), String> {
    let _session = session.mutation.lock().await;
    let _profile = refresh_guard.inner().0.lock().await;
    let mut idx = read_index(&app).await;
    if !idx.accounts.iter().any(|a| a.id == id) {
        return Err(format!("no such account: {id}"));
    }
    if idx.active.as_deref() == Some(id.as_str()) {
        return Ok(()); // already active — silent no-op
    }
    let player = app.state::<web_player::WebPlayerState>();
    web_player::reset(&app, player.inner()).await?;
    idx.active = Some(id);
    write_index(&app, &idx).await?;
    session.advance();
    let _ = app.emit("accounts-changed", ());
    Ok(())
}

/// Remove a single account. If the removed account was the active
/// one, pick the first remaining account as the new active (or
/// `None` when this was the last). Deletes the per-account cookies
/// directory off disk in the same call.
#[tauri::command]
async fn remove_account(
    app: tauri::AppHandle,
    session: tauri::State<'_, AccountSessionGuard>,
    refresh_guard: tauri::State<'_, RefreshGuard>,
    id: String,
) -> Result<(), String> {
    let _session = session.mutation.lock().await;
    let _profile = refresh_guard.inner().0.lock().await;
    let mut idx = read_index(&app).await;
    let pos = idx
        .accounts
        .iter()
        .position(|a| a.id == id)
        .ok_or_else(|| format!("no such account: {id}"))?;
    let player = app.state::<web_player::WebPlayerState>();
    let removed_profile = format!("account:{id}");
    if idx.active.as_deref() == Some(id.as_str())
        || web_player::uses_profile(player.inner(), &removed_profile).await
    {
        web_player::reset(&app, player.inner()).await?;
    }
    idx.accounts.remove(pos);
    // Release all browser-profile owners before deleting this account. The
    // other accounts' keepers are recreated lazily by their next refresh.
    web_player::close_keepers(&app).await?;
    remove_account_webview_store(&app, &id).await;
    let dir = accounts_dir(&app).join(&id);
    if dir.exists() {
        let _ = tokio::fs::remove_dir_all(&dir).await;
    }
    if idx.active.as_deref() == Some(id.as_str()) {
        idx.active = idx.accounts.first().map(|a| a.id.clone());
    }
    write_index(&app, &idx).await?;
    session.advance();
    let _ = app.emit("accounts-changed", ());
    Ok(())
}

/// Backfill or update meta for an account. Frontend calls this once
/// per session after `/account_menu` returns the active user's name
/// + email + avatar.
///
/// Dedup: if the supplied identity (email, or avatar when the email is
/// empty) matches a *different* existing account, this is a re-login of
/// an account we've seen before. Replace the older account's cookies
/// with the freshly-captured ones, drop this account's just-created
/// entry, and pin the older id as active.
#[tauri::command]
async fn update_account_meta(
    app: tauri::AppHandle,
    session: tauri::State<'_, AccountSessionGuard>,
    refresh_guard: tauri::State<'_, RefreshGuard>,
    id: String,
    name: String,
    email: String,
    #[allow(non_snake_case)] photoUrl: Option<String>,
) -> Result<(), String> {
    let _session = session.mutation.lock().await;
    let _profile = refresh_guard.inner().0.lock().await;
    let photo_url = photoUrl;
    let mut idx = read_index(&app).await;

    // Meta from /account_menu always describes the ACTIVE account: the
    // fetch runs with the active jar. A caller that pairs a stale id
    // with fresh meta (or a fresh id with stale meta) must not relabel
    // some other row; with identity dedup that could merge two real
    // accounts. Drop the write and let the backfill re-run with a
    // consistent pair.
    if idx.active.as_deref() != Some(id.as_str()) {
        return Ok(());
    }

    // When the account acts as a brand channel, /account_menu describes
    // the channel, not the Google account, so its meta can't identify a
    // duplicate row.
    let acting_as_brand = idx
        .accounts
        .iter()
        .find(|a| a.id == id)
        .map(|a| a.page_id.is_some())
        .unwrap_or(false);

    // Re-login of an existing account? Match a *different* row by
    // identity (email, or avatar when the email is empty; see
    // `meta_identity`). Keying on email alone missed brand-channel and
    // no-email accounts, which is how duplicate rows used to pile up.
    let incoming = if acting_as_brand {
        None
    } else {
        meta_identity(&email, photo_url.as_deref())
    };
    let dup_pos = incoming.as_ref().and_then(|key| {
        idx.accounts.iter().position(|a| {
            a.id != id
                && meta_identity(&a.email, a.photo_url.as_deref()).as_deref() == Some(key.as_str())
        })
    });

    // A "fresh add" is the very first meta backfill after
    // `start_login` — the account row exists but its name + email
    // are still empty placeholders. That's the moment to fire
    // `accounts-changed`, because it's the only event the UI listens
    // to for the full account-switch reset. Subsequent meta refreshes
    // (every session boot for an existing account) don't trigger the
    // reset; the frontend just invalidates the accounts list to pick
    // up name/photo changes.
    let was_fresh_add = idx
        .accounts
        .iter()
        .find(|a| a.id == id)
        .map(|a| a.name.is_empty() && a.email.is_empty())
        .unwrap_or(false);

    // Track whether the active account id actually flips. Dedup is
    // the only path that flips active here; a plain meta update
    // leaves `idx.active` alone.
    let mut active_changed = false;

    let identity_rebound = dup_pos.is_some();
    if let Some(other_pos) = dup_pos {
        let other_id = idx.accounts[other_pos].id.clone();
        let this_cookies = account_cookies_path(&app, &id);
        let other_cookies = account_cookies_path(&app, &other_id);
        if let Some(parent) = other_cookies.parent() {
            let _ = tokio::fs::create_dir_all(parent).await;
        }
        if let Ok(bytes) = tokio::fs::read(&this_cookies).await {
            if let Err(e) = tokio::fs::write(&other_cookies, bytes).await {
                eprintln!("[accounts] copy cookies on dedup: {e}");
            }
        }
        // Re-login replaces the older row's session with the freshly
        // captured one, so its live WebView profile has to move over too.
        // Otherwise the renewed account would have no profile to refresh
        // from and would die at ~2h like the old snapshot-only flow. The
        // just-closed login window can hold WebView2 file locks for a
        // beat, so retry the move briefly before giving up.
        let this_webview = account_webview_dir(&app, &id);
        if this_webview.exists() {
            let other_webview = account_webview_dir(&app, &other_id);
            let _ = tokio::fs::remove_dir_all(&other_webview).await;
            let mut moved = false;
            for _ in 0..5u8 {
                if tokio::fs::rename(&this_webview, &other_webview)
                    .await
                    .is_ok()
                {
                    moved = true;
                    break;
                }
                tokio::time::sleep(Duration::from_millis(400)).await;
            }
            if !moved {
                eprintln!(
                    "[accounts] could not move a deduplicated webview profile; \
                     re-login needed to re-arm session refresh"
                );
            }
        }
        let _ = tokio::fs::remove_dir_all(accounts_dir(&app).join(&id)).await;
        if let Some(this_pos) = idx.accounts.iter().position(|a| a.id == id) {
            idx.accounts.remove(this_pos);
        }
        if let Some(other) = idx.accounts.iter_mut().find(|a| a.id == other_id) {
            other.name = name;
            // Don't let an empty backfill (some accounts' /account_menu
            // carries no email) wipe a good stored email.
            if !email.is_empty() {
                other.email = email;
            }
            // The avatar can be the dedup identity when the email is
            // empty; never wipe it with a photo-less response.
            if photo_url.is_some() {
                other.photo_url = photo_url;
            }
            // The freshly moved browser profile came from a new Google login,
            // not from a verified brand-channel switch. Keep a stored brand
            // page id for InnerTube, but require it to be selected again before
            // official WebPlayer playback can use this replacement profile.
            if other.page_id.is_some() {
                other.web_player_identity_verified = Some(false);
            }
        }
        if idx.active.as_deref() != Some(other_id.as_str()) {
            active_changed = true;
        }
        idx.active = Some(other_id);
    } else if let Some(acct) = idx.accounts.iter_mut().find(|a| a.id == id) {
        if acting_as_brand {
            // Route brand-channel meta into the channel fields and leave
            // the account-level identity (name / email / photo captured
            // on the personal channel) untouched: re-login dedup keys on
            // it, and overwriting the account photo with the brand one
            // made a later re-login of the same account look like a new
            // identity.
            if !name.is_empty() {
                acct.channel_name = Some(name);
            }
            if photo_url.is_some() {
                acct.channel_photo_url = photo_url;
            }
        } else {
            acct.name = name;
            // Some accounts' /account_menu carries no email; don't let
            // that backfill wipe the stored one (it drives the re-login
            // dedup above).
            if !email.is_empty() {
                acct.email = email;
            }
            // The avatar can be the dedup identity when the email is
            // empty; never wipe it with a photo-less response.
            if photo_url.is_some() {
                acct.photo_url = photo_url;
            }
        }
    } else {
        return Err(format!("no such account: {id}"));
    }

    write_index(&app, &idx).await?;
    if identity_rebound {
        session.advance();
    }
    if was_fresh_add || active_changed {
        let _ = app.emit("accounts-changed", ());
    }
    Ok(())
}

/// Returns the id of the currently active account, or `None` when
/// signed out. Frontend uses this to pair fresh `account_menu` info
/// with the right account row.
#[tauri::command]
async fn get_active_account_id(
    app: tauri::AppHandle,
    session: tauri::State<'_, AccountSessionGuard>,
) -> Result<Option<String>, String> {
    let _session = session.mutation.lock().await;
    Ok(read_index(&app).await.active)
}

/// Select which YouTube channel (personal or brand) an account acts
/// as. `pageId: None` selects the personal channel. When the choice on
/// verification succeeds we emit `accounts-changed` even when re-selecting
/// the stored page id: the verification document replaces the old player and
/// may rotate the browser identity, so every cached owner must reset.
#[tauri::command]
async fn set_account_channel(
    app: tauri::AppHandle,
    player: tauri::State<'_, web_player::WebPlayerState>,
    server: tauri::State<'_, StreamServerState>,
    session: tauri::State<'_, AccountSessionGuard>,
    refresh_guard: tauri::State<'_, RefreshGuard>,
    id: String,
    #[allow(non_snake_case)] pageId: Option<String>,
    #[allow(non_snake_case)] signinUrl: String,
    #[allow(non_snake_case)] channelName: Option<String>,
    #[allow(non_snake_case)] channelPhotoUrl: Option<String>,
) -> Result<(), String> {
    if !validate_page_id(pageId.as_deref()) {
        return Err("invalid channel selection".into());
    }
    // Parse without reconstructing, persisting, or logging the opaque query.
    let signin_url = validate_account_signin_url(&signinUrl)?;
    let port = *server.port.lock().await;
    let token = server.web_player_token.lock().await.clone();
    let (port, token) = match (port, token) {
        (Some(port), Some(token)) => (port, token),
        _ => return Err("playback bridge is not ready".into()),
    };
    let bridge_url = format!("http://127.0.0.1:{port}/{token}/web-player/identity");
    let _session = session.mutation.lock().await;
    let mut idx = read_index(&app).await;
    if idx.active.as_deref() != Some(id.as_str()) {
        return Err("the selected account is no longer active".into());
    }
    let account_position = idx
        .accounts
        .iter()
        .position(|account| account.id == id)
        .ok_or_else(|| "the selected account no longer exists".to_string())?;
    if !account_webview_dir(&app, &id).exists() {
        return Err("sign in again before selecting a YouTube channel".into());
    }

    // Persist only a fail-closed marker before navigation. The existing page
    // id and display metadata remain untouched unless verification succeeds.
    idx.accounts[account_position].web_player_identity_verified = Some(false);
    write_index(&app, &idx).await?;
    // Cookie refresh and identity selection both own the same native profile.
    let _profile = refresh_guard.inner().0.lock().await;
    web_player::select_identity(
        &app,
        player.inner(),
        bridge_url,
        format!("account:{id}"),
        account_webview_dir(&app, &id),
        YT_LOGIN_UA,
        YT_WEBVIEW_ARGS,
        signin_url,
        pageId.as_deref(),
    )
    .await?;

    // The account lock has stayed held across verification, so this remains
    // the same active row. Commit the requested identity atomically only now.
    let account = &mut idx.accounts[account_position];
    account.page_id = pageId;
    account.channel_name = channelName;
    account.channel_photo_url = channelPhotoUrl;
    account.web_player_identity_verified = Some(true);
    write_index(&app, &idx).await?;
    // Even a re-verification of the stored page id closes the old playback
    // document and can rotate the browser identity. Invalidate every cached
    // auth/player snapshot after a successful proof.
    session.advance();
    let _ = app.emit("accounts-changed", ());
    Ok(())
}

/// Cookie header plus the active account's brand-channel page id in a
/// single call. The InnerTube client sends the page id back as the
/// `X-Goog-PageId` header. Bundling it with the cookie read (instead
/// of a second command) means a cold start can't pair fresh cookies
/// with a stale page id, or vice versa.
#[derive(Clone, Debug, serde::Serialize)]
struct AuthContext {
    cookie: String,
    #[serde(rename = "pageId")]
    page_id: Option<String>,
    #[serde(rename = "accountId")]
    account_id: Option<String>,
    epoch: u64,
}

#[tauri::command]
async fn get_auth_context(
    app: tauri::AppHandle,
    session: tauri::State<'_, AccountSessionGuard>,
    host: String,
) -> Result<AuthContext, String> {
    let _session = session.mutation.lock().await;
    let epoch = session.epoch.load(Ordering::Acquire);
    let idx = read_index(&app).await;
    let Some(account) = idx
        .accounts
        .iter()
        .find(|account| idx.active.as_deref() == Some(account.id.as_str()))
    else {
        return Ok(AuthContext {
            cookie: String::new(),
            page_id: None,
            account_id: None,
            epoch,
        });
    };
    let cookie =
        read_cookie_header_from_path(&account_cookies_path(&app, &account.id), &host).await;
    if cookie.is_empty() {
        return Ok(AuthContext {
            cookie,
            page_id: None,
            account_id: None,
            epoch,
        });
    }
    Ok(AuthContext {
        cookie,
        page_id: account.page_id.clone(),
        account_id: Some(account.id.clone()),
        epoch,
    })
}

/// Serializes changes to the active account/channel identity with auth
/// snapshots and response-cookie merges. `epoch` lets a delayed HTTP response
/// prove it still belongs to the snapshot that initiated it.
#[derive(Default)]
struct AccountSessionGuard {
    mutation: tokio::sync::Mutex<()>,
    epoch: AtomicU64,
}

impl AccountSessionGuard {
    fn advance(&self) {
        self.epoch.fetch_add(1, Ordering::AcqRel);
    }
}

fn auth_snapshot_is_current(
    index: &AccountsIndex,
    account_id: &str,
    snapshot_epoch: u64,
    current_epoch: u64,
) -> bool {
    snapshot_epoch == current_epoch
        && index.active.as_deref() == Some(account_id)
        && index
            .accounts
            .iter()
            .any(|account| account.id == account_id)
}

/// Serializes read-modify-write cycles on the active cookie jar.
/// Parallel InnerTube responses can each carry Set-Cookie rotations;
/// without the lock two merges could interleave and drop one.
#[derive(Default)]
struct JarWriteLock(tokio::sync::Mutex<()>);

/// Serializes cookie-refresh runs so the periodic keeper reload / jar
/// rewrite can't overlap between the timer and a manual trigger.
#[derive(Default)]
struct RefreshGuard(tokio::sync::Mutex<()>);

/// Merge `Set-Cookie` headers from an InnerTube response into the
/// active account's jar, mirroring what a browser would do. Google
/// rotates session-security cookies (SIDCC / __Secure-*PSIDCC /
/// LOGIN_INFO) right after sign-in and expects the client to echo the
/// fresh values from then on; a client that keeps replaying the
/// pre-rotation snapshot matches the stolen-cookie heuristic and the
/// whole session gets revoked within hours (the v0.2.0 "library and
/// Premium vanish" bug).
///
/// Returns `true` when a cookie VALUE changed — the frontend drops its
/// cached Cookie header then. Missing jar / dead decrypt are quiet
/// no-ops: rotation echo is best-effort and must never break the data
/// call that triggered it.
#[tauri::command]
async fn merge_response_cookies(
    app: tauri::AppHandle,
    lock: tauri::State<'_, JarWriteLock>,
    session: tauri::State<'_, AccountSessionGuard>,
    host: String,
    set_cookies: Vec<String>,
    #[allow(non_snake_case)] accountId: Option<String>,
    epoch: u64,
) -> Result<bool, String> {
    if set_cookies.is_empty() {
        return Ok(false);
    }
    let _guard = lock.0.lock().await;
    let _session = session.mutation.lock().await;
    let Some(account_id) = accountId else {
        return Ok(false);
    };
    let idx = read_index(&app).await;
    if !auth_snapshot_is_current(
        &idx,
        &account_id,
        epoch,
        session.epoch.load(Ordering::Acquire),
    ) {
        return Ok(false);
    }
    let path = account_cookies_path(&app, &account_id);
    let Ok(encrypted) = tokio::fs::read(&path).await else {
        return Ok(false);
    };
    let Ok(Ok(plain)) =
        tokio::task::spawn_blocking(move || secure_store::decrypt(&encrypted)).await
    else {
        return Ok(false);
    };
    let Ok(jar) = String::from_utf8(plain) else {
        return Ok(false);
    };

    let now_ts = time::OffsetDateTime::now_utc().unix_timestamp();
    let (merged, value_changed, needs_write) =
        merge_set_cookies_into_jar(&jar, &set_cookies, &host, now_ts);
    if !needs_write {
        return Ok(false);
    }

    let bytes = merged.into_bytes();
    let encrypted = tokio::task::spawn_blocking(move || secure_store::encrypt(&bytes))
        .await
        .map_err(|e| format!("encrypt join: {e}"))?
        .map_err(|e| format!("encrypt cookies: {e}"))?;
    // Write-then-rename: this path now runs on live rotations, not just
    // at login, and a torn cookies.enc reads as "signed out".
    let tmp = path.with_extension("enc.tmp");
    tokio::fs::write(&tmp, &encrypted)
        .await
        .map_err(|e| format!("write jar tmp: {e}"))?;
    tokio::fs::rename(&tmp, &path)
        .await
        .map_err(|e| format!("swap jar: {e}"))?;
    if value_changed {
        eprintln!("[auth] echoed rotated session cookie(s) into the active jar");
    }
    Ok(value_changed)
}

/// File (under the store plugin's default dir) + key holding the
/// user-chosen cache root. Written by `set_cache_dir`, read once at
/// startup — the stream server captures its directories when it
/// spawns, so a change only applies on the next launch.
const SETTINGS_STORE_FILE: &str = "settings.json";
const CACHE_DIR_KEY: &str = "cacheDir";

/// The durable offline-media root this process actually started with. Covers
/// deliberately do not derive from it: they remain disposable OS cache data.
struct ActiveCacheRoot(PathBuf);

fn default_cache_root(app: &tauri::AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .map(|path| path.join("offline-media"))
        .unwrap_or_else(|_| std::env::temp_dir())
}

fn legacy_cache_root(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path().app_cache_dir().ok()
}

/// User-chosen cache root from the settings store, if any.
fn stored_cache_root(app: &tauri::AppHandle) -> Option<PathBuf> {
    use tauri_plugin_store::StoreExt;
    let store = app.store(SETTINGS_STORE_FILE).ok()?;
    let value = store.get(CACHE_DIR_KEY)?;
    let s = value.as_str()?.trim().to_string();
    if s.is_empty() {
        None
    } else {
        Some(PathBuf::from(s))
    }
}

fn stream_cache_dir(app: &tauri::AppHandle) -> PathBuf {
    app.state::<ActiveCacheRoot>().0.join("stream")
}

/// Copy finalized legacy downloads into the durable store without removing or
/// overwriting either copy. Old cache directories remain recoverable and can
/// be deleted manually only after the user verifies the imported library.
async fn import_legacy_offline_files(source: &std::path::Path, target: &std::path::Path) {
    if source == target || !source.exists() {
        return;
    }
    if let Err(error) = tokio::fs::create_dir_all(target).await {
        eprintln!("[offline] could not create durable import directory: {error}");
        return;
    }
    let Ok(mut entries) = tokio::fs::read_dir(source).await else {
        return;
    };
    let mut audio_ids = Vec::new();
    while let Ok(Some(entry)) = entries.next_entry().await {
        let Some(name) = entry.file_name().to_str().map(str::to_string) else {
            continue;
        };
        if let Some(video_id) = name
            .strip_suffix(".webm")
            .filter(|id| sanitize_video_id(id))
        {
            audio_ids.push(video_id.to_string());
        }
    }

    for video_id in audio_ids {
        let audio_name = format!("{video_id}.webm");
        let audio_destination = target.join(&audio_name);
        // Treat an audio file and its sidecars as one ownership unit. A stale
        // legacy `.invalid` or metadata file must never attach itself to a
        // newer durable download that already owns this id.
        if audio_destination.exists() {
            continue;
        }

        let audio_candidate = target.join(format!("{audio_name}.importing"));
        let _ = tokio::fs::remove_file(&audio_candidate).await;
        if let Err(error) = tokio::fs::copy(source.join(&audio_name), &audio_candidate).await {
            eprintln!("[offline] could not import legacy file {audio_name}: {error}");
            continue;
        }

        let mut sidecar_failed = false;
        for suffix in [".meta.json", ".invalid"] {
            let name = format!("{video_id}{suffix}");
            let from = source.join(&name);
            let destination = target.join(&name);
            if !from.exists() || destination.exists() {
                continue;
            }
            let candidate = target.join(format!("{name}.importing"));
            let _ = tokio::fs::remove_file(&candidate).await;
            if let Err(error) = tokio::fs::copy(&from, &candidate).await {
                eprintln!("[offline] could not import legacy sidecar {name}: {error}");
                sidecar_failed = true;
                let _ = tokio::fs::remove_file(&candidate).await;
                break;
            }
            if let Err(error) = tokio::fs::rename(&candidate, &destination).await {
                eprintln!("[offline] could not finish legacy sidecar {name}: {error}");
                sidecar_failed = true;
                let _ = tokio::fs::remove_file(&candidate).await;
                break;
            }
        }
        if sidecar_failed {
            let _ = tokio::fs::remove_file(&audio_candidate).await;
            continue;
        }
        if let Err(error) = tokio::fs::rename(&audio_candidate, &audio_destination).await {
            let _ = tokio::fs::remove_file(&audio_candidate).await;
            eprintln!("[offline] could not finish legacy import for {audio_name}: {error}");
        }
    }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct CacheDirInfo {
    /// Root that will be used from the next launch on.
    path: String,
    default_path: String,
    is_custom: bool,
    /// True when the stored preference differs from what this process
    /// is running with — i.e. a restart is pending.
    needs_restart: bool,
}

#[tauri::command]
fn get_cache_dir(app: tauri::AppHandle) -> CacheDirInfo {
    let default = default_cache_root(&app);
    let stored = stored_cache_root(&app);
    let active = app.state::<ActiveCacheRoot>().0.clone();
    let effective = stored.clone().unwrap_or_else(|| default.clone());
    CacheDirInfo {
        needs_restart: effective != active,
        path: effective.display().to_string(),
        default_path: default.display().to_string(),
        is_custom: stored.is_some(),
    }
}

/// Persist a new cache root (`None` resets to the default). Validates
/// that the folder exists and is writable before saving; the change
/// takes effect on the next launch.
#[tauri::command]
async fn set_cache_dir(app: tauri::AppHandle, path: Option<String>) -> Result<(), String> {
    use tauri_plugin_store::StoreExt;
    let store = app
        .store(SETTINGS_STORE_FILE)
        .map_err(|e| format!("open settings store: {e}"))?;
    match path {
        None => {
            store.delete(CACHE_DIR_KEY);
        }
        Some(raw) => {
            let raw = raw.trim().to_string();
            let dir = PathBuf::from(&raw);
            if raw.is_empty() || !dir.is_absolute() {
                return Err("Pick an absolute folder path.".into());
            }
            tokio::fs::create_dir_all(&dir)
                .await
                .map_err(|e| format!("Can't create the folder: {e}"))?;
            let probe = dir.join(".ytubic-write-test");
            tokio::fs::write(&probe, b"ok")
                .await
                .map_err(|e| format!("Folder isn't writable: {e}"))?;
            let _ = tokio::fs::remove_file(&probe).await;
            store.set(CACHE_DIR_KEY, serde_json::Value::String(raw));
        }
    }
    store
        .save()
        .map_err(|e| format!("save settings store: {e}"))?;
    Ok(())
}

/// Native directory picker for the cache-folder setting. Returns
/// `None` when the user cancels. Blocking picker variant, so keep it
/// off the async runtime's core threads.
#[tauri::command]
async fn pick_cache_folder(app: tauri::AppHandle) -> Option<String> {
    use tauri_plugin_dialog::DialogExt;
    tauri::async_runtime::spawn_blocking(move || app.dialog().file().blocking_pick_folder())
        .await
        .ok()
        .flatten()
        .and_then(|f| f.into_path().ok())
        .map(|p| p.display().to_string())
}

#[derive(serde::Serialize)]
struct CacheEntry {
    #[serde(rename = "videoId")]
    video_id: String,
    size: u64,
    /// Seconds since unix epoch. Frontend formats for display.
    #[serde(rename = "modifiedSecs")]
    modified_secs: u64,
    /// Track title, if a sidecar was written when it was cached. The
    /// library walk is the frontend's fallback; without either, it shows
    /// the raw videoId.
    #[serde(skip_serializing_if = "Option::is_none")]
    title: Option<String>,
    /// Display artist string (already joined), if known.
    #[serde(skip_serializing_if = "Option::is_none")]
    artist: Option<String>,
    /// Queue/library identity. This can differ from `video_id` when the user
    /// downloaded the music-video source for a song card.
    #[serde(rename = "displayVideoId", skip_serializing_if = "Option::is_none")]
    display_video_id: Option<String>,
    #[serde(rename = "sourceKind", skip_serializing_if = "Option::is_none")]
    source_kind: Option<String>,
    /// Invalid legacy files stay visible for repair/removal but are never
    /// claimed as playable or silently deleted.
    valid: bool,
}

/// On-disk sidecar written next to a cached `<id>.webm` as
/// `<id>.meta.json`. The Rust side stores it verbatim; the frontend
/// supplies the already-formatted display strings.
#[derive(Clone, serde::Serialize, serde::Deserialize)]
struct TrackMeta {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    artist: Option<String>,
    #[serde(
        rename = "displayVideoId",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    display_video_id: Option<String>,
    #[serde(
        rename = "sourceKind",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    source_kind: Option<String>,
}

/// Best-effort read of a track's metadata sidecar. Any absence or parse
/// error is treated as "no metadata" — the cache file is still valid
/// without it.
async fn read_track_meta(dir: &std::path::Path, video_id: &str) -> TrackMeta {
    let path = dir.join(format!("{video_id}.meta.json"));
    match tokio::fs::read(&path).await {
        Ok(bytes) => serde_json::from_slice::<TrackMeta>(&bytes).unwrap_or(TrackMeta {
            title: None,
            artist: None,
            display_video_id: None,
            source_kind: None,
        }),
        Err(_) => TrackMeta {
            title: None,
            artist: None,
            display_video_id: None,
            source_kind: None,
        },
    }
}

fn offline_invalid_marker(dir: &std::path::Path, video_id: &str) -> PathBuf {
    dir.join(format!("{video_id}.invalid"))
}

async fn is_playable_offline_audio(dir: &std::path::Path, video_id: &str) -> bool {
    !offline_invalid_marker(dir, video_id).exists()
        && is_valid_cached_audio(&dir.join(format!("{video_id}.webm"))).await
}

/// List every finalized track (.webm) currently in the stream cache.
/// In-progress .part files are ignored — they'll appear once the
/// download finishes and the rename happens.
#[tauri::command]
async fn list_cache(app: tauri::AppHandle) -> Result<Vec<CacheEntry>, String> {
    let dir = stream_cache_dir(&app);
    let mut entries: Vec<CacheEntry> = Vec::new();
    let mut rd = match tokio::fs::read_dir(&dir).await {
        Ok(r) => r,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(entries),
        Err(e) => return Err(format!("read_dir: {e}")),
    };
    while let Ok(Some(e)) = rd.next_entry().await {
        let Some(name) = e.file_name().to_str().map(|s| s.to_string()) else {
            continue;
        };
        let Some(video_id) = name.strip_suffix(".webm") else {
            continue;
        };
        if !sanitize_video_id(video_id) {
            continue;
        }
        let Ok(meta) = e.metadata().await else {
            continue;
        };
        let modified_secs = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let sidecar = read_track_meta(&dir, video_id).await;
        let valid = is_playable_offline_audio(&dir, video_id).await;
        entries.push(CacheEntry {
            video_id: video_id.to_string(),
            size: meta.len(),
            modified_secs,
            title: sidecar.title,
            artist: sidecar.artist,
            display_video_id: sidecar.display_video_id,
            source_kind: sidecar.source_kind,
            valid,
        });
    }
    Ok(entries)
}

/// Delete an explicit set of downloaded tracks. Empty input is rejected so a
/// serialization/UI bug can never be interpreted as a destructive wipe-all.
#[tauri::command]
async fn delete_cache_entries(
    app: tauri::AppHandle,
    state: tauri::State<'_, StreamServerState>,
    video_ids: Vec<String>,
) -> Result<u64, String> {
    if video_ids.is_empty() {
        return Err("no downloaded tracks were selected".into());
    }
    let dir = stream_cache_dir(&app);
    if !dir.exists() {
        return Ok(0);
    }
    let mut freed: u64 = 0;

    let targets: Vec<String> = video_ids
        .into_iter()
        .filter(|id| sanitize_video_id(id))
        .collect();
    if targets.is_empty() {
        return Err("no valid downloaded tracks were selected".into());
    }
    // Serialize the active-map check with both new download registration and
    // the filesystem mutation. Otherwise a download could start in the gap
    // after this check and have its fresh `.part` file deleted underneath it.
    let runtime = state.runtime.lock().await.clone();
    let _file_guard = if let Some(runtime) = runtime.as_ref() {
        Some(runtime.offline_file_ops.lock().await)
    } else {
        None
    };
    if let Some(runtime) = runtime.as_ref() {
        let active = runtime.downloads.lock().await;
        if let Some(video_id) = targets
            .iter()
            .find(|video_id| active.contains_key(*video_id))
        {
            return Err(format!(
                "{video_id} is still downloading; cancel it before deleting the file"
            ));
        }
    }

    let mut errors = Vec::new();
    for id in targets {
        let path = dir.join(format!("{id}.webm"));
        let size = tokio::fs::metadata(&path)
            .await
            .map(|metadata| metadata.len())
            .unwrap_or(0);
        match tokio::fs::remove_file(&path).await {
            Ok(()) => freed += size,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => errors.push(format!("{}: {error}", path.display())),
        }
        for suffix in [
            ".part",
            ".webm.backup",
            ".meta.json",
            ".meta.json.part",
            ".invalid",
        ] {
            let extra = dir.join(format!("{id}{suffix}"));
            match tokio::fs::remove_file(&extra).await {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => errors.push(format!("{}: {error}", extra.display())),
            }
        }
    }
    if errors.is_empty() {
        Ok(freed)
    } else {
        Err(format!(
            "some cache files could not be removed: {}",
            errors.join("; ")
        ))
    }
}

/// Remember a decoder failure without deleting or renaming the user's file.
/// A later explicit playlist retry replaces it atomically and clears the
/// marker only after the new payload validates and installs successfully.
#[tauri::command]
async fn mark_offline_file_unplayable(
    app: tauri::AppHandle,
    state: tauri::State<'_, StreamServerState>,
    video_id: String,
) -> Result<(), String> {
    if !sanitize_video_id(&video_id) {
        return Err("invalid videoId".into());
    }
    let runtime = state.runtime.lock().await.clone();
    let _file_guard = if let Some(runtime) = runtime.as_ref() {
        Some(runtime.offline_file_ops.lock().await)
    } else {
        None
    };
    if let Some(runtime) = runtime.as_ref() {
        if runtime.downloads.lock().await.contains_key(&video_id) {
            return Err("the offline file is currently being repaired".into());
        }
    }
    let dir = stream_cache_dir(&app);
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|error| format!("create offline directory: {error}"))?;
    tokio::fs::write(offline_invalid_marker(&dir, &video_id), b"unplayable")
        .await
        .map_err(|error| format!("mark offline file for repair: {error}"))
}

/// Make the managed yt-dlp binary available (download on first use,
/// throttled self-update after). Ordinary playback never calls this command;
/// it is only the explicit offline-playlist setup retry path. Idempotent —
/// see `ytdlp::ensure`.
#[tauri::command]
async fn ensure_ytdlp(app: tauri::AppHandle) {
    ytdlp::ensure(app).await;
}

/// Lifecycle of one explicit offline playlist-track download. yt-dlp writes
/// into a `<videoId>.part` file and only replaces `<videoId>.webm` after the
/// payload passes validation. Ordinary playback never creates this state.
struct DownloadState {
    /// Wakes long-running setup/read operations when cancellation is requested.
    notify: Arc<Notify>,
    video_id: String,
    downloaded_bytes: AtomicU64,
    cancelled: AtomicBool,
    metadata: Option<TrackMeta>,
}

impl DownloadState {
    fn new_offline(video_id: String, metadata: TrackMeta) -> Self {
        Self {
            notify: Arc::new(Notify::new()),
            video_id,
            downloaded_bytes: AtomicU64::new(0),
            cancelled: AtomicBool::new(false),
            metadata: Some(metadata),
        }
    }
}

async fn write_track_meta_file(
    dir: &std::path::Path,
    video_id: &str,
    meta: &TrackMeta,
) -> Result<(), String> {
    tokio::fs::create_dir_all(dir)
        .await
        .map_err(|error| format!("create cache directory: {error}"))?;
    let bytes = serde_json::to_vec(meta).map_err(|error| format!("serialize: {error}"))?;
    let path = dir.join(format!("{video_id}.meta.json"));
    let part = dir.join(format!("{video_id}.meta.json.part"));
    tokio::fs::write(&part, bytes)
        .await
        .map_err(|error| format!("write metadata: {error}"))?;
    if path.exists() {
        let _ = tokio::fs::remove_file(&path).await;
    }
    tokio::fs::rename(&part, &path)
        .await
        .map_err(|error| format!("install metadata: {error}"))
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct OfflineDownloadSnapshot {
    video_id: String,
    phase: String,
    downloaded_bytes: u64,
    total_bytes: Option<u64>,
    error: Option<String>,
}

type OfflineDownloadJobs = Arc<Mutex<HashMap<String, OfflineDownloadSnapshot>>>;

type DownloadMap = Arc<Mutex<HashMap<String, Arc<DownloadState>>>>;

// Account cookies stay exclusive to the signed-in InnerTube/WebPlayer
// profile. Explicit offline downloads are anonymous and never pass cookies
// to yt-dlp or the PO-token provider.
#[derive(Clone)]
struct StreamServer {
    app: tauri::AppHandle,
    /// Explicit Premium playlist downloads live here across app restarts.
    cache_dir: PathBuf,
    cover_dir: PathBuf,
    downloads: DownloadMap,
    /// Serializes delete/invalid-marker writes with download registration so
    /// a new transfer cannot appear between a safety check and a file change.
    offline_file_ops: Arc<Mutex<()>>,
    /// Expected location of the managed yt-dlp copy. Resolution to an
    /// actual program (managed vs PATH fallback) happens per-spawn via
    /// `ytdlp::program` so a mid-session download takes effect
    /// immediately.
    ytdlp_bin: PathBuf,
    /// Serializes explicit playlist downloads so one playlist cannot fan out
    /// multiple yt-dlp processes from the same IP.
    limiter: Arc<Semaphore>,
    offline_jobs: OfflineDownloadJobs,
}

/// Hash a URL into a stable hex filename. Uses Rust's stdlib
/// SipHash13 (DefaultHasher) — not cryptographic, but for cache-key
/// purposes only and keeps the dependency footprint small.
fn url_to_filename(url: &str) -> String {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    url.hash(&mut hasher);
    let hash = format!("{:016x}", hasher.finish());
    let ext = if url.contains(".png") {
        "png"
    } else if url.contains(".webp") {
        "webp"
    } else {
        "jpg"
    };
    format!("{hash}.{ext}")
}

fn cover_cache_dir(app: &tauri::AppHandle) -> PathBuf {
    app.path()
        .app_cache_dir()
        .unwrap_or_else(|_| std::env::temp_dir())
        .join("covers")
}

/// Download a cover image (typically from iTunes / mzstatic) and stash
/// it in the local cover cache, returning a localhost URL the webview
/// can use as `<img src>`. Subsequent calls for the same URL skip the
/// network and just return the existing local URL.
///
/// We don't cache failures — the next track switch retries.
#[tauri::command]
async fn cache_cover(
    app: tauri::AppHandle,
    state: tauri::State<'_, StreamServerState>,
    url: String,
) -> Result<String, String> {
    let port = {
        let p = state.port.lock().await;
        p.ok_or_else(|| "stream server not ready".to_string())?
    };
    let token = {
        let t = state.token.lock().await;
        t.clone()
            .ok_or_else(|| "stream server not ready".to_string())?
    };

    // SSRF guard: cover URLs come from remote metadata (iTunes/mzstatic +
    // YT image hosts). Only fetch https from those known CDNs so a crafted
    // metadata field can't point the server-side fetch at an internal
    // service (e.g. 169.254.169.254 or a LAN admin page). Redirects are
    // disabled below so a CDN-looking URL can't 302 into the allowlist.
    {
        let parsed = reqwest::Url::parse(&url).map_err(|e| format!("bad url: {e}"))?;
        if parsed.scheme() != "https" {
            return Err(format!("blocked scheme: {}", parsed.scheme()));
        }
        const ALLOWED_HOST_SUFFIXES: &[&str] = &[
            "mzstatic.com",
            "ytimg.com",
            "ggpht.com",
            "googleusercontent.com",
        ];
        let host = parsed.host_str().unwrap_or("");
        let host_ok = ALLOWED_HOST_SUFFIXES
            .iter()
            .any(|s| host == *s || host.ends_with(&format!(".{s}")));
        if !host_ok {
            return Err(format!("blocked cover host: {host}"));
        }
    }

    let dir = cover_cache_dir(&app);
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|e| format!("mkdir: {e}"))?;

    let filename = url_to_filename(&url);
    let path = dir.join(&filename);

    if !path.exists() {
        let resp = reqwest::Client::builder()
            .timeout(Duration::from_secs(10))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|e| format!("client: {e}"))?
            .get(&url)
            .send()
            .await
            .map_err(|e| format!("fetch: {e}"))?;
        if !resp.status().is_success() {
            return Err(format!("HTTP {}", resp.status()));
        }
        let bytes = resp.bytes().await.map_err(|e| format!("read body: {e}"))?;
        // Write to a .part file then atomically rename so a concurrent
        // reader never sees a half-written file.
        let part = path.with_extension(format!(
            "{}.part",
            path.extension().and_then(|e| e.to_str()).unwrap_or("")
        ));
        tokio::fs::write(&part, &bytes)
            .await
            .map_err(|e| format!("write: {e}"))?;
        tokio::fs::rename(&part, &path)
            .await
            .map_err(|e| format!("rename: {e}"))?;
    }

    Ok(format!("http://127.0.0.1:{port}/{token}/cover/{filename}"))
}

#[derive(serde::Serialize)]
struct CoverCacheStats {
    count: u64,
    bytes: u64,
}

/// Sum up the cover cache directory. Used by the Settings UI to show
/// "Covers: 47 files, 12 MB" alongside the existing track-cache row.
#[tauri::command]
async fn cover_cache_stats(app: tauri::AppHandle) -> Result<CoverCacheStats, String> {
    let dir = cover_cache_dir(&app);
    let mut count: u64 = 0;
    let mut bytes: u64 = 0;
    let mut rd = match tokio::fs::read_dir(&dir).await {
        Ok(r) => r,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(CoverCacheStats { count: 0, bytes: 0 });
        }
        Err(e) => return Err(format!("read_dir: {e}")),
    };
    while let Ok(Some(e)) = rd.next_entry().await {
        let Ok(meta) = e.metadata().await else {
            continue;
        };
        if !meta.is_file() {
            continue;
        }
        count += 1;
        bytes += meta.len();
    }
    Ok(CoverCacheStats { count, bytes })
}

/// Wipe every file in the cover cache directory. Returns total bytes
/// freed. The directory itself is preserved so the next `cache_cover`
/// call doesn't have to recreate it.
#[tauri::command]
async fn clear_cover_cache(app: tauri::AppHandle) -> Result<u64, String> {
    let dir = cover_cache_dir(&app);
    let mut freed: u64 = 0;
    let mut rd = match tokio::fs::read_dir(&dir).await {
        Ok(r) => r,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(e) => return Err(format!("read_dir: {e}")),
    };
    while let Ok(Some(e)) = rd.next_entry().await {
        let Ok(meta) = e.metadata().await else {
            continue;
        };
        if !meta.is_file() {
            continue;
        }
        freed += meta.len();
        let _ = tokio::fs::remove_file(e.path()).await;
    }
    Ok(freed)
}

#[derive(Default)]
struct StreamServerState {
    port: Arc<Mutex<Option<u16>>>,
    /// Per-launch secret used as a path prefix on every offline-audio and
    /// cover URL. The frontend gets it baked into the base URL, so it's
    /// transparent to the webview; a web page in the user's browser that
    /// guesses the random port still can't form a valid URL — this closes
    /// the CSRF-spawn and DNS-rebinding-read vectors.
    token: Arc<Mutex<Option<String>>>,
    /// Separate per-launch secret exposed only to the remote YouTube Music
    /// observer. It must never share the stream token: page JavaScript needs
    /// permission to report state, not permission to inspect cached covers or
    /// read local audio.
    web_player_token: Arc<Mutex<Option<String>>>,
    runtime: Arc<Mutex<Option<StreamServer>>>,
    offline_jobs: OfflineDownloadJobs,
}

async fn publish_offline_download(
    srv: &StreamServer,
    state: &DownloadState,
    phase: &str,
    error: Option<String>,
) -> OfflineDownloadSnapshot {
    let snapshot = OfflineDownloadSnapshot {
        video_id: state.video_id.clone(),
        phase: phase.to_string(),
        downloaded_bytes: state.downloaded_bytes.load(Ordering::Relaxed),
        total_bytes: None,
        error: error.map(|value| value.chars().take(600).collect()),
    };
    srv.offline_jobs
        .lock()
        .await
        .insert(snapshot.video_id.clone(), snapshot.clone());
    let _ = srv.app.emit("offline-download-state", &snapshot);
    snapshot
}

#[tauri::command]
async fn start_offline_download(
    state: tauri::State<'_, StreamServerState>,
    video_id: String,
    force: Option<bool>,
    title: Option<String>,
    artist: Option<String>,
    display_video_id: Option<String>,
    source_kind: Option<String>,
) -> Result<OfflineDownloadSnapshot, String> {
    if !sanitize_video_id(&video_id) {
        return Err("invalid videoId".into());
    }
    let srv = state
        .runtime
        .lock()
        .await
        .clone()
        .ok_or_else(|| "download engine is not ready".to_string())?;
    let metadata = TrackMeta {
        title: title.filter(|value| !value.trim().is_empty()),
        artist: artist.filter(|value| !value.trim().is_empty()),
        display_video_id: display_video_id.filter(|id| sanitize_video_id(id)),
        source_kind: source_kind.filter(|kind| kind == "song" || kind == "video"),
    };
    let file_guard = srv.offline_file_ops.lock().await;
    let final_path = srv.cache_dir.join(format!("{video_id}.webm"));
    let force = force.unwrap_or(false);
    if !force && is_playable_offline_audio(&srv.cache_dir, &video_id).await {
        if metadata.title.is_some() {
            write_track_meta_file(&srv.cache_dir, &video_id, &metadata).await?;
        }
        let existing = DownloadState::new_offline(video_id, metadata);
        existing.downloaded_bytes.store(
            tokio::fs::metadata(&final_path)
                .await
                .map(|metadata| metadata.len())
                .unwrap_or(0),
            Ordering::Relaxed,
        );
        return Ok(publish_offline_download(&srv, &existing, "completed", None).await);
    }
    if let Some(remaining) = offline_download_cooldown_remaining(&srv.app) {
        return Err(offline_download_cooldown_message(remaining));
    }

    let mut was_created = false;
    let download = {
        let mut downloads = srv.downloads.lock().await;
        if let Some(existing) = downloads.get(&video_id) {
            existing.clone()
        } else {
            let download = Arc::new(DownloadState::new_offline(
                video_id.clone(),
                metadata.clone(),
            ));
            downloads.insert(video_id.clone(), download.clone());
            was_created = true;
            download
        }
    };
    drop(file_guard);
    let snapshot = publish_offline_download(
        &srv,
        &download,
        if was_created { "queued" } else { "downloading" },
        None,
    )
    .await;
    if was_created {
        spawn_downloader(video_id, srv.clone(), download);
    }
    Ok(snapshot)
}

#[tauri::command]
async fn cancel_offline_download(
    state: tauri::State<'_, StreamServerState>,
    video_id: String,
) -> Result<(), String> {
    if !sanitize_video_id(&video_id) {
        return Err("invalid videoId".into());
    }
    let srv = state
        .runtime
        .lock()
        .await
        .clone()
        .ok_or_else(|| "download engine is not ready".to_string())?;
    let download = srv.downloads.lock().await.get(&video_id).cloned();
    if let Some(download) = download {
        download.cancelled.store(true, Ordering::Release);
        // `notify_one` stores a permit when cancellation lands between the
        // atomic check and `notified()` registration; `notify_waiters` would
        // lose that wake-up and could leave setup/read blocked until timeout.
        download.notify.notify_one();
    }
    Ok(())
}

#[tauri::command]
async fn list_offline_downloads(
    state: tauri::State<'_, StreamServerState>,
) -> Result<Vec<OfflineDownloadSnapshot>, String> {
    Ok(state.offline_jobs.lock().await.values().cloned().collect())
}

#[tauri::command]
async fn get_stream_base_url(state: tauri::State<'_, StreamServerState>) -> Result<String, String> {
    let port = *state.port.lock().await;
    let token = state.token.lock().await.clone();
    match (port, token) {
        (Some(p), Some(t)) => Ok(format!("http://127.0.0.1:{p}/{t}")),
        _ => Err("stream server not ready".to_string()),
    }
}

async fn wait_for_web_player_bridge(state: &StreamServerState) -> Result<(u16, String), String> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
    loop {
        let port = *state.port.lock().await;
        let token = state.web_player_token.lock().await.clone();
        if let (Some(port), Some(token)) = (port, token) {
            return Ok((port, token));
        }
        if tokio::time::Instant::now() >= deadline {
            return Err("playback bridge did not become ready".into());
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

fn requests_cache_only(req: &Request) -> bool {
    let Some(query) = req.uri().query() else {
        return false;
    };
    query.split('&').any(|kv| {
        let mut it = kv.splitn(2, '=');
        let key = it.next().unwrap_or("");
        let val = it.next().unwrap_or("");
        key == "cache_only" && (val == "1" || val == "true")
    })
}

#[tauri::command]
async fn web_player_load(
    app: tauri::AppHandle,
    player: tauri::State<'_, web_player::WebPlayerState>,
    server: tauri::State<'_, StreamServerState>,
    session: tauri::State<'_, AccountSessionGuard>,
    refresh_guard: tauri::State<'_, RefreshGuard>,
    video_id: String,
    generation: u64,
    playing: bool,
    volume: f64,
    muted: bool,
) -> Result<(), String> {
    if !sanitize_video_id(&video_id) || !volume.is_finite() {
        return Err("invalid web player request".into());
    }
    // setup() performs account migrations before binding the loopback bridge.
    // A restored queue can reach this command during that short cold-start
    // window, so await readiness instead of consuming both frontend retries.
    let (port, web_player_token) = wait_for_web_player_bridge(server.inner()).await?;
    let bridge_url = format!("http://127.0.0.1:{port}/{web_player_token}/web-player/state");
    // Hold the account identity stable through profile selection and player
    // creation. A concurrent account/channel switch will wait, then reset this
    // owner before committing its new index snapshot.
    let _account_lock = session.mutation.lock().await;
    // Player creation and cookie-snapshot refresh both operate on the active
    // account WebView profile. Serialize them so a keeper cannot reload or
    // close while a playback handoff is in flight.
    let _profile_lock = refresh_guard.inner().0.lock().await;
    let index = read_index(&app).await;
    let (profile_key, profile_dir) = if let Some(active) = index.active {
        let account = index
            .accounts
            .iter()
            .find(|account| account.id == active)
            .ok_or_else(|| "active account profile is unavailable".to_string())?;
        if account.web_player_identity_verified == Some(false)
            || (account.page_id.is_some() && account.web_player_identity_verified != Some(true))
        {
            return Err("choose this account's YouTube channel before playback".into());
        }
        (
            format!("account:{active}"),
            account_webview_dir(&app, &active),
        )
    } else {
        let dir = app
            .path()
            .app_data_dir()
            .map_err(|error| error.to_string())?
            .join("playback-guest-webview");
        ("guest".to_string(), dir)
    };
    web_player::load(
        &app,
        player.inner(),
        bridge_url,
        profile_key,
        profile_dir,
        YT_LOGIN_UA,
        YT_WEBVIEW_ARGS,
        video_id,
        generation,
        playing,
        volume,
        muted,
    )
    .await
}

#[tauri::command]
async fn web_player_control(
    app: tauri::AppHandle,
    player: tauri::State<'_, web_player::WebPlayerState>,
    generation: u64,
    action: String,
    value: Option<f64>,
) -> Result<(), String> {
    if value.is_some_and(|value| !value.is_finite()) {
        return Err("invalid web player value".into());
    }
    web_player::control(&app, player.inner(), generation, &action, value).await
}

#[tauri::command]
async fn web_player_reset(
    app: tauri::AppHandle,
    player: tauri::State<'_, web_player::WebPlayerState>,
) -> Result<(), String> {
    web_player::reset(&app, player.inner()).await
}

#[tauri::command]
async fn web_player_health(
    app: tauri::AppHandle,
    player: tauri::State<'_, web_player::WebPlayerState>,
) -> Result<bool, String> {
    Ok(web_player::healthy(&app, player.inner()).await)
}

const OFFLINE_DOWNLOAD_COOLDOWN_KEY: &str = "offlineDownloadCooldownUntil";
const OFFLINE_DOWNLOAD_COOLDOWN: Duration = Duration::from_secs(15 * 60);
const YTDLP_OFFLINE_RETRY_ARGS: [&str; 4] = ["--retries", "0", "--extractor-retries", "0"];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum YtdlpFailureKind {
    RateLimited,
    Other,
}

/// Classify the unredacted diagnostic bytes before constructing a safe error
/// message. Some yt-dlp errors put the bot-check text and a help URL on the
/// same line; the display redactor intentionally drops that whole line.
fn classify_ytdlp_failure(stderr: &[u8]) -> YtdlpFailureKind {
    let lower = String::from_utf8_lossy(stderr).to_ascii_lowercase();
    if lower.contains("429")
        || lower.contains("too many requests")
        || lower.contains("not a bot")
        || lower.contains("rate limit")
    {
        YtdlpFailureKind::RateLimited
    } else {
        YtdlpFailureKind::Other
    }
}

fn unix_now_seconds() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

fn cooldown_remaining_at(until: u64, now: u64) -> Option<u64> {
    (until > now).then(|| until - now)
}

/// The Tauri store lives under app data, independently of the user-selected
/// offline-media directory. Keeping the deadline there prevents a cache-path
/// change or app restart from immediately retrying a rate-limited IP.
fn offline_download_cooldown_remaining(app: &tauri::AppHandle) -> Option<u64> {
    use tauri_plugin_store::StoreExt;
    let store = app.store(SETTINGS_STORE_FILE).ok()?;
    let until = store.get(OFFLINE_DOWNLOAD_COOLDOWN_KEY)?.as_u64()?;
    cooldown_remaining_at(until, unix_now_seconds())
}

fn persist_offline_download_cooldown(app: &tauri::AppHandle) -> Result<u64, String> {
    use tauri_plugin_store::StoreExt;
    let until = unix_now_seconds().saturating_add(OFFLINE_DOWNLOAD_COOLDOWN.as_secs());
    let store = app
        .store(SETTINGS_STORE_FILE)
        .map_err(|error| format!("open native settings store: {error}"))?;
    store.set(
        OFFLINE_DOWNLOAD_COOLDOWN_KEY,
        serde_json::Value::from(until),
    );
    store
        .save()
        .map_err(|error| format!("save native settings store: {error}"))?;
    Ok(until)
}

fn offline_download_cooldown_message(remaining_seconds: u64) -> String {
    let minutes = remaining_seconds.saturating_add(59) / 60;
    format!(
        "YouTube temporarily rate limited offline downloads. Try again in {minutes} minute{}.",
        if minutes == 1 { "" } else { "s" }
    )
}

/// Reduce yt-dlp/provider diagnostics to an actionable, credential-free tail.
fn summarize_ytdlp_stderr(stderr: &[u8]) -> String {
    let text = String::from_utf8_lossy(stderr);
    let mut lines = text
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        // yt-dlp/provider diagnostics can include per-session credentials.
        // Drop the entire line instead of attempting partial redaction, which
        // risks missing a new output format in a future extractor release.
        .filter(|line| {
            let lower = line.to_ascii_lowercase();
            !lower.contains("visitor data")
                && !lower.contains("visitor_data")
                && !lower.contains("po_token")
                && !lower.contains("request body")
                && !lower.contains("googlevideo.com")
                && !lower.contains("http://")
                && !lower.contains("https://")
                && !lower.contains("token=")
                && !lower.contains("pot=")
                && !lower.contains("authorization:")
                && !lower.contains("cookie:")
        })
        .collect::<Vec<_>>();
    // The actionable extractor/download error is conventionally last. Keep a
    // little context without returning pages of warnings through localhost.
    if lines.len() > 4 {
        lines.drain(..lines.len() - 4);
    }
    let summary = lines.join(" | ");
    if summary.is_empty() {
        "yt-dlp produced no audio".into()
    } else {
        summary.chars().take(1200).collect()
    }
}

/// Reject tiny HTML/storyboard/error payloads before they become persistent
/// cache entries. A real YouTube audio track is comfortably larger than this.
const MIN_AUDIO_BYTES: u64 = 32 * 1024;

/// Install a fully validated download without exposing or destroying the
/// previous cache entry first. This matters for old downloads: a failed
/// refresh must leave the user's existing bytes recoverable.
async fn install_cached_audio(
    part_path: &std::path::Path,
    final_path: &std::path::Path,
) -> Result<(), String> {
    if !final_path.exists() {
        return tokio::fs::rename(part_path, final_path)
            .await
            .map_err(|error| error.to_string());
    }

    let backup_path = final_path.with_extension("webm.backup");
    if backup_path.exists() {
        if is_valid_cached_audio(final_path).await {
            tokio::fs::remove_file(&backup_path)
                .await
                .map_err(|error| format!("remove stale cache backup: {error}"))?;
        } else {
            tokio::fs::remove_file(final_path)
                .await
                .map_err(|error| format!("remove invalid replacement: {error}"))?;
            tokio::fs::rename(&backup_path, final_path)
                .await
                .map_err(|error| format!("restore cache backup: {error}"))?;
        }
    }

    tokio::fs::rename(final_path, &backup_path)
        .await
        .map_err(|error| format!("stage previous cache entry: {error}"))?;
    match tokio::fs::rename(part_path, final_path).await {
        Ok(()) => {
            let _ = tokio::fs::remove_file(&backup_path).await;
            Ok(())
        }
        Err(error) => {
            let _ = tokio::fs::rename(&backup_path, final_path).await;
            Err(format!("install replacement cache entry: {error}"))
        }
    }
}

/// Recover the previous cache entry if the process stopped between staging an
/// old download as `.webm.backup` and installing its replacement. Valid final
/// files always win; an invalid or missing final is replaced only when the
/// backup itself passes the same container/size validation as normal cache
/// playback. Unknown files are left untouched for manual recovery.
async fn recover_cache_backups(cache_dir: &std::path::Path) {
    let Ok(mut entries) = tokio::fs::read_dir(cache_dir).await else {
        return;
    };
    while let Ok(Some(entry)) = entries.next_entry().await {
        let backup_path = entry.path();
        let Some(name) = backup_path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        let Some(final_name) = name.strip_suffix(".webm.backup") else {
            continue;
        };
        if !sanitize_video_id(final_name) || !is_valid_cached_audio(&backup_path).await {
            continue;
        }
        let final_path = cache_dir.join(format!("{final_name}.webm"));
        if is_valid_cached_audio(&final_path).await {
            let _ = tokio::fs::remove_file(&backup_path).await;
            continue;
        }
        if final_path.exists() {
            if let Err(error) = tokio::fs::remove_file(&final_path).await {
                eprintln!("[stream-server] could not remove interrupted replacement {final_name}: {error}");
                continue;
            }
        }
        if let Err(error) = tokio::fs::rename(&backup_path, &final_path).await {
            eprintln!("[stream-server] could not restore cache backup {final_name}: {error}");
        } else {
            eprintln!("[stream-server] restored interrupted cache backup {final_name}");
        }
    }
}

async fn wait_or_cancel<T>(
    state: &DownloadState,
    future: impl std::future::Future<Output = T>,
) -> Option<T> {
    if state.cancelled.load(Ordering::Acquire) {
        return None;
    }
    tokio::select! {
        result = future => Some(result),
        _ = state.notify.notified() => None,
    }
}

#[derive(Debug)]
enum OfflineDownloadAttempt {
    Completed,
    Cancelled,
    Failed {
        error: String,
        kind: YtdlpFailureKind,
        /// Local filesystem/spawn failures cannot be repaired by restarting
        /// the PO provider, even if it happened to exit at the same time.
        provider_retryable: bool,
    },
}

fn should_retry_after_provider_failure(
    provider_was_used: bool,
    kind: YtdlpFailureKind,
    provider_retryable: bool,
    provider_is_healthy: bool,
) -> bool {
    provider_was_used
        && kind != YtdlpFailureKind::RateLimited
        && provider_retryable
        && !provider_is_healthy
}

/// Run exactly one yt-dlp process and atomically install its validated output.
/// Retry policy stays in `spawn_downloader`; keeping one attempt here ensures
/// the crash-recovery retry has identical cancellation, progress, diagnostic,
/// and cache-preservation behavior.
async fn run_offline_download_attempt(
    video_id: &str,
    srv: &StreamServer,
    state: &DownloadState,
    ytdlp_program: &std::path::Path,
    provider: Option<&pot_provider::ProviderConfig>,
    target_dir: &std::path::Path,
    part_path: &std::path::Path,
    final_path: &std::path::Path,
) -> OfflineDownloadAttempt {
    let _ = tokio::fs::remove_file(part_path).await;
    if state.cancelled.load(Ordering::Acquire) {
        return OfflineDownloadAttempt::Cancelled;
    }

    let mut file = match tokio::fs::File::create(part_path).await {
        Ok(file) => file,
        Err(error) => {
            let message = format!("could not create offline download file: {error}");
            eprintln!("[offline] {video_id}: {message}");
            return OfflineDownloadAttempt::Failed {
                error: message,
                kind: YtdlpFailureKind::Other,
                provider_retryable: false,
            };
        }
    };

    let url = format!("https://www.youtube.com/watch?v={video_id}");
    let mut cmd = TokioCommand::new(ytdlp_program);
    // Keep config/plugin isolation first in argv so yt-dlp cannot apply a
    // user-controlled option before Goosic establishes the hermetic runtime.
    cmd.args(ytdlp::youtube_runtime_args(
        &srv.ytdlp_bin,
        provider.map(|config| (config.plugin_dir.as_path(), config.base_url.as_str())),
    ));
    cmd.args([
        "-f",
        "bestaudio[ext=webm]/bestaudio",
        "--no-playlist",
        "--no-part",
        "-q",
        "--socket-timeout",
        "15",
        "-o",
        "-",
    ]);
    // Do not let yt-dlp turn one playlist item into an immediate burst of
    // retries. The explicit UI retry remains available after non-rate-limit
    // failures; 429/not-a-bot responses activate the durable native cooldown.
    cmd.args(YTDLP_OFFLINE_RETRY_ARGS);
    cmd.arg(&url);
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    cmd.kill_on_drop(true);
    let mut child = match cmd.stdout(Stdio::piped()).stderr(Stdio::piped()).spawn() {
        Ok(child) => child,
        Err(error) => {
            drop(file);
            let _ = tokio::fs::remove_file(part_path).await;
            eprintln!("[offline] spawn {video_id}: {error}");
            return OfflineDownloadAttempt::Failed {
                error: format!("could not start yt-dlp: {error}"),
                kind: YtdlpFailureKind::Other,
                provider_retryable: false,
            };
        }
    };

    let Some(mut stdout) = child.stdout.take() else {
        let _ = child.start_kill();
        drop(file);
        let _ = tokio::fs::remove_file(part_path).await;
        return OfflineDownloadAttempt::Failed {
            error: "yt-dlp did not provide an audio pipe".into(),
            kind: YtdlpFailureKind::Other,
            provider_retryable: false,
        };
    };
    // Drain stderr concurrently so verbose extractor warnings cannot fill the
    // pipe and deadlock yt-dlp. Keep a bounded tail for diagnostics.
    let stderr_task = child.stderr.take().map(|mut stderr| {
        tokio::spawn(async move {
            const STDERR_TAIL_BYTES: usize = 64 * 1024;
            let mut tail = Vec::new();
            let mut chunk = [0u8; 8192];
            loop {
                match stderr.read(&mut chunk).await {
                    Ok(0) | Err(_) => break,
                    Ok(read) => {
                        tail.extend_from_slice(&chunk[..read]);
                        if tail.len() > STDERR_TAIL_BYTES {
                            let excess = tail.len() - STDERR_TAIL_BYTES;
                            tail.drain(..excess);
                        }
                    }
                }
            }
            tail
        })
    });

    let mut buf = vec![0u8; 64 * 1024];
    let mut ok = true;
    let mut provider_retryable = true;
    let mut last_progress_emit = std::time::Instant::now();
    const READ_TIMEOUT: Duration = Duration::from_secs(60);
    loop {
        if state.cancelled.load(Ordering::Acquire) {
            let _ = child.start_kill();
            ok = false;
            break;
        }
        let read_result = tokio::select! {
            result = tokio::time::timeout(READ_TIMEOUT, stdout.read(&mut buf)) => Some(result),
            _ = state.notify.notified() => None,
        };
        match read_result {
            None => {
                let _ = child.start_kill();
                ok = false;
                break;
            }
            Some(Err(_)) => {
                eprintln!("[offline] read timeout for {video_id}; killing yt-dlp");
                let _ = child.start_kill();
                ok = false;
                break;
            }
            Some(Ok(Ok(0))) => break,
            Some(Ok(Ok(read))) => {
                state
                    .downloaded_bytes
                    .fetch_add(read as u64, Ordering::Relaxed);
                if let Err(error) = file.write_all(&buf[..read]).await {
                    eprintln!("[offline] write .part: {error}");
                    let _ = child.start_kill();
                    ok = false;
                    provider_retryable = false;
                    break;
                }
                if last_progress_emit.elapsed() >= Duration::from_millis(250) {
                    let _ = publish_offline_download(srv, state, "downloading", None).await;
                    last_progress_emit = std::time::Instant::now();
                }
            }
            Some(Ok(Err(error))) => {
                eprintln!("[offline] read stdout: {error}");
                ok = false;
                break;
            }
        }
    }
    if let Err(error) = file.flush().await {
        eprintln!("[offline] flush .part: {error}");
        ok = false;
        provider_retryable = false;
    }
    drop(file);

    let status_result = if state.cancelled.load(Ordering::Acquire) {
        let _ = child.start_kill();
        tokio::time::timeout(Duration::from_secs(5), child.wait()).await
    } else {
        tokio::select! {
            result = tokio::time::timeout(Duration::from_secs(15), child.wait()) => result,
            _ = state.notify.notified() => {
                let _ = child.start_kill();
                tokio::time::timeout(Duration::from_secs(5), child.wait()).await
            }
        }
    };
    if status_result.is_err() {
        let _ = child.start_kill();
        ok = false;
    }
    let status = status_result.ok().and_then(Result::ok);
    let stderr = match stderr_task {
        Some(mut task) => match tokio::time::timeout(Duration::from_secs(5), &mut task).await {
            Ok(Ok(stderr)) => stderr,
            _ => {
                task.abort();
                Vec::new()
            }
        },
        None => Vec::new(),
    };

    if state.cancelled.load(Ordering::Acquire) {
        let _ = tokio::fs::remove_file(part_path).await;
        return OfflineDownloadAttempt::Cancelled;
    }

    let success = ok && status.is_some_and(|status| status.success());
    let part_size = tokio::fs::metadata(part_path)
        .await
        .map(|metadata| metadata.len())
        .unwrap_or(0);
    let supported_container =
        part_size >= MIN_AUDIO_BYTES && has_supported_audio_container(part_path).await;
    let failure_kind = classify_ytdlp_failure(&stderr);

    if success && supported_container {
        if let Err(error) = install_cached_audio(part_path, final_path).await {
            eprintln!("[offline] install {video_id}: {error}");
            let _ = tokio::fs::remove_file(part_path).await;
            return OfflineDownloadAttempt::Failed {
                error: format!(
                    "download finished but the audio cache file could not be installed: {error}"
                ),
                kind: YtdlpFailureKind::Other,
                provider_retryable: false,
            };
        }

        let _ = tokio::fs::remove_file(offline_invalid_marker(target_dir, video_id)).await;
        eprintln!("[offline] downloaded {video_id} ({part_size} bytes)");
        if let Some(metadata) = state.metadata.as_ref() {
            if metadata.title.is_some() {
                if let Err(error) = write_track_meta_file(target_dir, video_id, metadata).await {
                    eprintln!("[offline] metadata write failed for {video_id}: {error}");
                }
            }
        }
        return OfflineDownloadAttempt::Completed;
    }

    let error = if failure_kind == YtdlpFailureKind::RateLimited {
        offline_download_cooldown_message(OFFLINE_DOWNLOAD_COOLDOWN.as_secs())
    } else if success && part_size < MIN_AUDIO_BYTES {
        let detail = format!(
            "yt-dlp returned only {part_size} bytes (minimum audio size is {MIN_AUDIO_BYTES})"
        );
        eprintln!("[offline] download too small for {video_id}: {detail}");
        detail
    } else if success {
        eprintln!("[offline] unsupported audio payload for {video_id}");
        "yt-dlp returned an unsupported audio container".to_string()
    } else {
        let detail = summarize_ytdlp_stderr(&stderr);
        eprintln!("[offline] download failed {video_id}: {detail}");
        detail
    };
    let _ = tokio::fs::remove_file(part_path).await;
    OfflineDownloadAttempt::Failed {
        error,
        kind: failure_kind,
        provider_retryable,
    }
}

fn spawn_downloader(video_id: String, srv: StreamServer, state: Arc<DownloadState>) {
    let downloads = srv.downloads.clone();
    tokio::spawn(async move {
        let finish = |phase: &'static str, error: Option<String>| {
            let srv = srv.clone();
            let state = state.clone();
            let downloads = downloads.clone();
            async move {
                let _ = publish_offline_download(&srv, &state, phase, error).await;
                let mut active = downloads.lock().await;
                if active
                    .get(&state.video_id)
                    .is_some_and(|current| Arc::ptr_eq(current, &state))
                {
                    active.remove(&state.video_id);
                }
            }
        };

        let _permit = match wait_or_cancel(&state, srv.limiter.clone().acquire_owned()).await {
            Some(Ok(permit)) => permit,
            Some(Err(_)) => {
                finish(
                    "failed",
                    Some("offline download queue is unavailable".into()),
                )
                .await;
                return;
            }
            None => {
                finish("cancelled", None).await;
                return;
            }
        };
        if state.cancelled.load(Ordering::Acquire) {
            finish("cancelled", None).await;
            return;
        }
        // A playlist can already have later tracks queued when an earlier
        // track trips YouTube's rate limit. Re-check after acquiring the
        // serialized permit so those jobs stop without installing tooling or
        // sending another network request.
        if let Some(remaining) = offline_download_cooldown_remaining(&srv.app) {
            finish("failed", Some(offline_download_cooldown_message(remaining))).await;
            return;
        }
        let _ = publish_offline_download(&srv, &state, "downloading", None).await;

        // Offline tooling is lazy: ordinary playback must never install it.
        // Surface each first-use phase only after an explicit playlist action,
        // while this worker joins the same serialized setup locks as retries.
        let mut setup_announced = false;
        if !srv.ytdlp_bin.is_file() {
            ytdlp::emit_state(&srv.app, "downloading", None);
            setup_announced = true;
        }
        let ytdlp_program =
            match wait_or_cancel(&state, ytdlp::ensure_ytdlp_available(&srv.app)).await {
                Some(Ok(program)) => program,
                Some(Err(e)) => {
                    let message = format!("yt-dlp unavailable: {e}");
                    eprintln!("[offline] {video_id}: {message}");
                    if setup_announced {
                        ytdlp::emit_state(&srv.app, "error", Some(message.clone()));
                    }
                    finish("failed", Some(message)).await;
                    return;
                }
                None => {
                    if setup_announced {
                        ytdlp::emit_state(&srv.app, "cancelled", None);
                    }
                    finish("cancelled", None).await;
                    return;
                }
            };
        if !ytdlp::managed_deno_path(&srv.ytdlp_bin).is_file() {
            ytdlp::emit_state(
                &srv.app,
                "runtime",
                Some("Installing YouTube challenge runtime (Deno)".into()),
            );
            setup_announced = true;
        }
        let runtime_result = wait_or_cancel(&state, ytdlp::ensure_js_runtime(&srv.ytdlp_bin)).await;
        let Some(runtime_result) = runtime_result else {
            if setup_announced {
                ytdlp::emit_state(&srv.app, "cancelled", None);
            }
            finish("cancelled", None).await;
            return;
        };
        let mut setup_warning = None;
        if let Err(e) = runtime_result {
            // Best-effort by contract: android_vr can still resolve many
            // tracks, so an unavailable GitHub/Deno download is not itself a
            // download failure. The selected client args below automatically
            // omit web_safari when the managed runtime is absent.
            eprintln!("[offline] {video_id}: Deno unavailable, using fallback clients: {e}");
            setup_warning = Some(
                "YouTube challenge runtime unavailable; using fallback download clients"
                    .to_string(),
            );
        }
        if ytdlp::managed_deno_path(&srv.ytdlp_bin).is_file()
            && pot_provider::current_config().is_none()
        {
            ytdlp::emit_state(
                &srv.app,
                "provider",
                Some("Installing managed YouTube PO-token provider".into()),
            );
            setup_announced = true;
        }
        let provider = match wait_or_cancel(
            &state,
            pot_provider::ensure(&srv.app, &srv.ytdlp_bin, false),
        )
        .await
        {
            Some(Ok(config)) => Some(config),
            Some(Err(error)) => {
                eprintln!("[pot-provider] unavailable; using fallback clients: {error}");
                setup_warning =
                    Some("PO-token provider unavailable; using fallback download clients".into());
                None
            }
            None => {
                if setup_announced {
                    ytdlp::emit_state(&srv.app, "cancelled", None);
                }
                finish("cancelled", None).await;
                return;
            }
        };
        if setup_announced {
            ytdlp::emit_state(&srv.app, "ready", setup_warning);
        }

        let target_dir = srv.cache_dir.clone();
        let part_path = target_dir.join(format!("{video_id}.part"));
        let final_path = target_dir.join(format!("{video_id}.webm"));
        let _ = tokio::fs::create_dir_all(&target_dir).await;
        if state.cancelled.load(Ordering::Acquire) {
            finish("cancelled", None).await;
            return;
        }

        state.downloaded_bytes.store(0, Ordering::Release);
        let mut attempt = run_offline_download_attempt(
            &video_id,
            &srv,
            &state,
            &ytdlp_program,
            provider.as_ref(),
            &target_dir,
            &part_path,
            &final_path,
        )
        .await;

        let retry_failure = match &attempt {
            OfflineDownloadAttempt::Failed {
                kind,
                provider_retryable,
                ..
            } if provider.is_some()
                && *kind != YtdlpFailureKind::RateLimited
                && *provider_retryable =>
            {
                Some((*kind, *provider_retryable))
            }
            _ => None,
        };
        if let Some((kind, provider_retryable)) = retry_failure {
            let provider_is_healthy =
                match wait_or_cancel(&state, pot_provider::current_is_healthy()).await {
                    Some(healthy) => healthy,
                    None => {
                        finish("cancelled", None).await;
                        return;
                    }
                };
            if should_retry_after_provider_failure(
                true,
                kind,
                provider_retryable,
                provider_is_healthy,
            ) {
                ytdlp::emit_state(
                    &srv.app,
                    "provider",
                    Some("Restarting managed YouTube PO-token provider".into()),
                );
                let retry_provider = match wait_or_cancel(
                    &state,
                    pot_provider::ensure(&srv.app, &srv.ytdlp_bin, true),
                )
                .await
                {
                    Some(Ok(config)) => {
                        ytdlp::emit_state(&srv.app, "ready", None);
                        Some(config)
                    }
                    Some(Err(error)) => {
                        eprintln!(
                            "[pot-provider] restart failed; retrying with fallback clients: {error}"
                        );
                        ytdlp::emit_state(
                            &srv.app,
                            "ready",
                            Some(
                                "PO-token provider restart failed; retrying with fallback download clients"
                                    .into(),
                            ),
                        );
                        None
                    }
                    None => {
                        ytdlp::emit_state(&srv.app, "cancelled", None);
                        finish("cancelled", None).await;
                        return;
                    }
                };

                // A provider crash is the only automatic per-track retry. Its
                // progress starts at zero, and the second result is final even
                // if the replacement provider also exits.
                state.downloaded_bytes.store(0, Ordering::Release);
                let _ = publish_offline_download(&srv, &state, "downloading", None).await;
                attempt = run_offline_download_attempt(
                    &video_id,
                    &srv,
                    &state,
                    &ytdlp_program,
                    retry_provider.as_ref(),
                    &target_dir,
                    &part_path,
                    &final_path,
                )
                .await;
            }
        }

        match attempt {
            OfflineDownloadAttempt::Completed => finish("completed", None).await,
            OfflineDownloadAttempt::Cancelled => finish("cancelled", None).await,
            OfflineDownloadAttempt::Failed { error, kind, .. } => {
                if kind == YtdlpFailureKind::RateLimited {
                    if let Err(persist_error) = persist_offline_download_cooldown(&srv.app) {
                        eprintln!(
                            "[offline] could not persist the download rate-limit cooldown: {persist_error}"
                        );
                    }
                    eprintln!(
                        "[offline] YouTube rate limited explicit downloads; pausing new attempts"
                    );
                }
                finish("failed", Some(error)).await;
            }
        }
    });
}

/// Read the first 16 bytes of a completed track file and map the
/// container magic to the right `audio/*` mime. Every track is saved
/// with a `.webm` extension regardless of what yt-dlp actually
/// produced, so we can't trust the extension.
async fn sniff_audio_mime(path: &std::path::Path) -> &'static str {
    let mut buf = [0u8; 16];
    if let Ok(mut f) = tokio::fs::File::open(path).await {
        let _ = f.read(&mut buf).await;
    }
    audio_mime_from_header(&buf).unwrap_or("application/octet-stream")
}

fn audio_mime_from_header(buf: &[u8]) -> Option<&'static str> {
    if buf.len() >= 8 && &buf[4..8] == b"ftyp" {
        Some("audio/mp4")
    } else if buf.len() >= 4 && &buf[..4] == &[0x1A, 0x45, 0xDF, 0xA3] {
        Some("audio/webm")
    } else if buf.len() >= 4 && &buf[..4] == b"OggS" {
        Some("audio/ogg")
    } else if buf.len() >= 4 && &buf[..4] == b"fLaC" {
        Some("audio/flac")
    } else if buf.len() >= 12 && &buf[..4] == b"RIFF" && &buf[8..12] == b"WAVE" {
        Some("audio/wav")
    } else if (buf.len() >= 3 && &buf[..3] == b"ID3")
        || (buf.len() >= 2 && buf[0] == 0xFF && (buf[1] & 0xE0) == 0xE0)
    {
        Some("audio/mpeg")
    } else {
        None
    }
}

async fn has_supported_audio_container(path: &std::path::Path) -> bool {
    let mut buf = [0u8; 16];
    let Ok(mut file) = tokio::fs::File::open(path).await else {
        return false;
    };
    let Ok(read) = file.read(&mut buf).await else {
        return false;
    };
    audio_mime_from_header(&buf[..read]).is_some()
}

async fn is_valid_cached_audio(path: &std::path::Path) -> bool {
    let size = tokio::fs::metadata(path)
        .await
        .map(|meta| meta.len())
        .unwrap_or(0);
    size >= MIN_AUDIO_BYTES && has_supported_audio_container(path).await
}

/// Range-serve a finalized explicit offline download. This handler never
/// invokes yt-dlp; online playback belongs exclusively to the WebPlayer.
async fn stream_handler(
    AxumState(srv): AxumState<StreamServer>,
    Path(video_id): Path<String>,
    req: Request,
) -> Response {
    if !sanitize_video_id(&video_id) {
        return (StatusCode::BAD_REQUEST, "invalid videoId").into_response();
    }
    // Online playback belongs exclusively to the official WebPlayer. The
    // loopback media route may only Range-serve a finalized local download;
    // it must never become an implicit yt-dlp resolver again.
    if !requests_cache_only(&req) {
        return (
            StatusCode::FORBIDDEN,
            "online extraction is disabled; use an explicit playlist download",
        )
            .into_response();
    }

    let final_path = srv.cache_dir.join(format!("{video_id}.webm"));
    let final_valid = is_playable_offline_audio(&srv.cache_dir, &video_id).await;
    if !final_valid {
        let status = if final_path.exists() {
            StatusCode::UNPROCESSABLE_ENTITY
        } else {
            StatusCode::NOT_FOUND
        };
        return (status, "cached audio is unavailable").into_response();
    }

    let t0 = std::time::Instant::now();

    let range_hdr = req
        .headers()
        .get(axum::http::header::RANGE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    eprintln!("[offline] GET /stream/{video_id} range={range_hdr:?} cached={final_valid}");

    // Sniff actual content-type from the file's magic bytes. Every
    // track is saved with a `.webm` extension, but yt-dlp falls back
    // to m4a when a video has no webm audio — serving that as
    // `video/webm` (what tower-http guesses from the extension) makes
    // Chromium refuse to decode.
    let sniffed_ct = sniff_audio_mime(&final_path).await;
    let mut resp = ServeFile::new(&final_path)
        .oneshot(req)
        .await
        .map(|r| r.into_response())
        .unwrap_or_else(|e| {
            (StatusCode::INTERNAL_SERVER_ERROR, format!("serve: {e}")).into_response()
        });
    if resp.status().is_success() || resp.status() == StatusCode::PARTIAL_CONTENT {
        resp.headers_mut().insert(
            axum::http::header::CONTENT_TYPE,
            axum::http::HeaderValue::from_static(sniffed_ct),
        );
    }
    eprintln!(
        "[offline] {video_id}: responding {} ({:.2}s total) ct={:?} len={:?}",
        resp.status(),
        t0.elapsed().as_secs_f32(),
        resp.headers()
            .get(axum::http::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok()),
        resp.headers()
            .get(axum::http::header::CONTENT_LENGTH)
            .and_then(|v| v.to_str().ok()),
    );
    resp
}

/// GET /cover/:filename — serve a cached cover image. Files are placed
/// here by the `cache_cover` Tauri command. The filename is a hex hash +
/// extension produced by `url_to_filename`, which is the only way bytes
/// land in this directory — so accepting `[a-zA-Z0-9.]+` is enough to
/// rule out path traversal.
async fn cover_serve_handler(
    AxumState(srv): AxumState<StreamServer>,
    Path(filename): Path<String>,
    req: Request,
) -> Response {
    if filename.is_empty()
        || filename.len() > 64
        || !filename
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.')
        || filename.contains("..")
    {
        return (StatusCode::BAD_REQUEST, "invalid filename").into_response();
    }
    let path = srv.cover_dir.join(&filename);
    if !path.exists() {
        return (StatusCode::NOT_FOUND, "not cached").into_response();
    }
    let mut resp = ServeFile::new(&path)
        .oneshot(req)
        .await
        .map(|r| r.into_response())
        .unwrap_or_else(|e| {
            (StatusCode::INTERNAL_SERVER_ERROR, format!("serve: {e}")).into_response()
        });
    if resp.status().is_success() {
        // Filename is content-addressed (hash of the source URL), so
        // the bytes never change — let the webview cache aggressively.
        resp.headers_mut().insert(
            axum::http::header::CACHE_CONTROL,
            axum::http::HeaderValue::from_static("public, max-age=31536000, immutable"),
        );
    }
    resp
}

/// Generate an unguessable per-launch token used as a URL path prefix on
/// the local stream server. Stream and bridge tokens are independent 256-bit
/// values filled directly by the operating system CSPRNG.
fn generate_stream_token() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|error| format!("OS randomness unavailable: {error}"))?;
    let mut out = String::with_capacity(bytes.len() * 2);
    use std::fmt::Write as _;
    for byte in bytes {
        write!(&mut out, "{byte:02x}").expect("writing hex into String cannot fail");
    }
    Ok(out)
}

async fn start_stream_server(
    app: tauri::AppHandle,
    port_state: Arc<Mutex<Option<u16>>>,
    token_state: Arc<Mutex<Option<String>>>,
    web_player_token_state: Arc<Mutex<Option<String>>>,
    runtime_state: Arc<Mutex<Option<StreamServer>>>,
    offline_jobs: OfflineDownloadJobs,
    cache_dir: PathBuf,
    cover_dir: PathBuf,
    ytdlp_bin: PathBuf,
    web_player_state: web_player::WebPlayerState,
) {
    if let Err(e) = tokio::fs::create_dir_all(&cache_dir).await {
        eprintln!("[stream-server] mkdir {cache_dir:?}: {e}");
    }
    if let Err(e) = tokio::fs::create_dir_all(&cover_dir).await {
        eprintln!("[stream-server] mkdir {cover_dir:?}: {e}");
    }
    recover_cache_backups(&cache_dir).await;

    let server = StreamServer {
        app,
        cache_dir,
        cover_dir,
        downloads: Arc::new(Mutex::new(HashMap::new())),
        offline_file_ops: Arc::new(Mutex::new(())),
        ytdlp_bin,
        // Explicit playlist downloads are sequential. This native guard also
        // prevents future callers from fanning out extraction processes.
        limiter: Arc::new(Semaphore::new(1)),
        offline_jobs,
    };
    *runtime_state.lock().await = Some(server.clone());

    // Per-launch token as an unguessable path prefix. Baked into the base
    // URL (get_stream_base_url) and cover URLs (cache_cover), so it's
    // transparent to the webview but blocks blind access from a web page
    // that only knows the random port.
    let token = match generate_stream_token() {
        Ok(token) => token,
        Err(error) => {
            eprintln!("[stream-server] {error}");
            return;
        }
    };
    let web_player_token = match generate_stream_token() {
        Ok(token) => token,
        Err(error) => {
            eprintln!("[stream-server] {error}");
            return;
        }
    };
    *token_state.lock().await = Some(token.clone());
    *web_player_token_state.lock().await = Some(web_player_token.clone());

    let bridge_app = server.app.clone();
    let routes = Router::new()
        .route("/stream/:video_id", get(stream_handler))
        .route("/cover/:filename", get(cover_serve_handler))
        .with_state(server)
        .layer(CorsLayer::permissive());
    let bridge_routes = web_player::bridge_router(bridge_app, web_player_state);
    let app = Router::new()
        .nest(&format!("/{token}"), routes)
        .nest(&format!("/{web_player_token}"), bridge_routes);

    let addr = SocketAddr::new(IpAddr::V4(Ipv4Addr::new(127, 0, 0, 1)), 0);
    let listener = match tokio::net::TcpListener::bind(addr).await {
        Ok(l) => l,
        Err(e) => {
            eprintln!("[stream-server] bind failed: {e}");
            return;
        }
    };
    let port = match listener.local_addr() {
        Ok(a) => a.port(),
        Err(e) => {
            eprintln!("[stream-server] local_addr failed: {e}");
            return;
        }
    };
    *port_state.lock().await = Some(port);
    eprintln!("[stream-server] listening on 127.0.0.1:{port}");

    if let Err(e) = axum::serve(listener, app).await {
        eprintln!("[stream-server] serve error: {e}");
    }
}

/// Show + focus the main window (from tray click or single-instance
/// re-launch).
fn show_main_window(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

/// App icon for runtime surfaces (tray, taskbar). Debug builds get an
/// orange variant of the logo so a dev instance running next to an
/// installed release is distinguishable at a glance; release builds use
/// the bundled (red) icon.
fn runtime_icon(app: &tauri::AppHandle) -> tauri::image::Image<'static> {
    #[cfg(debug_assertions)]
    {
        if let Ok(icon) = tauri::image::Image::from_bytes(include_bytes!("../icons/icon-dev.png")) {
            return icon;
        }
    }
    app.default_window_icon()
        .cloned()
        .expect("bundled window icon missing")
        .to_owned()
}

fn build_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    let show_item = MenuItem::with_id(app, "show", "Show Goosic", true, None::<&str>)?;
    let play_item = MenuItem::with_id(app, "play_pause", "Play / Pause", true, Some("Space"))?;
    let prev_item = MenuItem::with_id(app, "prev", "Previous", true, None::<&str>)?;
    let next_item = MenuItem::with_id(app, "next", "Next", true, None::<&str>)?;
    let sep = tauri::menu::PredefinedMenuItem::separator(app)?;
    let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;

    let menu = Menu::with_items(
        app,
        &[
            &show_item, &sep, &play_item, &prev_item, &next_item, &sep, &quit_item,
        ],
    )?;

    let _tray = TrayIconBuilder::with_id("main-tray")
        .icon(runtime_icon(app))
        .tooltip(if cfg!(debug_assertions) {
            "Goosic (dev)"
        } else {
            "Goosic"
        })
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => show_main_window(app),
            "play_pause" => {
                let _ = app.emit("tray-action", "play_pause");
            }
            "prev" => {
                let _ = app.emit("tray-action", "prev");
            }
            "next" => {
                let _ = app.emit("tray-action", "next");
            }
            "quit" => {
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            // Left-click the icon = show the window.
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Register + pin the app's Windows identity (AppUserModelID) so the SMTC
    // media tile (and notifications, taskbar) resolve to "Goosic" + icon rather
    // than "Unknown app". Must run before any window is created. No-op off
    // Windows.
    appid::init();

    let state = StreamServerState::default();
    let port_handle = state.port.clone();
    let token_handle = state.token.clone();
    let web_player_token_handle = state.web_player_token.clone();
    let stream_runtime_handle = state.runtime.clone();
    let offline_jobs_handle = state.offline_jobs.clone();
    let web_player_state = web_player::WebPlayerState::default();
    let web_player_server_state = web_player_state.clone();

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            show_main_window(app);
        }))
        .plugin(
            // Default StateFlags includes DECORATIONS, which would
            // override our `decorations: false` from tauri.conf.json
            // every time the saved state is restored. Exclude it.
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::all()
                        & !tauri_plugin_window_state::StateFlags::DECORATIONS,
                )
                // Never persist or restore the hidden session-keeper windows.
                // Their saved "visible: true" + on-screen position was being
                // replayed on the next launch, popping a stray
                // music.youtube.com window into view until the user minimized
                // it. Keeping them out of the store lets their builder flags
                // (hidden, off-screen) hold on every launch.
                .with_filter(|label| !label.starts_with("keeper-") && label != "youtube-player")
                .build(),
        )
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .manage(state)
        .manage(web_player_state)
        .manage(CloseBehavior::default())
        .manage(JarWriteLock::default())
        .manage(AccountSessionGuard::default())
        .manage(RefreshGuard::default())
        .manage(discord::spawn())
        .manage(lastfm::LastfmState::default())
        .invoke_handler(tauri::generate_handler![
            ensure_ytdlp,
            get_stream_base_url,
            start_offline_download,
            cancel_offline_download,
            list_offline_downloads,
            web_player_load,
            web_player_control,
            web_player_reset,
            web_player_health,
            start_login,
            get_cookie_header,
            get_auth_context,
            merge_response_cookies,
            is_logged_in,
            refresh_active_session,
            clear_cookies,
            list_accounts,
            switch_account,
            remove_account,
            update_account_meta,
            set_account_channel,
            get_active_account_id,
            list_cache,
            delete_cache_entries,
            mark_offline_file_unplayable,
            cache_cover,
            cover_cache_stats,
            clear_cover_cache,
            quit_app,
            set_close_behavior,
            autostart_set,
            autostart_is_enabled,
            notify_track,
            get_cache_dir,
            set_cache_dir,
            pick_cache_folder,
            focus_main_window,
            open_player_window,
            close_player_window,
            media::media_update,
            media::media_clear,
            discord::discord_update,
            discord::discord_clear,
            discord::discord_set_enabled,
            lastfm::lastfm_is_configured,
            lastfm::lastfm_begin_auth,
            lastfm::lastfm_poll_session,
            lastfm::lastfm_user_info,
            lastfm::lastfm_update_now_playing,
            lastfm::lastfm_scrobble,
            lastfm::lastfm_love,
            lastfm::lastfm_flush,
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                match window.label() {
                    // Main window: hide to tray or quit, per the user's
                    // Settings choice (default tray). Quit goes through
                    // an explicit exit — just letting the close proceed
                    // could leave a floating-player window keeping the
                    // process alive headless.
                    "main" => {
                        let quit = window
                            .state::<CloseBehavior>()
                            .quit_on_close
                            .load(Ordering::Relaxed);
                        if quit {
                            window.app_handle().exit(0);
                        } else {
                            let _ = window.hide();
                            api.prevent_close();
                        }
                    }
                    // The floating player window actually closes — we
                    // tell the main window so it can revert the layout
                    // mode back to "right".
                    "player" => {
                        let _ = window.app_handle().emit("player-window-closed", ());
                    }
                    _ => {}
                }
            }
        })
        .setup(move |app| {
            let port = port_handle.clone();
            let token = token_handle.clone();
            let web_player_token = web_player_token_handle.clone();
            let stream_runtime = stream_runtime_handle.clone();
            let offline_jobs = offline_jobs_handle.clone();
            // User-chosen cache root (Settings → Storage) or the OS
            // default. Captured once and exposed as managed state so
            // every cache-path computation matches the directories the
            // stream server is about to bind — a preference change made
            // later only applies after relaunch.
            let cache_root =
                stored_cache_root(app.handle()).unwrap_or_else(|| default_cache_root(app.handle()));
            let legacy_stream_dir = legacy_cache_root(app.handle()).map(|root| root.join("stream"));
            app.manage(ActiveCacheRoot(cache_root.clone()));
            // Retry any scrobbles stranded offline on the previous run. Spawns
            // its own task; a no-op when Last.fm isn't configured or the queue
            // is empty. See src/lastfm.rs.
            lastfm::flush_on_startup(app.handle().clone());
            let cache_dir = cache_root.join("stream");
            let handle = app.handle().clone();
            let cover_dir = cover_cache_dir(&handle);
            eprintln!("[stream-server] cache dir: {cache_dir:?}");
            eprintln!("[stream-server] cover dir: {cover_dir:?}");
            let ytdlp_bin = ytdlp::managed_path(&handle);
            tauri::async_runtime::spawn(async move {
                migrate_plaintext_cookies(&handle).await;
                migrate_to_accounts_layout(&handle).await;
                // Heal any duplicate account rows left by the old
                // email-based dedup before the UI reads the list.
                dedup_accounts_by_identity(&handle).await;
                cleanup_login_artifacts(&handle).await;
                if let Some(legacy_stream_dir) = legacy_stream_dir.as_deref() {
                    import_legacy_offline_files(legacy_stream_dir, &cache_dir).await;
                }
                start_stream_server(
                    handle.clone(),
                    port,
                    token,
                    web_player_token,
                    stream_runtime,
                    offline_jobs,
                    cache_dir,
                    cover_dir,
                    ytdlp_bin,
                    web_player_server_state,
                )
                .await;
            });
            // Keep the active account's replayed cookie snapshot fresh.
            // Google leashes *extracted* cookies to ~2h; reloading the
            // hidden session-keeper every 20 min renews the bound session
            // well inside that window, so the library never silently
            // empties mid-session.
            // Accounts with no persisted profile (added before this
            // feature) are skipped until the user signs in again.
            let refresh_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                // Let migrations + the stream server settle, and give a
                // just-completed login time to persist its profile.
                tokio::time::sleep(Duration::from_secs(20)).await;
                loop {
                    let idx = read_index(&refresh_handle).await;
                    if let Some(active) = idx.active {
                        if account_webview_dir(&refresh_handle, &active).exists() {
                            match refresh_account_cookies(&refresh_handle, &active).await {
                                Ok(()) => eprintln!("[refresh] renewed active account snapshot"),
                                Err(e) => {
                                    eprintln!("[refresh] active account refresh failed: {e}")
                                }
                            }
                        }
                    }
                    tokio::time::sleep(Duration::from_secs(20 * 60)).await;
                }
            });
            // OS media controls (the Windows SMTC tile in Quick Settings / the
            // volume flyout, plus the hardware media keys). setup() runs on the
            // main thread, which souvlaki requires and where the main window's
            // HWND is available.
            media::init(app.handle());
            if let Err(e) = build_tray(app.handle()) {
                eprintln!("[tray] build failed: {e}");
            }
            // Debug builds swap the taskbar/window icon to the orange
            // dev variant (see runtime_icon) so a dev instance is
            // instantly distinguishable from an installed release.
            #[cfg(debug_assertions)]
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.set_icon(runtime_icon(app.handle()));
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|_app, event| {
        if matches!(event, tauri::RunEvent::Exit) {
            pot_provider::shutdown_now();
        }
    });
}

#[cfg(test)]
mod tests {
    use super::{
        audio_mime_from_header, auth_snapshot_is_current, classify_ytdlp_failure,
        cooldown_remaining_at, generate_stream_token, import_legacy_offline_files,
        install_cached_audio, is_playable_offline_audio, is_valid_cached_audio,
        offline_download_cooldown_message, offline_invalid_marker, recover_cache_backups,
        requests_cache_only, should_retry_after_provider_failure, summarize_ytdlp_stderr,
        validate_account_signin_url, validate_page_id, wait_for_web_player_bridge, Account,
        AccountsIndex, StreamServerState, YtdlpFailureKind, OFFLINE_DOWNLOAD_COOLDOWN,
        YTDLP_OFFLINE_RETRY_ARGS,
    };
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use axum::routing::get;
    use axum::Router;
    use tower::ServiceExt;

    #[test]
    fn stream_token_is_nonempty_hex_and_varies() {
        let a = generate_stream_token().unwrap();
        let b = generate_stream_token().unwrap();
        assert_eq!(a.len(), 64, "token should be 256 bits of hex");
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(a, b, "two tokens in a row must differ");
    }

    #[tokio::test]
    async fn web_player_bridge_waits_through_cold_start() {
        let state = StreamServerState::default();
        let port = state.port.clone();
        let token = state.web_player_token.clone();
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
            *port.lock().await = Some(43123);
            *token.lock().await = Some("bridge-secret".into());
        });

        assert_eq!(
            wait_for_web_player_bridge(&state).await.unwrap(),
            (43123, "bridge-secret".into())
        );
    }

    #[test]
    fn account_signin_url_validation_is_strict_and_opaque() {
        let valid =
            "https://www.youtube.com/signin?action_handle_signin=true&pageid=123%2B456&next=%2F";
        let parsed = validate_account_signin_url(valid).unwrap();
        assert_eq!(parsed.as_str(), valid);

        for invalid in [
            "http://www.youtube.com/signin?pageid=123",
            "https://youtube.com/signin?pageid=123",
            "https://www.youtube.com:444/signin?pageid=123",
            "https://user@www.youtube.com/signin?pageid=123",
            "https://www.youtube.com/signin/?pageid=123",
            "https://www.youtube.com/watch?pageid=123",
            "https://www.youtube.com/signin?pageid=123#fragment",
            " https://www.youtube.com/signin?pageid=123",
            "https://www.youtube.com/signin?page id=123",
        ] {
            assert!(validate_account_signin_url(invalid).is_err(), "{invalid}");
        }
    }

    #[test]
    fn page_id_validation_rejects_empty_or_scriptable_values() {
        assert!(validate_page_id(None));
        assert!(validate_page_id(Some("108031863270526872265")));
        assert!(!validate_page_id(Some("")));
        assert!(!validate_page_id(Some("page id")));
        assert!(!validate_page_id(Some("x');alert(1)//")));
    }

    #[test]
    fn cookie_merge_snapshot_is_bound_to_account_and_epoch() {
        let index = AccountsIndex {
            active: Some("account-a".into()),
            accounts: vec![
                Account {
                    id: "account-a".into(),
                    ..Default::default()
                },
                Account {
                    id: "account-b".into(),
                    ..Default::default()
                },
            ],
        };
        assert!(auth_snapshot_is_current(&index, "account-a", 7, 7));
        assert!(!auth_snapshot_is_current(&index, "account-b", 7, 7));
        assert!(!auth_snapshot_is_current(&index, "account-a", 6, 7));
        assert!(!auth_snapshot_is_current(&index, "missing", 7, 7));
    }

    #[test]
    fn cache_only_flag_is_explicit_and_order_independent() {
        let with_flag = Request::builder()
            .uri("/stream/E7LVi1AA218?ephemeral=1&cache_only=true")
            .body(Body::empty())
            .unwrap();
        let without_flag = Request::builder()
            .uri("/stream/E7LVi1AA218?ephemeral=1")
            .body(Body::empty())
            .unwrap();
        assert!(requests_cache_only(&with_flag));
        assert!(!requests_cache_only(&without_flag));
    }

    fn unique_cache_test_dir(label: &str) -> std::path::PathBuf {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("goosic-{label}-{}-{nonce}", std::process::id()))
    }

    fn valid_webm_bytes() -> Vec<u8> {
        let mut bytes = vec![0; super::MIN_AUDIO_BYTES as usize];
        bytes[..4].copy_from_slice(&[0x1a, 0x45, 0xdf, 0xa3]);
        bytes
    }

    #[tokio::test]
    async fn failed_replacement_restores_the_old_download() {
        let dir = unique_cache_test_dir("replace");
        tokio::fs::create_dir_all(&dir).await.unwrap();
        let final_path = dir.join("E7LVi1AA218.webm");
        tokio::fs::write(&final_path, valid_webm_bytes())
            .await
            .unwrap();

        let result = install_cached_audio(&dir.join("missing.part"), &final_path).await;

        assert!(result.is_err());
        assert!(is_valid_cached_audio(&final_path).await);
        assert!(!dir.join("E7LVi1AA218.webm.backup").exists());
        let _ = tokio::fs::remove_dir_all(&dir).await;
    }

    #[tokio::test]
    async fn startup_recovers_an_interrupted_cache_backup() {
        let dir = unique_cache_test_dir("recover");
        tokio::fs::create_dir_all(&dir).await.unwrap();
        let final_path = dir.join("E7LVi1AA218.webm");
        let backup_path = dir.join("E7LVi1AA218.webm.backup");
        tokio::fs::write(&final_path, b"interrupted").await.unwrap();
        tokio::fs::write(&backup_path, valid_webm_bytes())
            .await
            .unwrap();

        recover_cache_backups(&dir).await;

        assert!(is_valid_cached_audio(&final_path).await);
        assert!(!backup_path.exists());
        let _ = tokio::fs::remove_dir_all(&dir).await;
    }

    #[tokio::test]
    async fn decoder_failure_marker_preserves_bytes_and_requires_repair() {
        let dir = unique_cache_test_dir("decoder-marker");
        tokio::fs::create_dir_all(&dir).await.unwrap();
        let video_id = "E7LVi1AA218";
        let final_path = dir.join(format!("{video_id}.webm"));
        tokio::fs::write(&final_path, valid_webm_bytes())
            .await
            .unwrap();

        assert!(is_playable_offline_audio(&dir, video_id).await);
        tokio::fs::write(offline_invalid_marker(&dir, video_id), b"unplayable")
            .await
            .unwrap();

        assert!(
            final_path.exists(),
            "the user's download must remain intact"
        );
        assert!(is_valid_cached_audio(&final_path).await);
        assert!(!is_playable_offline_audio(&dir, video_id).await);

        tokio::fs::remove_file(offline_invalid_marker(&dir, video_id))
            .await
            .unwrap();
        assert!(is_playable_offline_audio(&dir, video_id).await);
        let _ = tokio::fs::remove_dir_all(&dir).await;
    }

    #[tokio::test]
    async fn legacy_download_import_is_non_destructive_and_never_overwrites() {
        let source = unique_cache_test_dir("legacy-source");
        let target = unique_cache_test_dir("durable-target");
        tokio::fs::create_dir_all(&source).await.unwrap();
        tokio::fs::create_dir_all(&target).await.unwrap();
        let name = "E7LVi1AA218.webm";
        tokio::fs::write(source.join(name), valid_webm_bytes())
            .await
            .unwrap();
        tokio::fs::write(target.join(name), b"keep-target")
            .await
            .unwrap();
        tokio::fs::write(source.join("E7LVi1AA218.meta.json"), b"{}")
            .await
            .unwrap();
        tokio::fs::write(source.join("E7LVi1AA218.invalid"), b"stale")
            .await
            .unwrap();
        tokio::fs::write(source.join("abcdefghijk.webm"), valid_webm_bytes())
            .await
            .unwrap();
        tokio::fs::write(source.join("abcdefghijk.meta.json"), b"{}")
            .await
            .unwrap();
        tokio::fs::write(source.join("ignored.part"), b"partial")
            .await
            .unwrap();

        import_legacy_offline_files(&source, &target).await;

        assert!(source.join(name).exists(), "legacy bytes must be preserved");
        assert_eq!(
            tokio::fs::read(target.join(name)).await.unwrap(),
            b"keep-target"
        );
        assert!(!target.join("E7LVi1AA218.meta.json").exists());
        assert!(!target.join("E7LVi1AA218.invalid").exists());
        assert!(target.join("abcdefghijk.webm").exists());
        assert!(target.join("abcdefghijk.meta.json").exists());
        assert!(!target.join("ignored.part").exists());
        let _ = tokio::fs::remove_dir_all(&source).await;
        let _ = tokio::fs::remove_dir_all(&target).await;
    }

    #[test]
    fn supported_audio_magic_maps_to_browser_mime_types() {
        assert_eq!(
            audio_mime_from_header(&[0, 0, 0, 0, b'f', b't', b'y', b'p']),
            Some("audio/mp4")
        );
        assert_eq!(
            audio_mime_from_header(&[0x1a, 0x45, 0xdf, 0xa3]),
            Some("audio/webm")
        );
        assert_eq!(audio_mime_from_header(b"OggS"), Some("audio/ogg"));
        assert_eq!(audio_mime_from_header(b"<html>blocked"), None);
    }

    #[test]
    fn resolver_error_summary_keeps_actionable_tail() {
        let stderr = b"warning one\nwarning two\nwarning three\nwarning four\nERROR: Sign in to confirm you're not a bot\n";
        let summary = summarize_ytdlp_stderr(stderr);
        assert!(summary.contains("ERROR: Sign in to confirm you're not a bot"));
        assert!(!summary.contains("warning one"));
    }

    #[test]
    fn resolver_error_summary_drops_session_credentials() {
        let stderr = b"WARNING: Missing required Visitor Data: secret\nWARNING: po_token=secret\nWARNING: https://rr1---sn.example.googlevideo.com/videoplayback?token=secret\nAuthorization: Bearer secret\nERROR: HTTP Error 429: Too Many Requests\n";
        let summary = summarize_ytdlp_stderr(stderr);
        assert!(!summary.to_ascii_lowercase().contains("visitor"));
        assert!(!summary.to_ascii_lowercase().contains("po_token"));
        assert!(!summary.to_ascii_lowercase().contains("googlevideo"));
        assert!(!summary.to_ascii_lowercase().contains("bearer"));
        assert!(summary.contains("HTTP Error 429"));
    }

    #[test]
    fn raw_rate_limit_classifier_survives_display_redaction() {
        let with_help_url = b"ERROR: Sign in to confirm you're not a bot. Use https://github.com/yt-dlp/yt-dlp/wiki/FAQ for help\n";
        assert_eq!(
            classify_ytdlp_failure(with_help_url),
            YtdlpFailureKind::RateLimited
        );
        assert_eq!(
            summarize_ytdlp_stderr(with_help_url),
            "yt-dlp produced no audio",
            "the credential-safe display path may drop URL-bearing lines"
        );
        assert_eq!(
            classify_ytdlp_failure(b"HTTP Error 429: Too Many Requests"),
            YtdlpFailureKind::RateLimited
        );
        assert_eq!(
            classify_ytdlp_failure(b"ERROR: requested format is not available"),
            YtdlpFailureKind::Other
        );
    }

    #[test]
    fn offline_downloads_disable_internal_retries() {
        assert_eq!(
            YTDLP_OFFLINE_RETRY_ARGS,
            ["--retries", "0", "--extractor-retries", "0"]
        );
    }

    #[test]
    fn only_an_unhealthy_used_provider_unlocks_the_single_recovery_retry() {
        assert!(should_retry_after_provider_failure(
            true,
            YtdlpFailureKind::Other,
            true,
            false,
        ));
        assert!(!should_retry_after_provider_failure(
            true,
            YtdlpFailureKind::RateLimited,
            true,
            false,
        ));
        assert!(!should_retry_after_provider_failure(
            true,
            YtdlpFailureKind::Other,
            true,
            true,
        ));
        assert!(!should_retry_after_provider_failure(
            false,
            YtdlpFailureKind::Other,
            true,
            false,
        ));
        assert!(!should_retry_after_provider_failure(
            true,
            YtdlpFailureKind::Other,
            false,
            false,
        ));
    }

    #[test]
    fn rate_limit_cooldown_expires_only_after_fifteen_minutes() {
        let now = 1_700_000_000;
        let until = now + OFFLINE_DOWNLOAD_COOLDOWN.as_secs();
        assert_eq!(
            cooldown_remaining_at(until, now),
            Some(15 * 60),
            "the persisted deadline must survive as a full cooldown"
        );
        assert!(offline_download_cooldown_message(61).contains("2 minutes"));
        assert_eq!(cooldown_remaining_at(until, until), None);
        assert_eq!(cooldown_remaining_at(until, until + 1), None);
    }

    // Guards the security fix (review high #1): the stream server nests all
    // routes under an unguessable per-launch token prefix, so a request that
    // doesn't carry the exact token can't reach a handler.
    #[test]
    fn nested_token_prefix_gates_routes() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let token = "deadbeefdeadbeefdeadbeefdeadbeef";
            let inner = Router::new().route("/ping", get(|| async { "pong" }));
            let app: Router = Router::new().nest(&format!("/{token}"), inner);

            let status = |uri: &'static str, app: Router| async move {
                app.oneshot(Request::builder().uri(uri).body(Body::empty()).unwrap())
                    .await
                    .unwrap()
                    .status()
            };

            assert_eq!(
                status("/deadbeefdeadbeefdeadbeefdeadbeef/ping", app.clone()).await,
                StatusCode::OK,
                "correct token reaches the handler"
            );
            assert_eq!(
                status("/wrongtoken/ping", app.clone()).await,
                StatusCode::NOT_FOUND,
                "a wrong token must not reach the handler"
            );
            assert_eq!(
                status("/ping", app).await,
                StatusCode::NOT_FOUND,
                "no token must not reach the handler"
            );
        });
    }

    use super::merge_set_cookies_into_jar;

    const NOW: i64 = 1_700_000_000;
    const HOST: &str = "music.youtube.com";

    fn jar() -> String {
        "# Netscape HTTP Cookie File\n\
         .youtube.com\tTRUE\t/\tTRUE\t1800000000\tSAPISID\told-sapisid\n\
         .youtube.com\tTRUE\t/\tTRUE\t1800000000\tSIDCC\told-sidcc\n"
            .to_string()
    }

    #[test]
    fn merge_replaces_rotated_value() {
        let lines = vec![
            "SIDCC=new-sidcc; Domain=.youtube.com; Path=/; Secure; Max-Age=31536000".to_string(),
        ];
        let (out, changed, dirty) = merge_set_cookies_into_jar(&jar(), &lines, HOST, NOW);
        assert!(changed && dirty);
        assert!(out.contains("SIDCC\tnew-sidcc"));
        assert!(!out.contains("old-sidcc"));
        assert!(
            out.contains("SAPISID\told-sapisid"),
            "untouched cookie survives"
        );
    }

    #[test]
    fn merge_inserts_new_cookie_with_domain() {
        let lines = vec![
            "LOGIN_INFO=abc; Domain=.youtube.com; Path=/; Secure; HttpOnly; Max-Age=63072000"
                .to_string(),
        ];
        let (out, changed, _) = merge_set_cookies_into_jar(&jar(), &lines, HOST, NOW);
        assert!(changed);
        assert!(out.contains(".youtube.com\tTRUE\t/\tTRUE\t1763072000\tLOGIN_INFO\tabc"));
    }

    #[test]
    fn merge_inserts_host_only_cookie_under_response_host() {
        let lines = vec!["PZS=1; Path=/; Secure; Max-Age=600".to_string()];
        let (out, changed, _) = merge_set_cookies_into_jar(&jar(), &lines, HOST, NOW);
        assert!(changed);
        assert!(out.contains(".music.youtube.com\tTRUE\t/\tTRUE"));
    }

    #[test]
    fn merge_removes_expired_cookie() {
        let lines = vec!["SIDCC=gone; Domain=.youtube.com; Path=/; Max-Age=0".to_string()];
        let (out, changed, _) = merge_set_cookies_into_jar(&jar(), &lines, HOST, NOW);
        assert!(changed);
        assert!(!out.contains("SIDCC"));
    }

    #[test]
    fn merge_ignores_foreign_domains() {
        let lines = vec![
            "tracker=1; Domain=.example.com; Path=/; Max-Age=1000".to_string(),
            "__cf_bm=x; Domain=.genius.com; Path=/; Max-Age=1000".to_string(),
        ];
        let (out, changed, dirty) = merge_set_cookies_into_jar(&jar(), &lines, HOST, NOW);
        assert!(!changed && !dirty);
        assert_eq!(out, jar(), "jar must be untouched");
    }

    #[test]
    fn merge_expiry_only_refresh_persists_without_cache_reset() {
        let lines = vec![
            "SIDCC=old-sidcc; Domain=.youtube.com; Path=/; Secure; Max-Age=31536000".to_string(),
        ];
        let (out, changed, dirty) = merge_set_cookies_into_jar(&jar(), &lines, HOST, NOW);
        assert!(!changed, "same value must not invalidate the header cache");
        assert!(dirty, "but the fresher expiry should be written");
        assert!(out.contains(&format!("{}", NOW + 31_536_000)));
    }
}
