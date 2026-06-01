# Remote TIA Portal control — Openness API + GUI hybrid

**Date:** 2026-05-31
**Status:** Approved, Phase 1 building.
**Owner:** Scott Graham.

## Foundational principle — universal visual control is the core

The product is a **general remote-GUI driver**: it must operate **any** Windows program, including
totally unsupported ones, **purely visually** (screenshot + mouse/keyboard + the UI-Automation tree).
This layer knows nothing about the app on screen and is the thing that must be rock-solid.

**TIA Openness is an *optional accelerator***, not a dependency — a fast-path for the one app that
happens to expose an API. If Openness is absent, broken, or the app is anything other than TIA, the
universal visual layer still drives it. TIA is the *motivating* app, never a coupling.

## Goal

1. **(Core)** Drive any Windows GUI purely visually — robustly enough for dense engineering software.
2. **(Accelerator)** Where the app is **TIA Portal** *and* Openness is available, offer a scriptable
   API fast-path for PLC/project work (`Siemens.Engineering.dll`) — with graceful fallback to visual.
3. **(Human)** Watched live by the operator over **native Microsoft RDP** (no app to build).

## Constraints (hard)

- **No Docker.** No third-party server components.
- **No new installs on the target.** Openness ships *with* TIA Portal — we only need the operator's
  Windows account added to the local **`Siemens TIA Openness`** group.
- **Minimal footprint** — reuse the existing SSH + interactive-session-helper channel.
- **Authentication stays SSH-key only** — no passwords stored or sent (unchanged).

## Why not the alternatives (recorded so we don't re-derive)

- **RDP-as-the-channel** (Claude reads the RDP framebuffer + injects input): would *lose* the
  UI-Automation tree — a real downgrade for precise work in a dense engineering GUI — and is a
  from-scratch rebuild of the previously-shelved agent. Rejected.
- **VNC / WinAppDriver:** both require installing a server on the target (violates minimal-footprint),
  and WinAppDriver is semi-abandoned by Microsoft. Rejected.
- **Pure GUI (no API):** works, but clicking a dense engineering GUI is fragile for operations Siemens
  exposes as a supported API. The API is strictly better where it reaches. Hence the hybrid.

## Architecture

Two control layers + an orchestration rule. Targeting needs **no code change** — the existing
`connect` tool already re-points host/user/identity at runtime (`src/config.ts:setTarget`), so the
baked-in env defaults (SGRAHAM-MINI) are just defaults; Claude calls `connect({host,user,identityFile})`
to drive the engineering PC.

### Layer A — Openness tools (new)

- **`windows/tia-openness.ps1`** — a single PowerShell dispatcher. Invoked as
  `tia-openness.ps1 -Op <name> -ArgsB64 <base64-json>`; emits exactly **one JSON line**
  (`{ ok: true, ... }` or `{ ok: false, error: ... }`) — same contract as the visual helper.
  - Resolves `Siemens.Engineering.dll` from the registry
    (`HKLM:\SOFTWARE\Siemens\Automation\Openness\<ver>`), registers an `AssemblyResolve` handler,
    and loads the assembly. Reports cleanly (`found:false`) when Openness is absent — so it is safe
    to call on a box without TIA (e.g. the Mini).
  - **PS 5.1 safety:** generic methods (`GetService<T>`) are called via reflection
    (`MakeGenericMethod`), since PS 5.1 lacks the `$x.GetService[T]()` syntax; `-replace` inside
    hashtable literals is parenthesized (lesson from the helper-parse bug).
- **`src/tia.ts`** — Node bridge. `tiaCall(op, args)` base64-encodes args, idempotently uploads the
  dispatcher to `C:/ProgramData/ClaudeControl/` once per process, runs it over SSH via
  `runPowerShell`, and parses the JSON line.
- **MCP tools** (in `src/server.ts`):
  - `tia_status` — Openness install + version, running TIA processes, open projects, group membership.
    *(The safe, Mini-testable entry point.)*
  - `tia_open_project` — attach to a running TIA (or start one) and open a `.ap*` project.
  - `tia_list_devices`, `tia_list_blocks`, `tia_list_tags` — read-only inventory.
  - `tia_export_block`, `tia_import_block` — XML round-trip of blocks.
  - `tia_compile` — compile a PLC's software; returns state + error/warning counts.
  - `tia_download` — **gated** (see Safety). Download to a PLC station.

### Layer B — GUI hybrid (existing, documented)

No new mechanism. `docs/tia-recipes.md` captures click/UIA recipes for the visual gaps the API
doesn't cover (HMI screen design, editor canvases, first-run Openness security dialog).

### Orchestration rule

Claude prefers Layer A when an operation is API-covered, falls back to Layer B otherwise — guided by
the **capability map** produced in Phase 0. The human watches over native RDP; because the helper runs
in the operator's logged-in session, RDP-ing in both lets the human watch *and* binds the helper.

## Safety

`tia_download` (and anything that writes to a live PLC) is **hard-to-reverse and touches real
hardware**. It:

- Requires an explicit `confirm: true` argument **and** an explicit `station` name — it never fires
  on defaults.
- Claude must get **human approval before each call** — it is never invoked autonomously.
- The dispatcher uses the **most conservative** download configuration: it does **not** auto-start the
  CPU (leaves modules as-is) unless an operation is explicitly told to.

## Phases

- **Phase 0 — Grounding spike** *(runs on the production TIA box, not the Mini).* Onboard the
  engineering PC (`claude-control-setup`); confirm TIA version + Openness DLL path + group membership;
  run `tia_status` and a real `tia_open_project`/`tia_list_blocks`; run `ui_tree` against a live TIA
  window. **Output:** fill in `docs/tia-recipes.md`'s capability map (op → API vs GUI). Validate the
  cross-session attach question (can an SSH/non-interactive session attach to the GUI's TIA instance?).
- **Phase 1 — Openness tool layer** *(this change).* Build the dispatcher + bridge + tools. Validate
  the **plumbing** on SGRAHAM-MINI: `connect` works, tools register, `tia_status` returns a clean
  "Openness not installed" result (TIA isn't on the Mini), the dispatcher parses on PS 5.1.
- **Phase 2 — GUI recipes.** Harden Layer B for the mapped gaps once Phase 0 reveals them.
- **Phase 3 — Orchestration + end-to-end.** Wire the prefer-API rule; validate a real flow
  (open → edit block → compile → [gated] download) mixing both layers, against the production box.

## Known unknowns (resolved in Phase 0, not guessed here)

- Exact Openness capability surface for the box's TIA version.
- The first-run TIA security-confirmation dialog (may need one Layer-B click the first time).
- Whether an SSH (non-interactive) session can attach to a TIA instance started in the interactive
  desktop, or whether the dispatcher must launch its own TiaPortal. The dispatcher attempts
  attach-to-running first and reports clearly if it can't.

## Testing

- **Offline:** `npm run smoke` asserts the new `tia_*` tools register.
- **PS parse:** invoking `tia-openness.ps1 -Op status` over SSH on the Mini exercises a full PS 5.1
  parse + the graceful "no Openness here" path.
- **Live:** deferred to Phase 0/3 on the production TIA server, per the owner's plan.
</content>
</invoke>
