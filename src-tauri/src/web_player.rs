//! Cross-platform hidden YouTube Music web player.
//!
//! The remote page never receives Tauri IPC. A document-start observer may
//! only POST a small, generation-scoped state envelope to the app's secret
//! loopback server. Native transport commands are evaluated from trusted app
//! code after strict action/value validation.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::{
    extract::{DefaultBodyLimit, State},
    http::{header::CONTENT_TYPE, HeaderMap, HeaderName, HeaderValue, Method, StatusCode},
    routing::post,
    Json, Router,
};
use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
use tokio::sync::{Mutex, Notify};
use tower_http::cors::CorsLayer;

const PLAYER_LABEL: &str = "youtube-player";
const BRIDGE_VERSION: u8 = 2;
const BRIDGE_HEADER: &str = "x-goosic-bridge";
const CLOSE_TIMEOUT: Duration = Duration::from_secs(2);
const HEALTH_HEARTBEAT_TIMEOUT: Duration = Duration::from_secs(5);
/// Observer samples to wait for the page's video identity before trusting a
/// sample without it. The observer samples every 250ms, so this is about three
/// seconds — long enough for a slow player API to appear, short enough that an
/// engine which never exposes one does not strand the interface in loading.
const IDENTITY_GRACE_SAMPLES: u32 = 12;
const IDENTITY_TIMEOUT: Duration = Duration::from_secs(20);

#[cfg(any(target_os = "windows", test))]
const WINDOWS_WS_EX_TOOLWINDOW: isize = 0x0000_0080;
#[cfg(any(target_os = "windows", test))]
const WINDOWS_WS_EX_APPWINDOW: isize = 0x0004_0000;
#[cfg(any(target_os = "windows", test))]
const WINDOWS_WS_EX_NOACTIVATE: isize = 0x0800_0000;

#[cfg(any(target_os = "windows", test))]
fn hardened_windows_ex_style(style: isize) -> isize {
    (style | WINDOWS_WS_EX_TOOLWINDOW | WINDOWS_WS_EX_NOACTIVATE) & !WINDOWS_WS_EX_APPWINDOW
}

#[derive(Clone, Default)]
pub struct WebPlayerState {
    inner: Arc<Mutex<Inner>>,
    lifecycle: Arc<Mutex<()>>,
    identity_notify: Arc<Notify>,
}

#[derive(Default)]
struct Inner {
    generation: u64,
    video_id: String,
    profile_key: String,
    advertisement: bool,
    suppress_ended_until_content_playing: bool,
    last_sequence: Option<u64>,
    terminal_emitted: bool,
    /// Consecutive samples whose video identity the page did not expose. Bounds
    /// the identity gate so an engine without a reachable player API cannot
    /// hold the interface in a loading state for the whole track.
    unidentified_samples: u32,
    last_heartbeat: Option<Instant>,
    identity_generation: u64,
    identity_result: Option<bool>,
}

#[derive(Debug, PartialEq, Eq)]
struct EndedGate {
    advertisement: bool,
    suppress_until_content_playing: bool,
    emit_ended: bool,
}

/// Ad media can retain an `ended` bit after the page removes its ad marker.
/// Suppress that transition, while allowing the observer's separately captured
/// requested-content terminal event to survive a completed post-roll ad.
fn gate_ended_event(
    previous_advertisement: bool,
    previously_suppressed: bool,
    reported_advertisement: bool,
    requested_content_playing: bool,
    reported_ended: bool,
) -> EndedGate {
    if reported_advertisement {
        return EndedGate {
            advertisement: true,
            suppress_until_content_playing: true,
            emit_ended: false,
        };
    }

    // `reported_ended` is produced only when the observer captured the
    // requested content's own media-ended callback. It therefore takes
    // precedence over the ad transition gate: a post-roll advertisement may
    // have changed the page's active video id before this terminal sample is
    // delivered, but it must not swallow the requested track's completion.
    if reported_ended {
        return EndedGate {
            advertisement: false,
            suppress_until_content_playing: false,
            emit_ended: true,
        };
    }

    if previous_advertisement || previously_suppressed {
        return EndedGate {
            advertisement: false,
            suppress_until_content_playing: !requested_content_playing,
            // The first non-ad playing sample clears the gate, but it must
            // never forward an `ended` bit left behind by the ad element.
            emit_ended: false,
        };
    }

    EndedGate {
        advertisement: false,
        suppress_until_content_playing: false,
        emit_ended: false,
    }
}

fn sequence_is_fresh(last_sequence: Option<u64>, sequence: u64) -> bool {
    sequence > 0 && last_sequence.map_or(true, |previous| sequence > previous)
}

fn is_unexpected_track(
    actual_video_id: Option<&str>,
    requested_video_id: &str,
    advertisement: bool,
    terminal_pending: bool,
    terminal_already_emitted: bool,
) -> bool {
    !advertisement
        && !terminal_pending
        && !terminal_already_emitted
        && actual_video_id.is_some_and(|actual| !actual.is_empty() && actual != requested_video_id)
}

fn actual_video_matches_requested(actual_video_id: Option<&str>, requested_video_id: &str) -> bool {
    actual_video_id.is_some_and(|actual| !actual.is_empty() && actual == requested_video_id)
}

