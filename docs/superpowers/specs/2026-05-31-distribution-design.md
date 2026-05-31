# Claude-Control — Distribution & One-Command Setup (design)

**Date:** 2026-05-31
**Status:** approved, implementing
**Goal:** Make Claude-Control trivial to deploy for coworkers and a few public friends —
robust, polished, and the fewest possible steps. Target experience: **one command on the
Mac, one paste on the Windows target, then Claude finishes the rest** (connect → bootstrap →
optional autologon → proof screenshot).

## The one irreducible step

Claude-Control drives a *remote* Windows machine. You cannot remotely enable SSH on a box you
have no access to yet, so **one admin action on the target is unavoidable** — it is the security
boundary that lets the tool in. The design shrinks that to a single copy-paste of a generated,
key-injected one-liner. Everything else is automated.

## End-to-end flow (the deliverable UX)

On a fresh Mac (coworker or friend), from a clone of the public repo:

1. `git clone https://github.com/ScottThomasGraham/Claude-Control.git && cd Claude-Control`
2. In a Claude Code session: **`/claude-control-setup`** (or, without Claude: `node scripts/setup.mjs`).
3. Claude runs preflight + key generation + build, then **prints one elevated-PowerShell line** to
   paste on the Windows target.
4. User pastes it on the Windows box (the one admin action). It prints `username: <name>`.
5. User tells Claude the host/IP + username (the "one login" input); opts in/out of autologon.
6. Claude registers the MCP server, connects, bootstraps the helper (reserved port 8765,
   restart-on-failure, idle-lock off), optionally enables autologon, and shows a proof screenshot.

Net: **1 Mac command · 1 Windows paste · 1 short conversation.** Reboots are bulletproof when
autologon is enabled.

## Components

### 1. `windows/provision.ps1` (new)
Target-side enabler, parameter `-PubKey`. Idempotent. Steps:
- Install `OpenSSH.Server` capability if missing; set `sshd` Automatic + start it.
- Add an **all-profiles** inbound TCP/22 firewall rule (the Private-only default silently blocks
  Tailscale/Public interfaces).
- Set PowerShell as the default SSH shell.
- Authorize `-PubKey` into `%ProgramData%\ssh\administrators_authorized_keys` with correct ACLs
  (`icacls` inheritance off, grant Administrators + SYSTEM), de-duplicated.
- Print `username: $env:USERNAME`, computer name, and LAN IPs for the operator to read back.
Exits clearly on the one thing it can't self-fix (capability install needing a moment).

### 2. `scripts/setup.mjs` (new, dependency-free Node)
CLI with subcommands. No external deps (uses `node:*` + the OS `ssh`/`scp` + the built lib).
- `doctor` — preflight: node ≥ 20; `ssh`/`scp` present; `build/` present (offer to build); key
  present; if a host is configured, port reachability via real `ssh`/`nc` (never `/dev/tcp`,
  which gives false negatives); helper bound.
- `keygen` — create `~/.ssh/claude-control_ed25519` (+`.pub`) if absent. Never overwrites.
- `provision-cmd [--inline]` — print the Windows paste. Default form is a short one-liner that
  fetches `windows/provision.ps1` from the repo's raw URL and passes the injected pubkey;
  `--inline` emits a fully self-contained block (no target internet needed).
- `register --host --user [--identity] [--helper-port]` — runs `claude mcp add claude-control`
  with the right env so future Claude Code sessions have the tools.
- `deploy --host --user [--identity] [--autologon]` — uses the built library to: connect-check →
  `scp` helper/bootstrap → run bootstrap (port 8765 reserved, restart-on-failure,
  `-DisableIdleLock`) → optional autologon (Sysinternals, LSA secret) → save a proof screenshot to
  a file. Lets the script finish a target even without Claude driving.
- (no args) — guided: doctor → keygen → print provision-cmd + instructions.

### 3. `.claude/skills/claude-control-setup/` (new)
The `/claude-control-setup` slash-command. Conversational wrapper that calls `setup.mjs` for
mechanics and the MCP tools for the live drive: shows the paste, waits, collects host/username,
prompts for autologon (password typed by the user / read securely — never stored), connects,
bootstraps, and returns a screenshot as proof. Friendly enough for non-experts.

### 4. `scripts/cc.mjs` (exists) — kept as the live-drive helper for ad-hoc control.

### 5. Optional, later: npm publish
Publish `claude-control-mcp` so friends can `npx -y claude-control-mcp` for the MCP attach (and
`npx claude-control-mcp setup`). Not required for the clone-based flow; noted as polish.

## Robustness / error handling

- **`doctor`** is the safety net: it encodes every failure class we hit in practice (old node,
  missing ssh, unbuilt, missing key, port blocked by a Private-only firewall rule, helper not
  bound because no interactive logon, idle-lock blanking capture) and prints the remediation.
- **Idempotent** everywhere: re-running setup, `provision.ps1`, and `bootstrap.ps1` is safe.
- **All hard-won fixes baked in**: all-profiles firewall rule; helper on reserved low port 8765;
  restart-on-failure; control-char sanitizing in the helper; launch-GUI-via-keystroke documented;
  autologon via encrypted LSA secret; idle-lock disabled.
- **Secrets**: SSH is key-only. The autologon Windows password is read via a hidden prompt, passed
  straight to Sysinternals Autologon (stored as an encrypted LSA secret on the target), and **never
  written to disk, the repo, or logs**. The `.pub` key is the only credential the repo ever sees.
- Clear non-zero exit codes and actionable messages from `setup.mjs`.

## Testing / validation

- `node scripts/setup.mjs doctor` self-checks the Mac side.
- `provision-cmd --dry` prints without side effects; `--inline` validated by parse-checking the
  emitted block.
- End-to-end validated against the live target (SGRAHAM-MINI): `deploy` re-bootstraps cleanly and
  returns a screenshot; existing `live-validate.mjs` / `mcp-test.mjs` still pass.

## Documentation

- README gets a top-of-file **"Get started in 2 steps"** (clone + `/claude-control-setup`), with the
  existing detailed Install/Quick-start kept as a manual fallback, and the Gotchas retained.
- A short `docs/SETUP.md` walking the script subcommands and the autologon/idle-lock options.
- Tone: concise, professional, example-first.

## Out of scope (YAGNI)

Multi-host fleet registry, a GUI installer, WinRM/MDM provisioning paths, and npm publishing are
not built now (npm publish noted as optional follow-up).
