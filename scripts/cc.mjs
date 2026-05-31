/**
 * Tiny interactive driver for live demos — issues ONE op against the target and
 * prints/saves the result, using the shipped functions.
 *   node scripts/cc.mjs run "<powershell>"
 *   node scripts/cc.mjs shot [outPath]
 *   node scripts/cc.mjs find "<text>"
 *   node scripts/cc.mjs click <x> <y>
 *   node scripts/cc.mjs type "<text>"
 *   node scripts/cc.mjs keys "<chord>"
 *   node scripts/cc.mjs windows
 *   node scripts/cc.mjs focus "<title>"
 *   node scripts/cc.mjs waitidle [timeoutMs] [settleMs]
 * Target comes from env: CLAUDE_CONTROL_HOST and CLAUDE_CONTROL_USER are
 * required; CLAUDE_CONTROL_IDENTITY / CLAUDE_CONTROL_HELPER_PORT are optional.
 *   CLAUDE_CONTROL_HOST=1.2.3.4 CLAUDE_CONTROL_USER=me node scripts/cc.mjs shot
 */
import { writeFileSync } from "node:fs";
import { setTarget } from "../build/config.js";
import { runRemote } from "../build/ssh.js";
import {
  vScreenshot, vClick, vScroll, vType, vKeys, vUiFind, vListWindows, vFocusWindow, vWaitIdle,
} from "../build/visual.js";

if (!process.env.CLAUDE_CONTROL_HOST || !process.env.CLAUDE_CONTROL_USER) {
  console.error("Set CLAUDE_CONTROL_HOST and CLAUDE_CONTROL_USER (and optionally CLAUDE_CONTROL_IDENTITY).");
  process.exit(2);
}
setTarget({
  host: process.env.CLAUDE_CONTROL_HOST,
  user: process.env.CLAUDE_CONTROL_USER,
  os: "windows",
  identityFile: process.env.CLAUDE_CONTROL_IDENTITY ?? `${process.env.HOME}/.ssh/claude-control_ed25519`,
  helperPort: Number(process.env.CLAUDE_CONTROL_HELPER_PORT ?? 49705),
});

const [op, ...rest] = process.argv.slice(2);
const saveShot = async (path) => {
  const s = await vScreenshot();
  writeFileSync(path, Buffer.from(s.png, "base64"));
  console.log(`shot ${s.width}x${s.height} -> ${path}`);
};

switch (op) {
  case "run": {
    const r = await runRemote(rest.join(" "), { timeoutMs: 30000 });
    console.log(`exit ${r.code}\n${r.stdout.trim()}${r.stderr.trim() ? "\nERR: " + r.stderr.trim() : ""}`);
    break;
  }
  case "shot": await saveShot(rest[0] ?? "/tmp/cc.png"); break;
  case "find": console.log(JSON.stringify(await vUiFind(rest.join(" ")), null, 2)); break;
  case "click": await vClick(Number(rest[0]), Number(rest[1]), "left", false); console.log(`clicked ${rest[0]},${rest[1]}`); break;
  case "scroll": await vScroll(Number(rest[0])); console.log(`scrolled ${rest[0]}`); break;
  case "type": await vType(rest.join(" ")); console.log(`typed ${rest.join(" ").length} chars`); break;
  case "keys": await vKeys(rest.join(" ")); console.log(`pressed ${rest.join(" ")}`); break;
  case "windows": console.log(JSON.stringify(await vListWindows(), null, 2)); break;
  case "focus": console.log("focused:", await vFocusWindow(rest.join(" "))); break;
  case "waitidle": console.log("idle:", await vWaitIdle(Number(rest[0] ?? 60000), Number(rest[1] ?? 1500))); break;
  default: console.log("unknown op:", op);
}
