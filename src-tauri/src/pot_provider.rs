//! Managed proof-of-origin token provider for yt-dlp.
//!
//! Goosic downloads one pinned upstream bgutil provider release, verifies both
//! archives before extracting anything, installs production dependencies with
//! the already-managed Deno runtime, and runs the provider only on loopback.
//! Account cookies never enter this process; yt-dlp uses it as an anonymous
//! per-video GVS token source for the `mweb` client.

use std::io::{Cursor, Read, Write};
use std::net::{Ipv4Addr, SocketAddrV4, TcpListener};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{LazyLock, RwLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use sha2::{Digest, Sha256};
use tauri::Manager;
use tokio::process::{Child, Command};
use tokio::sync::Mutex;

use crate::ytdlp;

pub const PROVIDER_VERSION: &str = "1.3.1";
const PLUGIN_URL: &str = "https://github.com/Brainicism/bgutil-ytdlp-pot-provider/releases/download/1.3.1/bgutil-ytdlp-pot-provider.zip";
const SOURCE_URL: &str =
    "https://github.com/Brainicism/bgutil-ytdlp-pot-provider/archive/refs/tags/1.3.1.zip";
const PLUGIN_SHA256: &str = "b8ceec7f76143da172aaf5ebeec0c2d218e5680c063b931586bca48567069b38";
const SOURCE_SHA256: &str = "5df1fa7081ab103209c2394f40ba815a5c8e1b934d6c6fbf80421ca3f2d48471";
const SOURCE_ROOT: &str = "bgutil-ytdlp-pot-provider-1.3.1";
const INSTALL_TIMEOUT: Duration = Duration::from_secs(10 * 60);
// The first Deno launch compiles the provider graph and loads native canvas;
// slower disks can legitimately need more than 20 seconds. Subsequent starts
// are normally nearly immediate.
const START_TIMEOUT: Duration = Duration::from_secs(60);
const RETRY_BACKOFF: Duration = Duration::from_secs(5 * 60);

static ENSURE_LOCK: Mutex<()> = Mutex::const_new(());
static PROCESS: Mutex<Option<ProviderProcess>> = Mutex::const_new(None);
static ACTIVE_CONFIG: LazyLock<RwLock<Option<ProviderConfig>>> =
    LazyLock::new(|| RwLock::new(None));
static RETRY_AFTER: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProviderConfig {
    pub plugin_dir: PathBuf,
    pub base_url: String,
}

struct ProviderProcess {
    child: Child,
}

impl Drop for ProviderProcess {
    fn drop(&mut self) {
        // `ensure` is raced against playlist cancellation. Until a healthy
        // launch is committed to `PROCESS`, this guard owns the child locally;
        // dropping that future must terminate Deno instead of orphaning it.
        let _ = self.child.start_kill();
    }
}

#[derive(Clone, Debug)]
struct ProviderPaths {
    root: PathBuf,
    plugin: PathBuf,
    server: PathBuf,
    marker: PathBuf,
}

impl ProviderPaths {
    fn from_root(root: PathBuf) -> Self {
        Self {
            plugin: root.join("plugins").join("bgutil-ytdlp-pot-provider.zip"),
            server: root.join(SOURCE_ROOT).join("server"),
            marker: root.join(".goosic-ready"),
            root,
        }
    }
}

fn provider_root(app: &tauri::AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir())
        .join("bin")
        .join("pot-provider")
        .join(PROVIDER_VERSION)
}

pub fn needs_setup(app: &tauri::AppHandle) -> bool {
    let paths = ProviderPaths::from_root(provider_root(app));
    !paths.marker.is_file()
        || !paths.plugin.is_file()
        || !paths.server.join("node_modules").is_dir()
}

pub fn current_config() -> Option<ProviderConfig> {
    ACTIVE_CONFIG.read().ok().and_then(|guard| guard.clone())
}

/// Report whether the currently advertised provider still has a live child
/// and answers the pinned-version health check. The explicit downloader uses
/// this only after a failed provider-backed attempt so a crash can be repaired
/// once without retrying ordinary extractor failures.
pub async fn current_is_healthy() -> bool {
    let Some(config) = current_config() else {
        return false;
    };
    let alive = {
        let mut process = PROCESS.lock().await;
        process
            .as_mut()
            .is_some_and(|running| running.child.try_wait().ok().flatten().is_none())
    };
    alive && provider_is_healthy(&config.base_url).await
}

fn set_current(config: Option<ProviderConfig>) {
    if let Ok(mut current) = ACTIVE_CONFIG.write() {
        *current = config;
    }
}

fn unix_now_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

