# TIA Portal recipes + Phase-0 capability map

This is the working notebook for driving **TIA Portal**. Read the design first:
[`docs/superpowers/specs/2026-05-31-remote-tia-control-design.md`](superpowers/specs/2026-05-31-remote-tia-control-design.md).

**Principle:** the universal **visual** tools drive TIA like any other program. **Openness** (`tia_*`)
is an optional fast-path. Prefer Openness where it's proven; fall back to visual everywhere else.

## Choosing a path (the orchestration rule)

1. If the operation has a proven `tia_*` tool (see the map below) → use it.
2. Otherwise drive it visually: `focus_window "TIA Portal"` → `screenshot` → prefer `ui_find`/`ui_tree`
   to locate controls by name → `click`/`type_text`/`drag` → `wait_idle` after long actions
   (compile/download/load) → `screenshot` to confirm.

## Capability map — FILL DURING PHASE 0 (on the production TIA box)

Run each probe against a live TIA + real project, then mark the verdict. Until verified, treat
Openness rows as **unconfirmed** and use the visual path.

| Operation | Openness probe | Verdict (API / GUI / mixed) | Notes |
|---|---|---|---|
| Detect Openness + version | `tia_status` | _TBD_ | Also confirms group membership |
| Attach to running TIA | `tia_status` → running_count | _TBD_ | **Key unknown:** can an SSH/session-0 process attach to the GUI's TIA? |
| Open project | `tia_open_project {path}` | _TBD_ | |
| List devices / PLCs | `tia_list_devices` | _TBD_ | |
| List blocks | `tia_list_blocks {plc}` | _TBD_ | |
| List tags | `tia_list_tags {plc}` | _TBD_ | |
| Export block | `tia_export_block {block,file}` | _TBD_ | Fetch with `download` |
| Import block | `tia_import_block {file}` | _TBD_ | `upload` the XML first |
| Compile | `tia_compile {plc}` | _TBD_ | |
| Download to PLC | `tia_download` (gated) | _TBD_ | **Hardware.** Live path wired only after Phase-3 sign-off |
| Edit ladder/SCL/FBD logic | — | _likely GUI_ | Custom editor canvases; expect pixels + `ui_tree` |
| HMI screen design | — | _likely GUI_ | Drag-drop on canvas → use `drag` |

### Cross-session attach (resolve first)

Openness attaches to a running `TiaPortal` process. The open question is whether a **non-interactive
SSH session** can attach to the instance running in the operator's **interactive desktop**. Phase-0
test: with TIA open on the desktop, run `tia_status` over SSH and check `running_count`/`attach_error`.
If attach fails cross-session, options are (a) launch TIA *via* Openness in the same session the script
runs in, or (b) drive TIA purely visually (always available). Record the outcome here.

## Visual recipes (Layer B)

> Filled in as we validate against TIA. Coordinates are never hard-coded — always re-locate with
> `screenshot` + `ui_find`/`ui_tree`, because TIA's layout shifts with window size and version.

### First-run Openness security dialog
The first time Openness attaches, TIA may show a one-time "An external application wants to access…"
confirmation. Handle visually: `focus_window "TIA Portal"` → `ui_find "Yes"` (or the localized
equivalent) → `click`. After accepting once, subsequent attaches are silent.

### Compile + read result (visual fallback)
`focus_window "TIA Portal"` → `ui_find "Compile"` / right-click the PLC in the project tree → `click`
→ `wait_idle` → `screenshot` (read the Inspector → Info → Compile tab for errors/warnings).

### HMI screen — place an object (drag-drop)
`screenshot` to find the toolbox item and target location → `drag {x1,y1 (toolbox item) → x2,y2
(canvas)}` → `screenshot` to confirm placement → adjust with `drag` on the placed object's handles.

_(Add concrete, verified recipes here as Phase 0/2 progress.)_
</content>
