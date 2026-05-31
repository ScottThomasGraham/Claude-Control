/**
 * Live end-to-end validation against a real target, driving the SHIPPED code
 * (the same functions the MCP tools call). Not part of the package — a manual
 * resume/validation harness. Usage:
 *   node scripts/live-validate.mjs <host> <user> <identityFile> [helperPort]
 */
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { writeFileSync } from "node:fs";
import { config, setTarget } from "../build/config.js";
import { sshExec, runPowerShell, scpUpload, helperCall } from "../build/ssh.js";
import { vScreenshot, vUiTree, vKeys } from "../build/visual.js";

const [host, user, identityFile, helperPort = "49705"] = process.argv.slice(2);
const WINDOWS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "windows");
const REMOTE_DIR = "C:/ProgramData/ClaudeControl";
const log = (m) => console.log(`\n=== ${m} ===`);

setTarget({ host, user, os: "windows", identityFile, helperPort: Number(helperPort) });

// 1) probe
log("1. SSH probe");
let r = await sshExec(`powershell -NoProfile -Command "Write-Output $env:COMPUTERNAME"`, { timeoutMs: 20000 });
console.log("computer:", r.stdout.trim(), "| exit", r.code);

// 2) bootstrap: mkdir, push scripts, run bootstrap.ps1
log("2. Bootstrap (mkdir + scp helper/bootstrap + register logon task)");
r = await runPowerShell(`New-Item -ItemType Directory -Force -Path '${REMOTE_DIR}' | Out-Null; '${REMOTE_DIR}'`);
console.log("mkdir exit", r.code, r.stdout.trim());
for (const f of ["helper.ps1", "bootstrap.ps1"]) {
  const up = await scpUpload(join(WINDOWS_DIR, f), `${REMOTE_DIR}/${f}`);
  console.log(`scp ${f} -> exit`, up.code, up.stderr.trim());
}
r = await sshExec(
  `powershell -NoProfile -ExecutionPolicy Bypass -File ${REMOTE_DIR}/bootstrap.ps1 -HelperPort ${helperPort}`,
  { timeoutMs: 90000 },
);
console.log("bootstrap.ps1 exit", r.code);
console.log(r.stdout.trim());
if (r.stderr.trim()) console.log("stderr:", r.stderr.trim());

// 3) helper ping (status)
log("3. Helper ping");
try {
  const pong = await helperCall({ op: "ping" }, { timeoutMs: 12000 });
  console.log("ping:", JSON.stringify(pong));
} catch (e) {
  console.log("ping FAILED:", e.message);
}

// 4) screenshot (baseline)
log("4. Screenshot (baseline)");
try {
  const shot = await vScreenshot();
  const path = "/tmp/cc-shot-1.png";
  writeFileSync(path, Buffer.from(shot.png, "base64"));
  console.log(`saved ${path}  ${shot.width}x${shot.height}  (${Math.round(shot.png.length * 0.75 / 1024)} KB)`);
} catch (e) {
  console.log("screenshot FAILED:", e.message);
  process.exit(1);
}

// 5) ui_tree
log("5. UI Automation tree (first 15 elements)");
try {
  const els = await vUiTree(60);
  const arr = Array.isArray(els) ? els : [];
  console.log(`got ${arr.length} elements; sample:`);
  for (const e of arr.slice(0, 15)) console.log("  -", JSON.stringify(e));
} catch (e) {
  console.log("ui_tree FAILED:", e.message);
}

// 6) keyboard input (non-destructive: open Start, screenshot, close)
log("6. Input test: press Win, screenshot, press Esc");
try {
  await vKeys("Win");
  await new Promise((s) => setTimeout(s, 1200));
  const shot2 = await vScreenshot();
  writeFileSync("/tmp/cc-shot-2.png", Buffer.from(shot2.png, "base64"));
  console.log("saved /tmp/cc-shot-2.png after Win press", `${shot2.width}x${shot2.height}`);
  await vKeys("Escape");
  console.log("pressed Escape to close Start");
} catch (e) {
  console.log("input test FAILED:", e.message);
}

log("DONE");
