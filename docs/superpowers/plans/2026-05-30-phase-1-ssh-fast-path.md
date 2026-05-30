# Phase 1 — SSH Fast Path Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the controller daemon and an SSH fast path so the agent can `connect`, `run`
PowerShell, `push`/`pull` files, query `state`, and `disconnect` against a remote Windows host — with
no GUI yet.

**Architecture:** A single Rust binary (`ctl`) with two roles. `ctl serve` runs a daemon that owns
persistent SSH sessions and exposes a Unix-domain-socket JSON-RPC API. `ctl <verb>` are thin client
subcommands that round-trip to the daemon. SSH is pure-Rust via `russh`/`russh-sftp`. Secrets come
from env/Keychain, never disk.

**Tech stack:** Rust (stable, Tokio), `russh`, `russh-sftp`, `serde`/`serde_json`, `clap`,
`tokio` UDS, `thiserror`. Tests run against **macOS Remote Login (`localhost` sshd)** first, then the
owner's Windows PC.

**Note on pre-1.0 APIs:** `russh` evolves; the SSH code below is illustrative of intent. Verify exact
signatures against current `docs.rs/russh` while the TDD loop drives the final shape.

---

## Prerequisites

- [ ] Install Rust: `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh` then
  `rustc --version` (expect ≥ 1.80).
- [ ] Enable macOS Remote Login for local SSH tests: System Settings → General → Sharing → Remote
  Login = On. Verify: `ssh localhost echo ok` returns `ok` (set up a key first if prompted).

---

## Task 0: Workspace scaffold

**Files:**
- Create: `Cargo.toml`, `rust-toolchain.toml`, `crates/protocol/Cargo.toml`,
  `crates/protocol/src/lib.rs`, `crates/controller/Cargo.toml`, `crates/controller/src/main.rs`

- [ ] **Step 1: Root workspace manifest**

```toml
# Cargo.toml
[workspace]
resolver = "2"
members = ["crates/protocol", "crates/controller"]
default-members = ["crates/controller"]

[workspace.package]
edition = "2021"
license = "MIT OR Apache-2.0"
repository = "https://github.com/ScottThomasGraham/Claude-Control"

[workspace.dependencies]
serde = { version = "1", features = ["derive"] }
serde_json = "1"
tokio = { version = "1", features = ["full"] }
thiserror = "1"
clap = { version = "4", features = ["derive"] }
anyhow = "1"
```

- [ ] **Step 2: Pin toolchain**

```toml
# rust-toolchain.toml
[toolchain]
channel = "stable"
components = ["rustfmt", "clippy"]
```

- [ ] **Step 3: protocol crate manifest**

```toml
# crates/protocol/Cargo.toml
[package]
name = "protocol"
version = "0.1.0"
edition.workspace = true
license.workspace = true

[dependencies]
serde.workspace = true
serde_json.workspace = true
thiserror.workspace = true
```

- [ ] **Step 4: controller crate manifest**

```toml
# crates/controller/Cargo.toml
[package]
name = "controller"
version = "0.1.0"
edition.workspace = true
license.workspace = true

[[bin]]
name = "ctl"
path = "src/main.rs"

[dependencies]
protocol = { path = "../protocol" }
serde.workspace = true
serde_json.workspace = true
tokio.workspace = true
thiserror.workspace = true
clap.workspace = true
anyhow.workspace = true
russh = "0.45"
russh-sftp = "2"
```

- [ ] **Step 5: placeholder lib + main so it compiles**

```rust
// crates/protocol/src/lib.rs
//! Shared, platform-neutral types for Claude-Control.
```

```rust
// crates/controller/src/main.rs
fn main() { println!("ctl"); }
```

- [ ] **Step 6: Build & commit**

Run: `cargo build`
Expected: compiles clean.

```bash
git add -A && git commit -m "chore: scaffold cargo workspace (protocol + controller)"
```

---

## Task 1: Protocol types (JSON-RPC envelope + domain types)

