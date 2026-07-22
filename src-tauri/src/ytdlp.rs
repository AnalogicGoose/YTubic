//! Managed yt-dlp binary lifecycle.
//!
//! End users don't have yt-dlp on PATH, so the app owns its copy: the
//! official single-file release is downloaded into
//! `<app-data>/bin/yt-dlp.exe` on first run and self-updated via
//! `yt-dlp -U` on a 72-hour cadence. The managed copy is canonical —
//! PATH is only a fallback for dev machines while the download hasn't
//! happened (or failed).
//!
//! Streaming resilience depends on this: YouTube regularly breaks
//! extractors and yt-dlp ships fixes within days, so the binary must
//! update on its own schedule, not the app's release schedule. Current
//! YouTube challenge solving also needs an external JavaScript runtime;
//! the app atomically installs and periodically refreshes official Deno.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tauri::{Emitter, Manager};
use tokio::io::AsyncWriteExt;

#[cfg(windows)]
const BINARY_NAME: &str = "yt-dlp.exe";
#[cfg(not(windows))]
const BINARY_NAME: &str = "yt-dlp";

#[cfg(windows)]
const DENO_BINARY_NAME: &str = "deno.exe";
#[cfg(not(windows))]
const DENO_BINARY_NAME: &str = "deno";

/// Official single-file builds. The `latest/download/` URL redirects to
/// the newest release asset, so no GitHub API call (and no rate limit)
/// is involved.
#[cfg(windows)]
const DOWNLOAD_URL: &str = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe";
#[cfg(target_os = "macos")]
const DOWNLOAD_URL: &str = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos";
#[cfg(all(unix, not(target_os = "macos")))]
const DOWNLOAD_URL: &str = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp";

/// How often to let the managed binary check for its own update.
const UPDATE_INTERVAL: Duration = Duration::from_secs(72 * 60 * 60);
/// Hard cap on the `-U` self-update run.
const UPDATE_TIMEOUT: Duration = Duration::from_secs(180);
/// Hard cap on the first-run download (the exe is ~12 MB).
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(10 * 60);
/// Deno is larger than yt-dlp, but a stalled first-run runtime download must
/// not remain alive indefinitely. Playback still degrades to the non-JS
/// clients when this best-effort download fails.
const DENO_DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(90);
/// Deno's challenge-runtime API is stable. A 90-day cadence avoids silently
/// redownloading a ~50 MB archive every month while still retiring old runtimes.
const DENO_UPDATE_INTERVAL: Duration = Duration::from_secs(90 * 24 * 60 * 60);
/// After a failed first install, keep per-track resolves on the non-JS client
/// fallback instead of re-downloading the archive for every song.
const DENO_RETRY_BACKOFF: Duration = Duration::from_secs(5 * 60);

static YTDLP_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
static DENO_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
static DENO_RETRY_AFTER: AtomicU64 = AtomicU64::new(0);

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Where the managed binary lives for this install.
pub fn managed_path(app: &tauri::AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir())
        .join("bin")
        .join(BINARY_NAME)
}

/// The managed JavaScript runtime lives beside yt-dlp. Current YouTube
/// extraction needs an external runtime to solve signature and `n` challenges;
/// the official yt-dlp executable bundles the solver scripts, but not Deno.
pub fn managed_deno_path(managed_ytdlp: &Path) -> PathBuf {
    managed_ytdlp
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join(DENO_BINARY_NAME)
}

