# Claude-Control — Design Spec

> **⚠️ Superseded mechanism (2026-05-30):** the *implementation approach* below (embedding IronRDP +
> a compiled Rust agent) was replaced by a simpler, more OS-native design: **drive Windows over SSH
> with PowerShell, shipped as an MCP server.** The goals, tri-channel model, session-0 insight, and
> security posture all carry over. See
> [`docs/architecture/implemented-architecture.md`](../../architecture/implemented-architecture.md)
> for the shipped design. This document is retained for design history.

**Date:** 2026-05-30
**Status:** Design complete, pending owner review (owner stepped away; will review on return)
**Repo:** `Claude-Control` (binary working name: `ctl`; product name provisional)
**Author:** Drafted by Claude (Opus 4.8) with Scott Graham (owner)

---

## 1. Purpose

A remote-PC control platform that lets an **AI agent (and a human)** fully operate remote **Windows
10/11** machines from **macOS**, using Microsoft's native protocols. It is the desktop-control analog
of Claude-Browser: where Claude-Browser drives a Chromium pane, Claude-Control drives an entire
Windows desktop.

The key idea that makes it fast *and* general is **three cooperating channels**, used in
least-cost-first order:

1. **SSH (fast path)** — run commands, scripts, and file transfers headlessly. No pixels involved.
   This is also the **delivery channel** that pushes and installs the helper agent.
2. **RDP (visual path)** — stream the desktop framebuffer for screenshots + a live viewer, and inject
   mouse/keyboard for GUI navigation. Used when a task genuinely needs eyes and clicks.
3. **UIA agent (semantic upgrade)** — an optional helper the app auto-deploys to machines the owner
   controls, exposing the Windows UI Automation tree (control type, name, click-ready screen
   coordinates) over a loopback socket tunneled through SSH.

The agent prefers the cheapest channel that can accomplish a step: SSH for headless work, the UIA
agent for precise semantic targeting, and RDP screenshots only when visual reasoning is required.

### The central design constraint

RDP delivers only a **pixel framebuffer** — no DOM, no element tree. So baseline perception is
computer-vision/OCR plus the LLM's visual reasoning. The **UIA agent** is what restores a
Claude-Browser-grade semantic legend, and the **SSH channel** is what lets us skip the GUI entirely
for most automation. The architecture is built around these three facts.

---

## 2. Resolved decisions

| Area | Decision | Rationale / source |
|---|---|---|
| Footprint | **Hybrid** — pixels-only baseline works anywhere; UIA-agent upgrade on owner's machines | Owner choice; see [UIA research](../../research/2026-05-30-uia-agent.md) |
| RDP engine | **IronRDP** (pure-Rust, library-first, headless-friendly) | [IronRDP research](../../research/2026-05-30-ironrdp.md) |
| Fast channel | **SSH** via `russh`/`russh-sftp` (pure-Rust) | [SSH research](../../research/2026-05-30-windows-ssh.md) |
| Agent delivery | **Auto-push over SSH**, run via logon Scheduled Task | Owner request; session-0 constraint |
| Viewer | **Live viewer pane** (localhost web) + manual takeover | Owner choice |
| Architecture | **Single Rust binary** (controller), subcommand-dispatched daemon + client; separate Windows agent binary | Owner choice; Cargo workspace |
| Perception | **Apple Vision OCR** (default) + `ocrs` fallback; UIA legend when agent present | [OCR research](../../research/2026-05-30-ocr-perception.md) |
| Distribution | **cargo-dist**: macOS universal2 + Homebrew tap (notarized); Windows agent = signed exe | [Distribution research](../../research/2026-05-30-distribution.md) |
| License | **MIT OR Apache-2.0** | Ecosystem standard; IronRDP-compatible |
| Test target | A **Windows PC the owner owns** (must be Pro/Enterprise/Education) | Owner choice; see Prerequisites |
| Controller host | The owner's **Mac** (Apple Silicon) | Environment |

---

## 3. Architecture