fn heartbeat_is_fresh(last_heartbeat: Option<Instant>, now: Instant) -> bool {
    last_heartbeat.is_some_and(|heartbeat| {
        now.saturating_duration_since(heartbeat) <= HEALTH_HEARTBEAT_TIMEOUT
    })
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaybackStateEvent {
    pub version: u8,
    pub generation: u64,
    pub sequence: u64,
    pub video_id: String,
    pub actual_video_id: Option<String>,
    pub ready: bool,
    pub playing: bool,
    pub buffering: bool,
    pub position: f64,
    pub duration: f64,
    pub volume: f64,
    pub muted: bool,
    pub advertisement: bool,
    pub ended: bool,
    /// The requested track is over, whether or not its one-shot terminal event
    /// has already been published for this generation.
    pub finished: bool,
    pub error: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct IdentityStateEvent {
    version: u8,
    generation: u64,
    matches: bool,
}

pub fn bridge_router(app: tauri::AppHandle, state: WebPlayerState) -> Router {
    let bridge_header = HeaderName::from_static(BRIDGE_HEADER);
    Router::new()
        .route("/web-player/state", post(bridge_state))
        .route("/web-player/identity", post(bridge_identity))
        .layer(DefaultBodyLimit::max(16 * 1024))
        .layer(
            CorsLayer::new()
                .allow_origin([
                    HeaderValue::from_static("https://music.youtube.com"),
                    HeaderValue::from_static("https://www.youtube.com"),
                ])
                .allow_methods([Method::POST])
                .allow_headers([CONTENT_TYPE, bridge_header])
                .allow_private_network(true),
        )
        .with_state((app, state))
}

fn trusted_bridge_origin(headers: &HeaderMap) -> Option<&HeaderValue> {
    headers.get("origin").filter(|value| {
        matches!(
            value.to_str(),
            Ok("https://music.youtube.com") | Ok("https://www.youtube.com")
        )
    })
}

fn trusted_bridge_request(headers: &HeaderMap) -> bool {
    trusted_bridge_origin(headers).is_some()
        && headers
            .get(BRIDGE_HEADER)
            .and_then(|value| value.to_str().ok())
            == Some("1")
}

async fn bridge_state(
    State((app, state)): State<(tauri::AppHandle, WebPlayerState)>,
    headers: HeaderMap,
    Json(payload): Json<PlaybackStateEvent>,
) -> StatusCode {
    if !trusted_bridge_request(&headers) {
        return StatusCode::FORBIDDEN;
    }
    apply_state_event(&app, &state, payload).await
}

/// Validate and publish one observer envelope. Every transport shares this:
/// Windows loopback HTTP, Linux's secure custom scheme, and the macOS script
/// message handler. Callers must have already established that the request
/// came from a trusted origin.
async fn apply_state_event(
    app: &tauri::AppHandle,
    state: &WebPlayerState,
    mut payload: PlaybackStateEvent,
) -> StatusCode {
    if payload.version != BRIDGE_VERSION
        || !payload.position.is_finite()
        || !payload.duration.is_finite()
        || !payload.volume.is_finite()
    {
        return StatusCode::FORBIDDEN;
    }

    let mut inner = state.inner.lock().await;
    if payload.generation != inner.generation || payload.video_id != inner.video_id {
        return StatusCode::CONFLICT;
    }
    if !sequence_is_fresh(inner.last_sequence, payload.sequence) {
        return StatusCode::CONFLICT;
    }
    inner.last_sequence = Some(payload.sequence);
    // The observer reports `finished` from the moment the requested track is
    // over — including the samples between its completion and the one-shot
    // terminal event. The official page's own autoplay queue has usually moved
    // to another video id by then, and treating that as a wrong-track load
    // reloaded the WebPlayer on the same queue row instead of advancing.
    let terminal_pending = (payload.ended || payload.finished) && !payload.advertisement;
    if is_unexpected_track(
        payload.actual_video_id.as_deref(),
        &inner.video_id,
        payload.advertisement,
        terminal_pending,
        inner.terminal_emitted,
    ) {
        payload.error = Some("official player loaded an unexpected track".into());
    }
    let actual_matches_requested =
        actual_video_matches_requested(payload.actual_video_id.as_deref(), &inner.video_id);
    let identity_unknown = payload
        .actual_video_id
        .as_deref()
        .map_or(true, |actual| actual.is_empty());
    inner.unidentified_samples = if identity_unknown {
        inner.unidentified_samples.saturating_add(1)
    } else {
        0
    };
    if !payload.advertisement
        && !terminal_pending
        && !inner.terminal_emitted
        && identity_unknown
        && inner.unidentified_samples <= IDENTITY_GRACE_SAMPLES
    {
        // Do not authorize an actionable content sample until the official
        // player's video identity is observable.
        //
        // The grace bound matters: some engines never expose the player API,
        // and an unbounded gate reported buffering for the entire track, so the
        // interface sat in a loading state while audio played correctly. After
        // the grace period the sample is trusted on its own terms — the page was
        // navigated to exactly this track's watch URL, and identity is only a
        // corroboration of that.
        payload.ready = false;
        payload.playing = false;
        payload.buffering = true;
    }
    let requested_content_playing = payload.playing && actual_matches_requested;
    let ended_gate = gate_ended_event(
        inner.advertisement,
        inner.suppress_ended_until_content_playing,
        payload.advertisement,
        requested_content_playing,
        payload.ended,
    );
    inner.advertisement = ended_gate.advertisement;
    inner.suppress_ended_until_content_playing = ended_gate.suppress_until_content_playing;
    inner.last_heartbeat = Some(Instant::now());
    payload.ended = ended_gate.emit_ended && !inner.terminal_emitted;
    if payload.ended {
        inner.terminal_emitted = true;
    }
    payload.position = payload.position.max(0.0);
    payload.duration = payload.duration.max(0.0);
    payload.volume = payload.volume.clamp(0.0, 1.0);
    if let Some(error) = payload.error.as_mut() {
        *error = error.chars().take(240).collect();
    }
    drop(inner);

    let _ = app.emit("web-player-state", payload);
    StatusCode::NO_CONTENT
}

async fn bridge_identity(
    State((_app, state)): State<(tauri::AppHandle, WebPlayerState)>,
    headers: HeaderMap,
    Json(payload): Json<IdentityStateEvent>,
) -> StatusCode {
    if !trusted_bridge_request(&headers) {
        return StatusCode::FORBIDDEN;
    }
    apply_identity_event(&state, payload).await
}

/// Record the one identity boolean a probe document may report. Shared by the
/// loopback route and the Linux custom scheme, as [`apply_state_event`] is.
async fn apply_identity_event(state: &WebPlayerState, payload: IdentityStateEvent) -> StatusCode {
    if payload.version != BRIDGE_VERSION {
        return StatusCode::FORBIDDEN;
    }

    let mut inner = state.inner.lock().await;
    if payload.generation != inner.identity_generation || inner.identity_result.is_some() {
        return StatusCode::CONFLICT;
    }
    inner.identity_result = Some(payload.matches);
    drop(inner);
    // `notify_one` stores a permit when verification completes just before
    // the waiter arms, avoiding the lost-wakeup behavior of `notify_waiters`.
    state.identity_notify.notify_one();
    StatusCode::NO_CONTENT
}

/// Addressing shared by the WebKit observer transports.
///
/// WebKitGTK refuses to load an `http://127.0.0.1` subresource from the
/// official page's HTTPS document: the observer's `fetch` is blocked as mixed
/// content before it leaves the page, so not one sample reaches the loopback
/// server. WKWebView can likewise withhold the loopback request behind
/// private-network policy. In both cases playback is audible while React never
/// sees `ready`, times the track out, and tears the WebPlayer down mid-song.
/// Chromium keeps the loopback route. Linux sends to the app-owned protocol;
/// macOS uses that protocol-shaped URL only as an authenticated address carried
/// inside its WKScriptMessageHandler envelope.
///
/// On Linux, wry registers the custom URI scheme with WebKit's security manager
/// as secure, which lifts the mixed-content block. On macOS, page CSP rejects a
/// fetch to the custom scheme, so the script-message handler routes the same
/// token, route, and JSON body to the shared validators without a network hop.
#[cfg(any(target_os = "linux", target_os = "macos"))]
pub const BRIDGE_SCHEME: &str = "goosicbridge";

/// Mirrors the loopback router's `DefaultBodyLimit`.
#[cfg(any(target_os = "linux", target_os = "macos"))]
const BRIDGE_BODY_LIMIT: usize = 16 * 1024;

/// Address the observer and identity probe post their envelopes to. `route` is
/// `state` or `identity`; `port` addresses the loopback server on Windows.
pub fn bridge_endpoint(port: u16, token: &str, route: &str) -> String {
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    {
        let _ = port;
        format!("{BRIDGE_SCHEME}://bridge/{token}/web-player/{route}")
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        format!("http://127.0.0.1:{port}/{token}/web-player/{route}")
    }
}

/// Answer one custom-scheme bridge request.
///
/// Applies the same gates the loopback router does — trusted origin, the
/// bridge header, the per-launch secret in the path, POST only, and the 16 KiB
/// envelope limit — plus one the HTTP route cannot express: the playback
/// WebView is the only webview allowed to reach this scheme. Linux-only:
/// macOS reaches native code through `install_message_bridge` instead, since
/// WebKit refuses the custom-scheme `fetch` outright.
#[cfg(target_os = "linux")]
pub async fn serve_bridge_scheme(
    app: &tauri::AppHandle,
    state: &WebPlayerState,
    webview_label: &str,
    token: &str,
    request: tauri::http::Request<Vec<u8>>,
) -> tauri::http::Response<Vec<u8>> {
    let status = bridge_scheme_status(app, state, webview_label, token, &request).await;
    let builder = tauri::http::Response::builder().status(status);
    // The document is cross-origin to this scheme, so its `fetch` resolves —
    // and the observer only learns a terminal event landed — when the response
    // opts that origin in. An untrusted caller is refused without one.
    let builder = match trusted_bridge_origin(request.headers()) {
        Some(origin) => builder
            .header("access-control-allow-origin", origin.clone())
            .header("vary", "Origin"),
        None => builder,
    };
    builder.body(Vec::new()).unwrap_or_else(|_| {
        let mut response = tauri::http::Response::new(Vec::new());
        *response.status_mut() = StatusCode::INTERNAL_SERVER_ERROR;
        response
    })
}

#[cfg(target_os = "linux")]
async fn bridge_scheme_status(
    app: &tauri::AppHandle,
    state: &WebPlayerState,
    webview_label: &str,
    token: &str,
    request: &tauri::http::Request<Vec<u8>>,
) -> StatusCode {
    if token.is_empty()
        || webview_label != PLAYER_LABEL
        || request.method() != Method::POST
        || !trusted_bridge_request(request.headers())
        || request.body().len() > BRIDGE_BODY_LIMIT
    {
        return StatusCode::FORBIDDEN;
    }
    let Some(route) = bridge_scheme_route(request.uri().path(), token) else {
        return StatusCode::FORBIDDEN;
    };
    match route {
        "state" => match serde_json::from_slice(request.body()) {
            Ok(payload) => apply_state_event(app, state, payload).await,
            Err(_) => StatusCode::BAD_REQUEST,
        },
        "identity" => match serde_json::from_slice(request.body()) {
            Ok(payload) => apply_identity_event(state, payload).await,
            Err(_) => StatusCode::BAD_REQUEST,
        },
        _ => StatusCode::NOT_FOUND,
    }
}

/// Strip the secret prefix the loopback router expresses as a `nest`, leaving
/// the route name. `None` means the request did not carry this launch's token.
#[cfg(any(target_os = "linux", target_os = "macos", test))]
fn bridge_scheme_route<'a>(path: &'a str, token: &str) -> Option<&'a str> {
    path.strip_prefix('/')?
        .strip_prefix(token)?
        .strip_prefix("/web-player/")
        .filter(|route| !route.is_empty())
}