/// Official Deno release archive for the current target. Goosic's published
/// targets are covered explicitly; an unusual development architecture simply
/// runs explicit downloads without the managed runtime when possible.
fn deno_download_url() -> Option<&'static str> {
    #[cfg(all(windows, target_arch = "x86_64"))]
    {
        return Some(
            "https://github.com/denoland/deno/releases/latest/download/deno-x86_64-pc-windows-msvc.zip",
        );
    }
    #[cfg(all(windows, target_arch = "aarch64"))]
    {
        return Some(
            "https://github.com/denoland/deno/releases/latest/download/deno-aarch64-pc-windows-msvc.zip",
        );
    }
    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    {
        return Some(
            "https://github.com/denoland/deno/releases/latest/download/deno-x86_64-apple-darwin.zip",
        );
    }
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        return Some(
            "https://github.com/denoland/deno/releases/latest/download/deno-aarch64-apple-darwin.zip",
        );
    }
    #[cfg(all(target_os = "linux", target_arch = "x86_64", not(target_env = "musl")))]
    {
        return Some(
            "https://github.com/denoland/deno/releases/latest/download/deno-x86_64-unknown-linux-gnu.zip",
        );
    }
    #[cfg(all(target_os = "linux", target_arch = "aarch64", not(target_env = "musl")))]
    {
        return Some(
            "https://github.com/denoland/deno/releases/latest/download/deno-aarch64-unknown-linux-gnu.zip",
        );
    }
    #[allow(unreachable_code)]
    None
}

fn youtube_player_clients(has_js_runtime: bool) -> &'static str {
    if has_js_runtime {
        // The TV client increasingly returns DRM-only formats and adds a full
        // player request without yielding playable audio. Android VR remains
        // the lightweight anonymous path; Safari supplies challenge-protected
        // formats when the managed Deno runtime is available.
        "youtube:player_client=android_vr,web_safari"
    } else {
        "youtube:player_client=android_vr"
    }
}

/// Arguments shared by every explicit offline-download invocation. Keeping
/// player selection here prevents setup and download paths from silently using
/// different challenge capabilities.
pub fn youtube_runtime_args(
    managed_ytdlp: &Path,
    provider: Option<(&Path, &str)>,
) -> Vec<OsString> {
    let deno = managed_deno_path(managed_ytdlp);
    let has_deno = deno.is_file();
    // Goosic's explicit downloader must be hermetic in both provider and
    // fallback modes. A user's yt-dlp config or globally installed plugin can
    // otherwise add cookies, change clients, or load unverified code.
    let mut args = vec![
        OsString::from("--ignore-config"),
        OsString::from("--no-plugin-dirs"),
    ];
    if let Some((plugin_dir, base_url)) = provider {
        // Load only the pinned, checksum-verified package. User/global yt-dlp
        // plugin directories are intentionally excluded from Goosic downloads.
        args.push(OsString::from("--plugin-dirs"));
        args.push(plugin_dir.as_os_str().to_owned());
        args.push(OsString::from("--extractor-args"));
        args.push(OsString::from("youtube:player_client=mweb"));
        args.push(OsString::from("--extractor-args"));
        args.push(OsString::from(format!(
            "youtubepot-bgutilhttp:base_url={base_url}"
        )));
    } else {
        args.push(OsString::from("--extractor-args"));
        args.push(OsString::from(youtube_player_clients(has_deno)));
    }
    if has_deno {
        args.push(OsString::from("--js-runtimes"));
        let mut runtime = OsString::from("deno:");
        runtime.push(deno.as_os_str());
        args.push(runtime);
    }
    args
}

pub(crate) fn emit_state(app: &tauri::AppHandle, phase: &str, message: Option<String>) {
    let _ = app.emit(
        "ytdlp-state",
        serde_json::json!({ "phase": phase, "message": message }),
    );
}