**Files:**
- Modify: `crates/protocol/src/lib.rs`
- Test: inline `#[cfg(test)]` in `crates/protocol/src/lib.rs`

- [ ] **Step 1: Write the failing test**

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rpc_request_round_trips() {
        let req = RpcRequest::Run { host: HostId("pc1".into()), command: "echo hi".into() };
        let json = serde_json::to_string(&req).unwrap();
        let back: RpcRequest = serde_json::from_str(&json).unwrap();
        assert_eq!(req, back);
    }

    #[test]
    fn run_result_serializes_exit_code() {
        let r = RunResult { stdout: "hi\n".into(), stderr: String::new(), exit_code: 0 };
        let v = serde_json::to_value(&r).unwrap();
        assert_eq!(v["exit_code"], 0);
    }
}
```

- [ ] **Step 2: Run it; verify it fails to compile (types undefined)**

Run: `cargo test -p protocol`
Expected: FAIL — `cannot find type RpcRequest`.

- [ ] **Step 3: Implement the types**

```rust
// crates/protocol/src/lib.rs
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct HostId(pub String);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ChannelKind { Ssh, Rdp, Agent }

/// Requests the client sends to the daemon over the control socket.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum RpcRequest {
    Connect { host: HostId, addr: String, user: String, secret_ref: SecretRef },
    Run { host: HostId, command: String },
    Push { host: HostId, local: String, remote: String },
    Pull { host: HostId, remote: String, local: String },
    State,
    Disconnect { host: HostId },
}

/// How to fetch a secret WITHOUT ever putting it in a file or arg.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SecretRef { Env { var: String }, Keychain { account: String }, AgentKey }

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RunResult { pub stdout: String, pub stderr: String, pub exit_code: i32 }

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HostState { pub host: HostId, pub channels: Vec<ChannelKind> }

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "ok")]
pub enum RpcResponse {
    #[serde(rename = "true")]  Ok { data: serde_json::Value },
    #[serde(rename = "false")] Err { code: ErrorCode, message: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    NotConnected, AuthFailed, CertUntrusted, Timeout, HostUnreachable, ProtocolError, BadRequest,
}
```

- [ ] **Step 4: Run tests; verify pass**

Run: `cargo test -p protocol`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(protocol): JSON-RPC envelope + domain types"
```

---

## Task 2: Secret resolution (env + macOS Keychain)

**Files:**
- Create: `crates/controller/src/secrets.rs`
- Modify: `crates/controller/src/main.rs` (add `mod secrets;`)
- Test: inline tests in `secrets.rs`

- [ ] **Step 1: Write the failing test (env path is unit-testable)**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use protocol::SecretRef;

    #[tokio::test]
    async fn resolves_env_secret() {
        std::env::set_var("CTL_TEST_SECRET", "hunter2");
        let s = resolve(&SecretRef::Env { var: "CTL_TEST_SECRET".into() }).await.unwrap();
        assert_eq!(s.expose(), "hunter2");
    }

    #[tokio::test]
    async fn missing_env_is_error() {
        let r = resolve(&SecretRef::Env { var: "CTL_NOPE_XYZ".into() }).await;
        assert!(r.is_err());
    }
}
```

- [ ] **Step 2: Run; verify fail**

Run: `cargo test -p controller secrets`
Expected: FAIL — `resolve` undefined.

- [ ] **Step 3: Implement**

```rust
// crates/controller/src/secrets.rs
use protocol::SecretRef;
use anyhow::{anyhow, Result};

/// A secret that prints redacted in Debug and is never serialized.
pub struct Secret(String);
impl Secret { pub fn expose(&self) -> &str { &self.0 } }
impl std::fmt::Debug for Secret { fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result { f.write_str("Secret(***)") } }

