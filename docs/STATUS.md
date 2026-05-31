# STATUS — resume here

**Last updated:** 2026-05-31
**For a fresh Claude session:** read this file first, then
[`docs/architecture/implemented-architecture.md`](architecture/implemented-architecture.md), then the
`src/` and `windows/` code. This file is the single source of truth for *where we are*.

---

## One-line state

**✅ FIRST LIVE RUN SUCCEEDED (2026-05-31).** The full visual loop is validated end-to-end against
**SGRAHAM-MINI** (Windows 11 Pro, build 26200) over the Tailscale tailnet: connect → bootstrap →
helper ping → **screenshot** → **ui_tree** (53 elements) → **keyboard input** (pressed Win, Start
menu opened) → screenshot. Proof screenshots saved to `/tmp/cc-shot-{1,2}.png` during the run and
sent to the owner. Two real bugs were found and fixed in the process (see below).

### First-live-run record (2026-05-31)

- **Target:** `<winuser>@<tailscale-ip>` (SGRAHAM-MINI), identity `~/.ssh/claude-control_ed25519`,
  helper port 49705. Interactive session is **RDP** (session 2), not console.
- **Getting SSH up took three target-side fixes:** install the OpenSSH.Server capability + start
  `sshd`; then the inbound firewall rule was scoped to **Private** only while Windows classified one
  path as Public — fixed by adding an **all-profiles** (`-Profile Any`) allow rule. (`/dev/tcp` on
  the Mac falsely reported the port closed even once it was open — trust `nc`/`ssh`, not `/dev/tcp`.)
- **Bug 1 — `bootstrap.ps1` user resolution.** `Win32_ComputerSystem.UserName` is empty for an RDP
  (non-console) logon, and the fallback used `$env:USERDOMAIN` = **`WORKGROUP`**, which is not a real
  SID → `Register-ScheduledTask` failed ("No mapping between account names and security IDs"). Fixed:
  fall back to parsing `quser` for the active session, and **normalize to `COMPUTERNAME\user`**.
- **Bug 2 — `helper.ps1` parse error (latent).** Line ~210
  `type = $el.Current.ControlType.ProgrammaticName -replace '^ControlType\.',''` failed to parse in
  Windows PowerShell 5.1 (the `-replace 'pat',''` comma inside a hashtable literal cascaded into
  "hash literal incomplete"), so the whole script exited with code 1 and the helper never bound its
  port. Fixed by parenthesizing: `($... -replace '^ControlType\.', '')`. **`npm run smoke` never
  caught this** — it only checks the Node MCP tool registry, never parses the PowerShell. Consider
  adding a PS parse-check (`[Parser]::ParseFile`) to CI.
- **Repro harness:** `scripts/live-validate.mjs <host> <user> <identityFile> [helperPort]` drives the
  *shipped* functions (not the MCP layer) through the whole loop. Re-run it any time to re-validate.

### Validated as a real MCP server too (2026-05-31)

- Registered with `claude mcp add claude-control --env CLAUDE_CONTROL_HOST=<tailscale-ip> --env
  CLAUDE_CONTROL_USER=<winuser> --env CLAUDE_CONTROL_IDENTITY=$HOME/.ssh/claude-control_ed25519 -- node
  ~/Projects/Claude-Control/build/index.js` — `claude mcp list` reports **✓ Connected**.
- Drove the built server over stdio with the MCP SDK's own `Client` (`scripts/mcp-test.mjs`): all 17
  tools advertised; verified `connect`, `status` (helper v0.1.0 reachable), `run`, `screenshot`
  (image content block), `list_windows`, `ui_find` ("Recycle Bin" at 38,40), `press_keys`, and a
  bad-arg `click` returning a clean MCP `-32602` validation error (no crash).
- Fixed a cosmetic wart found here: PowerShell serialized its progress stream to stderr as CLIXML
  over SSH; `runPowerShell` now sets `$ProgressPreference='SilentlyContinue'`.

### Still open / next ideas

- macOS target validation (input + AX-tree) still pending a Mac target.
- Helper only binds when an interactive session exists — true here (RDP session stays active).
- Note: screen resolution is reported by whatever the RDP session is currently sized to (saw both
  1512x949 and 1008x623 across runs as the RDP window changed) — coordinates stay internally
  consistent with the matching screenshot, so clicks land correctly.

<details><summary>Historical state (pre-first-run, 2026-05-30)</summary>

The tool was built, working, and pushed; we were one step from the first live run, waiting for
SGRAHAM-MINI to finish enabling OpenSSH. (Resolved 2026-05-31 — see above.)

</details>

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
