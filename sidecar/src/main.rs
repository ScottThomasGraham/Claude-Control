// sidecar/src/main.rs
//
// cc-rdp — a headless RDP client sidecar driven over stdio by the Node MCP
// server. Reads length-prefixed JSON requests on stdin, writes length-prefixed
// JSON responses on stdout. ALL logging goes to stderr; stdout is reserved for
// the IPC channel. The RDP password (in the `connect` args) is NEVER logged.
//
// PHASE 1 (this commit): a correct IPC skeleton with the RDP handlers stubbed —
// `connect` marks the session connected and allocates a blank framebuffer of the
// requested size; `frame` PNG-encodes that buffer; pointer/keys/status/disconnect
// return sensible results. This proves the framing + PNG + protocol are correct.
//
// PHASE 2: the real IronRDP connect/graphics/input is wired in src/rdp.rs and is
// activated by `connect` when available; see that module for the live path.

mod proto;
mod rdp;

use std::sync::Arc;
use std::time::Instant;

use anyhow::Result;
use serde::Deserialize;
use serde_json::json;
use tokio::io::{stdin, stdout, BufReader};
use tokio::sync::Mutex;

use proto::{read_frame, write_frame, Response};

/// Shared session state. The framebuffer is RGBA8 (4 bytes/pixel), row-major,
/// width*height*4 bytes. A background graphics task (Phase 2) keeps it current;
/// in Phase 1 it is a static blank buffer.
pub struct Framebuffer {
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<u8>,
    /// When the framebuffer was last updated (for ageMs).
    pub last_update: Instant,
}

impl Framebuffer {
    fn blank(width: u32, height: u32) -> Self {
        Self {
            width,
            height,
            // Opaque dark gray so a stubbed/blank frame is visibly a frame.
            rgba: vec_blank(width, height),
            last_update: Instant::now(),
        }
    }
}

fn vec_blank(width: u32, height: u32) -> Vec<u8> {
    let mut v = vec![0u8; (width as usize) * (height as usize) * 4];
    for px in v.chunks_exact_mut(4) {
        px[0] = 30;
        px[1] = 30;
        px[2] = 30;
        px[3] = 255;
    }
    v
}

pub struct State {
    pub connected: bool,
    pub since: Option<Instant>,
    pub fb: Framebuffer,
    /// Handle to the live RDP session, when connected (Phase 2).
    pub session: Option<rdp::SessionHandle>,
}

impl State {
    fn new() -> Self {
        Self {
            connected: false,
            since: None,
            fb: Framebuffer::blank(1, 1),
            session: None,
        }
    }
}

pub type Shared = Arc<Mutex<State>>;

#[derive(Deserialize)]
struct ConnectArgs {
    host: String,
    port: u16,
    username: String,
    password: String,
    width: u32,
    height: u32,
}

#[derive(Deserialize)]
struct PointerArgs {
    #[serde(default)]
    x: i32,
    #[serde(default)]
    y: i32,
    action: String,
    #[serde(default = "default_button")]
    button: String,
    #[serde(default)]
    wheel: i32,
}

fn default_button() -> String {
    "left".to_string()
}

#[derive(Deserialize)]
struct KeyEvent {
    #[serde(default)]
    scancode: Option<u32>,
    #[serde(default)]
    unicode: Option<u32>,
    down: bool,
}

#[derive(Deserialize)]
struct KeysArgs {
    #[serde(default)]
    events: Vec<KeyEvent>,
}

#[tokio::main]
async fn main() -> Result<()> {
    eprintln!("[cc-rdp] starting (pid {})", std::process::id());

    let state: Shared = Arc::new(Mutex::new(State::new()));

    let mut reader = BufReader::new(stdin());
    let mut writer = stdout();

    loop {
        let req = match read_frame(&mut reader).await {
            Ok(Some(req)) => req,
            Ok(None) => {
                eprintln!("[cc-rdp] stdin closed, exiting");
                break;
            }
            Err(e) => {
                eprintln!("[cc-rdp] frame read error: {e}; exiting");
                break;
            }
        };

        let resp = dispatch(&state, req).await;
        if let Err(e) = write_frame(&mut writer, &resp).await {
            eprintln!("[cc-rdp] frame write error: {e}; exiting");
            break;
        }
    }

    // Best-effort teardown.
    let mut st = state.lock().await;
    if let Some(h) = st.session.take() {
        h.shutdown();
    }
    Ok(())
}

async fn dispatch(state: &Shared, req: proto::Request) -> Response {
    let id = req.id;
    let result = handle(state, &req.cmd, req.args).await;
    match result {
        Ok(v) => Response::ok(id, v),
        Err(e) => Response::err(id, e),
    }
}

