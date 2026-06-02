# Design — RDP-Client Remote Control (zero-footprint visual plane)

**Date:** 2026-06-01
**Status:** Approved (brainstorm) → ready for implementation plan
**Branch:** `feat/rdp-client-plane`
**Supersedes:** the in-session PowerShell visual helper (`windows/helper.ps1` + `bootstrap`) for
all *visual* (capture + input) operations. The SSH "speed plane" is retained unchanged.

---

## 1. Problem & motivation

Claude-Control today rides as a **passenger inside a human's interactive desktop session**: the
helper runs as a logon Scheduled Task and uses GDI `CopyFromScreen` to see and `SendInput` to click.
That only works while the session is **Active** (connected + unlocked). The instant the session is
**disconnected** (RDP closed), **locked**, **logged off**, or the box is **headless** (no rendered
framebuffer), the agent goes **blind and unable to click** — captured live on 2026-06-01 against
SGRAHAM-MINI: SSH/`run` worked perfectly, but `screenshot` failed with
`"CopyFromScreen ... The handle is invalid"` because the only session was in state `Disc`.

The capability was, in effect, borrowing a human's session. The holy grail (owner-stated):

> Remote into a system, **introduce no changes**, control it **like a human via RDP**, with an
> **expansion into SSH/CLI/API** for tasks that are faster scripted.

## 2. Core idea

**Invert the model: instead of pushing a helper into the target's session, the MCP server becomes
the RDP client itself and holds the session open 24/7.**

Why this dissolves every failure mode above:

- **An RDP session is rendered for as long as a client holds it open.** We never let go → the session
  stays `Active` → there is always a live, rendered desktop to see and click. The disconnect failure
  becomes *structurally impossible*, not patched.
- **RDP manufactures its own virtual display.** The RDP server spins up a virtual framebuffer for the
  remote session, so this works identically on a **headless box, a VM, or a monitored desktop** — no
  display driver, no dummy plug. The previously-considered "virtual display tier" is obviated.
- **No human is ever required.** Log in over RDP with admin creds → Windows creates a fresh, fully
  rendered interactive session → drive it. Reboot → reconnect.
- **Control is literally human-equivalent** — mouse PDUs + keyboard scancodes, exactly what `mstsc`
  sends.
- **Target footprint is essentially zero.** The entire Windows visual helper (`helper.ps1`,
  `bootstrap.ps1`, the Scheduled Task) is **deleted**. The only prerequisite is that **RDP is
  enabled** — a setting, not a footprint (no files/service/driver, reversible).

> **Historical reconciliation:** STATUS.md notes an abandoned "IronRDP + Rust agent" design. That
> rejection was about putting **Rust on the target**. This design runs IronRDP **on the Mac (client
> side)**; the target stays clean. The two are mirror images — the past instinct and the present holy
> grail agree.

## 3. Architecture — two planes, one coordinator

```
                ┌─────────────────────── MCP server (Node/TS) ──────────────────────┐
   Claude  ───► │  vision/input tools ──► RDP plane  ──► IronRDP sidecar ──RDP────► │ ──► TARGET
                │  speed tools ─────────► SSH plane   ─────────────────────ssh────► │     (no install;
                │  ui_tree (opt-in) ────► UIA accelerator (transient, over SSH) ───► │      RDP enabled)
                └────────────────────────────────────────────────────────────────────┘
```

### 3.1 RDP plane (NEW) — vision + input

- **Engine:** **IronRDP** (Devolutions, pure Rust) run as a **sidecar process** the Node MCP server
  supervises and talks to over a local IPC channel (length-prefixed JSON over a stdio pipe or a
  Unix-domain socket). Chosen over FreeRDP (heavier native embed) and pure-Node libs (bitrotted, weak
  NLA). Pure Rust → single static binary, cross-compiles for macOS arm64, no system deps.
- **Auth:** **NLA/CredSSP** with admin username + password (RDP cannot use an SSH key).
- **Responsibilities:** establish + maintain the RDP connection; decode the graphics stream into a
  current framebuffer; expose snapshot + input commands; auto-reconnect with backoff on drop.
- **Sidecar command interface (IPC):**
  - `connect { host, port, username, password, width, height }` → `{ ok, session }`
  - `frame {}` → latest framebuffer as PNG bytes (+ width/height)
  - `pointer { x, y, buttons, wheel }` → injects mouse move/click/scroll
  - `keys { scancodes[] | unicode[] }` → injects keyboard input
  - `resize { width, height }` → renegotiate desktop size
  - `status {}` → `{ connected, since, width, height, lastFrameAgeMs }`
  - `disconnect {}`
- **Codecs:** bitmap + RemoteFX sufficient for UI work; GFX/AVC optional later.

### 3.2 SSH plane (UNCHANGED) — speed

The existing channel for `run`, `upload`, `download`, and the `tia_*` Openness accelerator. Used for
anything faster scripted than clicked, for the one-time RDP-enable step, and to carry the optional
UIA accelerator.

### 3.3 UIA accelerator (opt-in) — precision for dense apps

Default **off** (vision-first). When invoked for a dense enterprise UI (TIA Portal, Studio 5000), the
MCP server **transiently** pushes a small UI-Automation script over SSH, reads the element tree back,
and **cleans it up** — no persistent target footprint. Mirrors the project's existing "TIA Openness
as optional accelerator" philosophy.

## 4. Tool surface changes

