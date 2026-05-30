# Research notes

Sourced feasibility research captured during design (2026-05-30). Each brief synthesizes current web
sources (linked inline) into decisions for the [design spec](../superpowers/specs/2026-05-30-claude-control-design.md).

| Brief | Question | Headline finding |
|---|---|---|
| [IronRDP](2026-05-30-ironrdp.md) | What RDP engine? | Solid foundation: RGBA framebuffer, structured input, NLA/CredSSP, client-side DVC. MIT/Apache. Negotiate RemoteFX/bitmap; pre-1.0 API is the main risk. |
| [Windows SSH](2026-05-30-windows-ssh.md) | Fast headless channel? | OpenSSH Server FoD + `russh`. Key auth into admin account. **Session-0 isolation** means the UIA agent can't be a plain service. Either channel can enable the other. |
| [UIA agent](2026-05-30-uia-agent.md) | Semantic perception? | Rust + windows-rs, per-monitor DPI-aware; **Scheduled Task at-logon** to run in the interactive session; ship snapshots over **loopback TCP through the SSH tunnel**. |
| [Distribution](2026-05-30-distribution.md) | Reliable + distributable? | `cargo-dist`, macOS universal2 + Homebrew tap (notarized), Windows agent as bare signed exe. 3-crate workspace. MIT OR Apache-2.0. |
| [OCR/perception](2026-05-30-ocr-perception.md) | Pixels-only legend? | **Apple Vision** via `objc2-vision` (built-in, best accuracy) + `ocrs` fallback. Defer element detection to the LLM. |