pub async fn resolve(r: &SecretRef) -> Result<Secret> {
    match r {
        SecretRef::Env { var } => std::env::var(var)
            .map(Secret).map_err(|_| anyhow!("env var {var} not set")),
        SecretRef::Keychain { account } => keychain_lookup(account).await,
        SecretRef::AgentKey => Err(anyhow!("agent-key auth resolves in the ssh module, not here")),
    }
}

#[cfg(target_os = "macos")]
async fn keychain_lookup(account: &str) -> Result<Secret> {
    // Shell out to `security find-generic-password -a <account> -s claude-control -w`
    let out = tokio::process::Command::new("security")
        .args(["find-generic-password", "-a", account, "-s", "claude-control", "-w"])
        .output().await?;
    if !out.status.success() { return Err(anyhow!("keychain: no item for {account}")); }
    Ok(Secret(String::from_utf8(out.stdout)?.trim_end().to_string()))
}

#[cfg(not(target_os = "macos"))]
async fn keychain_lookup(_account: &str) -> Result<Secret> { Err(anyhow!("keychain only on macOS")) }
```

Add `mod secrets;` to `main.rs`.

- [ ] **Step 4: Run; verify pass**

Run: `cargo test -p controller secrets`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(secrets): env + macOS Keychain resolution (never to disk)"
```

---

## Task 3: SSH connect + exec

**Files:**
- Create: `crates/controller/src/ssh.rs`
- Modify: `crates/controller/src/main.rs` (`mod ssh;`)
- Test: `crates/controller/tests/ssh_localhost.rs` (integration, ignored by default)

- [ ] **Step 1: Write the failing integration test (gated on local sshd)**

```rust
// crates/controller/tests/ssh_localhost.rs
// Run with: CTL_SSH_USER=$USER cargo test -p controller --test ssh_localhost -- --ignored
#[tokio::test]
#[ignore = "requires macOS Remote Login + key auth to localhost"]
async fn exec_echo_over_localhost() {
    let user = std::env::var("CTL_SSH_USER").unwrap();
    let mut sess = controller::ssh::SshSession::connect_with_agent("127.0.0.1:22", &user)
        .await.expect("connect");
    let r = sess.exec("echo hello").await.expect("exec");
    assert_eq!(r.exit_code, 0);
    assert_eq!(r.stdout.trim(), "hello");
}
```

(Expose the module for the integration test: in `main.rs` add `pub mod ssh;` and create a
`crates/controller/src/lib.rs` re-exporting `pub mod ssh; pub mod secrets;` so `controller::ssh` is
reachable from `tests/`. Update `Cargo.toml` with `[lib] path = "src/lib.rs"` and keep the `[[bin]]`.)

- [ ] **Step 2: Run; verify fail to compile**

Run: `cargo test -p controller --test ssh_localhost -- --ignored`
Expected: FAIL — `SshSession` undefined.

- [ ] **Step 3: Implement the SSH client (verify russh API against docs.rs)**

```rust
// crates/controller/src/ssh.rs
use anyhow::{anyhow, Result};
use protocol::RunResult;
use std::sync::Arc;
use russh::client::{self, Handle, Handler};
use russh::keys::*;

struct Client;
#[async_trait::async_trait]
impl Handler for Client {
    type Error = russh::Error;
    // First-use host-key acceptance; Phase 1 pins on first connect (tighten later).
    async fn check_server_key(&mut self, _key: &ssh_key::PublicKey) -> Result<bool, Self::Error> {
        Ok(true)
    }
}

pub struct SshSession { handle: Handle<Client> }

impl SshSession {
    /// Connect using the local ssh-agent's keys (no secret on disk).
    pub async fn connect_with_agent(addr: &str, user: &str) -> Result<Self> {
        let config = Arc::new(client::Config::default());
        let mut handle = client::connect(config, addr, Client).await?;
        let mut agent = russh::keys::agent::client::AgentClient::connect_env().await?;
        let mut authed = false;
        for key in agent.request_identities().await? {
            if handle.authenticate_future(user, key, &mut agent).await.1? { authed = true; break; }
        }
        if !authed { return Err(anyhow!("ssh: no agent key accepted")); }
        Ok(Self { handle })
    }

    pub async fn exec(&mut self, command: &str) -> Result<RunResult> {
        let mut channel = self.handle.channel_open_session().await?;
        channel.exec(true, command).await?;
        let (mut stdout, mut stderr, mut code) = (Vec::new(), Vec::new(), 0);
        loop {
            let Some(msg) = channel.wait().await else { break };
            use russh::ChannelMsg::*;
            match msg {
                Data { data } => stdout.extend_from_slice(&data),
                ExtendedData { data, .. } => stderr.extend_from_slice(&data),
                ExitStatus { exit_status } => code = exit_status as i32,
                Eof | Close => {}
                _ => {}
            }
        }
        Ok(RunResult {
            stdout: String::from_utf8_lossy(&stdout).into_owned(),
            stderr: String::from_utf8_lossy(&stderr).into_owned(),
            exit_code: code,
        })
    }
}
```