/// Idempotent "make yt-dlp available" entry point. Called only for an
/// explicit offline download and safe to re-invoke as a user retry.
///
/// Emits `ytdlp-state` events: `downloading` / `runtime` → `ready` | `error`.
pub async fn ensure(app: tauri::AppHandle) {
    let managed = managed_path(&app);
    let already_present = managed.is_file();
    if !already_present {
        emit_state(&app, "downloading", None);
    }

    match ensure_ytdlp_available(&app).await {
        Ok(program) => {
            // Current yt-dlp needs an external runtime for full YouTube
            // challenge support. Advertise this distinct phase so first-run
            // setup is not mistaken for a hung download. The playlist worker
            // joins the same lock and can use a limited fallback client if the
            // optional runtime installation fails.
            if program == managed {
                maybe_self_update(&managed).await;
            }
            let runtime_setup_needed = deno_needs_setup(&managed).await;
            if runtime_setup_needed {
                emit_state(
                    &app,
                    "runtime",
                    Some("Installing YouTube challenge runtime (Deno)".into()),
                );
            }
            let deno_ready = match ensure_deno(&managed, true).await {
                Ok(()) => true,
                Err(e) => {
                    eprintln!("[ytdlp] managed Deno unavailable (non-fatal): {e}");
                    false
                }
            };
            let mut ready_message = None;
            if deno_ready {
                if crate::pot_provider::needs_setup(&app) {
                    emit_state(
                        &app,
                        "provider",
                        Some("Installing managed YouTube PO-token provider".into()),
                    );
                }
                if let Err(error) = crate::pot_provider::ensure(&app, &managed, true).await {
                    eprintln!(
                        "[pot-provider] setup failed; download fallback remains available: {error}"
                    );
                    ready_message = Some(format!(
                        "PO-token provider unavailable; using fallback download clients: {error}"
                    ));
                }
            } else {
                ready_message = Some(
                    "YouTube challenge runtime unavailable; using fallback download clients".into(),
                );
            }
            emit_state(&app, "ready", ready_message);
        }
        Err(e) => {
            eprintln!("[ytdlp] setup failed: {e}");
            emit_state(&app, "error", Some(e));
        }
    }
}

/// Resolve a working yt-dlp program for an explicit playlist download,
/// downloading the managed executable when necessary.
pub async fn ensure_ytdlp_available(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let managed = managed_path(app);
    if probe_program(&managed).await {
        return Ok(managed);
    }

    // Serialize explicit setup/retry calls and double-check after acquiring
    // the lock.
    let _guard = YTDLP_LOCK.lock().await;
    if probe_program(&managed).await {
        return Ok(managed);
    }

    if managed.exists() {
        eprintln!("[ytdlp] managed binary failed --version; replacing it");
        let _ = tokio::fs::remove_file(&managed).await;
    }

    let path_program = PathBuf::from("yt-dlp");
    let path_works = probe_program(&path_program).await;
    match download(&managed).await {
        Ok(()) if probe_program(&managed).await => {
            eprintln!("[ytdlp] downloaded managed binary to {managed:?}");
            touch_update_stamp(&managed);
            Ok(managed)
        }
        Ok(()) => {
            let _ = tokio::fs::remove_file(&managed).await;
            if path_works {
                Ok(path_program)
            } else {
                Err("downloaded yt-dlp failed its --version check".into())
            }
        }
        Err(e) if path_works => {
            eprintln!("[ytdlp] managed download failed; using PATH copy: {e}");
            Ok(path_program)
        }
        Err(e) => Err(e),
    }
}

/// True when `program --version` starts, exits successfully, and does not hang.
async fn probe_program(program: &Path) -> bool {
    let mut cmd = tokio::process::Command::new(program);
    cmd.arg("--version");
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd.stdout(std::process::Stdio::null());
    cmd.stderr(std::process::Stdio::null());
    cmd.kill_on_drop(true);
    match tokio::time::timeout(Duration::from_secs(15), cmd.status()).await {
        Ok(Ok(s)) => s.success(),
        _ => false,
    }
}

