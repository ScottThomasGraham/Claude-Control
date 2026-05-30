# Claude-Control — Implementation Roadmap

> **For agentic workers:** This is the master roadmap. Each phase has (or will get) its own detailed,
> bite-sized plan under `docs/superpowers/plans/`. Use `superpowers:subagent-driven-development` or
> `superpowers:executing-plans` to implement a phase's plan task-by-task.

**Goal:** Build an AI-and-human-drivable controller for remote Windows desktops over SSH (fast path)
+ RDP (visual path) + an auto-deployed UIA agent (semantic path), distributed as a clean, signed,
professional tool.

**Architecture:** A single Rust controller binary on macOS (daemon + client roles) manages persistent
per-host sessions across three channels, choosing the cheapest channel that can do each step. A tiny
separate Windows agent binary, auto-pushed over SSH, exposes the UI Automation tree. See the
[design spec](../specs/2026-05-30-claude-control-design.md).

**Tech stack:** Rust (Tokio), `russh`/`russh-sftp` (SSH), `IronRDP` (RDP), `objc2-vision` + `ocrs`
(OCR), `windows-rs` (Windows agent), `axum` or `tiny_http`+`tungstenite` (viewer), `cargo-dist`
(release). License: `MIT OR Apache-2.0`.

---

## Workspace file structure (locked at Phase 1)

```
Claude-Control/
├── Cargo.toml                 # [workspace]; default-members = ["crates/controller"] (skips agent on macOS)
├── rust-toolchain.toml        # pin stable channel
├── deny.toml                  # cargo-deny license/advisory config
├── .github/workflows/ci.yml   # fmt + clippy + test + cargo-deny (macOS + Windows)
├── crates/
│   ├── protocol/              # shared, platform-neutral types — builds everywhere
│   │   └── src/lib.rs         # HostId, ChannelKind, SessionState, Legend, RpcRequest/RpcResponse, errors
│   ├── controller/            # the `ctl` binary (macOS/Linux): daemon + client
│   │   └── src/
│   │       ├── main.rs        # arg dispatch: `serve` (daemon) vs client verbs
│   │       ├── daemon/        # serve role
│   │       │   ├── mod.rs     # control-socket JSON-RPC server + dispatch
│   │       │   ├── session.rs # SessionManager: per-host channel state + lifecycle
│   │       │   └── handlers.rs# one handler fn per verb
│   │       ├── ssh.rs         # russh client: connect (key auth), exec, sftp push/pull, tunnel
│   │       ├── rdp.rs         # IronRDP connect, framebuffer decode, input encode   (Phase 2)
│   │       ├── perceive.rs    # OCR (Apple Vision/ocrs) + UIA legend + tier select  (Phase 3/4)
│   │       ├── viewer.rs      # HTTP/WS viewer server + takeover                     (Phase 2)
│   │       ├── bootstrap.rs   # channel enablement, key provisioning, agent rollout  (Phase 4)
│   │       ├── secrets.rs     # env-var / macOS Keychain resolution (never to disk)
│   │       └── client.rs      # client-mode: connect to control socket, call verb, print
│   └── agent/                 # claude-control-agent.exe (Windows-only)              (Phase 4)
│       └── src/
│           ├── main.rs        # DPI-aware; start loopback server
│           ├── uia.rs         # cached FindAll over ControlViewWalker → snapshot
│           └── server.rs      # loopback TCP, newline-delimited JSON snapshots
└── docs/  (superpowers/specs, superpowers/plans, research, architecture)
```

**Cross-platform discipline:** never `#![cfg(windows)]` a whole `main.rs`. Gate Windows deps with
`[target.'cfg(windows)'.dependencies]`; put platform code behind `#[cfg(windows)]` modules so every
crate still compiles on macOS. `default-members` excludes `agent` so a bare `cargo build` on the Mac
never touches it.

---

## Phase map

Each phase delivers working, testable software and ends with an e2e smoke test against the owner's
Windows PC. A phase's detailed plan is written just-in-time, after the owner approves starting it.

| Phase | Delivers | Detailed plan | Depends on |
|---|---|---|---|
| **0** | Toolchain (`rustup`), workspace scaffold, CI skeleton, licenses | folded into Phase 1 | — |
| **1** | **SSH fast path**: daemon + control socket; `connect/run/push/pull/state/disconnect` | [phase-1-ssh-fast-path.md](2026-05-30-phase-1-ssh-fast-path.md) | 0 |
| **2** | **RDP visual path**: framebuffer `screenshot`, input (`click/type/key/scroll`), `wait`, live viewer + takeover | _TBW_ | 1 |
| **3** | **Perception**: Apple Vision OCR legend (+ ocrs fallback), `find`/`read`, tier reporting | _TBW_ | 2 |
| **4** | **UIA agent + auto-rollout**: Windows agent, SSH-tunnel ingestion, `bootstrap` + `ctl agent` lifecycle, semantic legend | _TBW_ | 1, (2 for coords) |
| **5** | **Distribution & polish**: cargo-dist, macOS notarize + Homebrew tap, Windows signing, multi-session, docs | _TBW_ | 1–4 |

_TBW = to be written when the phase is approved for execution._

---

## Cross-cutting conventions (apply to every phase)

- **TDD:** write the failing test first, watch it fail, implement minimally, watch it pass, commit.
- **Testability of SSH without Windows:** Phase 1 SSH logic is tested against **`localhost`** with
  macOS *Remote Login* (System Settings → General → Sharing) enabled — a real sshd — before pointing
  at the Windows PC. This removes the Windows dependency from the inner loop.
- **Secrets never touch disk** (owner's standing rule): resolve from env var or macOS Keychain only.
- **Structured errors:** every verb returns a typed error code (`not_connected`, `auth_failed`,
  `cert_untrusted`, `timeout`, `host_unreachable`, `protocol_error`) the agent can branch on.
- **Frequent commits:** one logical step per commit; conventional-commit messages.
- **CI gates green before merge:** `cargo fmt --check`, `cargo clippy -D warnings`, `cargo test`,
  `cargo deny check`.
- **External pre-1.0 APIs (IronRDP, russh):** the code in detailed plans is TDD-driven and
  *illustrative of intent*; verify exact signatures against current docs.rs when implementing, and
  let the tests drive the final shape.

---

## Definition of done (whole project)

`brew install` puts `ctl` on a Mac; the owner enables one channel on a fresh Windows PC; `ctl
bootstrap <host>` brings up SSH+RDP and silently installs the UIA agent; the agent can then run
headless commands, see the screen, click/type, and read a semantic element legend — with a live
viewer to watch and take over, full audit logging, and a clean uninstall.
