// Register every command exposed by `tauri::generate_handler!` with Tauri's
// application ACL. Without an AppManifest, Tauri 2 intentionally treats
// custom application commands as globally callable from every WebView,
// including external documents. The capability files grant only the subsets
// needed by Goosic's local `main` and `player` WebViews; the remote
// `youtube-player`, login, and session-keeper documents receive none.
const APP_COMMANDS: &[&str] = &[
    "ensure_ytdlp",
    "get_stream_base_url",
    "start_offline_download",
    "cancel_offline_download",
    "list_offline_downloads",
    "web_player_load",
    "web_player_control",
    "web_player_reset",
    "web_player_health",
    "start_login",
    "get_cookie_header",
    "get_auth_context",
    "merge_response_cookies",
    "is_logged_in",
    "refresh_active_session",
    "clear_cookies",
    "list_accounts",
    "switch_account",
    "remove_account",
    "update_account_meta",
    "set_account_channel",
    "get_active_account_id",
    "list_cache",
    "delete_cache_entries",
    "mark_offline_file_unplayable",
    "cache_cover",
    "cover_cache_stats",
    "clear_cover_cache",
    "quit_app",
    "set_close_behavior",
    "autostart_set",
    "autostart_is_enabled",
    "notify_track",
    "get_cache_dir",
    "set_cache_dir",
    "pick_cache_folder",
    "focus_main_window",
    "open_player_window",
    "close_player_window",
    "media_update",
    "media_clear",
    "discord_update",
    "discord_clear",
    "discord_set_enabled",
    "lastfm_is_configured",
    "lastfm_begin_auth",
    "lastfm_poll_session",
    "lastfm_user_info",
    "lastfm_update_now_playing",
    "lastfm_scrobble",
    "lastfm_love",
    "lastfm_flush",
];

fn main() {
    validate_app_command_manifest();
    validate_capability_boundary();
    inject_lastfm_credentials();
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(APP_COMMANDS)),
    )
    .expect("failed to build Goosic with its application command ACL")
}

/// Keep the build-time ACL manifest synchronized with the actual invoke
/// handler. A newly registered command must be classified into a capability
/// in the same change instead of silently inheriting Tauri's legacy global
/// application-command behavior.
fn validate_app_command_manifest() {
    use std::collections::BTreeSet;

    println!("cargo:rerun-if-changed=src/lib.rs");
    let source = std::fs::read_to_string("src/lib.rs")
        .expect("could not read src/lib.rs while validating the application ACL");
    let marker = ".invoke_handler(tauri::generate_handler![";
    let block = source
        .split_once(marker)
        .and_then(|(_, rest)| rest.split_once("])"))
        .map(|(commands, _)| commands)
        .expect("could not find the tauri::generate_handler! application command list");

    let registered: BTreeSet<&str> = block
        .lines()
        .filter_map(|line| {
            let command = line
                .split_once("//")
                .map_or(line, |(code, _)| code)
                .trim()
                .trim_end_matches(',')
                .trim();
            (!command.is_empty()).then(|| command.rsplit("::").next().unwrap())
        })
        .collect();
    let manifested: BTreeSet<&str> = APP_COMMANDS.iter().copied().collect();

    assert_eq!(
        registered, manifested,
        "src/lib.rs invoke commands and build.rs APP_COMMANDS differ; classify every command in the application ACL"
    );
}

/// Fail closed if a future capability accidentally targets an external
/// playback/authentication WebView, enables remote origins, or merges another
/// capability into one of the two trusted local UI labels.
fn validate_capability_boundary() {
    fn visit(dir: &std::path::Path, files: &mut Vec<std::path::PathBuf>) {
        for entry in std::fs::read_dir(dir).expect("could not read capabilities directory") {
            let path = entry.expect("could not read capability entry").path();
            if path.is_dir() {
                visit(&path, files);
            } else {
                files.push(path);
            }
        }
    }

    let mut files = Vec::new();
    visit(std::path::Path::new("capabilities"), &mut files);
    let capability_files: Vec<_> = files
        .into_iter()
        .filter(|path| {
            matches!(
                path.extension().and_then(|extension| extension.to_str()),
                Some("json" | "json5" | "toml")
            )
        })
        .collect();
    assert_eq!(
        capability_files.len(),
        2,
        "new capability files must be explicitly classified by validate_capability_boundary"
    );

    for path in capability_files {
        let raw = std::fs::read_to_string(&path)
            .unwrap_or_else(|_| panic!("could not read capability {}", path.display()));
        let compact: String = raw.chars().filter(|c| !c.is_whitespace()).collect();
        let name = path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("");

        assert!(
            !compact.contains("youtube-player"),
            "{} must not grant the remote youtube-player WebView any Tauri capability",
            path.display()
        );
        assert!(
            !compact.contains("\"remote\":")
                && !compact.contains("[remote]")
                && !compact.contains("remote="),
            "{} must remain local-only; remote documents use narrow native bridges",
            path.display()
        );
        assert!(
            !compact.contains("\"windows\":[\"*\"") && !compact.contains("\"webviews\":[\"*\""),
            "{} must target explicit bundled UI labels, never a wildcard",
            path.display()
        );

        if name == "default.json" {
            assert!(
                compact.contains("\"windows\":[\"main\"]"),
                "default.json must target exactly the bundled main window"
            );
            assert!(!compact.contains("\"webviews\":"));
            assert!(compact.contains("\"local\":true"));
        } else if name == "floating-player.json" {
            assert!(
                compact.contains("\"windows\":[\"player\"]"),
                "floating-player.json must target exactly the bundled player window"
            );
            assert!(!compact.contains("\"webviews\":"));
            assert!(compact.contains("\"local\":true"));
        } else {
            panic!(
                "{} is not an explicitly classified local UI capability",
                path.display()
            );
        }
    }
}

