// sidecar/src/rdp.rs
//
// RDP session module. PHASE 1: this is a stub whose `connect` always returns an
// Err so main.rs falls back to a blank framebuffer (proving the IPC contract
// without a server). PHASE 2 replaces the body of `connect` with the real
// IronRDP handshake + a background graphics/input task; the public interface
// (ConnectParams / SessionHandle / connect / pointer / key / shutdown) is the
// stable seam main.rs depends on.

use anyhow::Result;

use crate::Shared;

pub struct ConnectParams {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub password: String,
    pub width: u32,
    pub height: u32,
}

/// Owns the live RDP session's background task + the channel to send input. In
/// Phase 1 this is never constructed (connect returns Err).
pub struct SessionHandle {
    // Phase 2 fields (input sender, task abort handle) go here.
}

impl SessionHandle {
    pub fn pointer(&self, _x: i32, _y: i32, _action: &str, _button: &str, _wheel: i32) {
        // Phase 2: encode + send a fastpath mouse PDU.
    }
    pub fn key(&self, _scancode: Option<u32>, _unicode: Option<u32>, _down: bool) {
        // Phase 2: encode + send a fastpath keyboard PDU.
    }
    pub fn shutdown(self) {
        // Phase 2: abort the background task and close the TCP stream.
    }
}

/// Bring up a live RDP session. Phase 1: always Err (caller falls back to blank).
pub async fn connect(_state: Shared, _params: ConnectParams) -> Result<SessionHandle> {
    anyhow::bail!("live RDP not yet wired (phase 1 stub)")
}