fn retry_is_delayed() -> bool {
    unix_now_seconds() < RETRY_AFTER.load(Ordering::Acquire)
}

fn delay_retry() {
    RETRY_AFTER.store(
        unix_now_seconds().saturating_add(RETRY_BACKOFF.as_secs()),
        Ordering::Release,
    );
}

fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn verify_archive(label: &str, bytes: &[u8], expected: &str) -> Result<(), String> {
    let actual = sha256_hex(bytes);
    if actual == expected {
        Ok(())
    } else {
        Err(format!(
            "{label} checksum mismatch (expected {expected}, received {actual})"
        ))
    }
}

async fn download_archive(
    client: &reqwest::Client,
    label: &str,
    url: &str,
) -> Result<Vec<u8>, String> {
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|error| format!("download {label}: {error}"))?
        .error_for_status()
        .map_err(|error| format!("download {label}: {error}"))?;
    response
        .bytes()
        .await
        .map(|bytes| bytes.to_vec())
        .map_err(|error| format!("read {label}: {error}"))
}

fn extract_source(bytes: Vec<u8>, destination: &Path) -> Result<(), String> {
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes))
        .map_err(|error| format!("read provider source archive: {error}"))?;
    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|error| format!("read provider source entry: {error}"))?;
        let relative = entry
            .enclosed_name()
            .ok_or_else(|| "provider archive contains an unsafe path".to_string())?
            .to_path_buf();
        let output = destination.join(relative);
        if entry.is_dir() {
            std::fs::create_dir_all(&output)
                .map_err(|error| format!("create provider directory {output:?}: {error}"))?;
            continue;
        }
        if let Some(parent) = output.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|error| format!("create provider directory {parent:?}: {error}"))?;
        }
        let mut file = std::fs::File::create(&output)
            .map_err(|error| format!("create provider file {output:?}: {error}"))?;
        std::io::copy(&mut entry, &mut file)
            .map_err(|error| format!("extract provider file {output:?}: {error}"))?;
        file.sync_all()
            .map_err(|error| format!("sync provider file {output:?}: {error}"))?;
    }
    Ok(())
}

fn patch_loopback_binding(main_path: &Path) -> Result<(), String> {
    let mut source = String::new();
    std::fs::File::open(main_path)
        .and_then(|mut file| file.read_to_string(&mut source))
        .map_err(|error| format!("read provider entrypoint {main_path:?}: {error}"))?;
    let ipv6_count = source.matches("host: \"::\"").count();
    let ipv4_count = source.matches("host: \"0.0.0.0\"").count();
    if ipv6_count != 1 || ipv4_count != 1 {
        return Err("provider entrypoint no longer matches the audited loopback patch".into());
    }
    source = source
        .replace("host: \"::\"", "host: \"127.0.0.1\"")
        .replace("host: \"0.0.0.0\"", "host: \"127.0.0.1\"");
    let mut file = std::fs::File::create(main_path)
        .map_err(|error| format!("patch provider entrypoint {main_path:?}: {error}"))?;
    file.write_all(source.as_bytes())
        .and_then(|_| file.sync_all())
        .map_err(|error| format!("write provider entrypoint {main_path:?}: {error}"))
}

async fn file_matches_hash(path: &Path, expected: &str) -> bool {
    tokio::fs::read(path)
        .await
        .map(|bytes| sha256_hex(&bytes) == expected)
        .unwrap_or(false)
}

async fn installation_is_valid(paths: &ProviderPaths) -> bool {
    if tokio::fs::read_to_string(&paths.marker)
        .await
        .ok()
        .as_deref()
        != Some(PROVIDER_VERSION)
    {
        return false;
    }
    if !file_matches_hash(&paths.plugin, PLUGIN_SHA256).await {
        return false;
    }
    let Some(plugin_dir) = paths.plugin.parent() else {
        return false;
    };
    let Ok(mut entries) = tokio::fs::read_dir(plugin_dir).await else {
        return false;
    };
    let mut plugin_entries = 0_u8;
    loop {
        match entries.next_entry().await {
            Ok(Some(entry)) => {
                plugin_entries = plugin_entries.saturating_add(1);
                if entry.path() != paths.plugin {
                    return false;
                }
            }
            Ok(None) => break,
            Err(_) => return false,
        }
    }
    if plugin_entries != 1 {
        return false;
    }
    let main = match tokio::fs::read_to_string(paths.server.join("src/main.ts")).await {
        Ok(main) => main,
        Err(_) => return false,
    };
    main.contains("host: \"127.0.0.1\"")
        && !main.contains("host: \"::\"")
        && !main.contains("host: \"0.0.0.0\"")
        && paths
            .server
            .join("node_modules/express/package.json")
            .is_file()
        && paths
            .server
            .join("node_modules/canvas/package.json")
            .is_file()
}