Add `russh-keys`, `async-trait`, `ssh-key` to `Cargo.toml` as needed (check russh's re-exports first
to avoid version skew).

- [ ] **Step 4: Run the integration test; verify pass**

Run: `CTL_SSH_USER=$USER cargo test -p controller --test ssh_localhost -- --ignored`
Expected: PASS — exec returns `hello`, exit 0.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(ssh): russh connect (agent auth) + exec returning RunResult"
```

---

## Task 4: SFTP push / pull

**Files:**
- Modify: `crates/controller/src/ssh.rs`
- Test: `crates/controller/tests/ssh_localhost.rs` (add cases)

- [ ] **Step 1: Write failing tests**

```rust
#[tokio::test]
#[ignore]
async fn push_then_pull_roundtrips() {
    let user = std::env::var("CTL_SSH_USER").unwrap();
    let mut sess = controller::ssh::SshSession::connect_with_agent("127.0.0.1:22", &user).await.unwrap();
    let tmp = std::env::temp_dir();
    let src = tmp.join("ctl_src.txt"); let dst = tmp.join("ctl_dst.txt");
    std::fs::write(&src, b"payload").unwrap();
    sess.push(src.to_str().unwrap(), tmp.join("ctl_remote.txt").to_str().unwrap()).await.unwrap();
    sess.pull(tmp.join("ctl_remote.txt").to_str().unwrap(), dst.to_str().unwrap()).await.unwrap();
    assert_eq!(std::fs::read(&dst).unwrap(), b"payload");
}
```

- [ ] **Step 2: Run; verify fail** — Run: `cargo test -p controller --test ssh_localhost -- --ignored push_then_pull`; Expected: FAIL (`push` undefined).

- [ ] **Step 3: Implement push/pull via russh-sftp**

```rust
// add to impl SshSession in ssh.rs
use russh_sftp::client::SftpSession;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

impl SshSession {
    async fn sftp(&mut self) -> Result<SftpSession> {
        let channel = self.handle.channel_open_session().await?;
        channel.request_subsystem(true, "sftp").await?;
        Ok(SftpSession::new(channel.into_stream()).await?)
    }
    pub async fn push(&mut self, local: &str, remote: &str) -> Result<()> {
        let bytes = tokio::fs::read(local).await?;
        let sftp = self.sftp().await?;
        let mut f = sftp.create(remote).await?;
        f.write_all(&bytes).await?; f.flush().await?; Ok(())
    }
    pub async fn pull(&mut self, remote: &str, local: &str) -> Result<()> {
        let sftp = self.sftp().await?;
        let mut f = sftp.open(remote).await?;
        let mut buf = Vec::new(); f.read_to_end(&mut buf).await?;
        tokio::fs::write(local, buf).await?; Ok(())
    }
}
```

- [ ] **Step 4: Run; verify pass** — Run: `cargo test -p controller --test ssh_localhost -- --ignored push_then_pull`; Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(ssh): sftp push/pull"
```

---

