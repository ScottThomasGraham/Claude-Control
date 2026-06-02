<h1 align="center">Claude-Control</h1>

<p align="center"><em>Give Claude hands and eyes on a remote Windows PC — by becoming the RDP client itself, with SSH as a fast side-channel. Zero software installed on the target.</em></p>

---

## ▶ RESUME HERE (read this first)

**Branch:** `feat/rdp-client-plane`  ·  **Last worked:** 2026-06-02  ·  **Detailed runbook:** [`docs/STATUS.md`](docs/STATUS.md)

**Where we are:** The whole RDP-client rewrite is built, reviewed, and committed. All 12 plan tasks are code-complete; build/unit-tests/smoke are green; the Rust IronRDP sidecar compiles. **Live against the real Mini, the RDP connection works** (NLA/CredSSP auth + capability negotiation succeed, desktop negotiated at 1600×900 with no human logged in).

**The one open item:** on the first live run the framebuffer came back **blank** — connection fine, but no graphics ever painted. Root-caused: the server sends a `ServerDeactivateAll` PDU during session bring-up and the sidecar was silently dropping the `ActiveStageOutput::DeactivateAll` reactivation. **Fix committed (`c35ebdc`)** — we now drive the `ConnectionActivationSequence` to `Finalized` and resume (matches the upstream IronRDP client). **It is awaiting one live re-run to confirm graphics now paint.**

**To pick up exactly where we left off — have the owner run (in their own terminal, password typed at the hidden prompt, never stored):**

```bash
cd ~/Projects/Claude-Control && npm run build:sidecar && \
  CC_RDP_DEBUG=1 node scripts/live-validate.mjs 100.73.195.110 uksti ~/.ssh/claude-control_ed25519
```

Then read the pasted `[cc-rdp]` trace + inspect `/tmp/cc-rdp-shot.png` (should be the live desktop) and `/tmp/cc-rdp-shot2.png` (Start menu, proving input). Interpreting the trace:
- `DeactivateAll → reactivation finalized 1600x900 → GraphicsUpdate/copy_image_to_framebuffer` lines + small `frameAge` → **fixed.** Verify the screenshots, then run the final holistic review and land the branch (`superpowers:finishing-a-development-branch`).
- `DeactivateAll` but still no `GraphicsUpdate` → reactivation not fully resuming (per-step state names show where).
- No `DeactivateAll`, PDUs arriving, no graphics → codec/compression path, not reactivation.
- No PDUs at all → read pump isn't being driven.

**Target (the Mini):** `uksti@100.73.195.110` (Tailscale), SSH key `~/.ssh/claude-control_ed25519`, Windows 11 build 26200, RDP already enabled (port 3389 open). RDP password is supplied at runtime via `CLAUDE_CONTROL_RDP_PASSWORD` (or the hidden prompt) — **never written to disk.**

**Design + plan (source of truth for intent):**
- Spec: [`docs/superpowers/specs/2026-06-01-rdp-client-remote-control-design.md`](docs/superpowers/specs/2026-06-01-rdp-client-remote-control-design.md)
- Plan: [`docs/superpowers/plans/2026-06-01-rdp-client-plane.md`](docs/superpowers/plans/2026-06-01-rdp-client-plane.md)

---

## What it is

Claude-Control is an **MCP server** (Node/TypeScript) that lets Claude operate a remote **Windows** machine. The breakthrough vs. the old design: instead of installing an in-session helper on the target, **the MCP server *becomes the RDP client*** and holds the session open continuously. Because an RDP session stays rendered as long as a client holds it — and RDP manufactures its own virtual display — this works on a **headless / VM / no-monitor box with no human present**, and the desktop is always there to see and drive. Footprint on the target is essentially zero (the only prerequisite is that RDP is enabled, which we auto-enable over SSH).