```
  macOS controller (single Rust binary, `ctl`)                          Windows target
 ┌──────────────────────────────────────────────────┐               ┌──────────────────────┐
 │  ctl serve  (daemon role)                          │               │                      │
 │   ┌─────────────┐  session manager (1..N hosts)    │   SSH (22)    │  OpenSSH Server      │
 │   │  SSH client │──────────────────────────────────┼──────────────▶│  pwsh, sftp          │
 │   │  (russh)    │  commands · sftp · agent push     │               │   └─ pushes/install  │
 │   ├─────────────┤                                   │               │      UIA agent       │
 │   │ RDP client  │  framebuffer decode → RGBA        │   RDP (3389)  │  Terminal Services   │
 │   │ (IronRDP)   │──────────────────────────────────┼──────────────▶│  (NLA/CredSSP)       │
 │   │             │  input PDUs (mouse/kbd/wheel)     │               │                      │
 │   ├─────────────┤                                   │  loopback TCP │  UIA agent (Rust)    │
 │   │ Agent client│◀═══ tunneled over SSH ════════════┼──────────────│  walks UIA tree,     │
 │   │ (UIA JSON)  │  semantic element legend          │               │  emits JSON snapshot │
 │   ├─────────────┤                                   │               │  (logon Sched. Task, │
 │   │ Perception  │  Apple Vision / ocrs OCR          │               │   interactive session)│
 │   │ (OCR + sel) │  → legend with center coords      │               └──────────────────────┘
 │   └─────────────┘                                   │
 │   control socket (UDS, JSON-RPC) ──── ctl <verb> client subcommands                       │
 │   localhost HTTP/WS ──── live viewer (browser)                                             │
 └──────────────────────────────────────────────────┘
```

**Two roles, one binary:**
- **Daemon (`ctl serve`)** owns persistent sessions (an RDP connection and/or SSH connection per
  host can't live inside a one-shot CLI call). Hosts a Unix-domain-socket **JSON-RPC control API**
  and a **localhost HTTP/WebSocket** server for the viewer.
- **Client (`ctl <verb>`)** — short-lived subcommands round-tripping to the daemon.

**Separate Windows agent binary** (`claude-control-agent.exe`) — tiny Rust exe built for
`x86_64-pc-windows-msvc`, pushed and installed by the controller; not run on macOS.

---

## 4. Channels & the selection model

The agent (or a human) issues high-level intents; the controller routes each to the best channel:

| Need | Preferred channel | Example |
|---|---|---|
| Run a program, script, registry/file/service op | **SSH** | `ctl run "Get-Service"` → pwsh over SSH |
| Move/copy files to/from the host | **SSH (sftp)** | `ctl push ./x C:/Temp/x` |
| Know what's on screen, semantically | **UIA agent** (if present) → else OCR legend → else raw screenshot | `ctl perceive` |
| Click/type/scroll in a GUI | **RDP** input | `ctl click-at`, `ctl type-at` |
| Watch the desktop live / take over | **RDP** viewer | open `localhost:<port>` |

`perceive` auto-selects perception tier: **UIA legend > OCR legend > raw screenshot**, and always
returns a screenshot too. The controller reports which tier was used so the agent knows how much to
trust the legend.

---

## 5. Bootstrap & agent auto-rollout

**One manual step, once, per fresh machine:** the owner enables a single channel (SSH *or* RDP) by
hand. Everything else automates — either channel can enable the other
([SSH research §6](../../research/2026-05-30-windows-ssh.md)).

`ctl bootstrap <host>` performs, idempotently:
1. Connect over whichever channel exists.
2. If only RDP exists, enable + start OpenSSH Server (FoD), set startup Automatic, add the firewall
   rule, set DefaultShell to `pwsh`. If only SSH exists, enable RDP (`fDenyTSConnections=0` +
   firewall) so the visual path is available.
3. Provision a public key into `administrators_authorized_keys` with the locked-down ACL.
4. **Push the UIA agent** over SFTP to `%ProgramData%\ClaudeControl\agent-<version>.exe`, run the
   idempotent installer (register a **logon-triggered Scheduled Task, highest privileges**, user
   context — so it runs in the *interactive* session, dodging session-0 isolation), and start it.
5. Verify: open the SSH tunnel to the agent's loopback port and confirm a UIA snapshot returns.

`ctl agent {status|update|uninstall} <host>` manages the rollout lifecycle (version-checked,
idempotent; uninstall unregisters the task, kills the process, removes the directory).

---

## 6. Tool surface (agent-facing CLI)

Coordinate-first, mirroring the Claude-Browser action loop, extended with the SSH fast path:

**Session / channels**
- `ctl connect --host <h> [--rdp] [--ssh] --user <u> [--domain <d>]` — secret via env var name or
  macOS Keychain, **never** a flag/file. Returns a session id.
- `ctl bootstrap <host>` · `ctl agent {status|update|uninstall} <host>` · `ctl state` · `ctl disconnect`

**Fast path (SSH)**
- `ctl run "<powershell>"` — execute, return stdout/stderr/exit code (JSON).
- `ctl push <local> <remote>` · `ctl pull <remote> <local>` — SFTP.

**Visual path (RDP)**
- `ctl perceive` — screenshot PNG + best-available legend (records the tier used).
- `ctl screenshot [--region x,y,w,h]`
- `ctl click-at --x --y [--button] [--double]` · `ctl move-at` · `ctl drag` · `ctl scroll --dy`
- `ctl type-at --x --y --text "…"` · `ctl key --keys=Ctrl+Shift+Esc`
- `ctl find --text "…"` (locate → coords) · `ctl read [--region]` (OCR dump)
- `ctl wait --stable [--timeout ms]` (framebuffer settled)

Image-producing verbs write a PNG and return its path (agent reads it with image tooling, exactly
like Claude-Browser).

---

## 7. Perception

- **Tier 0 — raw screenshot:** always available from the RDP framebuffer.
- **Tier 1 — OCR legend (any target):** **Apple Vision** (`objc2-vision`, built into macOS, best
  accuracy, per-line/word boxes) by default; **`ocrs`** (pure-Rust, bundled models) as a portable
  fallback. Produces numbered text runs with center `(x,y)`. Element detection beyond text is
  **deferred to the LLM's visual reasoning** over the screenshot + legend (CV/OmniParser only if
  icon-only targeting proves unreliable).
