# STATUS — resume here

**Last updated:** 2026-05-30
**For a fresh Claude session:** read this file first, then
[`docs/architecture/implemented-architecture.md`](architecture/implemented-architecture.md), then the
`src/` and `windows/` code. This file is the single source of truth for *where we are*.

---

## One-line state

The tool is **built, working, and pushed**. We are **one step from the first live run**: waiting for
**SGRAHAM-MINI** to finish enabling OpenSSH, then connecting and validating end-to-end. The owner
has already pasted the enable-SSH script on the Mini.

## What this project is (so you don't re-derive it)

Claude-Control is an **MCP server** (Node/TypeScript) that lets Claude Code drive a **remote Windows
(or macOS) computer over SSH using only OS-preinstalled tools** — OpenSSH + PowerShell + .NET on
Windows; `ssh`/`scp` on the Mac. The motivating use case: operating **GUI software that can't be
automated** (Siemens **TIA Portal**, Rockwell **Studio 5000**) — so the visual + UI-Automation path
matters most. **Nothing is installed on the target**; the "visual helper" is a PowerShell script
(`windows/helper.ps1`) pushed and run via a logon Scheduled Task so it lives in the interactive
desktop session.

> Note: an earlier design (IronRDP + a compiled Rust agent) was **superseded**. Ignore the Rust/RDP
> approach in `docs/superpowers/specs/` except as history. The shipped design is SSH + PowerShell +
> MCP — see `docs/architecture/implemented-architecture.md`.

## Done ✅

- Repo created + pushed (private): `github.com/ScottThomasGraham/Claude-Control`. Local checkout:
  `~/Projects/Claude-Control`.
- MCP server built — **17 tools**, compiles clean, `npm run smoke` green:
  `connect, status, run, upload, download, screenshot, click, move, scroll, type_text, press_keys,
  ui_tree, ui_find, list_windows, focus_window, wait_idle, bootstrap`.
- Windows side: `windows/helper.ps1` (loopback JSON server: screen capture, SendInput,
  UI Automation, window list/focus, wait-idle; per-monitor DPI-aware) and `windows/bootstrap.ps1`
  (registers/starts the helper as a logon Scheduled Task; `-EnableRdp`; `-Uninstall`).
- macOS targets: `run`/`upload`/`download`/`screenshot` implemented; input + AX-tree return a clear
  "pending Mac-target validation" notice.
- Dedicated SSH key generated on the Mac: **`~/.ssh/claude-control_ed25519`** (+ `.pub`). The public
  key was authorized on the Mini by the owner.

## The target

- **SGRAHAM-MINI** — owner's Windows test PC, in the `<winuser>g@` Tailscale tailnet.
  - Tailscale IP (preferred, works anywhere): **`<tailscale-ip>`**
  - LAN: **`SGRAHAM-MINI.local`** = `<lan-ip>`
- Owner has pasted the OpenSSH-enable + key-authorize script; it was still installing at last check
  (port 22 closed). The owner will open a terminal when it finishes.

## ⛳ NEXT STEP — exactly what to do when SSH comes up

**Blocking input still needed from the owner:** the **Windows username** the paste printed
(`username: <…>`). You need it to `ssh <user>@host`. Set `WINUSER` below to it.

1. **Confirm SSH is up:**
   ```bash
   (exec 3<>/dev/tcp/<tailscale-ip>/22) 2>/dev/null && echo OPEN || echo "not yet"
   ```
2. **Smoke the connection** (raw ssh = same path the MCP server uses under the hood):
   ```bash
   ssh -i ~/.ssh/claude-control_ed25519 -o StrictHostKeyChecking=accept-new \
     <WINUSER>@<tailscale-ip> 'powershell -NoProfile -Command "$env:COMPUTERNAME; [Environment]::OSVersion.VersionString"'
   ```
3. **Build (if fresh checkout):** `cd ~/Projects/Claude-Control && npm install && npm run build`
4. **Attach to Claude Code:**
   ```bash
   claude mcp add claude-control \
     --env CLAUDE_CONTROL_HOST=<tailscale-ip> \
     --env CLAUDE_CONTROL_USER=<WINUSER> \
     --env CLAUDE_CONTROL_IDENTITY=$HOME/.ssh/claude-control_ed25519 \
     -- node ~/Projects/Claude-Control/build/index.js
   ```
5. **Bring up visual control:** call the `bootstrap` tool (or run, over ssh:
   `powershell -ExecutionPolicy Bypass -File C:/ProgramData/ClaudeControl/bootstrap.ps1 -HelperPort 49705`
   after `scp`-ing `windows/*.ps1` to `C:/ProgramData/ClaudeControl/`). The MCP `bootstrap` tool does
   all of this automatically.
6. **Validate the loop:** `status` (helper reachable?) → `screenshot` → `ui_tree` → `click` →
   `screenshot`. Send the owner a screenshot of the Mini as proof.
7. **Caveat to watch:** the helper only binds its loopback port when an interactive user is logged in
   on the Mini (Scheduled-Task-in-session). If `screenshot` says the helper is unreachable but `run`
   works, the box likely has no interactive logon — have the owner log in (or enable autologon).

## If validating a macOS target instead

`connect` with `os: "macos"`; `run`/`upload`/`download`/`screenshot` work (screenshot needs Screen
Recording permission granted to the SSH login process). Input + AX-tree are stubbed pending
validation — implementing them is the next macOS task.