| Tool | Change |
|---|---|
| `screenshot`, `click`, `move`, `scroll`, `type_text`, `press_keys`, `drag` | **Re-routed** to the RDP plane (IronRDP framebuffer + input PDUs). Same MCP signatures. |
| `bootstrap` | **Removed.** |
| `windows/helper.ps1`, `windows/bootstrap.ps1`, the Scheduled Task | **Deleted.** |
| `connect` | Gains RDP params (`rdpPort`, `width`, `height`) + sources the RDP **password** from env/secure store; brings up the RDP session as part of connecting; auto-enables RDP if off (see §6). |
| `ui_tree`, `ui_find`, `list_windows`, `focus_window` | Backed by the **opt-in UIA accelerator**; when it's off, vision-approximated (taskbar/alt-tab clicks, full-frame reasoning). |
| `run`, `upload`, `download`, `tia_*` | **Unchanged.** |
| `status` | Reports RDP-plane state (connected/since/resolution/last-frame-age) in addition to SSH/host. |

## 5. Credentials & secrets

- RDP requires a **password**. Per the owner's standing rule **never to store passwords in files**,
  the RDP password is supplied **only** via environment variable
  (e.g. `CLAUDE_CONTROL_RDP_PASSWORD`) or the authorized secure cred store, and is **never written to
  disk** by this project. It is passed to the IronRDP sidecar over the in-process IPC, not persisted.
- SSH continues to use the existing key `~/.ssh/claude-control_ed25519`.
- Logging must **redact** the password and must not echo it in error/diagnostic output.

## 6. Session lifecycle & resilience

- **RDP-enable prerequisite (auto, leave-on):** on `connect`, probe the RDP port; if closed, use the
  SSH plane (admin) to set `HKLM\SYSTEM\CurrentControlSet\Control\Terminal Server\fDenyTSConnections=0`
  and `Enable-NetFirewallRule -DisplayGroup 'Remote Desktop'`, then proceed. **Leave it enabled** (per
  decision). Surface what was changed.
- **Hold-open + auto-reconnect:** the sidecar keeps the session `Active` continuously; on a dropped
  connection it reconnects with bounded exponential backoff and resumes. `status` exposes liveness.
- **Reboots:** target reboot → sidecar reconnects → fresh rendered session. Autologon is **not
  required** (RDP creates its own session); it remains an optional convenience, not a dependency.
- **Single-session caveat (client SKUs, e.g. the Mini):** holding an RDP session bumps a local human
  user to the lock screen (Win 11 Pro = one interactive session). Acceptable for unattended boxes;
  documented for shared boxes. (Server SKUs allow multiple sessions.)
- **Secure desktop out of scope:** owner confirmed autologon-level is enough — no requirement to
  drive the login screen / UAC secure desktop. (A future SYSTEM-service tier could add it; not now.)

## 7. Error handling

- **RDP unreachable / auth failure:** clear MCP error distinguishing *port closed* (offer/auto
  enable), *auth rejected* (bad creds / NLA), and *handshake/codec* failures.
- **Frame staleness:** if `lastFrameAgeMs` exceeds a threshold, `screenshot` reports a stale/repairing
  state rather than returning a misleading old frame; triggers a reconnect.
- **Sidecar crash:** MCP server detects exit, restarts the sidecar, re-establishes the session.
- **UIA accelerator failure:** degrade to vision-only with a clear notice; never leave residue on the
  target (guaranteed cleanup).
- **Input bounds:** pointer coordinates validated against current negotiated resolution.

## 8. Testing & validation

- **Sidecar unit/contract tests:** IPC command/response shapes; reconnect/backoff state machine
  (mocked transport).
- **Live validation against SGRAHAM-MINI (the exact box that failed today):**
  1. `connect` (auto-enable RDP if needed) → RDP session `Active`.
  2. `screenshot` returns a real frame **while no human is connected** (the case that failed today).
  3. `click` / `type_text` / `drag` land correctly (open Start, type, drag a window).
  4. Force a disconnect → confirm auto-reconnect and that `screenshot` recovers.
  5. Reboot the box → confirm reconnect to a fresh session.
  6. Opt-in UIA accelerator returns a tree, then confirm **no residue** remains on the target.
- **Repro harness:** extend `scripts/live-validate.mjs` to drive the RDP plane end-to-end.
- **PS parse-check** for the (now smaller) SSH-pushed UIA script in CI (lesson from the prior
  helper.ps1 latent parse bug).

## 9. Out of scope (YAGNI)

- Driving the secure/login desktop (UAC, lock screen) — explicitly deferred.
- Virtual display drivers / dummy plugs — obviated by RDP's virtual display.
- macOS *target* visual control — RDP plane is Windows-target only; the SSH plane keeps its existing
  macOS support. (A VNC/ARD client plane for Mac targets is a possible future mirror.)
- Audio/clipboard/drive redirection, multi-monitor capture — later if needed.

## 10. Open questions to resolve during planning

- IronRDP API surface for headless framebuffer extraction + input injection (confirm exact crates:
  `ironrdp-session`, `ironrdp-graphics`, `ironrdp-pdu`, connector) and the simplest sidecar shape.
- IPC transport choice (stdio length-prefixed JSON vs UDS) and frame transfer encoding (raw vs PNG;
  push-latest vs pull-on-demand).
- Default negotiated resolution / DPI and how `screenshot` reports it.
