# Setup & Deployment

How to roll Claude-Control out to a Windows target — for yourself, a coworker, or a friend.
The model is simple: **one command on your Mac, one paste on the Windows machine, then Claude
finishes the rest.**

- [Prerequisites](#prerequisites)
- [The fast path](#the-fast-path)
- [What the one paste does](#what-the-one-paste-does)
- [Command reference](#command-reference)
- [Bulletproof reboots (autologon)](#bulletproof-reboots-autologon)
- [Troubleshooting](#troubleshooting)
- [Uninstall](#uninstall)

## Prerequisites

**Your Mac** (the controller): macOS with the built-in `ssh`/`scp`, [Node.js](https://nodejs.org) ≥ 20,
and [Claude Code](https://claude.com/claude-code). Run `node scripts/setup.mjs doctor` to check.

**The Windows target**: Windows 10/11, and the ability to run one **elevated** PowerShell command on
it once. The target must be reachable from your Mac — same LAN, or a mesh VPN like
[Tailscale](https://tailscale.com) (recommended; a `100.x.y.z` address works from anywhere).

Nothing is compiled or permanently installed on the target beyond Microsoft's own OpenSSH; the visual
helper is a PowerShell script run from a logon task.

## The fast path

```bash
git clone https://github.com/ScottThomasGraham/Claude-Control.git
cd Claude-Control && npm install && npm run build
node scripts/setup.mjs
```

`setup.mjs` (no arguments) generates a dedicated SSH key if needed and prints **one command**. Paste
it into an elevated PowerShell on the Windows machine. It prints a `username` and IP — then finish:

```bash
node scripts/setup.mjs register --host <ip> --user <name>
node scripts/setup.mjs deploy   --host <ip> --user <name>   # add --autologon for bulletproof reboots
```

Prefer to be walked through it conversationally? Open this repo in a Claude Code session and run the
bundled command **`/claude-control-setup`** — Claude runs each step, hands you the paste, and shows a
proof screenshot at the end.

## What the one paste does

The pasted command runs [`windows/provision.ps1`](../windows/provision.ps1) with your public key. It
is idempotent and does only what's needed to let the controller in:

1. Installs the OpenSSH **server** capability and starts `sshd` (Automatic).
2. Adds an inbound TCP/22 firewall rule on **all profiles** (the default rule is often Private-only,
   which silently blocks a Tailscale/VPN interface).
3. Sets PowerShell as the default SSH shell.
4. Authorizes your key in `administrators_authorized_keys` with the correct ACLs.
5. Prints the `username`, computer name, and IPs to read back.

## Command reference

`node scripts/setup.mjs <command>`

| Command | What it does |
|---|---|
| *(none)* | Guided: preflight → key → print the Windows paste → next steps. |
| `doctor [--host H --user U]` | Preflight the Mac side; with a host, also checks port 22, SSH login, and the helper. |
| `keygen` | Create `~/.ssh/claude-control_ed25519` if absent (never overwrites). |
| `provision-cmd [--inline]` | Print the Windows paste (your key injected). `--inline` emits a self-contained block for targets with no internet. |
| `register --host H --user U [--identity P] [--helper-port N]` | Attach the MCP server to Claude Code with the right environment. |
| `deploy --host H --user U [--identity P] [--autologon]` | Connect → push helper → bootstrap (reserved port 8765, restart-on-failure, idle-lock off) → optional autologon → save a proof screenshot. |
| `autologon --host H --user U` | Enable autologon only (prompts for the Windows password). |

## Bulletproof reboots (autologon)

The visual helper runs in the interactive desktop session, so it only starts once someone is logged
in. Enable **autologon** and a reboot auto-logs-in the user → the helper restarts → Claude regains
full control with zero manual steps (validated across two reboots installing TIA Portal V21).

```bash
node scripts/setup.mjs autologon --host <ip> --user <name>
```

You'll be prompted for the Windows password. It is handed to **Sysinternals Autologon**, which stores
it as an **encrypted LSA secret** on the target — never in plaintext, never on your Mac, never in this
repo. Run this step yourself (don't paste your password into a chat).

## Troubleshooting

Run `node scripts/setup.mjs doctor --host <ip> --user <name>` first — it pinpoints most issues.

| Symptom | Cause / fix |
|---|---|
| `port 22 NOT reachable` (but host pings) | Firewall rule is Private-only. Re-run the paste (it adds an all-profiles rule). Verify with `nc -vz <host> 22` — **don't** trust bash `/dev/tcp`, which gives false negatives. |
| SSH login fails | Key not authorized (re-run the paste **elevated**), or wrong username. |
| `visual helper not bound` but `run` works | No interactive logon on the target. Log in, or enable `--autologon`. |
| Helper bound before a reboot, broken after | Fixed by design — the helper uses reserved port **8765** (below the ephemeral range Windows/WinNAT grabs after reboot). |
| Screenshots fail with "handle is invalid" | The console session is locked/disconnected (often after RDP'ing in then disconnecting). Reconnect, or set up with idle-lock disabled (`bootstrap -DisableIdleLock`, on by default in `deploy`). |
| A GUI app won't appear when launched | Launch it via keystrokes (`press_keys "Win"`, type its name, Enter) — a command run over SSH starts in the invisible session 0, not the desktop. |

## Uninstall

On the target, from an elevated PowerShell:

```powershell
powershell -ExecutionPolicy Bypass -File C:\ProgramData\ClaudeControl\bootstrap.ps1 -Uninstall
```

This removes the helper task, files, and the port reservation. SSH and the firewall rule remain (you
provisioned those deliberately) — remove them by hand if desired.
