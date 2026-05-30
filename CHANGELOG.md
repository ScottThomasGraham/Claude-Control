# Changelog

All notable changes to this project are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this project will adopt
[Semantic Versioning](https://semver.org/) once it ships releases.

## [Unreleased]

### Added
- **Cross-platform targets:** `connect` takes an `os` (`windows`/`macos`); `run` uses PowerShell on
  Windows and `/bin/sh` on macOS. macOS supports run/upload/download + `screenshot` (via
  `screencapture`); input and AX-tree return a clear notice pending validation on a Mac target.
- **Windows GUI-driving tools** for heavy apps (TIA Portal, Studio 5000): `list_windows`,
  `focus_window` (by title), and `wait_idle` (block until the screen stops changing — e.g. after a
  compile/download). Backed by new helper ops (EnumWindows / SetForegroundWindow / frame-hash idle).

## [0.1.0] — 2026-05-30

First working implementation, shipped as an **MCP server** for Claude Code.

### Added
- `claude-control-mcp` MCP server (Node/TypeScript) with 14 tools: `connect`, `status`, `run`,
  `upload`, `download`, `screenshot`, `click`, `move`, `scroll`, `type_text`, `press_keys`,
  `ui_tree`, `ui_find`, `bootstrap`.
- SSH transport that shells out to the OS `ssh`/`scp` with ControlMaster multiplexing; all remote
  PowerShell via `-EncodedCommand`.
- Windows side using only preinstalled tools: `windows/helper.ps1` (interactive-session loopback
  server doing screen capture, `SendInput`, and UI Automation; per-monitor DPI-aware) and
  `windows/bootstrap.ps1` (registers/starts the helper as a logon Scheduled Task, optional RDP
  enable, `-Uninstall`).
- Offline tool-registration smoke test (`npm run smoke`).

### Changed
- **Architecture pivot:** replaced the planned IronRDP + compiled-Rust-agent approach with SSH +
  PowerShell + an MCP server — no RDP stack, nothing installed on the target. See
  `docs/architecture/implemented-architecture.md`.

### Design history
- Original tri-channel spec, 5 sourced research briefs (IronRDP, Windows SSH, UIA agent,
  distribution, OCR), and a 5-phase roadmap + Phase 1 plan are retained under `docs/`.
