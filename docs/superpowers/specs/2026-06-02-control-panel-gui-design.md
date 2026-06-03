# Claude-Control — Control Panel & Credential GUI

**Date:** 2026-06-02
**Status:** Design approved (pending written-spec review)
**Branch (suggested):** `feat/control-panel-gui`

## Problem

Driving a remote target needs an RDP password, but the MCP server reads it only from
`CLAUDE_CONTROL_RDP_PASSWORD` in its **own process environment**, which is frozen at launch by
Claude Code. There is no way to supply the password to a running server, and no way to *see* what a
session is doing. Today this dead-ends `connect` with "RDP password not set" and the user has no
feedback on connection state. (This is exactly what blocked a live TIA Portal task on 2026-06-02.)

We want a small, robust desktop GUI that:
1. Lets the user enter the RDP password once, stored securely (never a plaintext file).
2. Shows live status of every active session — **Connected · Working · Idle · Stopped**.
3. Shows the most recent screen frame of each session.

## Key decisions (validated in brainstorming)

- **Architecture: thin GUI + per-session server** (NOT a shared persistent daemon). Each Claude Code
  session keeps spawning its own MCP server → its own `cc-rdp` sidecar → its own RDP session.
- **Multi-session is a first-class feature.** Two Claude Code windows can connect to two *different*
  targets simultaneously, fully isolated. The GUI is a roster of all live sessions, not a single
  connection view. (A shared daemon would have forced one session — the thin model is what enables
  concurrent targets, which is why it was chosen.)
- **Credentials live in the macOS Keychain**, keyed per target. The OS-encrypted Keychain is not a
  file, so this honors the project's never-store-passwords rule. The server looks the password up at
  **connect time** (not launch), so no Claude restart is ever needed after setup.
- **GUI form factor: standalone window app, native Swift/AppKit** — a self-contained `.app` bundle
  built with the system `swiftc` (no Tauri/npm/webview install), giving a real Dock icon and a
  list + detail window. (Brainstorming said "Tauri/Rust"; switched to Swift/AppKit because it builds
  reliably from the Command Line Tools already on this Mac and yields a true native `.app` + `.icns`.
  macOS-only, which matches where the controller runs.)
- **Window layout: A · List + detail** — left rail of live sessions and saved targets; right pane
  with the selected session's live preview, credential field, and controls.
- **App icon: B · Targeting cursor** — corner brackets framing a control cursor, matte monochrome
  with a single green live-status accent. A complete icon set is shipped (no blank/default icon).

## Architecture

```
Claude Code session #1 ──► MCP server #1 ──► cc-rdp sidecar #1 ──► RDP ─► target A
Claude Code session #2 ──► MCP server #2 ──► cc-rdp sidecar #2 ──► RDP ─► target B
                                  │  reads cred at connect time
                                  ▼
                          macOS Keychain  ◄──────────── writes creds
                                  ▲                          │
   each server writes status+frame                          │
                                  ▼                          │
   ~/Library/Application Support/claude-control/sessions/<id>/{status.json, frame.png}
                                  ▲                          │
                                  └──── watches ──── Control Panel GUI (Tauri window) ─┘
```

Two decoupled contracts tie the pieces together — the **Keychain credential scheme** and the
**session state directory**. Neither side calls the other directly; they communicate through these
two well-defined surfaces, so the GUI and the MCP server can be built, tested, and changed
independently.

## Components

### 1. Credential store — `src/creds.ts` (MCP server side)

Reads/writes the RDP password in the macOS Keychain via the `security` CLI, behind a small backend
interface so tests can substitute an in-memory store and non-macOS hosts can fall back to env-only.

- **Keychain scheme (the contract):** service = `claude-control-rdp`, account = `${user}@${host}`,
  password = the RDP password.
