---
name: claude-control-setup
description: Set up / deploy Claude-Control to control a remote Windows PC. Use when the user wants to install, set up, deploy, onboard a machine, or roll out Claude-Control — turns a fresh clone into a working, controllable target with one Windows paste.
---

# Claude-Control — guided setup

Drive a coworker/friend from a fresh clone to a fully controllable Windows target with the
fewest possible steps: **one paste on the Windows box, then everything else automated.**

All mechanics live in `scripts/setup.mjs` (dependency-free). You provide the conversation:
read values back, show the proof screenshot, keep it friendly. Run commands from the repo root.

## Steps (do them in order)

1. **Preflight.** Run `node scripts/setup.mjs doctor`. If it reports "not built", run
   `npm install && npm run build`, then re-run doctor. Don't proceed until the Mac side is green.

2. **Make the key** (idempotent): `node scripts/setup.mjs keygen`.

3. **Hand off the Windows paste.** Run `node scripts/setup.mjs provision-cmd` and show the user the
   printed one-liner verbatim. Tell them:
   > Open an **elevated** PowerShell (Run as administrator) on the Windows machine you want to
   > control, paste this, and run it. When it finishes it prints a `username:` and an IP — tell me
   > both. (If that box has no internet, say so and I'll give you a self-contained version.)

   If they say the target has no internet, run `node scripts/setup.mjs provision-cmd --inline` and
   give them that block instead.

4. **Collect the target.** Ask for the **host/IP** and **username** the paste printed. Prefer a
   Tailscale `100.x.y.z` address if they have one (works from anywhere). This is the only "login"
   info you need.

5. **Register + deploy.** Run:
   - `node scripts/setup.mjs register --host <ip> --user <name>`
   - `node scripts/setup.mjs deploy --host <ip> --user <name>`

   `deploy` connects, pushes the helper, bootstraps it (reserved port 8765, restart-on-failure,
   idle-lock off), and saves a proof screenshot to `/tmp/claude-control-proof.png`. **Read that PNG
   and show it to the user** as confirmation the loop works.

   If `deploy` reports the SSH connect failed, run
   `node scripts/setup.mjs doctor --host <ip> --user <name>` and relay the specific remediation
   (usually: the paste wasn't run elevated, or the firewall rule didn't apply).

6. **Offer bulletproof reboots (autologon).** Ask if they want the target to auto-recover after
   reboots (recommended for unattended use). If yes, **have the USER run it themselves** so their
   password never passes through you:
   > Run this in your terminal — it'll prompt for the Windows password (hidden) and store it as an
   > encrypted LSA secret on the target, never on this Mac:
   > `node scripts/setup.mjs autologon --host <ip> --user <name>`

   Do **not** ask the user to paste their Windows password into the chat, and do not type it via a
   tool. Autologon is the one step the operator runs directly.

7. **Done.** Confirm the target is controllable. Mention they can now ask you things like
   "take a screenshot of the PC" or "open Notepad and type a note" in a session where the MCP server
   is attached (a fresh Claude Code session, since the server was just registered).

## Easiest path: one self-contained file (when the user can drop a file on the target)

If the operator can copy a file onto the Windows box (RDP clipboard, share, USB) rather than paste a
command, prefer this — it's the most foolproof: no console quoting, no internet, no private-repo
fetch. It does the WHOLE Windows side (provision + install helper + bootstrap) from one file.

1. `node scripts/setup.mjs make-installer` → writes `dist/claude-control-install.ps1` (the operator's
   public key + all three Windows scripts embedded as base64).
2. Tell the user: copy that file to the target, then **right-click → Run with PowerShell** (it
   self-elevates), or run `powershell -NoProfile -ExecutionPolicy Bypass -File .\claude-control-install.ps1`
   in an elevated prompt. It prints **and** saves (`C:\ProgramData\ClaudeControl\claude-control-ready.txt`)
   the `username` + IP.
3. Collect the username + IP, then finish on the Mac with `register` + `deploy` (steps 5–6 above).

The pasted-command path (`provision-cmd`) remains the fallback when the user can only paste text.

## Notes / guardrails

- The Windows installer/paste is the single irreducible manual step (it's the security boundary that
  lets SSH in — you can't enable it remotely on a box you can't reach yet). Everything after it's automated.
- Never write the user's Windows password to any file, the repo, or chat. SSH auth is key-only.
- If a target is shared with you already provisioned, you can skip to step 5.
- Full reference: `docs/SETUP.md`.