/// Fetch the official binary into `<managed>.part`, then rename. The
/// .part indirection means a torn download never masquerades as a
/// working binary.
async fn download(managed: &Path) -> Result<(), String> {
    if let Some(dir) = managed.parent() {
        tokio::fs::create_dir_all(dir)
            .await
            .map_err(|e| format!("mkdir {dir:?}: {e}"))?;
    }
    let part = managed.with_extension("part");
    let _ = tokio::fs::remove_file(&part).await;

    let fetch = async {
        let resp = reqwest::get(DOWNLOAD_URL)
            .await
            .map_err(|e| format!("request: {e}"))?
            .error_for_status()
            .map_err(|e| format!("http: {e}"))?;
        let mut file = tokio::fs::File::create(&part)
            .await
            .map_err(|e| format!("create {part:?}: {e}"))?;
        let mut stream = resp;
        while let Some(chunk) = stream
            .chunk()
            .await
            .map_err(|e| format!("read body: {e}"))?
        {
            file.write_all(&chunk)
                .await
                .map_err(|e| format!("write: {e}"))?;
        }
        file.flush().await.map_err(|e| format!("flush: {e}"))?;
        Ok::<(), String>(())
    };

    match tokio::time::timeout(DOWNLOAD_TIMEOUT, fetch).await {
        Err(_) => {
            let _ = tokio::fs::remove_file(&part).await;
            return Err("download timed out".into());
        }
        Ok(Err(e)) => {
            let _ = tokio::fs::remove_file(&part).await;
            return Err(e);
        }
        Ok(Ok(())) => {}
    }

    // Sanity floor: the real exe is ~12 MB; a tiny payload is an error
    // page or a truncated body, not yt-dlp.
    const MIN_BINARY_BYTES: u64 = 1024 * 1024;
    let size = tokio::fs::metadata(&part)
        .await
        .map(|m| m.len())
        .unwrap_or(0);
    if size < MIN_BINARY_BYTES {
        let _ = tokio::fs::remove_file(&part).await;
        return Err(format!("downloaded file too small ({size} bytes)"));
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = tokio::fs::set_permissions(&part, std::fs::Permissions::from_mode(0o755)).await;
    }

    tokio::fs::rename(&part, managed)
        .await
        .map_err(|e| format!("rename: {e}"))
}

fn deno_update_stamp_path(managed: &Path) -> PathBuf {
    managed.with_file_name("last-deno-update-check")
}

fn deno_update_stamp_age(managed: &Path) -> Option<Duration> {
    let raw = std::fs::read_to_string(deno_update_stamp_path(managed)).ok()?;
    let then = raw.trim().parse::<u64>().ok()?;
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    Some(Duration::from_secs(now.saturating_sub(then)))
}

fn touch_deno_update_stamp(managed: &Path) {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let _ = std::fs::write(deno_update_stamp_path(managed), now.to_string());
}

/// Install (or occasionally refresh) Deno beside yt-dlp. This is deliberately
/// best-effort: an explicit download can retain android_vr when no runtime is
/// available, while a successful atomic install adds web_safari to the next
/// download without restarting Goosic.
async fn deno_needs_setup(managed_ytdlp: &Path) -> bool {
    let managed = managed_deno_path(managed_ytdlp);
    !probe_program(&managed).await
        || deno_update_stamp_age(&managed)
            .map(|age| age >= DENO_UPDATE_INTERVAL)
            .unwrap_or(true)
}

fn unix_now_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

fn deno_retry_is_delayed() -> bool {
    unix_now_seconds() < DENO_RETRY_AFTER.load(Ordering::Acquire)
}

fn delay_deno_retry() {
    DENO_RETRY_AFTER.store(
        unix_now_seconds().saturating_add(DENO_RETRY_BACKOFF.as_secs()),
        Ordering::Release,
    );
}