- **Tier 2 — UIA legend (agent present):** the helper emits `{controlType, name, boundingRect}` in
  **physical screen coordinates** (per-monitor DPI-aware → click-ready), delivered over the SSH
  tunnel. This is the Claude-Browser-grade semantic legend.

---

## 8. Security & threat model

A tool that can fully control remote PCs must be conservative by default.

- **Secrets:** passwords/keys are **never written to files or passed as flags** (owner's standing
  rule). Resolved at connect time from a named env var or the macOS Keychain; held only in daemon
  memory for the session. SSH uses **key auth**; the private key stays in the Keychain/agent.
- **Transport:** RDP uses **NLA/CredSSP + TLS**; SSH is encrypted. The UIA agent binds **loopback
  only** and is reached **through the SSH tunnel** — never an open network port.
- **Certificate trust:** unknown RDP server certs are surfaced (`cert_untrusted`) and added to an
  allowlist on explicit confirmation — never silently accepted. SSH host keys verified on first use
  with pinning.
- **Least privilege:** the agent installer runs elevated (to register the task / write
  `%ProgramData%`); the agent itself runs at the user's level. Document exactly what privileges each
  step needs.
- **Auditability:** the daemon logs every command run and input injected, per session, with
  timestamps — so there's a record of everything the agent did.
- **Consent & scope:** auto-rollout of the agent targets only hosts the owner explicitly bootstraps.
  No discovery, no lateral movement, no acting on machines that weren't named.
- **Clean uninstall:** `ctl agent uninstall` fully removes the agent (task + binary + directory),
  leaving no residue.
- **Signing:** the macOS controller is Developer-ID signed + notarized; the Windows agent is
  Authenticode-signed (tamper-evidence + AV/EDR friendliness).

---

## 9. Components (Cargo workspace; each unit independently testable)

```
Cargo.toml                # [workspace] default-members excludes agent on macOS
crates/
  protocol/               # shared types: session state, legend schema, JSON-RPC messages, channel enums
  controller/             # the `ctl` binary (macOS/Linux): daemon + client roles
  agent/                  # claude-control-agent.exe (Windows-only; UIA walker + loopback server)
docs/  (superpowers/specs, superpowers/plans, research, architecture)
```

