# Implemented architecture (and why it changed)

*2026-05-30. This supersedes the implementation approach in the original
[design spec](../superpowers/specs/2026-05-30-claude-control-design.md). The original goals are
unchanged; the **mechanism** is simpler and more OS-native.*

## The pivot

The first design embedded **IronRDP** (a Rust RDP client) and a compiled Windows agent. After the
owner asked for something that (a) **works best as a Claude Code tool**, (b) **uses as much
OS-preinstalled capability as possible**, and (c) is **downloadable and attachable to anyone's local
Claude Code**, the better design became clear:

> **Don't implement RDP. Drive Windows over SSH with PowerShell, and ship as an MCP server.**

Windows already ships everything needed to *see and control* the desktop:

| Need | OS-preinstalled mechanism |
|---|---|
| Transport | **OpenSSH Server** (Windows Feature-on-Demand) + the **`ssh`/`scp`** already on macOS |
| Run commands / files | **PowerShell** + SFTP |
| Screen capture | **.NET `System.Drawing`** (`Graphics.CopyFromScreen`) |
| Mouse / keyboard | **Win32 `SendInput`** via PowerShell `Add-Type` |
| Semantic UI tree | **.NET `System.Windows.Automation`** (UI Automation) |

So the controller needs no RDP stack, and the target needs **nothing installed** — the "agent" is a
PowerShell script (`windows/helper.ps1`) that the tool pushes and runs.

## What ships

- **`claude-control-mcp`** — a Node/TypeScript **MCP server** (stdio). Attaches to Claude Code with
  `claude mcp add`. Source in `src/`.
- **`windows/helper.ps1`** — the interactive-session helper: a loopback JSON server doing
  screenshot / input / UI Automation with preinstalled .NET. Started by a **logon Scheduled Task**.
- **`windows/bootstrap.ps1`** — registers/starts the helper task (and optionally enables RDP for a
  human to watch); `-Uninstall` removes everything.

## Channels, by cost

1. **SSH + PowerShell (headless)** — `run`, `upload`, `download`. Works in any SSH session
   (session 0). Most automation never needs the GUI.
2. **Visual helper** — `screenshot`, `click`, `move`, `scroll`, `type_text`, `press_keys`. Must run
   in the **interactive desktop session** (session-0 processes can't see the screen), so the helper
   is launched by a logon task and reached over the SSH connection via a loopback relay.
3. **UI Automation** — `ui_tree`, `ui_find`. The semantic element map; coordinates are returned in
   the same space as `screenshot`, so they feed straight into `click`.

## Key technical decisions

- **No Node-side SSH library or tunnel daemon.** Every helper call is a short `ssh` exec of a tiny
  PowerShell relay that connects to `127.0.0.1:<helperPort>`. SSH **ControlMaster** multiplexing
  keeps repeated calls fast. Result: no persistent tunnel process to manage, helper port never
  exposed.
- **`powershell -EncodedCommand`** (UTF-16LE base64) for all remote PowerShell — eliminates quoting
  bugs across the ssh boundary.
- **Per-monitor-DPI-aware helper** (`SetProcessDpiAwarenessContext`) so capture, UI Automation
  `BoundingRectangle`, and `SetCursorPos` all share one physical-pixel coordinate space.
- **Auth is OS ssh keys only.** No passwords are sent or stored; a dedicated key
  (`~/.ssh/claude-control_ed25519`) is authorized once on the target.

## What carried over from the original design

The **goals**, the **tri-channel idea** (headless / visual / semantic), the **session-0 insight**
(helper must run in the interactive session via a logon task), and the **security posture**
(loopback-only helper, explicit one-time bootstrap, clean uninstall). The
[research briefs](../research/) on Windows SSH, UI Automation, and OCR remain directly relevant; the
IronRDP and Rust-distribution briefs are now historical context.