async fn ensure_deno(managed_ytdlp: &Path, refresh_existing: bool) -> Result<(), String> {
    let managed = managed_deno_path(managed_ytdlp);
    // A normal playlist-track download only needs to know whether the atomically
    // installed runtime exists. Candidates are validated before the swap, and
    // the scheduled launch-time refresh performs the executable probe.
    if !refresh_existing && managed.is_file() {
        return Ok(());
    }
    if deno_retry_is_delayed() {
        return Err("Deno setup recently failed; using fallback clients".into());
    }

    let Some(url) = deno_download_url() else {
        delay_deno_retry();
        return Err("no managed Deno build for this platform/architecture".into());
    };
    let working = probe_program(&managed).await;
    if working
        && (!refresh_existing
            || deno_update_stamp_age(&managed)
                .map(|age| age < DENO_UPDATE_INTERVAL)
                .unwrap_or(false))
    {
        return Ok(());
    }

    let _guard = DENO_LOCK.lock().await;
    if deno_retry_is_delayed() {
        return Err("Deno setup recently failed; using fallback clients".into());
    }
    let working = probe_program(&managed).await;
    if working
        && (!refresh_existing
            || deno_update_stamp_age(&managed)
                .map(|age| age < DENO_UPDATE_INTERVAL)
                .unwrap_or(false))
    {
        return Ok(());
    }

    match download_deno(url, &managed).await {
        Ok(()) => {
            DENO_RETRY_AFTER.store(0, Ordering::Release);
            touch_deno_update_stamp(&managed);
            eprintln!("[ytdlp] managed Deno ready at {managed:?}");
            Ok(())
        }
        // Never destroy a previously working runtime merely because its
        // scheduled refresh failed. The candidate is validated before swap.
        Err(e) if working => {
            DENO_RETRY_AFTER.store(0, Ordering::Release);
            touch_deno_update_stamp(&managed);
            eprintln!("[ytdlp] Deno refresh failed; keeping current runtime: {e}");
            Ok(())
        }
        Err(e) => {
            delay_deno_retry();
            Err(e)
        }
    }
}

/// Join first-run Deno setup before downloading a track. Failure is returned
/// to the caller so it can report a limited download fallback; online playback
/// is independent of this infrastructure.
pub async fn ensure_js_runtime(managed_ytdlp: &Path) -> Result<(), String> {
    ensure_deno(managed_ytdlp, false).await
}

async fn download_deno(url: &str, managed: &Path) -> Result<(), String> {
    if let Some(dir) = managed.parent() {
        tokio::fs::create_dir_all(dir)
            .await
            .map_err(|e| format!("mkdir {dir:?}: {e}"))?;
    }

    let archive_path = managed.with_file_name("deno-download.zip.part");
    #[cfg(windows)]
    let candidate = managed.with_file_name("deno.update.exe");
    #[cfg(not(windows))]
    let candidate = managed.with_file_name("deno.update");
    let _ = tokio::fs::remove_file(&archive_path).await;
    let _ = tokio::fs::remove_file(&candidate).await;

    let archive_for_fetch = archive_path.clone();
    let candidate_for_extract = candidate.clone();
    let install = async move {
        let mut resp = reqwest::get(url)
            .await
            .map_err(|e| format!("Deno request: {e}"))?
            .error_for_status()
            .map_err(|e| format!("Deno http: {e}"))?;
        let mut file = tokio::fs::File::create(&archive_for_fetch)
            .await
            .map_err(|e| format!("create {archive_for_fetch:?}: {e}"))?;
        let mut bytes_written = 0u64;
        while let Some(chunk) = resp
            .chunk()
            .await
            .map_err(|e| format!("read Deno archive: {e}"))?
        {
            bytes_written = bytes_written.saturating_add(chunk.len() as u64);
            file.write_all(&chunk)
                .await
                .map_err(|e| format!("write Deno archive: {e}"))?;
        }
        file.flush()
            .await
            .map_err(|e| format!("flush Deno archive: {e}"))?;
        drop(file);
        if bytes_written < 1024 * 1024 {
            return Err(format!(
                "downloaded Deno archive too small ({bytes_written} bytes)"
            ));
        }

        let archive = archive_for_fetch.clone();
        let output = candidate_for_extract.clone();
        tokio::task::spawn_blocking(move || -> Result<(), String> {
            let file = std::fs::File::open(&archive)
                .map_err(|e| format!("open Deno archive {archive:?}: {e}"))?;
            let mut zip = zip::ZipArchive::new(file).map_err(|e| format!("read Deno zip: {e}"))?;
            let mut entry = zip
                .by_name(DENO_BINARY_NAME)
                .map_err(|e| format!("Deno executable missing from archive: {e}"))?;
            if entry.is_dir() {
                return Err("Deno archive entry is a directory".into());
            }
            let mut out = std::fs::File::create(&output)
                .map_err(|e| format!("create Deno candidate {output:?}: {e}"))?;
            std::io::copy(&mut entry, &mut out)
                .map_err(|e| format!("extract Deno executable: {e}"))?;
            out.sync_all()
                .map_err(|e| format!("sync Deno executable: {e}"))?;
            Ok(())
        })
        .await
        .map_err(|e| format!("extract Deno join: {e}"))??;

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            tokio::fs::set_permissions(
                &candidate_for_extract,
                std::fs::Permissions::from_mode(0o755),
            )
            .await
            .map_err(|e| format!("chmod Deno: {e}"))?;
        }

        if !probe_program(&candidate_for_extract).await {
            return Err("extracted Deno failed its --version check".into());
        }
        replace_managed_file(&candidate_for_extract, managed).await
    };

    let result = match tokio::time::timeout(DENO_DOWNLOAD_TIMEOUT, install).await {
        Ok(result) => result,
        Err(_) => Err("Deno download timed out".into()),
    };
    let _ = tokio::fs::remove_file(&archive_path).await;
    if result.is_err() {
        let _ = tokio::fs::remove_file(&candidate).await;
    }
    result
}