**controller** internal modules:
1. `session` — lifecycle/state for a host (which channels are up), reconnect/backoff.
2. `ssh` — russh client: exec, sftp, tunnel/port-forward to the agent.
3. `rdp` — IronRDP connect (NLA/CredSSP/TLS), framebuffer decode → RGBA, input encoding.
4. `perceive` — Apple Vision/ocrs OCR; UIA-legend ingestion; tier selection.
5. `control_api` — JSON-RPC over UDS; verb handlers.
6. `viewer` — HTTP/WS server, dirty-rect tile streaming, takeover input ingest.
7. `cli` — subcommand parsing/dispatch (client mode).
8. `bootstrap` — channel enablement, key provisioning, agent push/install/verify.

**agent** (Windows): `uia` (cached `FindAll` over `ControlViewWalker`, DPI-aware), `server`
(loopback TCP, newline-delimited JSON), `installer` (idempotent, version-checked).

---

## 10. Build roadmap (phases within this one spec)

- **Phase 1 — SSH fast path + skeleton.** Workspace + `protocol` + `controller` skeleton; daemon +
  control socket; `connect`/`run`/`push`/`pull`/`state`/`disconnect` over SSH (`russh`). Proves the
  fast path and the daemon shape against the owner's PC. *(No GUI yet.)*
- **Phase 2 — RDP visual path.** IronRDP connect (NLA/CredSSP/TLS), framebuffer → `screenshot`, core
  input (`move-at`/`click-at`/`type-at`/`key`/`scroll`), `wait --stable`, and the **live viewer** with
  takeover. `perceive` returns raw screenshot (no legend yet).
- **Phase 3 — Perception.** Apple Vision OCR legend (+ `ocrs` fallback), `find`/`read`, perceive tier
  reporting.
- **Phase 4 — UIA agent + auto-rollout.** Windows agent (UIA → JSON over loopback), SSH-tunnel
  ingestion, `bootstrap` + `ctl agent` lifecycle, semantic legend (Tier 2).
- **Phase 5 — Distribution & polish.** cargo-dist release pipeline, macOS notarization + Homebrew tap,
  Windows agent signing, CI (fmt/clippy/test/cargo-deny), multi-session management, docs.

Each phase ends with an e2e smoke test against the owner's Windows PC.

---

## 11. Testing strategy

- **Unit (Rust):** protocol/codec/input encoding against recorded PDU fixtures + synthetic
  framebuffers; channel-selection logic; legend coordinate math (DPI scaling).
- **Integration:** control-socket JSON-RPC contract against an in-process daemon with mock channels.
- **End-to-end:** the live loop against the owner-owned Windows PC; a scripted smoke per phase
  (connect → run → push → perceive → click → type → verify).
- **Viewer:** WebSocket tile stream asserted against framebuffer diffs.
- **CI gates:** `cargo fmt --check`, `cargo clippy -D warnings`, `cargo test`, `cargo deny check`.

---

## 12. Prerequisites (before Phase-1 e2e)

- Target Windows PC is **Pro/Enterprise/Education** (Home can't host RDP), reachable from the Mac.
- **One channel enabled by hand once** (SSH or RDP); `bootstrap` does the rest.
- An account with the right permissions; credentials supplied via env/Keychain at runtime.
- **Rust toolchain** on the Mac (`rustup`) — not yet installed.
- For distribution (Phase 5): Apple Developer account ($99/yr) + Windows code-signing cert.

---

## 13. Open questions / risks

- IronRDP graphics-codec coverage on the specific target (negotiate RemoteFX/bitmap; verify GFX/H.264
  early) — pre-1.0 async API may shift.
- `objc2-vision` ergonomics from Rust — validate with a spike before committing OCR to Apple Vision;
  `ocrs` is the fallback either way.
- Scheduled-Task-in-interactive-session reliability across lock/reconnect/fast-user-switching — test
  on the real PC.
- Keyboard layout / scancode mapping across locales.
- Whether to later add a DVC transport for the agent (vs the SSH-tunnel default) — deferred; SSH
  tunnel is simpler and sufficient.

---

## 14. Naming

Working names: repo **Claude-Control**, controller binary **`ctl`**, agent
**`claude-control-agent.exe`**. All provisional — easy to rename before first release.