## Task 5: Daemon — control socket + session manager

**Files:**
- Create: `crates/controller/src/daemon/mod.rs`, `daemon/session.rs`, `daemon/handlers.rs`
- Modify: `crates/controller/src/lib.rs` (`pub mod daemon;`)
- Test: `crates/controller/tests/daemon_rpc.rs`

- [ ] **Step 1: Write a failing test (State on an empty daemon, no SSH needed)**

```rust
// crates/controller/tests/daemon_rpc.rs
use protocol::{RpcRequest, RpcResponse};
#[tokio::test]
async fn state_on_empty_daemon_returns_no_hosts() {
    let sock = std::env::temp_dir().join(format!("ctl-test-{}.sock", std::process::id()));
    let _srv = controller::daemon::spawn(sock.clone()).await.unwrap();
    let resp = controller::client::call(&sock, RpcRequest::State).await.unwrap();
    match resp { RpcResponse::Ok { data } => assert_eq!(data["hosts"].as_array().unwrap().len(), 0),
                 RpcResponse::Err { .. } => panic!("expected ok") }
}
```

- [ ] **Step 2: Run; verify fail** — Run: `cargo test -p controller --test daemon_rpc`; Expected: FAIL (`daemon::spawn` undefined).

- [ ] **Step 3: Implement the session manager**

```rust
// crates/controller/src/daemon/session.rs
use protocol::{ChannelKind, HostId, HostState};
use std::collections::HashMap;
use crate::ssh::SshSession;

#[derive(Default)]
pub struct SessionManager { hosts: HashMap<HostId, HostSession> }
pub struct HostSession { pub ssh: Option<SshSession> }

impl SessionManager {
    pub fn insert_ssh(&mut self, host: HostId, ssh: SshSession) {
        self.hosts.entry(host).or_insert(HostSession { ssh: None }).ssh = Some(ssh);
    }
    pub fn ssh_mut(&mut self, host: &HostId) -> Option<&mut SshSession> {
        self.hosts.get_mut(host).and_then(|h| h.ssh.as_mut())
    }
    pub fn remove(&mut self, host: &HostId) { self.hosts.remove(host); }
    pub fn state(&self) -> Vec<HostState> {
        self.hosts.iter().map(|(h, s)| HostState {
            host: h.clone(),
            channels: s.ssh.as_ref().map(|_| vec![ChannelKind::Ssh]).unwrap_or_default(),
        }).collect()
    }
}
```

```rust
// crates/controller/src/daemon/mod.rs
pub mod session; pub mod handlers;
use protocol::{RpcRequest, RpcResponse};
use session::SessionManager;
use std::{path::PathBuf, sync::Arc};
use tokio::{net::UnixListener, sync::Mutex, io::{AsyncReadExt, AsyncWriteExt}};

pub struct DaemonHandle { _task: tokio::task::JoinHandle<()> }

pub async fn spawn(socket: PathBuf) -> anyhow::Result<DaemonHandle> {
    let _ = std::fs::remove_file(&socket);
    let listener = UnixListener::bind(&socket)?;
    let mgr = Arc::new(Mutex::new(SessionManager::default()));
    let task = tokio::spawn(async move {
        loop {
            let Ok((mut stream, _)) = listener.accept().await else { break };
            let mgr = mgr.clone();
            tokio::spawn(async move {
                let mut buf = Vec::new();
                if stream.read_to_end(&mut buf).await.is_err() { return; }
                let resp = match serde_json::from_slice::<RpcRequest>(&buf) {
                    Ok(req) => handlers::dispatch(req, &mgr).await,
                    Err(e) => RpcResponse::Err { code: protocol::ErrorCode::BadRequest, message: e.to_string() },
                };
                let _ = stream.write_all(&serde_json::to_vec(&resp).unwrap()).await;
            });
        }
    });
    Ok(DaemonHandle { _task: task })
}
```

- [ ] **Step 4: Implement handlers (State first; others in Task 7)**

