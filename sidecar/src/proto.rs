// sidecar/src/proto.rs
//
// IPC framing + types for the cc-rdp sidecar.
//
// Wire format (both directions): a 4-byte big-endian uint32 length N, then N
// bytes of UTF-8 JSON. This must match the Node side (src/ipc.ts) exactly.
use anyhow::Result;
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

#[derive(Deserialize)]
pub struct Request {
    pub id: u64,
    pub cmd: String,
    #[serde(default)]
    pub args: serde_json::Value,
}

#[derive(Serialize)]
pub struct Response {
    pub id: u64,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl Response {
    pub fn ok(id: u64, result: serde_json::Value) -> Self {
        Self { id, ok: true, result: Some(result), error: None }
    }
    pub fn err(id: u64, e: impl ToString) -> Self {
        Self { id, ok: false, result: None, error: Some(e.to_string()) }
    }
}

/// Read one framed request. Returns Ok(None) on a clean EOF (stdin closed).
pub async fn read_frame<R: AsyncReadExt + Unpin>(r: &mut R) -> Result<Option<Request>> {
    let mut len = [0u8; 4];
    if r.read_exact(&mut len).await.is_err() {
        return Ok(None); // EOF / parent closed stdin
    }
    let n = u32::from_be_bytes(len) as usize;
    let mut body = vec![0u8; n];
    r.read_exact(&mut body).await?;
    Ok(Some(serde_json::from_slice(&body)?))
}

/// Write one framed response.
pub async fn write_frame<W: AsyncWriteExt + Unpin>(w: &mut W, resp: &Response) -> Result<()> {
    let body = serde_json::to_vec(resp)?;
    w.write_all(&(body.len() as u32).to_be_bytes()).await?;
    w.write_all(&body).await?;
    w.flush().await?;
    Ok(())
}