/// Swap a fully validated candidate into place, restoring the old runtime if
/// Windows refuses the second rename. POSIX rename-overwrite is already atomic;
/// the backup dance is only needed on Windows where rename does not replace.
async fn replace_managed_file(candidate: &Path, managed: &Path) -> Result<(), String> {
    #[cfg(not(windows))]
    {
        return tokio::fs::rename(candidate, managed)
            .await
            .map_err(|e| format!("install Deno: {e}"));
    }

    #[cfg(windows)]
    {
        if !managed.exists() {
            return tokio::fs::rename(candidate, managed)
                .await
                .map_err(|e| format!("install Deno: {e}"));
        }
        let backup = managed.with_file_name("deno.previous.exe");
        let _ = tokio::fs::remove_file(&backup).await;
        tokio::fs::rename(managed, &backup)
            .await
            .map_err(|e| format!("backup current Deno: {e}"))?;
        match tokio::fs::rename(candidate, managed).await {
            Ok(()) => {
                let _ = tokio::fs::remove_file(&backup).await;
                Ok(())
            }
            Err(e) => {
                let _ = tokio::fs::rename(&backup, managed).await;
                Err(format!("install Deno: {e}"))
            }
        }
    }
}

fn update_stamp_path(managed: &Path) -> PathBuf {
    managed.with_file_name("last-update-check")
}

fn touch_update_stamp(managed: &Path) {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let _ = std::fs::write(update_stamp_path(managed), now.to_string());
}

fn update_stamp_age(managed: &Path) -> Option<Duration> {
    let raw = std::fs::read_to_string(update_stamp_path(managed)).ok()?;
    let then = raw.trim().parse::<u64>().ok()?;
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    Some(Duration::from_secs(now.saturating_sub(then)))
}

