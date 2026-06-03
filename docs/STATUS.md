# STATUS — resume here

**Last updated:** 2026-06-02

> **Parallel track — Control Panel GUI & Keychain credentials (branch `feat/control-panel-gui`).**
> A native macOS app (`gui/Claude-Control.app`) + Keychain-backed per-target RDP passwords resolved at
> connect time, plus a per-session state dir (`status.json` + `frame.png`) the app reads to show every
> live session's status and screen. Phases 1–3 built, unit-tested, app compiles. See
> [`docs/superpowers/specs/2026-06-02-control-panel-gui-design.md`](superpowers/specs/2026-06-02-control-panel-gui-design.md)
> and [`docs/superpowers/plans/2026-06-02-control-panel-gui.md`](superpowers/plans/2026-06-02-control-panel-gui.md).
> Set a password: `node scripts/creds.mjs set <host> <user>` or in the app. Build the app: `bash gui/build.sh`.

**For a fresh Claude session:** read [`README.md`](../README.md) "▶ RESUME HERE" first (it has the exact
next command), then this file, then the spec and plan:
- [`docs/superpowers/specs/2026-06-01-rdp-client-remote-control-design.md`](superpowers/specs/2026-06-01-rdp-client-remote-control-design.md)
- [`docs/superpowers/plans/2026-06-01-rdp-client-plane.md`](superpowers/plans/2026-06-01-rdp-client-plane.md)

---

## ⏳ CURRENT STATE (2026-06-02) — one live re-run away from done

Code-complete (all 12 plan tasks) and the RDP **connection works live** against the Mini (NLA/CredSSP
auth + capability negotiation succeed, desktop negotiated 1600×900, no human logged in). The first
live run showed a **blank framebuffer** — connection fine but no graphics painted. **Root cause found
and fixed (commit `c35ebdc`):** the server sends `ServerDeactivateAll` during bring-up and the sidecar
was dropping the `ActiveStageOutput::DeactivateAll` reactivation; we now drive the
`ConnectionActivationSequence` to `Finalized` and resume (matches upstream IronRDP client). Added
`CC_RDP_DEBUG=1` stderr tracing.

**NEXT (the only open step):** owner runs, in their own terminal —
```
cd ~/Projects/Claude-Control && npm run build:sidecar && \
  CC_RDP_DEBUG=1 node scripts/live-validate.mjs 100.73.195.110 uksti ~/.ssh/claude-control_ed25519
```
— password at the hidden prompt. Confirm the `[cc-rdp]` trace shows `DeactivateAll → reactivation
finalized → GraphicsUpdate/copy_image_to_framebuffer` with small `frameAge`, and that
`/tmp/cc-rdp-shot.png` is the live desktop (+ `shot2.png` the Start menu). If good → run the final
holistic review + `superpowers:finishing-a-development-branch` to land `feat/rdp-client-plane`. If the
trace shows a different failure, README's "▶ RESUME HERE" lists how to interpret each case.

---

## One-line state

**RDP-client model built (2026-06-01/02); connection live-verified; graphics fix awaiting one re-run.**

The MCP server is now itself the RDP client: a Rust sidecar (`sidecar/cc-rdp`, built with IronRDP)
holds a live RDP session to the target 24/7. Screen capture and input are designed to work with no
human present. SSH remains the speed plane (run/upload/download/tia_* go over SSH for speed). An
optional UIA accelerator covers `ui_tree`/`ui_find` (set `CLAUDE_CONTROL_UIA=1`). Zero target footprint
beyond RDP being enabled — and RDP is auto-enabled over SSH during the first `connect` call
(`src/rdpEnable.ts :: ensureRdpEnabled`).

**Build status:**
- `npm run build` — zero errors
- `npm run smoke` — SMOKE OK; 28 tools (no `bootstrap`)
- `node --test test/ipc.test.mjs test/keymap.test.mjs test/rdp-plane.test.mjs` — 14 pass
- `~/.cargo/bin/cargo build --release --manifest-path sidecar/Cargo.toml` — Finished, no errors

**Live validation harness:** `scripts/live-validate.mjs <host> <user> [identityFile]` —
prompts for the RDP password on the TTY (hidden, never stored or logged) and drives the
full RDP loop end-to-end against a real Windows target.

**RDP password:** supplied at runtime as `CLAUDE_CONTROL_RDP_PASSWORD` (env var). It is NEVER
written to disk, never stored in any file or config, and never baked into `claude mcp add`
commands — per the project's never-store-passwords rule.