fn observer_script(bridge_url: &str) -> String {
    let bridge = serde_json::to_string(bridge_url).expect("URL serializes");
    format!(
        r#"
(() => {{
  if (window.top !== window) return;
  if (location.origin !== 'https://music.youtube.com' && location.origin !== 'https://www.youtube.com') return;
  // YouTube Music registers a beforeunload confirmation after its player
  // state changes. This WebView is an internal playback transport, not a user-
  // editable browser tab; allowing that handler would surface a modal "Leave
  // site?" dialog over Goosic every time native code navigates to a new track.
  // Install the guard at document start, before the page's own scripts.
  const nativeWindowAddEventListener = window.addEventListener.bind(window);
  nativeWindowAddEventListener('beforeunload', (event) => {{
    // Do not cancel the event ourselves; simply prevent later page handlers
    // from setting returnValue/preventDefault and requesting a confirmation.
    event.stopImmediatePropagation();
  }}, {{ capture: true }});
  Object.defineProperty(window, 'addEventListener', {{
    configurable: false,
    value: (type, listener, options) => {{
      if (String(type).toLowerCase() === 'beforeunload') return;
      return nativeWindowAddEventListener(type, listener, options);
    }},
  }});
  try {{
    Object.defineProperty(window, 'onbeforeunload', {{
      configurable: false,
      enumerable: true,
      get: () => null,
      set: () => {{}},
    }});
  }} catch {{
    window.onbeforeunload = null;
  }}
  const bridge = {bridge};
  const nativeFetch = window.fetch.bind(window);
  // WKWebView rejects fetch() from this https document to both loopback HTTP
  // and app-owned schemes, so macOS reports through a script message handler
  // installed on the user content controller right after the WebView is
  // created. Resolved per call: that install can land a tick after this
  // document-start script runs. Other platforms fall through to fetch.
  const send = (target, options) => {{
    const wk = window.webkit && window.webkit.messageHandlers;
    const native = wk && wk.goosicBridge;
    if (native) {{
      try {{
        native.postMessage(JSON.stringify({{ url: target, body: (options && options.body) || '' }}));
        return Promise.resolve({{ ok: true }});
      }} catch (error) {{
        return Promise.reject(error);
      }}
    }}
    return nativeFetch(target, options);
  }};
  const url = new URL(location.href);
  const fragment = new URLSearchParams(url.hash.replace(/^#/, ''));
  const fromUrl = (name) => url.searchParams.get(name) || fragment.get(name) || '';
  const readSession = (name) => {{
    try {{ return sessionStorage.getItem(name) || ''; }} catch {{ return ''; }}
  }};
  const initialGeneration = fromUrl('goosic_generation');
  const initialVideoId = url.searchParams.get('v') || '';
  const storedGeneration = readSession('goosic-player-generation');
  const storedVideoId = readSession('goosic-player-video-id');
  const resumesStoredPlayback = !!initialGeneration &&
    initialGeneration === storedGeneration &&
    !!storedVideoId;
  const startsNewPlayback = !!initialGeneration && !!initialVideoId && !resumesStoredPlayback;
  if (initialGeneration && initialVideoId) {{
    try {{
      if (startsNewPlayback) {{
        sessionStorage.setItem('goosic-player-sequence', '0');
        sessionStorage.setItem('goosic-player-autoplay', fromUrl('goosic_autoplay'));
        sessionStorage.setItem('goosic-player-volume', fromUrl('goosic_volume'));
        sessionStorage.setItem('goosic-player-muted', fromUrl('goosic_muted'));
      }}
      sessionStorage.setItem('goosic-player-generation', initialGeneration);
      sessionStorage.setItem('goosic-player-video-id', resumesStoredPlayback ? storedVideoId : initialVideoId);
    }} catch {{}}
  }}
  const generation = Number(initialGeneration || readSession('goosic-player-generation') || 0);
  const requestedVideoId = (startsNewPlayback ? initialVideoId : storedVideoId) || initialVideoId;
  const desiredAutoplay = startsNewPlayback
    ? fromUrl('goosic_autoplay')
    : readSession('goosic-player-autoplay') || fromUrl('goosic_autoplay');
  const desiredVolume = startsNewPlayback
    ? fromUrl('goosic_volume')
    : readSession('goosic-player-volume') || fromUrl('goosic_volume');
  const desiredMuted = startsNewPlayback
    ? fromUrl('goosic_muted')
    : readSession('goosic-player-muted') || fromUrl('goosic_muted');
  const shouldAutoplay = desiredAutoplay === '1';
  const parsedVolume = Number(desiredVolume || 1);
  const initialVolume = Number.isFinite(parsedVolume) ? Math.max(0, Math.min(1, parsedVolume)) : 1;
  const initialMuted = desiredMuted === '1';
  const documentSession = Object.freeze({{ generation, videoId: requestedVideoId }});
  try {{
    Object.defineProperty(window, '__goosicPlaybackSession', {{
      value: documentSession,
      configurable: false,
      enumerable: false,
      writable: false
    }});
  }} catch {{}}
  const desiredState = {{ playing: shouldAutoplay, volume: initialVolume, muted: initialMuted }};
  try {{
    Object.defineProperty(window, '__goosicPlaybackDesiredState', {{
      value: desiredState,
      configurable: false,
      enumerable: false,
      writable: false
    }});
  }} catch {{}}
  // Goosic's transport owns the output level. YouTube assigns its own
  // persisted volume (usually 1.0) to a replacement media element the instant
  // it is created — before any observer sample, `volumechange` listener, or
  // native eval can run — which produced a short burst at full volume during
  // track transitions. Governing the prototype accessor closes that window
  // entirely: the page may still make the element quieter (WebKit's silent
  // autoplay probing relies on that) but it can never exceed the requested
  // level.
  try {{
    const volumeDescriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'volume');
    if (volumeDescriptor && typeof volumeDescriptor.get === 'function' && typeof volumeDescriptor.set === 'function') {{
      Object.defineProperty(HTMLMediaElement.prototype, 'volume', {{
        configurable: true,
        enumerable: volumeDescriptor.enumerable,
        get() {{ return volumeDescriptor.get.call(this); }},
        set(value) {{
          const requested = Number(value);
          const ceiling = desiredState.volume;
          volumeDescriptor.set.call(
            this,
            Number.isFinite(requested) ? Math.min(Math.max(requested, 0), ceiling) : ceiling
          );
        }}
      }});
    }}
  }} catch {{}}
  const applyDesiredVolume = (media) => {{
    if (!media) return;
    try {{
      if (Math.abs(media.volume - desiredState.volume) > 0.0001) {{
        media.volume = desiredState.volume;
      }}
    }} catch {{}}
  }};
  // A newly constructed element starts at 1.0 without passing through the
  // setter above, so normalize once more on the one call that can turn a media
  // element into audible output.
  try {{
    const nativePlay = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function (...args) {{
      applyDesiredVolume(this);
      return nativePlay.apply(this, args);
    }};
  }} catch {{}}
  const storedSequence = Number(readSession('goosic-player-sequence'));
  let sequence = Number.isSafeInteger(storedSequence) && storedSequence >= 0 ? storedSequence : 0;
  const nextSequence = () => {{
    sequence += 1;
    try {{ sessionStorage.setItem('goosic-player-sequence', String(sequence)); }} catch {{}}
    return sequence;
  }};
  let initialized = false;
  let attachedMedia = null;
  let requestedContentMedia = null;
  let autoplayAttempts = 0;
  let pendingContentEnded = false;
  let pendingContentEndedSawAd = false;
  let pendingContentEndedPageMoved = false;
  let pendingContentEndedNonAdSamples = 0;
  let pendingError = null;
  let lastObservedAd = false;
  let suppressEndedUntilContentPlaying = false;
  let reportedTrackEnded = false;
  // True once the official page has actually loaded the track Goosic asked
  // for. Until then a mismatched video id is a wrong-track load; afterwards it
  // means the page's own autoplay queue moved past our track.
  let observedRequestedContent = false;
  const findMedia = () =>
    document.querySelector('ytmusic-player video') ||
    document.querySelector('#movie_player video') ||
    document.querySelector('video') ||
    document.querySelector('audio');
  const detectAd = () => !!document.querySelector(
    '.ad-showing, ytmusic-player-bar[ad-playing], ytmusic-player-bar[is-advertisement], .ytp-ad-player-overlay, .ytp-ad-text'
  );
  const readActualVideoId = () => {{
    try {{
      const players = [
        document.querySelector('ytmusic-player')?.playerApi,
        document.querySelector('ytmusic-player-bar')?.playerApi,
        document.querySelector('#movie_player')
      ];
      for (const player of players) {{
        const data = player?.getVideoData?.();
        const id = data?.video_id || data?.videoId;
        if (typeof id === 'string' && id) return id;
      }}
    }} catch {{}}
    // The player API is not reachable on every engine: WKWebView and WebKitGTK
    // can leave `playerApi` undefined even while playback is healthy, which
    // used to leave identity permanently unknown. YouTube Music keeps `?v=` in
    // its own address in step with whatever it is playing, including when its
    // autoplay queue moves on, so the page's URL is a reliable second source.
    try {{
      const fromLocation = new URL(location.href).searchParams.get('v');
      if (typeof fromLocation === 'string' && fromLocation) return fromLocation;
    }} catch {{}}
    return null;
  }};
  try {{
    if (navigator.mediaSession?.setActionHandler) {{
      navigator.mediaSession.setActionHandler = () => {{}};
    }}
  }} catch {{}}
  try {{
    if (navigator.locks?.request) {{
      void navigator.locks.request('goosic-playback-active', () => new Promise(() => {{}}));
    }}
  }} catch {{}}
  let postQueued = false;
  let postInFlight = false;
  let postAfterFlight = false;
  const schedulePost = () => {{
    if (postInFlight) {{
      postAfterFlight = true;
      return;
    }}
    if (postQueued) return;
    postQueued = true;
    queueMicrotask(() => {{
      postQueued = false;
      post();
    }});
  }};
  const mediaReachedEnd = (media) => !!media && (media.ended || (
    Number.isFinite(media.duration) && media.duration > 0 &&
    media.currentTime >= media.duration - 0.05
  ));
  const attemptPlayback = (media) => {{
    if (!desiredState.playing || !media?.paused || autoplayAttempts >= 5) return;
    // Reaching the end fires `pause` before `ended`, and `play()` on a
    // finished element rewinds it to zero. Without this guard the resume
    // helper restarted the very track Goosic was about to advance past.
    if (pendingContentEnded || reportedTrackEnded || mediaReachedEnd(media)) return;
    // Never force-start the official page's own autoplay pick; Goosic's queue
    // decides what plays next. Advertisements are exempt because the page
    // legitimately owns that media and Goosic must not interfere with it.
    if (!detectAd()) {{
      const actual = readActualVideoId();
      if (actual && actual !== requestedVideoId) return;
    }}
    autoplayAttempts += 1;
    void media.play().catch(() => {{
      const button = document.querySelector(
        'ytmusic-player-bar #play-pause-button,#movie_player .ytp-play-button'
      );
      if (desiredState.playing && media.paused && button) button.click();
    }});
  }};
  const post = () => {{
    if (postInFlight) {{
      postAfterFlight = true;
      return;
    }}
    const media = findMedia();
    if (media && media !== attachedMedia) {{
      attachedMedia = media;
      initialized = false;
      autoplayAttempts = 0;
      const observedMedia = media;
      media.addEventListener('ended', () => {{
        if (observedMedia !== attachedMedia) return;
        const endedDuringAd = lastObservedAd || detectAd();
        const actualAtEnd = readActualVideoId();
        // A post-roll ad marker can already be on the page during the tick the
        // requested content ends. Identity is the reliable discriminator: the
        // official player reports the advertisement's own id while an ad owns
        // the element, so a matching id means our track is what finished and
        // the marker must not swallow its completion.
        const endedRequestedContent = actualAtEnd === requestedVideoId ||
          (!actualAtEnd && !endedDuringAd && observedMedia === requestedContentMedia);
        if (endedRequestedContent) {{
          pendingContentEnded = true;
          pendingContentEndedSawAd = endedDuringAd;
          pendingContentEndedNonAdSamples = 0;
        }} else if (endedDuringAd) {{
          suppressEndedUntilContentPlaying = true;
        }}
        schedulePost();
      }}, {{ capture: true, passive: true }});
      media.addEventListener('error', () => {{
        if (observedMedia === attachedMedia) {{
          pendingError = media.error ? `media error ${{media.error.code}}` : 'media error';
        }}
        schedulePost();
      }}, {{ passive: true }});
      for (const eventName of [
        'loadedmetadata', 'durationchange', 'timeupdate', 'play', 'playing',
        'pause', 'waiting', 'stalled', 'seeking', 'seeked', 'volumechange',
        'canplay', 'emptied'
      ]) {{
        media.addEventListener(eventName, () => {{
          if (observedMedia !== attachedMedia) return;
          if (eventName === 'loadedmetadata' || eventName === 'canplay' || eventName === 'pause') {{
            attemptPlayback(media);
          }}
          schedulePost();
        }}, {{ passive: true }});
      }}
    }}
    if (media && !initialized) {{
      initialized = true;
      if (!detectAd()) {{
        media.volume = desiredState.volume;
        media.muted = desiredState.muted;
      }}
      if (desiredState.playing) attemptPlayback(media);
      else media.pause();
    }}
    const ad = detectAd();
    const actualVideoId = readActualVideoId();
    const error = pendingError || (media?.error ? `media error ${{media.error.code}}` : null);
    const actualMatchesRequested = actualVideoId === requestedVideoId;
    // Goosic's volume store is the transport authority. The prototype ceiling
    // installed at document start already makes anything louder impossible;
    // this pins the element to the exact requested level after YouTube resets
    // a replacement element to its own persisted default. Mute stays untouched
    // during advertisements, which Goosic never alters.
    applyDesiredVolume(media);
    if (media && !ad && media.muted !== desiredState.muted) {{
      media.muted = desiredState.muted;
    }}
    if (media && !ad && actualMatchesRequested) {{
      requestedContentMedia = media;
      if (media.readyState >= 1) observedRequestedContent = true;
    }}
    // The official page runs its own autoplay queue inside this transport
    // document. Once it moves past the track Goosic asked for, that track has
    // finished — report an ordinary completion instead of letting the native
    // bridge read the page's own pick as an unexpected-track failure, which
    // tore down and reloaded the WebPlayer on the same row instead of
    // advancing the queue. `lastObservedAd`/`suppressEndedUntilContentPlaying`
    // keep advertisements out of this path: the DOM ad marker can clear one
    // sample before the official player reports the requested content again,
    // and that transition must not be mistaken for an auto-advance.
    const pageAdvancedPastRequest = !ad &&
      !lastObservedAd &&
      !suppressEndedUntilContentPlaying &&
      observedRequestedContent &&
      !!actualVideoId &&
      !actualMatchesRequested;
    if (pageAdvancedPastRequest && !pendingContentEnded && !reportedTrackEnded) {{
      pendingContentEnded = true;
      pendingContentEndedPageMoved = true;
      pendingContentEndedSawAd = false;
      pendingContentEndedNonAdSamples = 0;
    }}
    const finished = pendingContentEnded || reportedTrackEnded;
    // Silence whatever the page picked for itself. Goosic's queue owns the
    // next track, and without this the page's choice stays audible for as long
    // as it takes the completion to reach React and navigate this WebView.
    if (finished && media && !ad && !lastObservedAd && !actualMatchesRequested && !media.paused) {{
      media.pause();
    }}
    if (ad) {{
      suppressEndedUntilContentPlaying = true;
      if (pendingContentEnded) {{
        pendingContentEndedSawAd = true;
        pendingContentEndedNonAdSamples = 0;
      }}
    }}
    const requestedContentPlaying = !!media &&
      !ad &&
      !media.paused &&
      !media.ended &&
      actualMatchesRequested;
    if (requestedContentPlaying) {{
      suppressEndedUntilContentPlaying = false;
      autoplayAttempts = 0;
      if (media.currentTime < Math.max(1, (Number.isFinite(media.duration) ? media.duration : 0) - 1)) {{
        reportedTrackEnded = false;
      }}
    }}
    let ended = false;
    if (pendingContentEnded && !ad && !reportedTrackEnded) {{
      if (pendingContentEndedSawAd || pendingContentEndedPageMoved) {{
        ended = true;
      }} else {{
        // Give the official player one complete observer sample to expose a
        // post-roll ad before publishing the requested content's terminal
        // event. This is state-based rather than a timing guess.
        pendingContentEndedNonAdSamples += 1;
        ended = pendingContentEndedNonAdSamples >= 2;
      }}
    }}
    if (ended) {{
      suppressEndedUntilContentPlaying = false;
    }}
    pendingError = null;
    lastObservedAd = ad;
    const body = {{
      version: {BRIDGE_VERSION},
      generation,
      sequence: nextSequence(),
      videoId: requestedVideoId,
      actualVideoId,
      ready: !!media && media.readyState >= 1,
      playing: !!media && !media.paused && !media.ended,
      buffering: !!media && !media.paused && media.readyState < 3,
      position: Number.isFinite(media?.currentTime) ? media.currentTime : 0,
      duration: Number.isFinite(media?.duration) ? media.duration : 0,
      volume: Number.isFinite(media?.volume) ? media.volume : 1,
      muted: !!media?.muted,
      advertisement: ad,
      ended,
      // The requested track is over even if its terminal event has not been
      // published yet. React uses this to stop re-issuing `play` at a document
      // that would only rewind and restart the finished song.
      finished,
      error
    }};
    postInFlight = true;
    send(bridge, {{ method: 'POST', headers: {{ 'content-type': 'application/json', '{BRIDGE_HEADER}': '1' }}, body: JSON.stringify(body), cache: 'no-store' }})
      .then((response) => {{
        if (ended && response.ok) {{
          reportedTrackEnded = true;
          pendingContentEnded = false;
          pendingContentEndedSawAd = false;
          pendingContentEndedPageMoved = false;
          pendingContentEndedNonAdSamples = 0;
        }}
      }})
      .catch(() => {{}})
      .finally(() => {{
        postInFlight = false;
        if (postAfterFlight) {{
          postAfterFlight = false;
          schedulePost();
        }}
      }});
  }};
  const interval = window.setInterval(schedulePost, 250);
  document.addEventListener('DOMContentLoaded', schedulePost, {{ once: true, passive: true }});
  post();
  window.addEventListener('pagehide', () => window.clearInterval(interval), {{ once: true }});
}})();
"#
    )
}

/// Probe the official page's effective identity without sending its
/// `DATASYNC_ID` (or the expected page id) across the bridge. The server-issued
/// `/signin` document is deliberately ignored: it can still expose the old
/// identity before YouTube has applied the selection. Only a post-redirect
/// YouTube document with a structurally valid DATASYNC_ID reports one boolean.
fn identity_probe_script(
    bridge_url: &str,
    generation: u64,
    expected_page_id: Option<&str>,
) -> String {
    let bridge = serde_json::to_string(bridge_url).expect("URL serializes");
    let expected = serde_json::to_string(&expected_page_id).expect("page id serializes");
    format!(
        r#"
(() => {{
  if (window.top !== window) return;
  if (location.origin !== 'https://music.youtube.com' && location.origin !== 'https://www.youtube.com') return;
  if (location.pathname === '/signin') return;
  const bridge = {bridge};
  const expectedPageId = {expected};
  let sent = false;
  const verify = () => {{
    if (sent) return;
    let raw = '';
    try {{ raw = window.ytcfg?.get?.('DATASYNC_ID') || ''; }} catch {{ return; }}
    if (typeof raw !== 'string') return;
    const pieces = raw.split('||');
    if (pieces.length !== 2 || !pieces[0]) return;
    const matches = expectedPageId === null
      ? pieces[1] === ''
      : pieces[0] === expectedPageId && pieces[1].length > 0;
    sent = true;
    const payload = JSON.stringify({{ version: {BRIDGE_VERSION}, generation: {generation}, matches }});
    // Same macOS transport split as the playback observer: script message
    // handler when native installed one, fetch elsewhere.
    const wk = window.webkit && window.webkit.messageHandlers;
    const native = wk && wk.goosicBridge;
    if (native) {{
      try {{
        native.postMessage(JSON.stringify({{ url: bridge, body: payload }}));
      }} catch {{
        sent = false;
      }}
      return;
    }}
    window.fetch(bridge, {{
      method: 'POST',
      headers: {{ 'content-type': 'application/json', '{BRIDGE_HEADER}': '1' }},
      body: payload,
      cache: 'no-store'
    }}).catch(() => {{ sent = false; }});
  }};
  const timer = window.setInterval(verify, 250);
  document.addEventListener('DOMContentLoaded', verify, {{ once: true, passive: true }});
  window.addEventListener('pagehide', () => window.clearInterval(timer), {{ once: true }});
  verify();
}})();
"#
    )
}

fn trusted_navigation(url: &tauri::Url) -> bool {
    if url.scheme() != "https" {
        return false;
    }
    url.host_str().is_some_and(|host| {
        host == "music.youtube.com"
            || host == "www.youtube.com"
            || host == "accounts.google.com"
            || host == "consent.youtube.com"
            || host == "consent.google.com"
    })
}

#[cfg(target_os = "windows")]
fn configure_background_window(window: &tauri::WebviewWindow) -> Result<(), String> {
    use std::ffi::c_void;

    type Hwnd = *mut c_void;
    const GWL_EXSTYLE: i32 = -20;
    const SWP_NOSIZE: u32 = 0x0001;
    const SWP_NOZORDER: u32 = 0x0004;
    const SWP_NOACTIVATE: u32 = 0x0010;
    const SWP_FRAMECHANGED: u32 = 0x0020;

    #[link(name = "user32")]
    extern "system" {
        #[cfg(target_pointer_width = "64")]
        fn GetWindowLongPtrW(window: Hwnd, index: i32) -> isize;
        #[cfg(target_pointer_width = "32")]
        #[link_name = "GetWindowLongW"]
        fn GetWindowLongPtrW(window: Hwnd, index: i32) -> isize;
        #[cfg(target_pointer_width = "64")]
        fn SetWindowLongPtrW(window: Hwnd, index: i32, value: isize) -> isize;
        #[cfg(target_pointer_width = "32")]
        #[link_name = "SetWindowLongW"]
        fn SetWindowLongPtrW(window: Hwnd, index: i32, value: isize) -> isize;
        fn SetWindowPos(
            window: Hwnd,
            insert_after: Hwnd,
            x: i32,
            y: i32,
            width: i32,
            height: i32,
            flags: u32,
        ) -> i32;
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn GetLastError() -> u32;
        fn SetLastError(error: u32);
    }

    let hwnd = window
        .hwnd()
        .map_err(|error| format!("get playback window handle: {error}"))?
        .0 as Hwnd;

    window
        .set_focusable(false)
        .map_err(|error| format!("disable playback window focus: {error}"))?;
    window
        .set_skip_taskbar(true)
        .map_err(|error| format!("exclude playback window from taskbar: {error}"))?;
    window
        .set_ignore_cursor_events(true)
        .map_err(|error| format!("disable playback window input: {error}"))?;

    // Tao replaces an off-monitor builder position with CW_USEDEFAULT. Move
    // the still-hidden HWND first, then map it exactly once. The style patch
    // must happen after `show`: Tao recomputes the complete extended style as
    // part of that transition and would otherwise restore WS_EX_APPWINDOW.
    unsafe {
        if SetWindowPos(
            hwnd,
            std::ptr::null_mut(),
            -32000,
            -32000,
            0,
            0,
            SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE,
        ) == 0
        {
            return Err(format!(
                "position hidden playback window: Win32 error {}",
                GetLastError()
            ));
        }
    }

    window
        .show()
        .map_err(|error| format!("activate hidden playback window: {error}"))?;
    window
        .set_skip_taskbar(true)
        .map_err(|error| format!("exclude playback window from taskbar: {error}"))?;
    window
        .set_ignore_cursor_events(true)
        .map_err(|error| format!("disable playback window input: {error}"))?;

    unsafe {
        SetLastError(0);
        let old_style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        let read_error = GetLastError();
        if old_style == 0 && read_error != 0 {
            return Err(format!(
                "read hidden playback window style: Win32 error {read_error}"
            ));
        }

        SetLastError(0);
        let previous = SetWindowLongPtrW(hwnd, GWL_EXSTYLE, hardened_windows_ex_style(old_style));
        let write_error = GetLastError();
        if previous == 0 && write_error != 0 {
            return Err(format!(
                "apply hidden playback window style: Win32 error {write_error}"
            ));
        }

        if SetWindowPos(
            hwnd,
            std::ptr::null_mut(),
            -32000,
            -32000,
            0,
            0,
            SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED,
        ) == 0
        {
            return Err(format!(
                "finalize hidden playback window: Win32 error {}",
                GetLastError()
            ));
        }
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn configure_background_window(window: &tauri::WebviewWindow) -> Result<(), String> {
    use objc2_app_kit::{NSWindow, NSWindowCollectionBehavior};

    let ns_window = window
        .ns_window()
        .map_err(|error| format!("get playback NSWindow: {error}"))?
        as *const NSWindow;
    if ns_window.is_null() {
        return Err("get playback NSWindow: null handle".into());
    }

    // A zero-alpha ordered NSWindow keeps WKWebView's media lifecycle active
    // without exposing it in the Window menu, Mission Control, or Cmd-` cycle.
    let ns_window = unsafe { &*ns_window };
    ns_window.setAlphaValue(0.0);
    ns_window.setIgnoresMouseEvents(true);
    ns_window.setExcludedFromWindowsMenu(true);
    ns_window.setCanHide(false);
    ns_window.setHidesOnDeactivate(false);
    ns_window.setHasShadow(false);
    let mut behavior = ns_window.collectionBehavior();
    behavior.remove(
        NSWindowCollectionBehavior::CanJoinAllSpaces
            | NSWindowCollectionBehavior::MoveToActiveSpace
            | NSWindowCollectionBehavior::Managed
            | NSWindowCollectionBehavior::Stationary
            | NSWindowCollectionBehavior::ParticipatesInCycle
            | NSWindowCollectionBehavior::FullScreenPrimary
            | NSWindowCollectionBehavior::FullScreenAuxiliary
            | NSWindowCollectionBehavior::FullScreenAllowsTiling
            | NSWindowCollectionBehavior::Primary
            | NSWindowCollectionBehavior::Auxiliary
            | NSWindowCollectionBehavior::CanJoinAllApplications,
    );
    behavior.insert(
        NSWindowCollectionBehavior::Transient
            | NSWindowCollectionBehavior::IgnoresCycle
            | NSWindowCollectionBehavior::FullScreenNone
            | NSWindowCollectionBehavior::FullScreenDisallowsTiling,
    );
    ns_window.setCollectionBehavior(behavior);

    window
        .set_focusable(false)
        .map_err(|error| format!("disable playback window focus: {error}"))?;
    window
        .set_ignore_cursor_events(true)
        .map_err(|error| format!("disable playback window input: {error}"))?;
    window
        .set_position(tauri::LogicalPosition::new(-32000.0, -32000.0))
        .map_err(|error| format!("position hidden playback window: {error}"))?;
    window
        .show()
        .map_err(|error| format!("activate hidden playback window: {error}"))?;
    Ok(())
}

#[cfg(target_os = "linux")]
fn configure_background_window(window: &tauri::WebviewWindow) -> Result<(), String> {
    use gtk::prelude::WidgetExt;

    window
        .set_focusable(false)
        .map_err(|error| format!("disable playback window focus: {error}"))?;
    window
        .set_skip_taskbar(true)
        .map_err(|error| format!("exclude playback window from taskbar: {error}"))?;

    // A mapped GTK surface is required for reliable WebKitGTK media lifecycle.
    // Make the native host fully transparent before mapping it. X11 also
    // honors an offscreen position; native Wayland forbids client-selected
    // positions, so alpha-zero + skip-taskbar + ignored input is its hidden
    // host contract.
    let gtk_window = window
        .gtk_window()
        .map_err(|error| format!("get hidden playback GTK window: {error}"))?;
    gtk_window.set_opacity(0.0);
    let configured_backend = std::env::var("GDK_BACKEND").ok();
    if linux_uses_x11_backend(
        configured_backend.as_deref(),
        std::env::var_os("WAYLAND_DISPLAY").is_some(),
    ) {
        window
            .set_position(tauri::LogicalPosition::new(-32000.0, -32000.0))
            .map_err(|error| format!("position hidden playback window: {error}"))?;
    }
    window
        .show()
        .map_err(|error| format!("activate hidden playback window: {error}"))?;

    // Strictly after the surface is mapped. Tao services this request with
    // `gtk_widget_get_window(...).unwrap()`, and that returns NULL until the
    // widget is realized — so asking before `show()` panicked. That panic runs
    // inside a glib dispatch callback, where unwinding is not allowed, so it
    // aborted the whole process the first time a track was played instead of
    // surfacing as an error. Keep this last.
    window
        .set_ignore_cursor_events(true)
        .map_err(|error| format!("disable playback window input: {error}"))?;
    Ok(())
}

#[cfg(any(target_os = "linux", test))]
fn linux_uses_x11_backend(configured_backend: Option<&str>, wayland_display: bool) -> bool {
    match configured_backend
        .and_then(|value| value.split(',').find(|entry| !entry.trim().is_empty()))
        .map(str::trim)
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("x11") => true,
        Some("wayland") => false,
        _ => !wayland_display,
    }
}

#[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
fn configure_background_window(_window: &tauri::WebviewWindow) -> Result<(), String> {
    Ok(())
}

async fn activate_background_window(
    app: &tauri::AppHandle,
    window: &tauri::WebviewWindow,
) -> Result<(), String> {
    let window = window.clone();
    let (sender, receiver) = tokio::sync::oneshot::channel();
    app.run_on_main_thread(move || {
        let _ = sender.send(configure_background_window(&window));
    })
    .map_err(|error| format!("schedule hidden playback window activation: {error}"))?;

    match tokio::time::timeout(CLOSE_TIMEOUT, receiver).await {
        Ok(Ok(result)) => result,
        Ok(Err(_)) => Err("hidden playback window activation was interrupted".into()),
        Err(_) => Err("hidden playback window activation timed out".into()),
    }
}

#[cfg(target_os = "macos")]
fn data_store_identifier(profile_key: &str) -> [u8; 16] {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(format!("goosic-webview-profile:{profile_key}").as_bytes());
    let mut identifier = [0u8; 16];
    identifier.copy_from_slice(&digest[..16]);
    identifier
}

async fn close_player(app: &tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(PLAYER_LABEL) {
        window
            .close()
            .map_err(|error| format!("close YouTube player: {error}"))?;
    }
    let deadline = tokio::time::Instant::now() + CLOSE_TIMEOUT;
    loop {
        if app.get_webview_window(PLAYER_LABEL).is_none() {
            return Ok(());
        }
        if tokio::time::Instant::now() >= deadline {
            return Err("timed out closing YouTube player".into());
        }
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }
}

pub async fn close_keepers(app: &tauri::AppHandle) -> Result<(), String> {
    let mut close_errors = Vec::new();
    for (label, window) in app.webview_windows() {
        if label.starts_with("keeper-") {
            if let Err(error) = window.close() {
                close_errors.push(format!("{label}: {error}"));
            }
        }
    }
    if !close_errors.is_empty() {
        return Err(format!(
            "close account session keeper: {}",
            close_errors.join("; ")
        ));
    }

    let deadline = tokio::time::Instant::now() + CLOSE_TIMEOUT;
    loop {
        let remaining: Vec<String> = app
            .webview_windows()
            .keys()
            .filter(|label| label.starts_with("keeper-"))
            .cloned()
            .collect();
        if remaining.is_empty() {
            return Ok(());
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(format!(
                "timed out closing account session keeper(s): {}",
                remaining.join(", ")
            ));
        }
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }
}

async fn clear_player_state(state: &WebPlayerState) {
    let mut inner = state.inner.lock().await;
    inner.generation = inner.generation.saturating_add(1);
    inner.video_id.clear();
    inner.profile_key.clear();
    inner.advertisement = false;
    inner.suppress_ended_until_content_playing = false;
    inner.last_sequence = None;
    inner.terminal_emitted = false;
    inner.unidentified_samples = 0;
    inner.last_heartbeat = None;
}

async fn clear_identity_result(state: &WebPlayerState, generation: u64) {
    let mut inner = state.inner.lock().await;
    if inner.identity_generation == generation {
        inner.identity_result = None;
    }
}

async fn wait_for_identity_result(
    state: &WebPlayerState,
    generation: u64,
    timeout: Duration,
) -> Result<bool, String> {
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        // Create and enable the waiter before checking shared state. Together
        // with notify_one's stored permit, this closes both sides of the
        // result-published-between-check-and-await race.
        let notified = state.identity_notify.notified();
        tokio::pin!(notified);
        notified.as_mut().enable();

        if let Some(result) = {
            let inner = state.inner.lock().await;
            (inner.identity_generation == generation)
                .then_some(inner.identity_result)
                .flatten()
        } {
            return Ok(result);
        }

        let now = tokio::time::Instant::now();
        if now >= deadline {
            return Err("account verification timed out".into());
        }
        tokio::select! {
            _ = &mut notified => {}
            _ = tokio::time::sleep_until(deadline) => {
                return Err("account verification timed out".into());
            }
        }
    }
}

/// Navigate the active account's browser profile through YouTube's ephemeral,
/// server-issued identity URL and prove the resulting official page matches
/// the requested personal/brand identity. The URL is accepted already parsed
/// by the caller and is never logged or persisted here.
#[allow(clippy::too_many_arguments)]
pub async fn select_identity(
    app: &tauri::AppHandle,
    state: &WebPlayerState,
    bridge_url: String,
    _profile_key: String,
    profile_dir: PathBuf,
    user_agent: &str,
    browser_args: &str,
    signin_url: tauri::Url,
    expected_page_id: Option<&str>,
) -> Result<(), String> {
    let _lifecycle = state.lifecycle.lock().await;
    close_keepers(app)
        .await
        .map_err(|_| "could not prepare account verification".to_string())?;
    close_player(app)
        .await
        .map_err(|_| "could not prepare account verification".to_string())?;
    clear_player_state(state).await;

    let identity_generation = {
        let mut inner = state.inner.lock().await;
        inner.identity_generation = inner.identity_generation.saturating_add(1).max(1);
        inner.identity_result = None;
        inner.identity_generation
    };

    std::fs::create_dir_all(&profile_dir)
        .map_err(|_| "could not open account profile".to_string())?;
    let builder = WebviewWindowBuilder::new(app, PLAYER_LABEL, WebviewUrl::External(signin_url))
        .title("Goosic account verification")
        .visible(false)
        .focused(false)
        .focusable(false)
        .decorations(false)
        .shadow(false)
        .skip_taskbar(true)
        .resizable(false)
        .minimizable(false)
        .maximizable(false)
        .inner_size(1024.0, 768.0)
        .background_throttling(tauri::utils::config::BackgroundThrottlingPolicy::Disabled)
        .data_directory(profile_dir)
        .user_agent(user_agent)
        .additional_browser_args(browser_args)
        .initialization_script(identity_probe_script(
            &bridge_url,
            identity_generation,
            expected_page_id,
        ))
        .on_navigation(trusted_navigation);
    #[cfg(target_os = "macos")]
    let builder = builder.data_store_identifier(data_store_identifier(&_profile_key));
    let verification_window = match builder.build() {
        Ok(window) => window,
        Err(_) => {
            clear_identity_result(state, identity_generation).await;
            return Err("could not start account verification".into());
        }
    };
    // The identity probe posts through the same macOS transport as the
    // playback observer; without the handler its boolean never arrives.
    #[cfg(target_os = "macos")]
    if let Err(error) = install_message_bridge(&verification_window, state, &bridge_url) {
        let _ = close_player(app).await;
        clear_identity_result(state, identity_generation).await;
        return Err(error);
    }
    if activate_background_window(app, &verification_window)
        .await
        .is_err()
    {
        let _ = close_player(app).await;
        clear_player_state(state).await;
        clear_identity_result(state, identity_generation).await;
        return Err("could not activate account verification".into());
    }

    let verification = wait_for_identity_result(state, identity_generation, IDENTITY_TIMEOUT).await;

    let close_result = close_player(app).await;
    clear_player_state(state).await;
    clear_identity_result(state, identity_generation).await;
    close_result.map_err(|_| "could not finish account verification".to_string())?;
    match verification? {
        true => Ok(()),
        false => Err("the official player selected a different channel".into()),
    }
}

fn guarded_playback_script(generation: u64, video_id: &str, body: &str) -> String {
    let expected_video_id = serde_json::to_string(video_id).expect("video id serializes");
    format!(
        r#"
(() => {{
  const expectedGeneration = {generation};
  const expectedVideoId = {expected_video_id};
  const immutableSession = window.__goosicPlaybackSession;
  let documentGeneration = Number.NaN;
  let documentVideoId = '';
  if (immutableSession && Object.isFrozen(immutableSession)) {{
    documentGeneration = Number(immutableSession.generation);
    documentVideoId = typeof immutableSession.videoId === 'string' ? immutableSession.videoId : '';
  }} else {{
    try {{
      documentGeneration = Number(sessionStorage.getItem('goosic-player-generation') || 0);
      documentVideoId = sessionStorage.getItem('goosic-player-video-id') || '';
    }} catch {{}}
  }}
  if (documentGeneration !== expectedGeneration || documentVideoId !== expectedVideoId) return;
  const readStored = (name) => {{
    try {{ return sessionStorage.getItem(name) || ''; }} catch {{ return ''; }}
  }};
  const storedVolume = Number(readStored('goosic-player-volume') || 1);
  const desired = window.__goosicPlaybackDesiredState || {{
    playing: readStored('goosic-player-autoplay') === '1',
    volume: Number.isFinite(storedVolume) ? Math.max(0, Math.min(1, storedVolume)) : 1,
    muted: readStored('goosic-player-muted') === '1'
  }};
  desired.playing = !!desired.playing;
  desired.volume = Number.isFinite(desired.volume) ? Math.max(0, Math.min(1, desired.volume)) : 1;
  desired.muted = !!desired.muted;
  const persistDesired = () => {{
    try {{
      sessionStorage.setItem('goosic-player-autoplay', desired.playing ? '1' : '0');
      sessionStorage.setItem('goosic-player-volume', String(desired.volume));
      sessionStorage.setItem('goosic-player-muted', desired.muted ? '1' : '0');
    }} catch {{}}
  }};
  const media = document.querySelector('ytmusic-player video') ||
    document.querySelector('#movie_player video') ||
    document.querySelector('video') ||
    document.querySelector('audio');
  const advertisement = !!document.querySelector(
    '.ad-showing, ytmusic-player-bar[ad-playing], ytmusic-player-bar[is-advertisement], .ytp-ad-player-overlay, .ytp-ad-text'
  );
  // The official player owns the media source. Assigning `currentTime` moves
  // only the element, so a target outside the buffered range collapses back to
  // whatever is already buffered and leaves the page's own clock — the one
  // driving its progress UI and its next segment requests — pointing somewhere
  // else entirely. `seekTo` is the supported entry point: it appends the media
  // for the requested position and keeps both clocks in agreement.
  const playerApi = (() => {{
    try {{
      const players = [
        document.querySelector('ytmusic-player')?.playerApi,
        document.querySelector('ytmusic-player-bar')?.playerApi,
        document.querySelector('#movie_player')
      ];
      for (const player of players) {{
        if (typeof player?.seekTo === 'function') return player;
      }}
    }} catch {{}}
    return null;
  }})();
  {body}
}})()
"#
    )
}

fn load_state_script(
    generation: u64,
    video_id: &str,
    playing: bool,
    volume: f64,
    muted: bool,
) -> String {
    let volume = if volume.is_finite() {
        volume.clamp(0.0, 1.0)
    } else {
        1.0
    };
    let transport = if playing {
        "void media.play().catch(() => { const button=document.querySelector('ytmusic-player-bar #play-pause-button,#movie_player .ytp-play-button'); if (media.paused && button) button.click(); });"
    } else {
        "media.pause();"
    };
    let body = format!(
        "desired.playing={playing}; desired.volume={volume}; desired.muted={muted}; persistDesired(); if (media) {{ if (!advertisement) {{ media.volume=desired.volume; media.muted=desired.muted; }} {transport} }}"
    );
    guarded_playback_script(generation, video_id, &body)
}

fn control_script(
    generation: u64,
    video_id: &str,
    action: &str,
    value: Option<f64>,
) -> Result<String, String> {
    let finite_value = || {
        value
            .filter(|candidate| candidate.is_finite())
            .ok_or_else(|| "invalid web player control value".to_string())
    };
    let body = match action {
        "play" => "desired.playing=true; persistDesired(); if (media) { void media.play().catch(() => { const button=document.querySelector('ytmusic-player-bar #play-pause-button,#movie_player .ytp-play-button'); if (media.paused && button) button.click(); }); }".to_string(),
        "pause" => "desired.playing=false; persistDesired(); if (media) media.pause();".to_string(),
        "seek" => format!(
            "persistDesired(); if (!advertisement) {{ const target={}; if (playerApi) playerApi.seekTo(target, true); else if (media) media.currentTime=target; }}",
            finite_value()?.max(0.0)
        ),
        "volume" => format!(
            "desired.volume={value}; persistDesired(); if (media && !advertisement) media.volume=desired.volume;",
            value = finite_value()?.clamp(0.0, 1.0)
        ),
        "mute" => format!(
            "desired.muted={}; persistDesired(); if (media && !advertisement) media.muted=desired.muted;",
            finite_value()? >= 0.5
        ),
        _ => return Err("unsupported web player action".into()),
    };
    Ok(guarded_playback_script(generation, video_id, &body))
}

fn playback_url(
    video_id: &str,
    generation: u64,
    playing: bool,
    volume: f64,
    muted: bool,
) -> Result<tauri::Url, String> {
    let volume = if volume.is_finite() {
        volume.clamp(0.0, 1.0)
    } else {
        1.0
    };
    format!(
        "https://music.youtube.com/watch?v={}#goosic_generation={generation}&goosic_autoplay={}&goosic_volume={volume}&goosic_muted={}",
        urlencoding::encode(video_id),
        if playing { "1" } else { "0" },
        if muted { "1" } else { "0" }
    )
    .parse::<tauri::Url>()
    .map_err(|error| error.to_string())
}

#[allow(clippy::too_many_arguments)]
pub async fn load(
    app: &tauri::AppHandle,
    state: &WebPlayerState,
    bridge_url: String,
    profile_key: String,
    profile_dir: PathBuf,
    user_agent: &str,
    browser_args: &str,
    video_id: String,
    generation: u64,
    playing: bool,
    volume: f64,
    muted: bool,
) -> Result<(), String> {
    let _lifecycle = state.lifecycle.lock().await;
    let volume = if volume.is_finite() {
        volume.clamp(0.0, 1.0)
    } else {
        1.0
    };
    let url = playback_url(&video_id, generation, playing, volume, muted)?;

    let current_profile = state.inner.lock().await.profile_key.clone();
    let had_player = app.get_webview_window(PLAYER_LABEL).is_some();
    let recreate = had_player && current_profile != profile_key;

    // A keeper and player cannot concurrently own the same WebView2 data dir.
    // Do this before closing a healthy existing player: a keeper failure then
    // leaves the old owner and its state intact instead of producing silence.
    close_keepers(app).await?;

    if recreate {
        close_player(app).await?;
        clear_player_state(state).await;
    } else if !had_player {
        // Heal stale state left by an externally-terminated content window.
        clear_player_state(state).await;
    }

    let window = if let Some(window) = app.get_webview_window(PLAYER_LABEL) {
        window
            .navigate(url)
            .map_err(|error| format!("navigate YouTube player: {error}"))?;
        window
    } else {
        std::fs::create_dir_all(&profile_dir)
            .map_err(|error| format!("create playback profile: {error}"))?;
        let builder = WebviewWindowBuilder::new(app, PLAYER_LABEL, WebviewUrl::External(url))
            .title("Goosic playback")
            // Build hidden first. Platform-specific activation maps the
            // surface only after native offscreen/no-activate policy is in
            // place, preventing Windows from substituting CW_USEDEFAULT and
            // flashing the remote page onscreen.
            .visible(false)
            .focused(false)
            .focusable(false)
            .decorations(false)
            .shadow(false)
            .skip_taskbar(true)
            .resizable(false)
            .minimizable(false)
            .maximizable(false)
            .inner_size(1024.0, 768.0)
            .background_throttling(tauri::utils::config::BackgroundThrottlingPolicy::Disabled)
            .data_directory(profile_dir)
            .user_agent(user_agent)
            .additional_browser_args(browser_args)
            .initialization_script(observer_script(&bridge_url))
            .on_navigation(trusted_navigation);
        #[cfg(target_os = "macos")]
        let builder = builder.data_store_identifier(data_store_identifier(&profile_key));
        let window = builder
            .build()
            .map_err(|error| format!("build YouTube player: {error}"))?;
        // Attach the script-message transport before the page can post its
        // first observer sample (the JS side resolves the handler per call).
        #[cfg(target_os = "macos")]
        if let Err(error) = install_message_bridge(&window, state, &bridge_url) {
            let _ = close_player(app).await;
            return Err(error);
        }
        if let Err(error) = activate_background_window(app, &window).await {
            let _ = close_player(app).await;
            return Err(error);
        }
        window
    };

    // Commit only after the correct profile owns a successfully activated,
    // navigated window. Until this point bridge posts continue to validate
    // against the old owner (or the cleared no-owner state).
    {
        let mut inner = state.inner.lock().await;
        inner.generation = generation;
        inner.video_id.clone_from(&video_id);
        inner.profile_key.clone_from(&profile_key);
        inner.advertisement = false;
        inner.suppress_ended_until_content_playing = false;
        inner.last_sequence = None;
        inner.terminal_emitted = false;
        inner.unidentified_samples = 0;
        inner.last_heartbeat = None;
    }

    let script = load_state_script(generation, &video_id, playing, volume, muted);
    let _ = window.eval(&script);
    Ok(())
}

pub async fn control(
    app: &tauri::AppHandle,
    state: &WebPlayerState,
    generation: u64,
    action: &str,
    value: Option<f64>,
) -> Result<(), String> {
    let _lifecycle = state.lifecycle.lock().await;
    let inner = state.inner.lock().await;
    if generation != inner.generation {
        return Err("stale playback generation".into());
    }
    if inner.advertisement && matches!(action, "seek" | "mute" | "volume") {
        return Err("this control is unavailable during advertisements".into());
    }
    let expected_video_id = inner.video_id.clone();
    drop(inner);
    let window = app
        .get_webview_window(PLAYER_LABEL)
        .ok_or_else(|| "web player is not running".to_string())?;
    let script = control_script(generation, &expected_video_id, action, value)?;
    window.eval(&script).map_err(|error| error.to_string())
}

pub async fn reset(app: &tauri::AppHandle, state: &WebPlayerState) -> Result<(), String> {
    let _lifecycle = state.lifecycle.lock().await;
    close_player(app).await?;
    clear_player_state(state).await;
    Ok(())
}

/// macOS transport for the observer bridge.
///
/// WKWebView rejects a `fetch` from the official https document to every
/// address native code can serve: loopback HTTP falls to private-network
/// policy, and a custom URI scheme is refused inside WebKit before the
/// registered scheme handler can observe it (verified 2026-07-22: the page
/// loads, the observer runs, and zero requests — not even a CORS preflight —
/// reach the handler; the page's CSP would forbid the connect anyway). The
/// sanctioned any-origin channel from page JS to native is a
/// `WKScriptMessageHandler` on the WebView's user content controller, which
/// mixed-content, private-network, and CSP policy do not apply to.
///
/// The observer posts the same envelope it would have POSTed — the bridge URL
/// (still carrying the per-launch token) plus the JSON body — through
/// `window.webkit.messageHandlers.goosicBridge`. Validation mirrors the other
/// transports: main frame only, trusted https origin (WebKit-attested, not a
/// forgeable header), the 16 KiB limit, and the token/route gate via
/// `bridge_scheme_route`, before the shared `apply_state_event` /
/// `apply_identity_event` run. Only the two `youtube-player` window creation
/// sites install the handler, so no other webview can reach it.
#[cfg(target_os = "macos")]
mod wk_message_bridge {
    use objc2::rc::Retained;
    use objc2::runtime::ProtocolObject;
    use objc2::{define_class, msg_send, DefinedClass, MainThreadOnly};
    use objc2_foundation::{MainThreadMarker, NSObject, NSObjectProtocol, NSString};
    use objc2_web_kit::{
        WKScriptMessage, WKScriptMessageHandler, WKUserContentController, WKWebView,
    };

    use super::{
        apply_identity_event, apply_state_event, bridge_scheme_route, StatusCode, WebPlayerState,
        BRIDGE_BODY_LIMIT, BRIDGE_SCHEME,
    };

    /// Must match the `messageHandlers` property the injected scripts use.
    const MESSAGE_HANDLER_NAME: &str = "goosicBridge";

    /// The token segment of a bridge endpoint URL
    /// (`goosicbridge://bridge/<token>/web-player/<route>`).
    pub(super) fn bridge_url_token(bridge_url: &str) -> Option<&str> {
        let path = bridge_url
            .strip_prefix(BRIDGE_SCHEME)?
            .strip_prefix("://bridge/")?;
        let token = path.split('/').next()?;
        (!token.is_empty()).then_some(token)
    }

    #[derive(serde::Deserialize)]
    struct WkEnvelope {
        url: String,
        body: String,
    }

    pub(super) struct BridgeIvars {
        app: tauri::AppHandle,
        state: WebPlayerState,
        token: String,
    }

    define_class!(
        #[unsafe(super(NSObject))]
        #[thread_kind = MainThreadOnly]
        #[name = "GoosicWebPlayerBridge"]
        #[ivars = BridgeIvars]
        pub(super) struct BridgeHandler;

        unsafe impl NSObjectProtocol for BridgeHandler {}

        unsafe impl WKScriptMessageHandler for BridgeHandler {
            #[unsafe(method(userContentController:didReceiveScriptMessage:))]
            fn did_receive_script_message(
                &self,
                _controller: &WKUserContentController,
                message: &WKScriptMessage,
            ) {
                // Synchronous part stays minimal: extract and gate on the
                // WebKit-attested facts (frame, origin, size), then hand the
                // string to the async runtime for parsing and routing.
                let body = unsafe { message.body() };
                let Some(raw) = body.downcast_ref::<NSString>().map(|s| s.to_string()) else {
                    return;
                };
                if raw.len() > BRIDGE_BODY_LIMIT {
                    return;
                }
                let frame = unsafe { message.frameInfo() };
                if !unsafe { frame.isMainFrame() } {
                    return;
                }
                let origin = unsafe { frame.securityOrigin() };
                let scheme = unsafe { origin.protocol() }.to_string();
                let host = unsafe { origin.host() }.to_string();
                if scheme != "https"
                    || !matches!(host.as_str(), "music.youtube.com" | "www.youtube.com")
                {
                    return;
                }
                let ivars = self.ivars();
                let app = ivars.app.clone();
                let state = ivars.state.clone();
                let token = ivars.token.clone();
                tauri::async_runtime::spawn(async move {
                    route_message(app, state, token, raw).await;
                });
            }
        }
    );

    impl BridgeHandler {
        fn new(
            mtm: MainThreadMarker,
            app: tauri::AppHandle,
            state: WebPlayerState,
            token: String,
        ) -> Retained<Self> {
            let this = mtm
                .alloc::<Self>()
                .set_ivars(BridgeIvars { app, state, token });
            unsafe { msg_send![super(this), init] }
        }
    }

    async fn route_message(
        app: tauri::AppHandle,
        state: WebPlayerState,
        token: String,
        raw: String,
    ) {
        let Ok(envelope) = serde_json::from_str::<WkEnvelope>(&raw) else {
            return;
        };
        let prefix = format!("{BRIDGE_SCHEME}://bridge");
        let Some(path) = envelope.url.strip_prefix(&prefix) else {
            return;
        };
        let Some(route) = bridge_scheme_route(path, &token) else {
            return;
        };
        let status = match route {
            "state" => match serde_json::from_str(&envelope.body) {
                Ok(payload) => apply_state_event(&app, &state, payload).await,
                Err(_) => StatusCode::BAD_REQUEST,
            },
            "identity" => match serde_json::from_str(&envelope.body) {
                Ok(payload) => apply_identity_event(&state, payload).await,
                Err(_) => StatusCode::BAD_REQUEST,
            },
            _ => StatusCode::NOT_FOUND,
        };
        // A rejected sample (stale generation, malformed body) is expected
        // during track changes and simply not published; the observer keeps
        // sampling. Nothing to surface here — the status is for parity with
        // the HTTP transports' return type.
        let _ = status;
    }

    /// Attach the message handler to a freshly created player/probe WebView.
    /// Runs on AppKit's main thread via `with_webview`; the content controller
    /// retains the handler for the WebView's lifetime.
    pub(super) fn install(
        webview: tauri::webview::PlatformWebview,
        app: tauri::AppHandle,
        state: WebPlayerState,
        token: String,
    ) {
        let Some(mtm) = MainThreadMarker::new() else {
            eprintln!("[web-player] bridge handler skipped: not on the main thread");
            return;
        };
        unsafe {
            let wk: &WKWebView = &*webview.inner().cast::<WKWebView>();
            let controller = wk.configuration().userContentController();
            let handler = BridgeHandler::new(mtm, app, state, token);
            controller.addScriptMessageHandler_name(
                ProtocolObject::from_ref(&*handler),
                &NSString::from_str(MESSAGE_HANDLER_NAME),
            );
        }
    }
}

/// Register the macOS script-message transport on a just-built player or
/// identity-probe window. A failure is a hard error: without the handler the
/// observer cannot report and playback would repeat the silent-stall bug.
#[cfg(target_os = "macos")]
fn install_message_bridge(
    window: &tauri::WebviewWindow,
    state: &WebPlayerState,
    bridge_url: &str,
) -> Result<(), String> {
    let Some(token) = wk_message_bridge::bridge_url_token(bridge_url) else {
        return Err("malformed bridge endpoint".into());
    };
    let app = window.app_handle().clone();
    let state = state.clone();
    let token = token.to_string();
    window
        .with_webview(move |webview| {
            wk_message_bridge::install(webview, app, state, token);
        })
        .map_err(|error| format!("install macOS playback bridge: {error}"))
}

pub async fn uses_profile(state: &WebPlayerState, profile_key: &str) -> bool {
    state.inner.lock().await.profile_key == profile_key
}

pub async fn healthy(app: &tauri::AppHandle, state: &WebPlayerState) -> bool {
    if app.get_webview_window(PLAYER_LABEL).is_none() {
        return false;
    }
    let inner = state.inner.lock().await;
    !inner.video_id.is_empty() && heartbeat_is_fresh(inner.last_heartbeat, Instant::now())
}

#[cfg(test)]
mod tests {
    use std::time::{Duration, Instant};

    use super::{
        actual_video_matches_requested, bridge_endpoint, bridge_scheme_route, control_script,
        gate_ended_event, heartbeat_is_fresh, is_unexpected_track, load_state_script,
        observer_script, playback_url, sequence_is_fresh, trusted_navigation,
        wait_for_identity_result, WebPlayerState, HEALTH_HEARTBEAT_TIMEOUT,
        WINDOWS_WS_EX_APPWINDOW, WINDOWS_WS_EX_NOACTIVATE, WINDOWS_WS_EX_TOOLWINDOW,
    };

    #[cfg(any(target_os = "linux", test))]
    use super::linux_uses_x11_backend;

    /// Whatever transport the platform uses, the address the observer is given
    /// must be the one the bridge's own secret gate accepts.
    #[test]
    fn bridge_endpoint_carries_the_route_past_the_secret_gate() {
        let endpoint = bridge_endpoint(1234, "s3cret", "state");
        let path = endpoint
            .parse::<tauri::Url>()
            .expect("endpoint is a URL")
            .path()
            .to_string();
        assert_eq!(bridge_scheme_route(&path, "s3cret"), Some("state"));
    }

    /// The macOS script-message transport pulls the per-launch token straight
    /// out of the endpoint URL, so it must recover exactly what
    /// `bridge_endpoint` embedded (and reject anything else).
    #[cfg(target_os = "macos")]
    #[test]
    fn wk_bridge_recovers_the_token_from_its_own_endpoint() {
        use super::wk_message_bridge::bridge_url_token;
        let endpoint = bridge_endpoint(0, "s3cret", "state");
        assert_eq!(bridge_url_token(&endpoint), Some("s3cret"));
        assert_eq!(
            bridge_url_token("goosicbridge://bridge//web-player/state"),
            None
        );
        assert_eq!(bridge_url_token("https://music.youtube.com/"), None);
    }

    #[test]
    fn bridge_scheme_route_rejects_foreign_or_malformed_paths() {
        assert_eq!(
            bridge_scheme_route("/s3cret/web-player/identity", "s3cret"),
            Some("identity")
        );
        // A different launch's secret, and a prefix that merely starts with it.
        assert_eq!(
            bridge_scheme_route("/other/web-player/state", "s3cret"),
            None
        );
        assert_eq!(
            bridge_scheme_route("/s3cretly/web-player/state", "s3cret"),
            None
        );
        // The secret alone authorizes nothing without a named route.
        assert_eq!(bridge_scheme_route("/s3cret/web-player/", "s3cret"), None);
        assert_eq!(bridge_scheme_route("/s3cret/stream/abc", "s3cret"), None);
        assert_eq!(
            bridge_scheme_route("s3cret/web-player/state", "s3cret"),
            None
        );
    }

    #[test]
    fn navigation_allowlist_rejects_untrusted_origins() {
        assert!(trusted_navigation(
            &"https://music.youtube.com/watch?v=x".parse().unwrap()
        ));
        assert!(trusted_navigation(
            &"https://accounts.google.com/".parse().unwrap()
        ));
        assert!(trusted_navigation(
            &"https://consent.google.com/".parse().unwrap()
        ));
        assert!(!trusted_navigation(
            &"https://example.com/".parse().unwrap()
        ));
        assert!(!trusted_navigation(
            &"http://music.youtube.com/".parse().unwrap()
        ));
    }

    #[test]
    fn linux_backend_detection_honors_explicit_x11_under_xwayland() {
        assert!(linux_uses_x11_backend(Some("x11"), true));
        assert!(linux_uses_x11_backend(Some(" X11 ,wayland"), true));
        assert!(!linux_uses_x11_backend(Some("wayland,x11"), true));
        assert!(!linux_uses_x11_backend(None, true));
        assert!(linux_uses_x11_backend(None, false));
    }

    #[test]
    fn health_requires_a_recent_bridge_heartbeat() {
        let now = Instant::now();
        assert!(!heartbeat_is_fresh(None, now));
        assert!(heartbeat_is_fresh(Some(now), now));
        assert!(heartbeat_is_fresh(
            Some(now - HEALTH_HEARTBEAT_TIMEOUT),
            now
        ));
        assert!(!heartbeat_is_fresh(
            Some(now - HEALTH_HEARTBEAT_TIMEOUT - Duration::from_millis(1)),
            now
        ));
    }

    #[test]
    fn playback_sequence_must_increase_within_a_generation() {
        assert!(!sequence_is_fresh(None, 0));
        assert!(sequence_is_fresh(None, 1));
        assert!(!sequence_is_fresh(Some(8), 8));
        assert!(!sequence_is_fresh(Some(8), 7));
        assert!(sequence_is_fresh(Some(8), 9));
    }

    #[test]
    fn windows_background_style_is_tool_only_and_nonactivating() {
        let style = super::hardened_windows_ex_style(WINDOWS_WS_EX_APPWINDOW | 0x20);
        assert_eq!(style & WINDOWS_WS_EX_APPWINDOW, 0);
        assert_ne!(style & WINDOWS_WS_EX_TOOLWINDOW, 0);
        assert_ne!(style & WINDOWS_WS_EX_NOACTIVATE, 0);
        assert_ne!(style & 0x20, 0);
    }

    #[test]
    fn captured_terminal_is_not_an_unexpected_track_error() {
        assert!(!actual_video_matches_requested(None, "requested"));
        assert!(!actual_video_matches_requested(Some(""), "requested"));
        assert!(actual_video_matches_requested(
            Some("requested"),
            "requested"
        ));
        assert!(is_unexpected_track(
            Some("auto-advanced"),
            "requested",
            false,
            false,
            false
        ));
        assert!(!is_unexpected_track(
            Some("post-roll"),
            "requested",
            false,
            true,
            false
        ));
        assert!(!is_unexpected_track(
            Some("auto-advanced"),
            "requested",
            false,
            false,
            true
        ));
        // The official page's own autoplay queue moves to another video during
        // the samples between a track's completion and its terminal event.
        // That is a finished track, not a wrong-track load.
        assert!(!is_unexpected_track(
            Some("page-autoplay-pick"),
            "requested",
            false,
            true,
            false
        ));
    }

    #[test]
    fn ad_ended_is_suppressed_until_requested_content_plays() {
        let during_ad = gate_ended_event(false, false, true, true, true);
        assert!(during_ad.advertisement);
        assert!(during_ad.suppress_until_content_playing);
        assert!(!during_ad.emit_ended);

        // The DOM ad marker can disappear one sample before the ad media's
        // ended bit. That transition must still stay suppressed.
        let transition = gate_ended_event(
            during_ad.advertisement,
            during_ad.suppress_until_content_playing,
            false,
            false,
            false,
        );
        assert!(!transition.advertisement);
        assert!(transition.suppress_until_content_playing);
        assert!(!transition.emit_ended);

        let content_started = gate_ended_event(
            transition.advertisement,
            transition.suppress_until_content_playing,
            false,
            true,
            false,
        );
        assert!(!content_started.suppress_until_content_playing);
        assert!(!content_started.emit_ended);

        let content_ended = gate_ended_event(false, false, false, false, true);
        assert!(content_ended.emit_ended);

        // The observer remembers a requested-content terminal callback across
        // a post-roll ad. Its terminal report must override the transition
        // suppression rather than being mistaken for the ad media ending.
        let post_roll_content_ended = gate_ended_event(true, true, false, false, true);
        assert!(!post_roll_content_ended.advertisement);
        assert!(!post_roll_content_ended.suppress_until_content_playing);
        assert!(post_roll_content_ended.emit_ended);
    }

    #[test]
    fn observer_carries_ordering_and_requested_terminal_state() {
        let script = observer_script("http://127.0.0.1:1234/secret/web-player/state");
        let unload_guard = script
            .find("String(type).toLowerCase() === 'beforeunload'")
            .expect("observer must suppress remote unload confirmations");
        let bridge_setup = script
            .find("const bridge =")
            .expect("observer must configure its bridge");
        assert!(
            unload_guard < bridge_setup,
            "unload guard must run before page observer setup"
        );
        assert!(script.contains("Object.defineProperty(window, 'onbeforeunload'"));
        assert!(script.contains("event.stopImmediatePropagation()"));
        assert!(script.contains("Math.abs(media.volume - desiredState.volume)"));
        assert!(script.contains("media.muted !== desiredState.muted"));
        assert!(script.contains("sequence: nextSequence()"));
        assert!(script.contains("actualAtEnd === requestedVideoId"));
        assert!(script.contains("pendingContentEndedSawAd"));
        assert!(script.contains("capture: true"));
        assert!(script.contains("ended && response.ok"));
        assert!(script.contains("resumesStoredPlayback"));
        assert!(
            script.contains("readSession('goosic-player-autoplay') || fromUrl('goosic_autoplay')")
        );
        assert!(script.contains("Object.defineProperty(window, '__goosicPlaybackSession'"));
        assert!(script.contains("Object.freeze({ generation, videoId: requestedVideoId })"));
        // WKWebView and WebKitGTK can leave `playerApi` undefined while playing
        // normally, so identity must have a second source.
        assert!(script.contains("new URL(location.href).searchParams.get('v')"));
    }

    #[test]
    fn observer_caps_output_before_any_media_element_can_be_heard() {
        let script = observer_script("http://127.0.0.1:1234/secret/web-player/state");
        let ceiling = script
            .find("Object.defineProperty(HTMLMediaElement.prototype, 'volume'")
            .expect("observer must cap the media volume accessor");
        let play_guard = script
            .find("HTMLMediaElement.prototype.play = function")
            .expect("observer must normalize output before playback starts");
        let first_media_query = script
            .find("const findMedia =")
            .expect("observer must look up media elements");
        assert!(
            ceiling < first_media_query && play_guard < first_media_query,
            "output guards must be installed before the page can create media"
        );
        assert!(script.contains("Math.min(Math.max(requested, 0), ceiling)"));
    }

    #[test]
    fn observer_treats_page_autoplay_as_the_requested_track_finishing() {
        let script = observer_script("http://127.0.0.1:1234/secret/web-player/state");
        assert!(script.contains("observedRequestedContent"));
        assert!(script.contains("pendingContentEndedPageMoved"));
        assert!(script.contains("pendingContentEndedSawAd || pendingContentEndedPageMoved"));
        // An advertisement must never be mistaken for the page auto-advancing.
        // Matched as separate tokens rather than one multi-line slice: this
        // file is rewritten with CRLF on Windows, which silently breaks any
        // assertion that spans a newline.
        let gate = script
            .split("const pageAdvancedPastRequest")
            .nth(1)
            .and_then(|rest| rest.split(';').next())
            .expect("observer must gate the auto-advance terminal");
        assert!(gate.contains("!lastObservedAd"));
        assert!(gate.contains("!suppressEndedUntilContentPlaying"));
        assert!(gate.contains("observedRequestedContent"));
        // The page's own pick must be silenced at the source, not merely reported.
        assert!(script.contains(
            "if (finished && media && !ad && !lastObservedAd && !actualMatchesRequested && !media.paused)"
        ));
        // A finished element must never be resumed: play() rewinds it to zero.
        assert!(script.contains(
            "if (pendingContentEnded || reportedTrackEnded || mediaReachedEnd(media)) return;"
        ));
        assert!(script.contains("finished,"));
    }

    #[test]
    fn transport_scripts_guard_the_immutable_session_and_persist_desired_state() {
        let load = load_state_script(12, "quoted\"id", true, 0.4, false);
        assert!(load.contains("window.__goosicPlaybackSession"));
        assert!(load.contains("sessionStorage.getItem('goosic-player-generation')"));
        assert!(load.contains("sessionStorage.setItem('goosic-player-autoplay'"));
        assert!(load.contains("sessionStorage.setItem('goosic-player-volume'"));
        assert!(load.contains("sessionStorage.setItem('goosic-player-muted'"));
        assert!(!load.contains("location.searchParams"));
        assert!(load.contains("quoted\\\"id"));

        let volume = control_script(12, "video", "volume", Some(0.25)).unwrap();
        assert!(volume.contains("desired.volume=0.25"));
        assert!(volume.contains("media && !advertisement"));
        assert!(volume.contains("sessionStorage.setItem('goosic-player-volume'"));
        assert!(!volume.contains("location.searchParams"));
    }

    #[test]
    fn seeking_goes_through_the_official_player_api() {
        let seek = control_script(12, "video", "seek", Some(198.5)).unwrap();
        assert!(seek.contains("const target=198.5"));
        // Assigning `currentTime` moves only the media element: a target
        // outside the buffered range collapses back to what is buffered and
        // the page's own clock keeps pointing somewhere else.
        assert!(seek.contains("playerApi.seekTo(target, true)"));
        assert!(seek.contains("typeof player?.seekTo === 'function'"));
        // The element assignment stays as a fallback for a document whose
        // player API is not exposed.
        assert!(seek.contains("else if (media) media.currentTime=target"));
        assert!(seek.contains("if (!advertisement)"));
        // A negative request is clamped before it reaches the page.
        let clamped = control_script(12, "video", "seek", Some(-5.0)).unwrap();
        assert!(clamped.contains("const target=0"));
        assert!(control_script(12, "video", "seek", None).is_err());
        assert!(control_script(12, "video", "seek", Some(f64::NAN)).is_err());
    }

    #[test]
    fn internal_playback_state_stays_in_the_url_fragment() {
        let url = playback_url("video/id", 42, true, 0.5, false).unwrap();
        let query: Vec<_> = url.query_pairs().collect();
        assert_eq!(query.len(), 1);
        assert_eq!(query[0].0, "v");
        assert_eq!(query[0].1, "video/id");
        let fragment = url.fragment().unwrap();
        assert!(fragment.contains("goosic_generation=42"));
        assert!(fragment.contains("goosic_autoplay=1"));
        assert!(fragment.contains("goosic_volume=0.5"));
        assert!(fragment.contains("goosic_muted=0"));
    }

    #[tokio::test]
    async fn identity_wait_observes_a_result_published_before_awaiting() {
        let state = WebPlayerState::default();
        {
            let mut inner = state.inner.lock().await;
            inner.identity_generation = 17;
            inner.identity_result = Some(true);
        }
        // A stored permit models the result arriving between a state check and
        // the waiter entering its await point.
        state.identity_notify.notify_one();
        assert!(
            wait_for_identity_result(&state, 17, Duration::from_millis(50))
                .await
                .unwrap()
        );
    }
}
