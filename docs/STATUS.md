# STATUS — resume here

**Last updated:** 2026-05-31
**For a fresh Claude session:** read this file first, then
[`docs/architecture/implemented-architecture.md`](architecture/implemented-architecture.md), then the
`src/` and `windows/` code. This file is the single source of truth for *where we are*.

---

## One-line state

**✅ UNIVERSAL VISUAL LAYER COMPLETED + TIA OPENNESS ACCELERATOR ADDED (2026-05-31).** Reframed
the product around its real purpose: **drive ANY Windows program purely visually** — TIA Portal is
the motivating app, never a coupling. Two changes shipped this round (validated on SGRAHAM-MINI,
pushed to `main`):

1. **Universal visual core — `drag` added (helper v0.3.0).** The visual layer had no drag (mouse
   input was click-only), blocking drag-drop / sliders / marquee-select / reordering on arbitrary
   GUIs. Added `MouseDown`/`MouseUp` + an interpolated `drag` op to `windows/helper.ps1`, `vDrag`/
   `vMouseDown`/`vMouseUp` in `src/visual.ts`, and `drag`/`mouse_down`/`mouse_up` MCP tools. **29
   tools** now. Validated live: helper restarted to v0.3.0, `ping`→0.3.0, `drag` returned ok, fresh
   screenshot captured (888x555).
2. **OPTIONAL TIA Openness accelerator.** `windows/tia-openness.ps1` (a JSON-dispatch PowerShell
   that loads `Siemens.Engineering.dll` via registry + AssemblyResolve, PS5.1-safe reflection for
   generic `GetService<T>`) + `src/tia.ts` bridge + 9 `tia_*` MCP tools (status / open_project /
   list_devices|blocks|tags / export_block / import_block / compile / **download [gated]**). It is
   NOT a dependency — purely a fast-path for TIA. `tia_download` is gated (confirm:true + station,
   human-approved, live push deferred to Phase-3 on the real box). Validated on the Mini:
   `tia_status` → `{"ok":true,"openness_found":false,"in_openness_group":false}` (parses on PS5.1,
   degrades gracefully where no TIA exists).

**Design + plan:** `docs/superpowers/specs/2026-05-31-remote-tia-control-design.md` (universal-visual
-first; Openness as optional accelerator) and the working notebook `docs/tia-recipes.md` (visual
recipes + a **capability map to fill during Phase 0** on the production TIA box).

**Targeting needs no code change:** `connect` already re-points host/user/identity at runtime, so the
baked-in env (SGRAHAM-MINI) is just a default — call `connect({host,user,identityFile})` to drive the
production TIA engineering PC when it's onboarded. The MCP server is also now registered at **user
scope**, so its tools load in any session (not just the project dir).

**▶ NEXT (Phase 0, on the production TIA box):** onboard it (`claude-control-setup`), add the operator
to the `Siemens TIA Openness` group, run `tia_status` + a real `tia_open_project`/`tia_list_blocks`,
resolve the cross-session-attach question, and fill in `docs/tia-recipes.md`'s capability map. Then
Phase 2 (GUI recipes) + Phase 3 (orchestration + gated live download).

### Prior state — SECOND TARGET LIVE, SGRAHAM-MINI (2026-05-31)

**✅ SECOND TARGET LIVE — SGRAHAM-MINI (2026-05-31).** Provisioned + deployed + screenshotted the
owner's Mini (`<winuser>@<tailscale-ip>`, Windows 11 build 26200, helper v0.2.0, 1408x881). MCP server
registered with that target baked in, so a fresh Claude session loads `connect/screenshot/...`
ready to go. Two **setup-tooling** bugs that made the Windows paste fail were fixed in the process
(`scripts/setup.mjs cmdProvisionCmd`):
- **Private-repo 404.** `provision-cmd` (non-`--inline`) fetched `provision.ps1` from
  `raw.githubusercontent.com`, which **404s for a private repo**. Fixed: `provision-cmd` is now
  always self-contained (script embedded in a here-string) — no fetch, no private-repo dependency.
- **PowerShell-paste mangling.** The generated command used `$k='...'` inside a
  `powershell -Command "..."` wrapper (cmd syntax). Pasted into the *elevated PowerShell* the
  instructions tell the user to open, the outer shell expands `$k` (empty) first → `=ssh-ed25519…`
  error. Fixed: drop the wrapper and the variable — run the scriptblock directly and pass the key
  as a single-quoted literal to `-PubKey`. Paste-safe in an interactive PowerShell now.