/// Run `yt-dlp -U` on the managed copy when the last check is older
/// than `UPDATE_INTERVAL`. The official release binary replaces itself
/// in place. The stamp is refreshed even on failure so a broken update
/// path can't turn into a retry storm on every launch.
async fn maybe_self_update(managed: &Path) {
    match update_stamp_age(managed) {
        Some(age) if age < UPDATE_INTERVAL => return,
        _ => {}
    }
    touch_update_stamp(managed);

    let mut cmd = tokio::process::Command::new(managed);
    cmd.arg("-U");
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());
    // The timeout below drops the output() future — without this the
    // wedged child would outlive it as an orphan.
    cmd.kill_on_drop(true);

    let run = async {
        match cmd.output().await {
            Ok(out) => {
                let stdout = String::from_utf8_lossy(&out.stdout);
                let line = stdout
                    .lines()
                    .rev()
                    .find(|l| !l.trim().is_empty())
                    .unwrap_or("");
                eprintln!("[ytdlp] self-update ({}): {line}", out.status);
            }
            Err(e) => eprintln!("[ytdlp] self-update spawn failed: {e}"),
        }
    };
    if tokio::time::timeout(UPDATE_TIMEOUT, run).await.is_err() {
        eprintln!("[ytdlp] self-update timed out");
    }
}

#[cfg(test)]
mod tests {
    use super::{
        deno_download_url, managed_deno_path, youtube_player_clients, youtube_runtime_args,
    };
    use std::path::Path;

    #[test]
    fn js_capable_client_set_avoids_drm_only_tv_formats() {
        assert_eq!(
            youtube_player_clients(true),
            "youtube:player_client=android_vr,web_safari"
        );
        assert_eq!(
            youtube_player_clients(false),
            "youtube:player_client=android_vr"
        );
    }

    #[test]
    fn deno_is_installed_beside_ytdlp() {
        let path = managed_deno_path(Path::new("bin/yt-dlp"));
        assert_eq!(path.parent(), Some(Path::new("bin")));
        assert!(path
            .file_stem()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name == "deno"));
    }

    #[test]
    fn provider_args_select_mweb_and_only_the_managed_plugin() {
        let args = youtube_runtime_args(
            Path::new("bin/yt-dlp"),
            Some((Path::new("pot/plugins"), "http://127.0.0.1:4416")),
        );
        let args = args
            .iter()
            .map(|arg| arg.to_string_lossy())
            .collect::<Vec<_>>();
        assert_eq!(
            args.first().map(|arg| arg.as_ref()),
            Some("--ignore-config")
        );
        assert_eq!(
            args.get(1).map(|arg| arg.as_ref()),
            Some("--no-plugin-dirs")
        );
        assert_eq!(
            args.iter().filter(|arg| **arg == "--ignore-config").count(),
            1
        );
        assert_eq!(
            args.iter()
                .filter(|arg| **arg == "--no-plugin-dirs")
                .count(),
            1
        );
        assert!(args.iter().any(|arg| arg == "pot/plugins"));
        assert!(args.iter().any(|arg| arg == "youtube:player_client=mweb"));
        assert!(args
            .iter()
            .any(|arg| { arg == "youtubepot-bgutilhttp:base_url=http://127.0.0.1:4416" }));
    }

    #[test]
    fn fallback_args_ignore_user_config_and_all_external_plugins() {
        let args = youtube_runtime_args(Path::new("bin/yt-dlp"), None)
            .into_iter()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect::<Vec<_>>();

        assert_eq!(args.first().map(String::as_str), Some("--ignore-config"));
        assert_eq!(args.get(1).map(String::as_str), Some("--no-plugin-dirs"));
        assert_eq!(
            args.iter().filter(|arg| *arg == "--ignore-config").count(),
            1
        );
        assert_eq!(
            args.iter().filter(|arg| *arg == "--no-plugin-dirs").count(),
            1
        );
        assert!(!args.iter().any(|arg| arg == "--plugin-dirs"));
        assert!(args
            .iter()
            .any(|arg| arg.starts_with("youtube:player_client=android_vr")));
    }

    #[test]
    fn release_targets_have_an_official_deno_asset() {
        if cfg!(all(
            any(windows, target_os = "macos", target_os = "linux"),
            any(target_arch = "x86_64", target_arch = "aarch64")
        )) {
            let url = deno_download_url().expect("published target needs Deno URL");
            assert!(url.starts_with("https://github.com/denoland/deno/releases/"));
            assert!(url.ends_with(".zip"));
        }
    }
}