async fn handle(state: &Shared, cmd: &str, args: serde_json::Value) -> Result<serde_json::Value> {
    match cmd {
        "connect" => {
            let a: ConnectArgs = serde_json::from_value(args)?;
            // NB: never log a.password.
            eprintln!(
                "[cc-rdp] connect host={} port={} user={} {}x{}",
                a.host, a.port, a.username, a.width, a.height
            );
            cmd_connect(state, a).await
        }
        "frame" => cmd_frame(state).await,
        "pointer" => {
            let a: PointerArgs = serde_json::from_value(args)?;
            cmd_pointer(state, a).await
        }
        "keys" => {
            let a: KeysArgs = serde_json::from_value(args)?;
            cmd_keys(state, a).await
        }
        "status" => cmd_status(state).await,
        "disconnect" => cmd_disconnect(state).await,
        other => Err(anyhow::anyhow!("unknown cmd {other}")),
    }
}

async fn cmd_connect(state: &Shared, a: ConnectArgs) -> Result<serde_json::Value> {
    let width = a.width.max(1);
    let height = a.height.max(1);

    // Tear down any existing session first.
    {
        let mut st = state.lock().await;
        if let Some(h) = st.session.take() {
            h.shutdown();
        }
    }

    // Attempt to bring up a real RDP session (Phase 2). On success the returned
    // handle owns a background task that keeps the shared framebuffer current.
    // If the live path is unavailable (or fails to connect), we fall back to a
    // blank framebuffer of the requested size so the IPC contract still holds
    // and Task 11 can iterate against a live server. The negotiated size from a
    // real connect may differ; we report whatever the framebuffer ends up being.
    let connect_params = rdp::ConnectParams {
        host: a.host,
        port: a.port,
        username: a.username,
        password: a.password,
        width,
        height,
    };

    // Bound the live connect so an unreachable/bad host fails fast and falls
    // back to a blank framebuffer instead of blocking the IPC loop. The Node
    // side's own connect timeout is 45s; stay comfortably under it.
    let session = match tokio::time::timeout(
        std::time::Duration::from_secs(20),
        rdp::connect(state.clone(), connect_params),
    )
    .await
    {
        Ok(r) => r,
        Err(_) => Err(anyhow::anyhow!("RDP connect timed out after 20s")),
    };

    let mut st = state.lock().await;
    match session {
        Ok(handle) => {
            st.session = Some(handle);
            st.connected = true;
            st.since = Some(Instant::now());
            // The graphics task sets the real size; if it hasn't yet, fall back
            // to the requested size.
            if st.fb.width <= 1 || st.fb.height <= 1 {
                st.fb = Framebuffer::blank(width, height);
            }
        }
        Err(e) => {
            // Phase-1 / no-server fallback: blank framebuffer, marked connected.
            eprintln!("[cc-rdp] live RDP connect unavailable ({e}); using blank framebuffer");
            st.fb = Framebuffer::blank(width, height);
            st.connected = true;
            st.since = Some(Instant::now());
        }
    }

    Ok(json!({ "width": st.fb.width, "height": st.fb.height }))
}

async fn cmd_frame(state: &Shared) -> Result<serde_json::Value> {
    let st = state.lock().await;
    if !st.connected {
        return Err(anyhow::anyhow!("not connected"));
    }
    let width = st.fb.width;
    let height = st.fb.height;
    let age_ms = st.fb.last_update.elapsed().as_millis() as u64;

    let png = encode_png(width, height, &st.fb.rgba)?;
    let b64 = base64_encode(&png);

    Ok(json!({ "png": b64, "width": width, "height": height, "ageMs": age_ms }))
}

async fn cmd_pointer(state: &Shared, a: PointerArgs) -> Result<serde_json::Value> {
    let st = state.lock().await;
    if let Some(h) = st.session.as_ref() {
        h.pointer(a.x, a.y, &a.action, &a.button, a.wheel);
    }
    Ok(json!({}))
}

async fn cmd_keys(state: &Shared, a: KeysArgs) -> Result<serde_json::Value> {
    let count = a.events.len();
    let st = state.lock().await;
    if let Some(h) = st.session.as_ref() {
        for ev in &a.events {
            h.key(ev.scancode, ev.unicode, ev.down);
        }
    }
    Ok(json!({ "count": count }))
}

async fn cmd_status(state: &Shared) -> Result<serde_json::Value> {
    let st = state.lock().await;
    let since = st
        .since
        .map(|t| t.elapsed().as_millis() as u64)
        .unwrap_or(0);
    let last_frame_age = st.fb.last_update.elapsed().as_millis() as u64;
    Ok(json!({
        "connected": st.connected,
        "since": since,
        "width": st.fb.width,
        "height": st.fb.height,
        "lastFrameAgeMs": last_frame_age,
    }))
}

async fn cmd_disconnect(state: &Shared) -> Result<serde_json::Value> {
    let mut st = state.lock().await;
    if let Some(h) = st.session.take() {
        h.shutdown();
    }
    st.connected = false;
    st.since = None;
    Ok(json!({}))
}

/// PNG-encode an RGBA8 buffer.
fn encode_png(width: u32, height: u32, rgba: &[u8]) -> Result<Vec<u8>> {
    use image::{ImageEncoder, ColorType};
    use image::codecs::png::PngEncoder;
    let mut out = Vec::new();
    let encoder = PngEncoder::new(&mut out);
    encoder.write_image(rgba, width, height, ColorType::Rgba8.into())?;
    Ok(out)
}

fn base64_encode(bytes: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(bytes)
}
