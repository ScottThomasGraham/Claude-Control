/**
 * OS-aware visual backend.
 *
 *  - Windows: the interactive-session helper (windows/helper.ps1) over the SSH
 *    loopback relay.
 *  - macOS: native preinstalled tools (`screencapture`) over SSH.
 *
 * Visual control on either OS requires a one-time permission grant on the target
 * (Windows: the logon helper task via `bootstrap`; macOS: Screen Recording +
 * Accessibility in System Settings for the process that runs over SSH).
 */
import { config } from "./config.js";
import { helperCall, runRemote } from "./ssh.js";

export interface Shot {
  png: string;
  width?: number;
  height?: number;
}

function macOnlyNotice(op: string): never {
  throw new Error(
    `'${op}' on a macOS target is not enabled in this build yet (it needs validation against a real ` +
      `Mac target + Accessibility permission). Windows is fully supported; macOS currently supports ` +
      `run/upload/download and screenshot. Tell me when a Mac target is ready and I'll finish + verify input/UI-tree.`,
  );
}

async function macScreenshot(): Promise<Shot> {
  // Capture the main display, read its pixel dimensions, return base64 PNG.
  const script = [
    'set -e',
    'f="$(mktemp /tmp/cc.XXXXXX)"; f="$f.png"',
    'if ! screencapture -x -t png "$f" 2>/tmp/cc.err; then printf "CAPTURE_FAIL:%s" "$(cat /tmp/cc.err)"; exit 0; fi',
    'w="$(sips -g pixelWidth "$f" | sed -n "s/.*pixelWidth: //p")"',
    'h="$(sips -g pixelHeight "$f" | sed -n "s/.*pixelHeight: //p")"',
    'b="$(base64 < "$f")"',
    'rm -f "$f"',
    'printf "%s\\t%s\\t%s" "$w" "$h" "$b"',
  ].join("\n");
  const r = await runRemote(script, { timeoutMs: 30_000 });
  const out = r.stdout.trim();
  if (out.startsWith("CAPTURE_FAIL") || r.code !== 0) {
    throw new Error(
      `macOS screenshot failed — grant Screen Recording permission to the SSH login process ` +
        `(System Settings → Privacy & Security → Screen Recording). Detail: ${out || r.stderr}`,
    );
  }
  const tab = out.indexOf("\t");
  const tab2 = out.indexOf("\t", tab + 1);
  return {
    width: Number(out.slice(0, tab)),
    height: Number(out.slice(tab + 1, tab2)),
    png: out.slice(tab2 + 1),
  };
}

export async function vScreenshot(): Promise<Shot> {
  if (config.os === "macos") return macScreenshot();
  const r = await helperCall({ op: "screenshot" }, { timeoutMs: 30_000 });
  if (!r?.png) throw new Error("Windows helper returned no image (run `bootstrap`).");
  return { png: r.png, width: r.width, height: r.height };
}

export async function vMove(x: number, y: number): Promise<void> {
  if (config.os === "macos") macOnlyNotice("move");
  await helperCall({ op: "move", x, y });
}

export async function vClick(x: number, y: number, button: string, double: boolean): Promise<void> {
  if (config.os === "macos") macOnlyNotice("click");
  await helperCall({ op: "click", x, y, button, double });
}

export async function vScroll(amount: number): Promise<void> {
  if (config.os === "macos") macOnlyNotice("scroll");
  await helperCall({ op: "scroll", amount });
}

export async function vDrag(
  x1: number, y1: number, x2: number, y2: number, button: string, steps?: number,
): Promise<void> {
  if (config.os === "macos") macOnlyNotice("drag");
  await helperCall({ op: "drag", x1, y1, x2, y2, button, steps }, { timeoutMs: 30_000 });
}

export async function vMouseDown(x: number, y: number, button: string): Promise<void> {
  if (config.os === "macos") macOnlyNotice("mouse_down");
  await helperCall({ op: "mouse_down", x, y, button });
}

export async function vMouseUp(x: number, y: number, button: string): Promise<void> {
  if (config.os === "macos") macOnlyNotice("mouse_up");
  await helperCall({ op: "mouse_up", x, y, button });
}

export async function vType(text: string): Promise<void> {
  if (config.os === "macos") macOnlyNotice("type_text");
  await helperCall({ op: "type", text }, { timeoutMs: 30_000 });
}

export async function vKeys(chord: string): Promise<void> {
  if (config.os === "macos") macOnlyNotice("press_keys");
  await helperCall({ op: "keys", chord });
}

export async function vUiTree(maxElements: number): Promise<unknown> {
  if (config.os === "macos") macOnlyNotice("ui_tree");
  const r = await helperCall({ op: "uia_tree", maxElements }, { timeoutMs: 30_000 });
  return r.elements ?? r;
}

export async function vUiFind(text: string): Promise<unknown> {
  if (config.os === "macos") macOnlyNotice("ui_find");
  const r = await helperCall({ op: "uia_find", text }, { timeoutMs: 30_000 });
  return r.matches ?? r;
}

// ---- Windows-only GUI driving (for heavy apps like TIA Portal / Studio 5000) ----

export async function vListWindows(): Promise<unknown> {
  if (config.os === "macos") macOnlyNotice("list_windows");
  const r = await helperCall({ op: "list_windows" }, { timeoutMs: 20_000 });
  return r.windows ?? r;
}

export async function vFocusWindow(title: string): Promise<boolean> {
  if (config.os === "macos") macOnlyNotice("focus_window");
  const r = await helperCall({ op: "focus_window", title }, { timeoutMs: 20_000 });
  return !!r.found;
}

export async function vWaitIdle(timeoutMs: number, settleMs: number): Promise<boolean> {
  if (config.os === "macos") macOnlyNotice("wait_idle");
  const r = await helperCall({ op: "wait_idle", timeoutMs, settleMs }, { timeoutMs: timeoutMs + 10_000 });
  return !!r.idle;
}
