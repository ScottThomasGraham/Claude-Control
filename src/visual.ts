// src/visual.ts
/**
 * OS-aware visual backend.
 *  - Windows: the RDP plane (src/rdp.ts) — we are the RDP client, session is
 *    always live, zero target footprint.
 *  - macOS: native preinstalled tools (`screencapture`) over SSH; input/UI-tree
 *    remain stubbed pending a Mac target.
 */
import { config } from "./config.js";
import { runRemote } from "./ssh.js";
import {
  rdpFrame, rdpMove, rdpClick, rdpScroll, rdpDrag, rdpMouseDown, rdpMouseUp, rdpType, rdpChord,
} from "./rdp.js";

export interface Shot { png: string; width?: number; height?: number }

function macOnlyNotice(op: string): never {
  throw new Error(
    `'${op}' on a macOS target is not enabled in this build yet. Windows is fully supported via RDP; ` +
      `macOS currently supports run/upload/download and screenshot.`,
  );
}

async function macScreenshot(): Promise<Shot> {
  const script = [
    "set -e",
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
    throw new Error(`macOS screenshot failed (grant Screen Recording). Detail: ${out || r.stderr}`);
  }
  const tab = out.indexOf("\t");
  const tab2 = out.indexOf("\t", tab + 1);
  return { width: Number(out.slice(0, tab)), height: Number(out.slice(tab + 1, tab2)), png: out.slice(tab2 + 1) };
}

export async function vScreenshot(): Promise<Shot> {
  if (config.os === "macos") return macScreenshot();
  const f = await rdpFrame();
  return { png: f.png, width: f.width, height: f.height };
}

export async function vMove(x: number, y: number): Promise<void> {
  if (config.os === "macos") macOnlyNotice("move"); await rdpMove(x, y);
}
export async function vClick(x: number, y: number, button: string, double: boolean): Promise<void> {
  if (config.os === "macos") macOnlyNotice("click"); await rdpClick(x, y, button, double);
}
export async function vScroll(amount: number): Promise<void> {
  if (config.os === "macos") macOnlyNotice("scroll"); await rdpScroll(amount);
}
export async function vDrag(x1: number, y1: number, x2: number, y2: number, button: string, steps?: number): Promise<void> {
  if (config.os === "macos") macOnlyNotice("drag"); await rdpDrag(x1, y1, x2, y2, button, steps ?? 20);
}
export async function vMouseDown(x: number, y: number, button: string): Promise<void> {
  if (config.os === "macos") macOnlyNotice("mouse_down"); await rdpMouseDown(x, y, button);
}
export async function vMouseUp(x: number, y: number, button: string): Promise<void> {
  if (config.os === "macos") macOnlyNotice("mouse_up"); await rdpMouseUp(x, y, button);
}
export async function vType(text: string): Promise<void> {
  if (config.os === "macos") macOnlyNotice("type_text"); await rdpType(text);
}
export async function vKeys(chord: string): Promise<void> {
  if (config.os === "macos") macOnlyNotice("press_keys"); await rdpChord(chord);
}