**New onboarding path for future boxes (2026-05-31):** `node scripts/setup.mjs make-installer`
writes ONE self-contained `dist/claude-control-install.ps1` (key + provision/helper/bootstrap
embedded as base64). Drop it on a target, right-click → Run with PowerShell (self-elevates), and it
does the entire Windows side, then prints + saves the `username`/IP. Most foolproof option when the
operator can copy a file (immune to the interactive-paste quoting traps). `provision-cmd` is the
paste-only fallback. Installer AST-parses clean on PS 5.1 + embeds round-trip byte-exact.

Remaining friction toward fully-unattended one-click: the helper only binds with an interactive
logon, so a reboot with nobody logged in leaves `screenshot` unreachable until login. `setup.mjs
autologon` (run by the owner, password never touches the Mac) closes that gap.

**✅ FIRST LIVE RUN SUCCEEDED (2026-05-31).** The full visual loop is validated end-to-end against
**THE-PC** (Windows 11 Pro, build 26200) over the Tailscale tailnet: connect → bootstrap →
helper ping → **screenshot** → **ui_tree** (53 elements) → **keyboard input** (pressed Win, Start
menu opened) → screenshot. Proof screenshots saved to `/tmp/cc-shot-{1,2}.png` during the run and
sent to the owner. Two real bugs were found and fixed in the process (see below).

### First-live-run record (2026-05-31)

- **Target:** `WINUSER@HOST` (THE-PC), identity `~/.ssh/claude-control_ed25519`,
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
- **Repro harness:** `scripts/live-validate.mjs HOST <user> <identityFile> [helperPort]` drives the
  *shipped* functions (not the MCP layer) through the whole loop. Re-run it any time to re-validate.

### Validated as a real MCP server too (2026-05-31)

- Registered with `claude mcp add claude-control --env CLAUDE_CONTROL_HOST=HOST --env
  CLAUDE_CONTROL_USER=WINUSER --env CLAUDE_CONTROL_IDENTITY=$HOME/.ssh/claude-control_ed25519 -- node
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
THE-PC to finish enabling OpenSSH. (Resolved 2026-05-31 — see above.)

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

- **THE-PC** — owner's Windows test PC, in the your Tailscale tailnet.
  - Tailscale IP (preferred, works anywhere): **`HOST`**
  - LAN: **`THE-PC.local`** = `LAN_IP`
- Owner has pasted the OpenSSH-enable + key-authorize script; it was still installing at last check
  (port 22 closed). The owner will open a terminal when it finishes.

## ⛳ NEXT STEP — exactly what to do when SSH comes up

**Blocking input still needed from the owner:** the **Windows username** the paste printed
(`username: <…>`). You need it to `ssh <user>@host`. Set `WINUSER` below to it.

1. **Confirm SSH is up:**
   ```bash
   (exec 3<>/dev/tcp/HOST/22) 2>/dev/null && echo OPEN || echo "not yet"
   ```
2. **Smoke the connection** (raw ssh = same path the MCP server uses under the hood):
   ```bash
   ssh -i ~/.ssh/claude-control_ed25519 -o StrictHostKeyChecking=accept-new \
     <WINUSER>@HOST 'powershell -NoProfile -Command "$env:COMPUTERNAME; [Environment]::OSVersion.VersionString"'
   ```
3. **Build (if fresh checkout):** `cd ~/Projects/Claude-Control && npm install && npm run build`
4. **Attach to Claude Code:**
   ```bash
   claude mcp add claude-control \
     --env CLAUDE_CONTROL_HOST=HOST \
     --env CLAUDE_CONTROL_USER=<WINUSER> \
     --env CLAUDE_CONTROL_IDENTITY=$HOME/.ssh/claude-control_ed25519 \
     -- node ~/Projects/Claude-Control/build/index.js
   ```
5. **Bring up visual control:** call the `bootstrap` tool (or run, over ssh:
   `powershell -ExecutionPolicy Bypass -File C:/ProgramData/ClaudeControl/bootstrap.ps1 -HelperPort 8765`
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