async fn install_dependencies(deno: &Path, server: &Path) -> Result<(), String> {
    let mut command = Command::new(deno);
    command
        .args([
            "install",
            "--prod",
            "--allow-scripts=npm:canvas",
            "--frozen",
            "--quiet",
        ])
        .current_dir(server)
        .env("DENO_NO_UPDATE_CHECK", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x0800_0000);
    let output = tokio::time::timeout(INSTALL_TIMEOUT, command.output())
        .await
        .map_err(|_| "provider dependency installation timed out".to_string())?
        .map_err(|error| format!("start provider dependency installation: {error}"))?;
    if output.status.success() {
        Ok(())
    } else {
        let detail = String::from_utf8_lossy(&output.stderr);
        Err(format!(
            "provider dependency installation failed: {}",
            detail.chars().take(1000).collect::<String>()
        ))
    }
}

async fn install_provider(app: &tauri::AppHandle, deno: &Path) -> Result<ProviderPaths, String> {
    let final_paths = ProviderPaths::from_root(provider_root(app));
    if installation_is_valid(&final_paths).await {
        return Ok(final_paths);
    }

    let parent = final_paths
        .root
        .parent()
        .ok_or_else(|| "provider root has no parent".to_string())?;
    tokio::fs::create_dir_all(parent)
        .await
        .map_err(|error| format!("create provider root {parent:?}: {error}"))?;
    let candidate_root = parent.join(format!("{PROVIDER_VERSION}.installing"));
    let candidate = ProviderPaths::from_root(candidate_root.clone());
    let _ = tokio::fs::remove_dir_all(&candidate_root).await;
    tokio::fs::create_dir_all(&candidate_root)
        .await
        .map_err(|error| format!("create provider candidate {candidate_root:?}: {error}"))?;

    let install = async {
        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(20))
            .timeout(Duration::from_secs(2 * 60))
            .build()
            .map_err(|error| format!("build provider download client: {error}"))?;
        let (plugin_result, source_result) = tokio::join!(
            download_archive(&client, "provider plugin", PLUGIN_URL),
            download_archive(&client, "provider source", SOURCE_URL),
        );
        let plugin = plugin_result?;
        let source = source_result?;
        verify_archive("provider plugin", &plugin, PLUGIN_SHA256)?;
        verify_archive("provider source", &source, SOURCE_SHA256)?;
        let plugin_dir = candidate
            .plugin
            .parent()
            .ok_or_else(|| "provider plugin path has no parent".to_string())?;
        tokio::fs::create_dir_all(plugin_dir)
            .await
            .map_err(|error| format!("create provider plugin directory: {error}"))?;
        tokio::fs::write(&candidate.plugin, plugin)
            .await
            .map_err(|error| format!("write provider plugin: {error}"))?;

        let extract_root = candidate.root.clone();
        tokio::task::spawn_blocking(move || extract_source(source, &extract_root))
            .await
            .map_err(|error| format!("extract provider join: {error}"))??;
        let main_path = candidate.server.join("src/main.ts");
        tokio::task::spawn_blocking(move || patch_loopback_binding(&main_path))
            .await
            .map_err(|error| format!("patch provider join: {error}"))??;

        Ok::<(), String>(())
    };

    let result = install.await;
    if let Err(error) = result {
        let _ = tokio::fs::remove_dir_all(&candidate_root).await;
        return Err(error);
    }
    let previous_root = parent.join(format!("{PROVIDER_VERSION}.previous"));
    let _ = tokio::fs::remove_dir_all(&previous_root).await;
    let had_previous = final_paths.root.exists();
    if had_previous {
        tokio::fs::rename(&final_paths.root, &previous_root)
            .await
            .map_err(|error| format!("stage invalid provider install for replacement: {error}"))?;
    }
    if let Err(error) = tokio::fs::rename(&candidate_root, &final_paths.root).await {
        if had_previous {
            let _ = tokio::fs::rename(&previous_root, &final_paths.root).await;
        }
        return Err(format!("install provider: {error}"));
    }

    // Deno uses absolute directory junctions for npm packages on Windows.
    // Dependencies must therefore be installed only after the verified source
    // has reached its final versioned path; moving node_modules afterward
    // leaves every junction pointing back at the temporary directory.
    if let Err(error) = install_dependencies(deno, &final_paths.server).await {
        let _ = tokio::fs::remove_dir_all(&final_paths.root).await;
        if had_previous {
            let _ = tokio::fs::rename(&previous_root, &final_paths.root).await;
        }
        return Err(error);
    }
    if let Err(error) = tokio::fs::write(&final_paths.marker, PROVIDER_VERSION).await {
        let _ = tokio::fs::remove_dir_all(&final_paths.root).await;
        if had_previous {
            let _ = tokio::fs::rename(&previous_root, &final_paths.root).await;
        }
        return Err(format!("write provider marker: {error}"));
    }
    if had_previous {
        let _ = tokio::fs::remove_dir_all(&previous_root).await;
    }
    Ok(final_paths)
}