- `getPassword(host, user)` → `security find-generic-password -s claude-control-rdp -a <acct> -w`.
- `requireRdpPassword(host, user)` resolution order: **(1)** `CLAUDE_CONTROL_RDP_PASSWORD` env
  (explicit override, kept for CI / power users), **(2)** Keychain lookup for the target, **(3)**
  throw a clear error pointing the user at the GUI ("Open Claude-Control and set the password for
  `<host>`").
- `config.ts :: requireRdpPassword()` is updated to take `{host, user}` and delegate here.

### 2. Session state writer — `src/state.ts` (MCP server side)

Each MCP server instance owns a `sessionId` (`<pid>-<host>`), and a session directory under
`stateRoot = ~/Library/Application Support/claude-control` (XDG fallback elsewhere):
`sessions/<sessionId>/`.

- Writes `status.json` atomically (temp-file + rename):
  ```json
  {
    "sessionId": "48213-100.73.195.110",
    "host": "100.73.195.110", "user": "uksti", "label": "sgraham-mini",
    "state": "connecting|connected|working|idle|stopped|error",
    "since": 1780451000, "lastActivityAt": 1780451200,
    "lastFrameAt": 1780451201, "lastHeartbeatAt": 1780451205,
    "currentTool": "screenshot", "lastError": null
  }
  ```
- **State transitions:** `connect` → `connecting` → `connected`; every tool invocation flips
  `working` (with `currentTool`) then back to `idle` on completion; sidecar exit / disconnect →
  `stopped`; a thrown error sets `error` + `lastError`.
- **Heartbeat:** `lastHeartbeatAt` updated on a low-rate timer so the GUI can mark a session dead if
  the server crashed without cleanup.
- **Frame writer:** while connected, a ~1 fps timer pulls the current framebuffer from the sidecar
  (`src/rdp.ts` exposes a current-frame fetch — the sidecar already maintains the framebuffer) and
  writes `frame.png` atomically. This is local-only I/O — **no model tokens** (distinct from the
  no-token-polling rule, which is about Claude-driven polling).
- Cleanup of the session dir on graceful exit; the GUI prunes stale dirs on launch.

### 3. Control Panel GUI — `gui/` (native Swift/AppKit `.app`)

- **Sessions roster (Layout A):** polls `stateRoot/sessions/` (~1s timer; simple and robust), renders
  the left rail (`NSTableView` of live sessions grouped above saved-but-idle targets) and a detail
  pane for the selected session: large live preview (`NSImageView` reloading `frame.png`), target
  info, a password field (`NSSecureTextField`), and a Save button.
- **Status glyphs:** green = connected/working, amber = idle, grey = stopped, red = error; stale
  (heartbeat older than ~10s) renders grey with a "(no response)" note.
- **Credential management:** add / edit / remove saved targets. The Swift app writes to the **same
  Keychain scheme** as `creds.ts` by shelling out to `/usr/bin/security` (identical command surface,
  so node + GUI agree). The scheme is the shared contract — documented in both places.
- **Disconnect (optional, Phase 3):** writes a `command` file into the session dir that the MCP
  server watches; keeps the GUI view-only otherwise. Out of scope for Phase 1–2.
- **Icon B** wired as the bundle/Dock/window icon (`AppIcon.icns`).

### 4. Icon asset — `gui/`

Icon B (targeting brackets + control cursor, matte monochrome squircle + green accent) is drawn
programmatically with CoreGraphics by `gui/make-icon.swift` (no external SVG rasterizer needed):
it renders every required size into `AppIcon.iconset/`, then `iconutil -c icns` produces
`AppIcon.icns`, bundled into `Resources/`. There is **never** a blank/default icon.

## Keychain access & headless reads (gotcha)

A generic-password read by the `node` process can trigger a one-time Keychain authorization prompt
("security wants to use confidential information"). For an unattended server this must not block.
When the GUI writes the item it grants access so the server can read without prompting — preferred:
`security add-generic-password -T <node-binary> -T /usr/bin/security ...`; acceptable on a personal
machine: `-A` (allow all apps), documented as a tradeoff. This is captured so the implementation
plan handles it explicitly rather than discovering it live.

## Error handling

- **Keychain miss / no env:** `connect` throws a clear, actionable error naming the host and telling
  the user to set the password in the GUI.
- **Server died without cleanup:** stale `status.json` (heartbeat aged out) → GUI marks `stopped
  (no response)`; dirs pruned on next GUI launch.
- **Missing `frame.png`:** preview shows a placeholder, not an error.
- **No sessions dir yet:** GUI shows an empty state plus the saved-targets credential manager.

## Testing

- `creds.ts` — unit tests against the in-memory backend (transition + resolution-order logic);
  one opt-in integration test against a throwaway Keychain item, skipped in CI.
- `state.ts` — unit tests for state transitions and atomic writes to a temp `stateRoot`.
- GUI — a parser/watcher unit test that ingests sample `status.json` files; the visual app is
  validated manually.
- **End-to-end (the original goal):** connect to sgraham-mini, confirm the GUI shows `connected` +
  a live frame, then complete the blocked TIA Portal ProfiNet-name lookup.

## Phasing (detailed task breakdown deferred to the implementation plan)

- **Phase 1 — Unblock:** `creds.ts` + Keychain scheme + `requireRdpPassword({host,user})` rewrite +
  a minimal `claude-control creds set` CLI path. *This alone unblocks the live TIA task.*
- **Phase 2 — Visibility:** `src/state.ts` status + frame writer wired into the tool lifecycle; the
  Tauri window (Layout A) showing the live roster + preview; Keychain credential management in-GUI.
- **Phase 3 — Polish:** icon B asset pipeline + bundle wiring, stale-session pruning, optional
  GUI-initiated Disconnect.

## Out of scope (YAGNI)

- Driving the remote target *from* the GUI (it is view + credentials only; Disconnect is the lone
  optional control).
- Windows/Linux GUI parity (Tauri keeps the door open; not built now).
- The persistent shared-session daemon (explicitly rejected — kills concurrent multi-target).