/// Make the Last.fm API key + shared secret available to `option_env!` in
/// src/lastfm.rs WITHOUT committing them to source. Precedence: existing env
/// vars (set as GitHub Actions secrets for release builds), then a gitignored
/// `lastfm_config.json` next to this file (for local dev). If neither provides a
/// value the env var is left unset and the feature simply stays unconfigured.
fn inject_lastfm_credentials() {
    println!("cargo:rerun-if-env-changed=YTUBIC_LASTFM_API_KEY");
    println!("cargo:rerun-if-env-changed=YTUBIC_LASTFM_API_SECRET");
    println!("cargo:rerun-if-changed=lastfm_config.json");

    let mut key = clean_credential(std::env::var("YTUBIC_LASTFM_API_KEY").unwrap_or_default());
    let mut secret =
        clean_credential(std::env::var("YTUBIC_LASTFM_API_SECRET").unwrap_or_default());

    if key.is_empty() || secret.is_empty() {
        if let Ok(raw) = std::fs::read_to_string("lastfm_config.json") {
            if key.is_empty() {
                if let Some(v) = json_string_field(&raw, "api_key") {
                    key = clean_credential(v);
                }
            }
            if secret.is_empty() {
                if let Some(v) = json_string_field(&raw, "api_secret") {
                    secret = clean_credential(v);
                }
            }
        }
    }

    assert_credential_shape("YTUBIC_LASTFM_API_KEY", &key);
    assert_credential_shape("YTUBIC_LASTFM_API_SECRET", &secret);

    if !key.is_empty() {
        println!("cargo:rustc-env=YTUBIC_LASTFM_API_KEY={key}");
    }
    if !secret.is_empty() {
        println!("cargo:rustc-env=YTUBIC_LASTFM_API_SECRET={secret}");
    }
}

/// Strip a UTF-8 BOM plus surrounding whitespace from a credential value.
/// Piping a value into `gh secret set` from Windows PowerShell 5.1 prepends a
/// BOM to the stored secret; v0.3.1 shipped with a "\u{FEFF}<key>" const that
/// Last.fm rejected as error 10 (Invalid API key). Cargo's directive parsing
/// already drops trailing CR/LF, but a leading BOM sails through untouched.
fn clean_credential(v: String) -> String {
    v.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}')
        .to_string()
}

/// Fail the build loudly when a credential is present but malformed, instead
/// of silently shipping a release whose Last.fm integration can never work.
/// Both the Last.fm API key and shared secret are exactly 32 hex chars; empty
/// stays allowed (the feature just reports itself unconfigured).
fn assert_credential_shape(name: &str, v: &str) {
    if v.is_empty() {
        return;
    }
    let hex32 = v.len() == 32 && v.bytes().all(|b| b.is_ascii_hexdigit());
    assert!(
        hex32,
        "{name} looks corrupted ({} bytes, expected 32 hex chars). \
         Re-set the GitHub secret with `gh secret set {name} --body <value>`; \
         never pipe the value in (PowerShell prepends a UTF-8 BOM).",
        v.len()
    );
}

/// Pull a top-level string field out of a flat JSON object. Deliberately tiny
/// (the config is two string fields) to avoid a serde_json build-dependency.
fn json_string_field(json: &str, field: &str) -> Option<String> {
    let needle = format!("\"{field}\"");
    let start = json.find(&needle)? + needle.len();
    let after_colon = json[start..].find(':')? + start + 1;
    let rest = &json[after_colon..];
    let open = rest.find('"')? + 1;
    let close = rest[open..].find('"')? + open;
    Some(rest[open..close].to_string())
}