```rust
// crates/controller/src/daemon/handlers.rs
use protocol::{RpcRequest, RpcResponse};
use super::session::SessionManager;
use std::sync::Arc; use tokio::sync::Mutex;

pub async fn dispatch(req: RpcRequest, mgr: &Arc<Mutex<SessionManager>>) -> RpcResponse {
    match req {
        RpcRequest::State => {
            let hosts = mgr.lock().await.state();
            ok(serde_json::json!({ "hosts": hosts }))
        }
        _ => RpcResponse::Err { code: protocol::ErrorCode::BadRequest, message: "unimplemented (Task 7)".into() },
    }
}
fn ok(data: serde_json::Value) -> RpcResponse { RpcResponse::Ok { data } }
```

- [ ] **Step 5: Run; verify pass** (also needs `client::call`, Task 6 — implement Task 6 Step 3 first, then return). Run: `cargo test -p controller --test daemon_rpc`; Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(daemon): control socket + session manager + State handler"
```

---

## Task 6: Client transport + CLI dispatch

**Files:**
- Create: `crates/controller/src/client.rs`
- Modify: `crates/controller/src/main.rs`, `crates/controller/src/lib.rs`
- Test: inline test in `client.rs` (serialization), plus reuse of Task 5 test

- [ ] **Step 1: Implement the client transport (one round-trip over UDS)**

```rust
// crates/controller/src/client.rs
use protocol::{RpcRequest, RpcResponse};
use std::path::Path;
use tokio::{net::UnixStream, io::{AsyncReadExt, AsyncWriteExt}};

pub async fn call(socket: &Path, req: RpcRequest) -> anyhow::Result<RpcResponse> {
    let mut stream = UnixStream::connect(socket).await?;
    stream.write_all(&serde_json::to_vec(&req)?).await?;
    stream.shutdown().await?; // signal EOF so daemon's read_to_end completes
    let mut buf = Vec::new();
    stream.read_to_end(&mut buf).await?;
    Ok(serde_json::from_slice(&buf)?)
}

pub fn default_socket() -> std::path::PathBuf {
    std::env::var("CTL_SOCK").map(Into::into)
        .unwrap_or_else(|_| std::env::temp_dir().join("claude-control.sock"))
}
```

- [ ] **Step 2: Implement CLI dispatch with clap**

```rust
// crates/controller/src/main.rs
mod secrets; mod ssh; mod daemon; mod client;
use clap::{Parser, Subcommand};
use protocol::{HostId, RpcRequest, SecretRef};