async fn provider_is_healthy(base_url: &str) -> bool {
    let Ok(client) = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(1))
        .timeout(Duration::from_secs(2))
        .build()
    else {
        return false;
    };
    let Ok(response) = client.get(format!("{base_url}/ping")).send().await else {
        return false;
    };
    if !response.status().is_success() {
        return false;
    }
    response
        .text()
        .await
        .ok()
        .and_then(|body| serde_json::from_str::<serde_json::Value>(&body).ok())
        .and_then(|body| {
            body.get("version")
                .and_then(|value| value.as_str())
                .map(str::to_owned)
        })
        .as_deref()
        == Some(PROVIDER_VERSION)
}

async fn stop_running() {
    set_current(None);
    if let Some(mut process) = PROCESS.lock().await.take() {
        let _ = process.child.start_kill();
        let _ = tokio::time::timeout(Duration::from_secs(3), process.child.wait()).await;
    }
}

async fn launch_provider(paths: &ProviderPaths, deno: &Path) -> Result<ProviderConfig, String> {
    let listener = TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 0))
        .map_err(|error| format!("reserve provider port: {error}"))?;
    let port = listener
        .local_addr()
        .map_err(|error| format!("read provider port: {error}"))?
        .port();
    drop(listener);

    let node_modules = paths.server.join("node_modules");
    let mut command = Command::new(deno);
    command
        .args([
            "run",
            "--no-prompt",
            "--allow-env",
            "--allow-net",
            "--allow-ffi=.",
            "--allow-read=..",
            "../src/main.ts",
            "--port",
            &port.to_string(),
        ])
        .current_dir(&node_modules)
        .env("DENO_NO_UPDATE_CHECK", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x0800_0000);
    let child = command
        .spawn()
        .map_err(|error| format!("start PO provider: {error}"))?;
    let config = ProviderConfig {
        plugin_dir: paths
            .plugin
            .parent()
            .ok_or_else(|| "provider plugin path has no parent".to_string())?
            .to_path_buf(),
        base_url: format!("http://127.0.0.1:{port}"),
    };
    // Keep ownership local while health checking. `wait_or_cancel` may drop
    // this future at any await point; ProviderProcess::drop then kills the
    // uncommitted child. Only a version-verified healthy process enters the
    // global lifecycle slot.
    let mut process = ProviderProcess { child };

    let deadline = tokio::time::Instant::now() + START_TIMEOUT;
    loop {
        let exited = process.child.try_wait().ok().flatten().is_some();
        if exited {
            let _ = process.child.wait().await;
            return Err("PO provider exited before becoming ready".into());
        }
        if provider_is_healthy(&config.base_url).await {
            *PROCESS.lock().await = Some(process);
            set_current(Some(config.clone()));
            return Ok(config);
        }
        if tokio::time::Instant::now() >= deadline {
            let _ = process.child.start_kill();
            let _ = tokio::time::timeout(Duration::from_secs(3), process.child.wait()).await;
            return Err("PO provider health check timed out".into());
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

/// Ensure a healthy provider process and return the isolated plugin
/// directory/base URL yt-dlp should receive. When `force_retry` is false, a
/// recent setup failure stays on the anonymous fallback instead of repeating
/// npm/GitHub work per track.
pub async fn ensure(
    app: &tauri::AppHandle,
    managed_ytdlp: &Path,
    force_retry: bool,
) -> Result<ProviderConfig, String> {
    let _guard = ENSURE_LOCK.lock().await;

    if let Some(config) = current_config() {
        let alive = {
            let mut process = PROCESS.lock().await;
            process
                .as_mut()
                .is_some_and(|running| running.child.try_wait().ok().flatten().is_none())
        };
        if alive && provider_is_healthy(&config.base_url).await {
            return Ok(config);
        }
        stop_running().await;
    } else {
        // Heal any orphaned global slot left by an older build or an
        // interrupted lifecycle transition before starting another provider.
        let has_orphan = PROCESS.lock().await.is_some();
        if has_orphan {
            stop_running().await;
        }
    }

    if !force_retry && retry_is_delayed() {
        return Err("PO provider setup recently failed; using fallback clients".into());
    }
    let deno = ytdlp::managed_deno_path(managed_ytdlp);
    if !deno.is_file() {
        delay_retry();
        return Err("managed Deno is unavailable for the PO provider".into());
    }

    match install_provider(app, &deno).await {
        Ok(paths) => match launch_provider(&paths, &deno).await {
            Ok(config) => {
                RETRY_AFTER.store(0, Ordering::Release);
                eprintln!("[pot-provider] v{PROVIDER_VERSION} ready on loopback");
                Ok(config)
            }
            Err(error) => {
                delay_retry();
                Err(error)
            }
        },
        Err(error) => {
            delay_retry();
            Err(error)
        }
    }
}

/// Best-effort synchronous exit hook. `start_kill` is non-blocking and safe to
/// call from Tauri's run-event callback.
pub fn shutdown_now() {
    set_current(None);
    if let Ok(mut process) = PROCESS.try_lock() {
        if let Some(mut running) = process.take() {
            let _ = running.child.start_kill();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        extract_source, patch_loopback_binding, provider_is_healthy, sha256_hex, verify_archive,
        ProviderPaths, PLUGIN_SHA256, PROVIDER_VERSION, SOURCE_SHA256,
    };
    use std::io::{Read, Write};

    #[test]
    fn pinned_checksums_are_sha256_and_mismatches_are_rejected() {
        assert_eq!(
            sha256_hex(b"goosic"),
            "3a6cf03baef13e0c538b49bb17b5e36778393ad502e1d59867f82e3bd60951b7"
        );
        assert_eq!(PLUGIN_SHA256.len(), 64);
        assert_eq!(SOURCE_SHA256.len(), 64);
        assert!(PLUGIN_SHA256.bytes().all(|byte| byte.is_ascii_hexdigit()));
        assert!(SOURCE_SHA256.bytes().all(|byte| byte.is_ascii_hexdigit()));
        assert!(verify_archive("plugin", b"wrong", PLUGIN_SHA256).is_err());
        assert!(verify_archive("source", b"wrong", SOURCE_SHA256).is_err());
    }

    #[test]
    fn provider_paths_are_version_scoped() {
        let paths =
            ProviderPaths::from_root(std::path::PathBuf::from("pot").join(PROVIDER_VERSION));
        assert!(paths
            .plugin
            .ends_with("plugins/bgutil-ytdlp-pot-provider.zip"));
        assert!(paths
            .server
            .ends_with("bgutil-ytdlp-pot-provider-1.3.1/server"));
    }

    #[test]
    fn audited_server_patch_removes_public_bindings() {
        let root = std::env::temp_dir().join(format!(
            "goosic-pot-provider-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let main = root.join("main.ts");
        std::fs::write(
            &main,
            "listen({ host: \"::\" }); listen({ host: \"0.0.0.0\" });",
        )
        .unwrap();
        patch_loopback_binding(&main).unwrap();
        let patched = std::fs::read_to_string(&main).unwrap();
        assert_eq!(patched.matches("127.0.0.1").count(), 2);
        assert!(!patched.contains("0.0.0.0"));
        assert!(!patched.contains("host: \"::\""));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn source_archive_rejects_path_traversal() {
        let mut writer = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        writer
            .start_file("../outside.ts", zip::write::SimpleFileOptions::default())
            .unwrap();
        writer.write_all(b"unsafe").unwrap();
        let archive = writer.finish().unwrap().into_inner();
        let root = std::env::temp_dir().join(format!(
            "goosic-pot-provider-archive-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).unwrap();
        assert!(extract_source(archive, &root).is_err());
        assert!(!root.join("outside.ts").exists());
        let _ = std::fs::remove_dir_all(root);
    }

    async fn fake_ping(version: &'static str) -> String {
        let listener = std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).unwrap();
        let address = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0_u8; 1024];
            let _ = stream.read(&mut request);
            let body = format!(r#"{{"server_uptime":1,"version":"{version}"}}"#);
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            )
            .unwrap();
        });
        format!("http://127.0.0.1:{}", address.port())
    }

    #[tokio::test]
    async fn health_check_requires_the_pinned_version_on_loopback() {
        let correct = fake_ping(PROVIDER_VERSION).await;
        assert!(provider_is_healthy(&correct).await);

        let wrong = fake_ping("9.9.9").await;
        assert!(!provider_is_healthy(&wrong).await);
    }
}
