<h1 align="center">Claude-Control</h1>

<p align="center"><em>Give Claude Code hands on a remote Windows PC — over SSH, using only what Windows already ships.</em></p>

---

## Overview

This is the desktop-control counterpart to **Claude-Browser**. Where Claude-Browser lets an AI drive
a web browser, **Claude-Control lets Claude Code fully operate a remote Windows PC** — run commands,
see the screen, click, type, and read the on-screen UI — like sitting at the machine.

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
   Your Mac (Claude Code)                          Windows PC (e.g. SGRAHAM-MINI)
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
New-NetFirewallRule -Name sshd -DisplayName 'OpenSSH Server' -Enabled True -Direction Inbound -Protocol TCP -Action Allow -LocalPort 22 -ErrorAction SilentlyContinue
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
| `connect` | Set the active Windows host + verify SSH (keys only). |
| `status` | Show the target and whether the visual helper is live. |
| `run` | Run PowerShell; returns stdout/stderr/exit. |
| `upload` / `download` | Copy files via scp. |
| `screenshot` | PNG of the live desktop (returned as an image). |
| `click` / `move` / `scroll` | Mouse control at pixel coordinates. |
| `type_text` / `press_keys` | Keyboard: text and chords (`Ctrl+S`, `Alt+Tab`, `Win+R`). |
| `ui_tree` / `ui_find` | Windows UI Automation elements with click-ready coordinates. |
| `bootstrap` | Install the interactive-session helper (logon task) + optionally enable RDP. |

Coordinates are consistent everywhere: `ui_tree` centers feed straight into `click`.

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
