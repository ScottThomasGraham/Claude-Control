<h1 align="center">Claude-Control</h1>

<p align="center"><em>Give Claude Code hands on a remote Windows PC — over SSH, using only what Windows already ships.</em></p>

---

> ### ✅ Status: working & validated end-to-end (2026-05-31)
> 17-tool MCP server, validated on a live Windows 11 Pro target over Tailscale — connect → bootstrap →
> screenshot → read the UI tree → click → type, plus driving a real GUI app (opened Word and typed a
> document). See **[Quick start](#quick-start-fresh-machine)** below to set it up from scratch, and
> [`docs/STATUS.md`](docs/STATUS.md) for the full build/validation history. macOS targets support
> run/upload/download/screenshot today; input + AX-tree are pending a Mac target.

---

## Overview

This is the desktop-control counterpart to **Claude-Browser**. Where Claude-Browser lets an AI drive
a web browser, **Claude-Control lets Claude Code fully operate a remote computer** — run commands,
see the screen, click, type, and read the on-screen UI — like sitting at the machine.

It's built for the hard case: **GUI software that can't be scripted** — e.g. Siemens **TIA Portal**
or Rockwell **Studio 5000**. There's no API to call, so you operate the interface: screenshot to
see, the UI Automation tree for a semantic map of those dense engineering windows, and click/type to
work. Targets can be **Windows** (full visual + UI Automation) or **macOS** (run/files + screenshot
today; input/AX-tree landing once validated on a Mac target).

It ships as an **MCP server**, so it attaches to *anyone's* local Claude Code in one line. And it
leans entirely on **OS-preinstalled tools**: the `ssh`/`scp` already on your Mac, and **OpenSSH +
PowerShell + .NET** already on Windows. **Nothing is compiled or installed on the target** — no agent
binary, no drivers, no RDP stack to maintain. The "agent" that sees and clicks is a PowerShell script
that uses Windows' own screen-capture, input, and UI Automation APIs.

The design principle: **use the cheapest channel that does the job.**

- **Headless (SSH + PowerShell):** run commands, move files, manage the box — instant, scriptable, no
  GUI needed. This is most of the work.
- **Visual (the helper):** when a task needs eyes and clicks, a tiny PowerShell helper running in the
  desktop session returns **screenshots** and performs **mouse/keyboard** input.
- **Semantic (UI Automation):** instead of guessing from pixels, ask Windows for the **element tree**
  — every control's type, name, and click-ready coordinates.

---

## How it works

```
   Your Mac (Claude Code)                          Windows PC (the target)
 ┌─────────────────────────┐      SSH (OpenSSH)   ┌────────────────────────────────┐
 │  claude-control (MCP)   │───── powershell ─────▶│  PowerShell + .NET             │
 │   • run / upload / ...  │      scp files        │   • commands, files            │
 │   • screenshot / click  │                       │                                │
 │   • type / press_keys   │   helper (loopback,   │  helper.ps1 (logon task,       │
 │   • ui_tree / ui_find   │◀── relayed over SSH ──│   interactive session):        │
 │                         │                       │   screen capture · SendInput · │
 └─────────────────────────┘                       │   UI Automation tree           │
                                                    └────────────────────────────────┘
```

Authentication is your **OS ssh keys** — no password is ever sent or stored. The helper binds
**loopback only** and is reached *through* the SSH connection, so nothing new is exposed on the
network.

---

## Quick start (fresh machine)

New here — or a fresh Claude Code session with nothing set up? Do these in order. Steps 1–3 are on
**your Mac**; step 4 is the one manual step on the **Windows target**; steps 5–6 are back on the Mac
(Claude Code can do them for you).

1. **Clone & build** (needs Node ≥ 20, and the `ssh`/`scp` that ship with macOS):
   ```bash
   git clone https://github.com/ScottThomasGraham/Claude-Control.git
   cd Claude-Control && npm install && npm run build && npm run smoke   # smoke should print "SMOKE OK"
   ```
2. **Make a dedicated SSH key** for this (keeps it separate from your other keys):
   ```bash
   ssh-keygen -t ed25519 -f ~/.ssh/claude-control_ed25519 -C "claude-control" -N ""
   cat ~/.ssh/claude-control_ed25519.pub   # copy this — you paste it on Windows in step 3
   ```
3. **One-time Windows setup** — run the elevated-PowerShell block in [Install → step 3](#install)
   on the target (enables OpenSSH, authorizes your key, opens the firewall on **all** profiles).
   Note the username it prints at the end; you need it. The target must be reachable from your Mac —
   same LAN, or a VPN/mesh like [Tailscale](https://tailscale.com) (recommended; works anywhere).
4. **Sanity-check the connection** from the Mac (this is the exact path the server uses):
   ```bash
   ssh -i ~/.ssh/claude-control_ed25519 <win-user>@<host> 'powershell -NoProfile -Command "$env:COMPUTERNAME"'
   ```
   > If this times out but the host pings, it's almost always the firewall — see
   > [Gotchas](#gotchas-hard-won-lessons). `nc -vz <host> 22` tells you if port 22 is really open;
   > don't trust bash's `/dev/tcp`, which can report false negatives.
5. **Attach to Claude Code** (see [Install → step 2](#install)), then in a Claude Code session say:
   *"connect to `<host>` as `<win-user>` with identity `~/.ssh/claude-control_ed25519`, then bootstrap."*
   The `connect` tool verifies SSH; `bootstrap` installs the visual helper into your desktop session.
6. **Try it:** *"take a screenshot."* If it returns an image, you're done. To watch live while Claude
   drives, RDP into the **same** Windows user/session and leave the window connected.

A brand-new Claude Code working from this repo has everything it needs: the steps above, the
[Tools](#tools) table, and [Gotchas](#gotchas-hard-won-lessons). For project history and the
validation record, see [`docs/STATUS.md`](docs/STATUS.md).

---

## Install

**1. Build (or install) the server.**

```bash
git clone https://github.com/ScottThomasGraham/Claude-Control.git
cd Claude-Control && npm install && npm run build
```

**2. Attach it to Claude Code.**

```bash
claude mcp add claude-control -- node /absolute/path/to/Claude-Control/build/index.js
# (once published to npm:  claude mcp add claude-control -- npx -y claude-control-mcp )
```

Optionally pre-set a default target so Claude can connect immediately:

```bash
claude mcp add claude-control \
  --env CLAUDE_CONTROL_HOST=sgraham-mini \
  --env CLAUDE_CONTROL_USER=<windows-user> \
  --env CLAUDE_CONTROL_IDENTITY=$HOME/.ssh/claude-control_ed25519 \
  -- node /absolute/path/to/Claude-Control/build/index.js
```

**3. One-time setup on the Windows PC** (the only manual step — it's the security boundary that lets
the tool in). In an **elevated PowerShell** on the target, enable OpenSSH and authorize your key:

```powershell
# Enable OpenSSH Server
Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0
Set-Service sshd -StartupType Automatic; Start-Service sshd
# Allow inbound 22 on ALL profiles. The capability's own rule is sometimes scoped to
# "Private" only, which silently blocks a Tailscale/Public interface — so add an explicit one.
New-NetFirewallRule -Name sshd-allprofiles -DisplayName 'OpenSSH Server (all profiles)' -Enabled True -Direction Inbound -Protocol TCP -Action Allow -LocalPort 22 -Profile Any
# Default shell = PowerShell
New-ItemProperty -Path "HKLM:\SOFTWARE\OpenSSH" -Name DefaultShell -Value "C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe" -PropertyType String -Force | Out-Null
# Authorize your Claude-Control public key (admin accounts use this shared file)
$pub = '<PASTE YOUR ~/.ssh/claude-control_ed25519.pub HERE>'
$f = "$env:ProgramData\ssh\administrators_authorized_keys"
Add-Content -Path $f -Value $pub
icacls.exe $f /inheritance:r /grant "Administrators:F" /grant "SYSTEM:F" | Out-Null
"username: $env:USERNAME"
```

Then, from Claude Code, ask it to **`bootstrap`** the host once — that installs the visual helper
(screenshot/click/UIA) into your desktop session. After that, everything is automatic.

---

## Tools

| Tool | What it does |
|---|---|
| `connect` | Set the active host + OS (`windows`/`macos`) + verify SSH (keys only). |
| `status` | Show the target and whether the visual helper is live. |
| `run` | Run a command (PowerShell on Windows, sh on macOS); returns stdout/stderr/exit. |
| `upload` / `download` | Copy files via scp. |
| `screenshot` | PNG of the live desktop (returned as an image). |
| `click` / `move` / `scroll` | Mouse control at pixel coordinates. |
| `type_text` / `press_keys` | Keyboard: text and chords (`Ctrl+S`, `Alt+Tab`, `Win+R`). |
| `ui_tree` / `ui_find` | UI Automation elements with click-ready coordinates. |
| `list_windows` / `focus_window` | Orient and switch between windows in big multi-window apps. |
| `wait_idle` | Block until the screen stops changing — e.g. after a TIA compile/download. |
| `bootstrap` | Install the interactive-session helper (logon task), reserve its port, restart-on-failure; flags: `-EnableRdp`, `-DisableIdleLock`, `-Uninstall`. |

Coordinates are consistent everywhere: `ui_tree` centers feed straight into `click`. The visual,
`ui_*`, and window tools are Windows-first; on macOS, `run`/`upload`/`download`/`screenshot` work
today and the rest return a clear notice until validated on a Mac target.

---

## Gotchas (hard-won lessons)

Things that bit us on the first real run — worth knowing up front:

- **Port 22 closed even though the host pings?** Windows often scopes the OpenSSH firewall rule to
  the **Private** profile, while a Tailscale/VPN adapter gets classified **Public** — so SSH is
  silently blocked. Add an all-profiles rule: `New-NetFirewallRule -Name sshd-allprofiles -Enabled
  True -Direction Inbound -Protocol TCP -Action Allow -LocalPort 22 -Profile Any`. Also: bash's
  `/dev/tcp` can report a false "closed" — verify with `nc -vz <host> 22` or a real `ssh`.
- **Launch GUI apps with keystrokes, not `Start-Process`.** A command run over SSH executes in
  **session 0** (the service session), so `Start-Process winword` opens Word *invisibly* there, not
  on the desktop. To open an app where the helper can see it, drive the desktop: `press_keys "Win"`,
  `type_text "Word"`, `press_keys "Enter"` (or use `Win+R` and type the path). Same root cause as
  why the helper must run as a logon task, not a service.
- **Helper only binds while someone is logged in.** The helper lives in the interactive desktop
  session (logon Scheduled Task). If `screenshot` says the helper is unreachable but `run` works,
  no one is logged in — log in (or enable autologon). A **disconnected** RDP session keeps the
  helper alive; **logging off** kills it.
- **Watching live = RDP to the same user/session.** Reconnect as the same Windows user and you land
  in the very session Claude drives. Keep the window connected; if the desktop isn't being rendered
  anywhere, captures can go stale/black. Expect to share the cursor — take turns.
- **Screen size follows the RDP client.** Screenshot dimensions track whatever the RDP session is
  currently sized to. That's fine — `ui_tree`/`ui_find` coordinates are always in the same space as
  the matching screenshot, so clicks land correctly. (Also: RDP'ing in and **disconnecting** leaves
  the console session **locked** — captures fail with "handle is invalid" until you reconnect or
  reboot. `bootstrap -DisableIdleLock` reduces this.)
- **Helper port is a low static port (8765), reserved persistently.** After a reboot, Windows/WinNAT
  reserve chunks of the ephemeral range (49152–65535), so a high helper port (e.g. 49705) can fail to
  bind with `WSAEACCES` ("socket access forbidden"). `bootstrap` defaults to **8765** and reserves it
  via `netsh ... add excludedportrange`, so reboots don't break it.
- **For unattended / bulletproof reboots, enable autologon.** The helper only starts at *logon*. With
  autologon on, a reboot auto-logs-in the user → the helper's logon task restarts → control returns
  with zero manual steps (validated end-to-end installing TIA Portal across two reboots). Use
  Sysinternals **Autologon** (stores the password as an encrypted LSA secret — never plaintext in the
  registry). `bootstrap` also sets restart-on-failure on the helper task.

---

## Security

OS ssh keys only — no passwords sent or stored · helper binds loopback and is reached through SSH ·
the helper runs at the user's privilege level; only `bootstrap` needs admin · `bootstrap -Uninstall`
removes the task, helper, and files cleanly · the target runs only Microsoft-shipped code.

---

## Project docs

Design history and the original (pre-pivot) Rust/RDP exploration live under
[`docs/`](docs/) — see [`docs/architecture/implemented-architecture.md`](docs/architecture/implemented-architecture.md)
for why the shipped design is SSH + PowerShell rather than a hand-rolled RDP client, and
[`docs/research/`](docs/research/) for the sourced feasibility research that informed it.

## License

Dual-licensed under [Apache-2.0](LICENSE-APACHE) or [MIT](LICENSE-MIT), at your option.
