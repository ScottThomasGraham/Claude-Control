// src/uia.ts
/**
 * OPTIONAL UIA accelerator. Default OFF (vision-first). Enable with
 * CLAUDE_CONTROL_UIA=1. When on, runs windows/uia-accelerator.ps1 inside the
 * live RDP session via a one-shot Scheduled Task, reads the JSON, then removes
 * the task and the temp file — no persistent footprint.
 */
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { runPowerShell, scpUpload } from "./ssh.js";
import { requireTarget, config } from "./config.js";

const WINDOWS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "windows");
const REMOTE = "C:/Users/Public";
const OUT = `${REMOTE}/cc-uia.json`;
const SCRIPT = `${REMOTE}/cc-uia.ps1`;
const TASK = "CCUiaOneShot";

function enabled(): boolean { return process.env.CLAUDE_CONTROL_UIA === "1"; }
function offNotice(op: string): never {
  throw new Error(
    `${op} needs the optional UIA accelerator (off by default). Use \`screenshot\` + coordinates ` +
      `(vision-first), or set CLAUDE_CONTROL_UIA=1 to enable the accelerator.`,
  );
}

async function runWalk(find = "", maxElements = 200): Promise<any[]> {
  requireTarget();
  await scpUpload(join(WINDOWS_DIR, "uia-accelerator.ps1"), SCRIPT);
  const argLine = `-File ${SCRIPT} -Out ${OUT} -MaxElements ${maxElements}` + (find ? ` -Find '${find.replace(/'/g, "''")}'` : "");
  // Register a one-shot task running as the interactive user, run it now, wait, read, clean up.
  const ps = `
$ErrorActionPreference='Stop'
$u = (Get-CimInstance Win32_ComputerSystem).UserName
if (-not $u) { $u = (quser 2>$null | Select-Object -Skip 1 | ForEach-Object { ($_ -replace '^>?\\s*','').Split(' ')[0] } | Select-Object -First 1) ; if ($u) { $u = "$env:COMPUTERNAME\\$u" } }
Remove-Item '${OUT}' -ErrorAction SilentlyContinue
$a = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument '-NoProfile -ExecutionPolicy Bypass ${argLine}'
$p = New-ScheduledTaskPrincipal -UserId $u -LogonType Interactive -RunLevel Highest
Register-ScheduledTask -TaskName '${TASK}' -Action $a -Principal $p -Force | Out-Null
Start-ScheduledTask -TaskName '${TASK}'
$deadline=(Get-Date).AddSeconds(20)
while (-not (Test-Path '${OUT}') -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 300 }
Unregister-ScheduledTask -TaskName '${TASK}' -Confirm:$false -ErrorAction SilentlyContinue
if (Test-Path '${OUT}') { Get-Content -Raw '${OUT}'; Remove-Item '${OUT}' -ErrorAction SilentlyContinue } else { '[]' }
`;
  const r = await runPowerShell(ps, { timeoutMs: 40_000 });
  if (r.code !== 0) throw new Error(`UIA accelerator failed:\n${r.stderr || r.stdout}`);
  return JSON.parse(r.stdout.trim() || "[]");
}

export async function uiaTree(maxElements: number): Promise<any[]> {
  if (!enabled()) offNotice("ui_tree");
  return runWalk("", maxElements);
}
export async function uiaFind(text: string): Promise<any[]> {
  if (!enabled()) offNotice("ui_find");
  return runWalk(text, 200);
}
export async function uiaListWindows(): Promise<any[]> {
  if (!enabled()) offNotice("list_windows");
  const all = await runWalk("", 500);
  return all.filter((e) => e.type === "Window");
}
export async function uiaFocusWindow(title: string): Promise<boolean> {
  if (!enabled()) offNotice("focus_window");
  // Vision-first focus: find the window's title-bar element and click it.
  const m = (await runWalk(title, 200)).find((e) => e.type === "Window") ?? (await runWalk(title, 200))[0];
  if (!m) return false;
  const { rdpClick } = await import("./rdp.js");
  await rdpClick(m.x, m.y, "left", false);
  return true;
}