---

## What this project is

Claude-Control is an **MCP server** (Node/TypeScript) that lets Claude Code drive a **remote
Windows computer** as a fully-automated RDP client — no human at the keyboard needed. The
motivating use case is operating GUI software that cannot be automated programmatically:
**Siemens TIA Portal**, Rockwell **Studio 5000**, and similar industrial tools.

### Architecture (twin-plane model)

```
Mac (Claude Code)
│
├── SSH plane (speed)          src/ssh.ts
│   run, upload, download, tia_* ops, rdpEnable
│
└── RDP plane (visual)         src/rdp.ts + sidecar/cc-rdp (Rust/IronRDP)
    screenshot, click, drag, type_text, press_keys,
    scroll, move, list_windows, focus_window, wait_idle
    └── optional UIA accelerator (CLAUDE_CONTROL_UIA=1)
        ui_tree, ui_find  ←  windows/uia-accelerator.ps1 over SSH
```

**Prerequisites on the Windows target:**
1. OpenSSH server enabled + SSH key authorized — done once by pasting the output of
   `node scripts/setup.mjs provision-cmd` into an elevated PowerShell.
2. RDP enabled — done automatically by `ensureRdpEnabled` over SSH on first `connect`.
   Nothing else is installed; zero persistent footprint.

**Key env vars at runtime:**
- `CLAUDE_CONTROL_HOST` — target IP or hostname
- `CLAUDE_CONTROL_USER` — Windows username
- `CLAUDE_CONTROL_IDENTITY` — SSH key path (defaults to `~/.ssh/claude-control_ed25519`)
- `CLAUDE_CONTROL_RDP_PASSWORD` — RDP/NLA password (env only, NEVER stored)
- `CLAUDE_CONTROL_UIA=1` — opt in to UIA accelerator for ui_tree/ui_find

---

## Tools (28 total)

`connect, status, run, upload, download, screenshot, click, move, drag,
mouse_down, mouse_up, scroll, type_text, press_keys, list_windows, focus_window,
wait_idle, ui_tree, ui_find,
tia_status, tia_open_project, tia_list_devices, tia_list_blocks, tia_list_tags,
tia_export_block, tia_import_block, tia_compile, tia_download`

---

## Source layout

```
src/
  index.ts          MCP server entry, tool registry
  config.ts         ConnConfig (host/user/rdpPort/rdpWidth/rdpHeight/sidecarPath)
  ssh.ts            SSH/SCP transport (ControlMaster multiplex)
  rdp.ts            RDP plane — spawns + speaks IPC with sidecar/cc-rdp
  rdpEnable.ts      ensureRdpEnabled (over SSH, idempotent)
  visual.ts         vScreenshot/vClick/vDrag/vType/vKeys/vUiFind/...
  tia.ts            TIA Portal Openness bridge (SSH fast-path, optional)
  ...

sidecar/
  src/main.rs       IronRDP-based RDP client; IPC protocol over stdin/stdout
  Cargo.toml

windows/
  provision.ps1     Enables OpenSSH + authorizes SSH key (onboarding, run once)
  uia-accelerator.ps1  Optional UIA tree/find over SSH (CLAUDE_CONTROL_UIA=1)
  tia-openness.ps1  TIA Portal Openness dispatcher (uploaded by tia.ts)

scripts/
  setup.mjs         Onboarding CLI: keygen | provision-cmd | register | doctor
  cc.mjs            Interactive one-shot driver (env-target, no RDP password needed)
  live-validate.mjs Full RDP loop validation against a real target (prompts for pw)

test/
  ipc.test.mjs      IPC codec unit tests
  keymap.test.mjs   Key-name → scancode mapping tests
  rdp-plane.test.mjs RDP plane integration tests (mocked sidecar)
```

---

## Historical — helper era (superseded 2026-06-01)

The original design used a loopback PowerShell HTTP server (`windows/helper.ps1`) installed as
a logon Scheduled Task by `windows/bootstrap.ps1`. This required an interactive Windows session
to be active (the helper only bound its port when a user was logged in). The design was replaced
by the RDP-client model: the MCP server is now the RDP client itself, holding the session live
so capture + input work with no human present.

Deleted on 2026-06-01: `windows/helper.ps1`, `windows/bootstrap.ps1`.
The `bootstrap` MCP tool was also removed (28 tools, down from 29).
Prior run logs and validation records are in `git log` on `main` pre-2026-06-01.