**Two planes, one coordinator:**
- **RDP plane (vision + input)** — a small **Rust sidecar** (`sidecar/`, built on [IronRDP](https://github.com/Devolutions/IronRDP)) that the Node server spawns and talks to over a length-prefixed-JSON stdio IPC. It connects, holds the session, decodes the framebuffer (PNG on demand), and injects mouse/keyboard.
- **SSH plane (speed)** — the OS `ssh`/`scp` for fast headless work: `run`, `upload`, `download`, the optional TIA Openness accelerator, and the one-time RDP-enable.
- **Optional UIA accelerator** (off by default; `CLAUDE_CONTROL_UIA=1`) — for dense enterprise UIs, runs a transient one-shot UI-Automation walk *inside* the live RDP session and cleans up. Vision-first otherwise.

## Status

| Layer | State |
|---|---|
| Node/TS RDP plane (IPC, keymap, config, rdp plane, rdp-enable, visual, server, UIA) | ✅ built, **14/14 unit tests**, `npm run smoke` green (28 tools) |
| Rust IronRDP sidecar (`sidecar/cc-rdp`) | ✅ compiles warning-free; IPC verified against the live binary |
| Live RDP **connection** (auth + negotiate, no human present) | ✅ verified against the Mini |
| Live **graphics paint** | ⏳ fix committed (`c35ebdc`), **awaiting one live re-run** (see Resume block) |
| Old in-session helper (`helper.ps1`/`bootstrap`) | ❌ removed |

## Build & test (no hardware needed)

```bash
npm install
npm run build          # tsc -> build/
npm run build:sidecar  # cargo build --release -> sidecar/target/release/cc-rdp  (needs Rust toolchain)
npm run smoke          # MCP tool registry check
node --test test/ipc.test.mjs test/keymap.test.mjs test/rdp-plane.test.mjs   # 14 unit tests (vs a mock sidecar)
```

Requires Node ≥20 and a Rust toolchain (rustup). The unit tests exercise the Node RDP plane against a mock sidecar — no real RDP server required.

## Repo layout

```
src/
  ipc.ts          length-prefixed JSON framing (Node side of the sidecar IPC)
  keymap.ts       chord/text -> RDP key events (scancodes / unicode)
  config.ts       in-memory target config (RDP host/port/size, sidecar path); secrets never persisted
  rdp.ts          the RDP plane: spawn/supervise sidecar, frame/pointer/keys/status, click/drag/type
  rdpEnable.ts    auto-enable RDP on the target over SSH (idempotent, leave-on)
  ssh.ts          OS ssh/scp transport (run/upload/download/runPowerShell)
  visual.ts       OS dispatcher: Windows -> rdp.ts; macOS -> screencapture
  uia.ts          optional opt-in UIA accelerator (transient, in the live session)
  server.ts       MCP server: registers all tools (connect/status/run/screenshot/click/.../tia_*)
  tia.ts          optional Siemens TIA Openness accelerator
sidecar/          Rust IronRDP client sidecar (cc-rdp): proto.rs (IPC), rdp.rs (session), main.rs
windows/          provision.ps1 (SSH+key onboarding), uia-accelerator.ps1, tia-openness.ps1
scripts/          setup.mjs (onboarding), cc.mjs (CLI), live-validate.mjs (live RDP harness)
test/             node:test unit tests + mock-sidecar.mjs
docs/             STATUS.md (resume runbook) + superpowers/specs + superpowers/plans
```

## Onboarding a new target (RDP era)

1. **SSH + key:** `node scripts/setup.mjs provision-cmd` prints a one-liner to paste into an elevated PowerShell on the target (enables OpenSSH, authorizes the key, opens the firewall).
2. **Register the MCP server:** `node scripts/setup.mjs register --host <ip> --user <user>` runs `claude mcp add` with `CLAUDE_CONTROL_HOST/USER/IDENTITY`.
3. **Connect:** call the `connect` tool (host + user). It auto-enables RDP over SSH if needed and brings up the live session. The RDP **password** is read at runtime from `CLAUDE_CONTROL_RDP_PASSWORD` — never baked into any command or file.

## Security notes

- **No passwords on disk, ever.** SSH uses your key; the RDP password comes only from the environment / a hidden prompt and lives in process memory.
- RDP TLS currently uses a permissive cert verifier (standard for self-signed RDP hosts) — flag for any production hardening pass.
- License: MIT OR Apache-2.0.