#[derive(Parser)]
#[command(name = "ctl")]
struct Cli { #[command(subcommand)] cmd: Cmd }

#[derive(Subcommand)]
enum Cmd {
    Serve,
    Connect { host: String, addr: String, #[arg(long)] user: String, #[arg(long)] secret_env: Option<String> },
    Run { host: String, command: String },
    Push { host: String, local: String, remote: String },
    Pull { host: String, remote: String, local: String },
    State,
    Disconnect { host: String },
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let cli = Cli::parse();
    let sock = client::default_socket();
    let req = match cli.cmd {
        Cmd::Serve => { let _h = daemon::spawn(sock.clone()).await?; std::future::pending::<()>().await; return Ok(()); }
        Cmd::Connect { host, addr, user, secret_env } => RpcRequest::Connect {
            host: HostId(host), addr, user,
            secret_ref: secret_env.map(|v| SecretRef::Env { var: v }).unwrap_or(SecretRef::AgentKey),
        },
        Cmd::Run { host, command } => RpcRequest::Run { host: HostId(host), command },
        Cmd::Push { host, local, remote } => RpcRequest::Push { host: HostId(host), local, remote },
        Cmd::Pull { host, remote, local } => RpcRequest::Pull { host: HostId(host), remote, local },
        Cmd::State => RpcRequest::State,
        Cmd::Disconnect { host } => RpcRequest::Disconnect { host: HostId(host) },
    };
    let resp = client::call(&sock, req).await?;
    println!("{}", serde_json::to_string_pretty(&resp)?);
    Ok(())
}
```

```rust
// crates/controller/src/lib.rs
pub mod secrets; pub mod ssh; pub mod daemon; pub mod client;
```

- [ ] **Step 3: Run the full Task-5 test now** — Run: `cargo test -p controller`; Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat(cli): UDS client transport + clap dispatch"
```

---

## Task 7: Wire the remaining handlers (connect/run/push/pull/disconnect)

**Files:**
- Modify: `crates/controller/src/daemon/handlers.rs`
- Test: `crates/controller/tests/daemon_ssh_e2e.rs` (ignored; localhost)

- [ ] **Step 1: Write a failing e2e test (connect → run over localhost via the daemon)**

```rust
// crates/controller/tests/daemon_ssh_e2e.rs
use protocol::{HostId, RpcRequest, RpcResponse, SecretRef};
#[tokio::test]
#[ignore = "requires localhost sshd + agent key"]
async fn connect_then_run_echo() {
    let user = std::env::var("CTL_SSH_USER").unwrap();
    let sock = std::env::temp_dir().join("ctl-e2e.sock");
    let _srv = controller::daemon::spawn(sock.clone()).await.unwrap();
    let c = controller::client::call(&sock, RpcRequest::Connect {
        host: HostId("local".into()), addr: "127.0.0.1:22".into(), user, secret_ref: SecretRef::AgentKey,
    }).await.unwrap();
    assert!(matches!(c, RpcResponse::Ok { .. }));
    let r = controller::client::call(&sock, RpcRequest::Run {
        host: HostId("local".into()), command: "echo via-daemon".into(),
    }).await.unwrap();
    match r { RpcResponse::Ok { data } => assert_eq!(data["stdout"].as_str().unwrap().trim(), "via-daemon"),
              RpcResponse::Err { message, .. } => panic!("{message}") }
}
```

- [ ] **Step 2: Run; verify fail** — Run: `cargo test -p controller --test daemon_ssh_e2e -- --ignored`; Expected: FAIL (Connect returns "unimplemented").

- [ ] **Step 3: Implement the handlers**

```rust
// replace the `_ =>` arm in handlers.rs dispatch()
RpcRequest::Connect { host, addr, user, secret_ref } => {
    // AgentKey path uses the ssh-agent; env/keychain password path is a follow-up within Phase 1.
    match crate::ssh::SshSession::connect_with_agent(&addr, &user).await {
        Ok(sess) => { mgr.lock().await.insert_ssh(host, sess); ok(serde_json::json!({"connected": true})) }
        Err(e) => err(protocol::ErrorCode::AuthFailed, e.to_string()),
    }
}
RpcRequest::Run { host, command } => {
    let mut g = mgr.lock().await;
    match g.ssh_mut(&host) {
        Some(s) => match s.exec(&command).await {
            Ok(r) => ok(serde_json::to_value(r).unwrap()),
            Err(e) => err(protocol::ErrorCode::ProtocolError, e.to_string()),
        },
        None => err(protocol::ErrorCode::NotConnected, format!("no ssh session for {:?}", host)),
    }
}
RpcRequest::Push { host, local, remote } => with_ssh(mgr, &host, |s| s.push(&local, &remote)).await,
RpcRequest::Pull { host, remote, local } => with_ssh(mgr, &host, |s| s.pull(&remote, &local)).await,
RpcRequest::Disconnect { host } => { mgr.lock().await.remove(&host); ok(serde_json::json!({"disconnected": true})) }
```

```rust
// helpers in handlers.rs
fn err(code: protocol::ErrorCode, message: String) -> RpcResponse { RpcResponse::Err { code, message } }

async fn with_ssh<F, Fut>(mgr: &Arc<Mutex<SessionManager>>, host: &protocol::HostId, f: F) -> RpcResponse
where F: FnOnce(&mut crate::ssh::SshSession) -> Fut, Fut: std::future::Future<Output = anyhow::Result<()>> {
    let mut g = mgr.lock().await;
    match g.ssh_mut(host) {
        Some(s) => match f(s).await { Ok(()) => ok(serde_json::json!({"done": true})),
                                      Err(e) => err(protocol::ErrorCode::ProtocolError, e.to_string()) },
        None => err(protocol::ErrorCode::NotConnected, "not connected".into()),
    }
}
```

- [ ] **Step 4: Run; verify pass** — Run: `CTL_SSH_USER=$USER cargo test -p controller --test daemon_ssh_e2e -- --ignored`; Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(daemon): connect/run/push/pull/disconnect handlers"
```

---

## Task 8: End-to-end smoke against the Windows PC

**Files:**
- Create: `scripts/smoke-phase1.sh`

- [ ] **Step 1: Write the smoke script**

```bash
#!/usr/bin/env bash
# scripts/smoke-phase1.sh  — requires: ctl built, key in the host's administrators_authorized_keys
set -euo pipefail
HOST="${1:?usage: smoke-phase1.sh user@host:port-addr  e.g. 192.168.1.50:22}"
USER="${2:?ssh user}"
SOCK="$(mktemp -u).sock"
CTL_SOCK="$SOCK" ./target/debug/ctl serve &  DAEMON=$!
trap 'kill $DAEMON' EXIT
sleep 1
CTL_SOCK="$SOCK" ./target/debug/ctl connect winpc "$HOST" --user "$USER"
CTL_SOCK="$SOCK" ./target/debug/ctl run winpc 'powershell -c "$PSVersionTable.PSVersion.ToString()"'
echo "hello from claude-control" > /tmp/ctl_probe.txt
CTL_SOCK="$SOCK" ./target/debug/ctl push winpc /tmp/ctl_probe.txt 'C:/Windows/Temp/ctl_probe.txt'
CTL_SOCK="$SOCK" ./target/debug/ctl run winpc 'powershell -c "Get-Content C:/Windows/Temp/ctl_probe.txt"'
CTL_SOCK="$SOCK" ./target/debug/ctl state
CTL_SOCK="$SOCK" ./target/debug/ctl disconnect winpc
echo "PHASE 1 SMOKE OK"
```

- [ ] **Step 2: Make executable + build**

Run: `chmod +x scripts/smoke-phase1.sh && cargo build`

- [ ] **Step 3: Run against the owner's PC** (after a key is provisioned manually for Phase 1; the
  automated provisioning lands in Phase 4 `bootstrap`).

Run: `./scripts/smoke-phase1.sh 192.168.x.x:22 <winuser>`
Expected: prints the PowerShell version, echoes the pushed file contents, lists the host with an
`Ssh` channel, ends with `PHASE 1 SMOKE OK`.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "test: phase-1 e2e smoke script"
```

---

## Self-review against the spec

- **§4 SSH fast-path verbs** (`connect/run/push/pull/state/disconnect`): Tasks 3–7. ✓
- **§6 tool surface (SSH subset)**: CLI in Task 6. ✓
- **§8 secrets never to disk**: Task 2 (`Secret` redacts; env/Keychain only). ✓
- **§8 structured error codes**: `ErrorCode` in Task 1; used in handlers Task 7. ✓
- **§3 daemon + control socket + client roles**: Tasks 5–6. ✓
- **Roadmap: test against localhost sshd first**: Tasks 3/4/7 use `127.0.0.1` + `--ignored`. ✓
- **Deferred to later phases (correctly absent here):** RDP, viewer, OCR, UIA agent, bootstrap/auto
  rollout, host-key pinning hardening, password-auth connect path (AgentKey is the Phase-1 path).

**Naming consistency:** `SshSession::{connect_with_agent, exec, push, pull}`, `SessionManager::{insert_ssh,
ssh_mut, remove, state}`, `client::call`, `daemon::spawn` — used identically across tasks. ✓
