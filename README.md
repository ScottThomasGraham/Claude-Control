<h1 align="center">Claude-Control</h1>

<p align="center"><em>Full agentic control of a remote Windows desktop — over Microsoft's native protocols.</em></p>

---

## Overview

This is the desktop-control counterpart to **Claude-Browser**. Where Claude-Browser lets an AI drive
a web browser, **Claude-Control lets an AI fully operate a remote Windows PC** — like RDP/MSTSC, but
built so the agent itself can see the screen and click, type, and run commands, end to end.

The design rests on a simple idea: **use the cheapest channel that can do the job.**

- **SSH (fast path)** — run PowerShell, scripts, and file transfers headlessly. No pixels needed for
  most automation. This is also how the app **silently deploys its own helper agent**.
- **RDP (visual path)** — stream the live desktop and inject mouse/keyboard, exactly when a task
  needs eyes and clicks. Watch it in a live viewer and grab control yourself anytime.
- **UIA agent (semantic upgrade)** — a tiny helper the app **auto-pushes** to machines you own,
  exposing Windows' UI Automation tree so the agent gets a precise, clickable map of every on-screen
  control — the same superpower the browser's accessibility tree gives Claude-Browser.

The goal is a tool that is **reliable, distributable, and clean** — professional enough to install
with `brew install`, signed and notarized, with a one-step setup on a fresh PC and a spotless
uninstall.

> **Status:** Design + research phase. This repository currently holds the **specification, sourced
> feasibility research, and implementation plan** for review. No application code has been written
> yet — implementation begins after the design is approved.

---

## How it works (at a glance)

```
  macOS (your Mac)                                           Windows PC (yours or any host)
 ┌───────────────────────────┐        SSH 22         ┌──────────────────────────────┐
 │  ctl  (one Rust binary)   │──── commands · files ──▶│  OpenSSH ─ pushes/installs ──┐ │
 │   • SSH fast path (russh) │        RDP 3389        │                              ▼ │
 │   • RDP visual (IronRDP)  │──── screen · clicks ───▶│  Windows desktop      UIA agent│
 │   • OCR (Apple Vision)    │   loopback over SSH    │                       (logon    │
 │   • live web viewer       │◀─── UIA element map ───│                        task)    │
 └───────────────────────────┘                        └──────────────────────────────┘
```

One channel enabled by hand once on a fresh PC; `ctl bootstrap <host>` does everything else —
enables the other channel, provisions a key, and rolls out the helper agent.

---

## Repository map

| Path | What's there |
|---|---|
| [`docs/superpowers/specs/`](docs/superpowers/specs/) | **The design spec** — architecture, channels, security model, phases |
| [`docs/superpowers/plans/`](docs/superpowers/plans/) | **Implementation roadmap** + the detailed **Phase 1** plan |
| [`docs/research/`](docs/research/) | **Sourced feasibility research** (IronRDP, Windows SSH, UIA agent, distribution, OCR) |
| `crates/` | Rust workspace (`protocol`, `controller`, `agent`) — _created when implementation starts_ |

**Start here:** the [design spec](docs/superpowers/specs/2026-05-30-claude-control-design.md), then
the [roadmap](docs/superpowers/plans/2026-05-30-claude-control-roadmap.md).

---

## Planned tech stack

Rust (Tokio) · [IronRDP](https://github.com/Devolutions/IronRDP) (RDP) ·
[`russh`](https://github.com/Eugeny/russh) (SSH) · `objc2-vision` + [`ocrs`](https://github.com/robertknight/ocrs)
(OCR) · [`windows-rs`](https://github.com/microsoft/windows-rs) (UIA agent) ·
[`cargo-dist`](https://github.com/axodotdev/cargo-dist) (releases). Dual-licensed **MIT OR
Apache-2.0**.

---

## Security posture (by design)

Secrets never touch disk (env/Keychain only) · RDP over NLA/CredSSP+TLS · the helper agent binds
**loopback only**, reached through the SSH tunnel · explicit certificate trust · full audit log of
every command and input · agent rollout only to hosts you explicitly bootstrap · clean uninstall.
See the spec's [security & threat model](docs/superpowers/specs/2026-05-30-claude-control-design.md#8-security--threat-model).

---

## License

Licensed under either of [Apache License 2.0](LICENSE-APACHE) or [MIT license](LICENSE-MIT) at your
option.
