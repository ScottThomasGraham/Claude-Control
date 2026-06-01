#!/usr/bin/env node
/**
 * Claude-Control setup CLI — the Mac-side mechanics for a fast, repeatable rollout.
 *
 * Dependency-free (uses only node built-ins, the OS ssh/scp, and the built library).
 *
 *   node scripts/setup.mjs                 # guided: doctor -> keygen -> print the Windows paste
 *   node scripts/setup.mjs doctor [--host H --user U]
 *   node scripts/setup.mjs keygen
 *   node scripts/setup.mjs provision-cmd     # self-contained, PowerShell-paste-safe
 *   node scripts/setup.mjs make-installer    # write ONE .ps1 that does the whole Windows side
 *   node scripts/setup.mjs register --host H --user U [--identity PATH] [--helper-port N]
 *   node scripts/setup.mjs deploy   --host H --user U [--identity PATH] [--autologon]
 *
 * Most users never call the subcommands directly — the /claude-control-setup skill
 * (or Claude) drives this and the MCP tools. See docs/SETUP.md.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const WINDOWS_DIR = join(ROOT, "windows");
const KEY = join(homedir(), ".ssh", "claude-control_ed25519");
const HELPER_PORT_DEFAULT = 8765;
const REMOTE_DIR = "C:/ProgramData/ClaudeControl";

const c = { g: (s) => `\x1b[32m${s}\x1b[0m`, y: (s) => `\x1b[33m${s}\x1b[0m`, r: (s) => `\x1b[31m${s}\x1b[0m`, b: (s) => `\x1b[1m${s}\x1b[0m`, d: (s) => `\x1b[2m${s}\x1b[0m` };
const ok = (s) => console.log(`${c.g("✓")} ${s}`);
const warn = (s) => console.log(`${c.y("!")} ${s}`);
const bad = (s) => console.log(`${c.r("✗")} ${s}`);
const head = (s) => console.log(`\n${c.b(s)}`);

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const k = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) out[k] = true;
      else { out[k] = next; i++; }
    } else out._.push(a);
  }
  return out;
}

function which(bin) {
  const r = spawnSync("/bin/sh", ["-c", `command -v ${bin}`], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}

async function prompt(question, { hidden = false } = {}) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  if (hidden) {
    const onData = (ch) => { const s = ch + ""; if (s === "\n" || s === "\r" || s === "\r\n" || s === "") return; process.stdout.write("\x1b[2K\x1b[200D" + question); };
    process.stdin.on("data", onData);
    const ans = await new Promise((res) => rl.question(question, res));
    process.stdin.removeListener("data", onData);
    rl.close();
    process.stdout.write("\n");
    return ans;
  }
  const ans = await new Promise((res) => rl.question(question, res));
  rl.close();
  return ans;
}

// ---- subcommands ----------------------------------------------------------

function cmdKeygen() {
  head("SSH key");
  if (existsSync(KEY) && existsSync(KEY + ".pub")) { ok(`key already exists: ${KEY}`); return KEY; }
  mkdirSync(dirname(KEY), { recursive: true });
  execFileSync("ssh-keygen", ["-t", "ed25519", "-f", KEY, "-C", "claude-control", "-N", ""], { stdio: "inherit" });
  ok(`generated ${KEY}`);
  return KEY;
}

function readPubKey() {
  if (!existsSync(KEY + ".pub")) { cmdKeygen(); }
  return readFileSync(KEY + ".pub", "utf8").trim();
}

function cmdProvisionCmd(args) {
  const pub = readPubKey();
  const body = readFileSync(join(WINDOWS_DIR, "provision.ps1"), "utf8");
  head("Run this ONCE in an elevated PowerShell on the Windows target");
  // Self-contained + PowerShell-paste-safe by design:
  //   - no `powershell -Command "..."` wrapper, so it runs in the elevated PowerShell
  //     window the user already has open (the instruction says "in PowerShell").
  //   - no `$k=` variable: a `$k` inside a double-quoted -Command string gets expanded
  //     by the *outer* interactive PowerShell before the child runs, mangling the key.
  //     The pubkey is passed as a single-quoted literal straight to -PubKey instead.
  //   - the script body is embedded in a here-string, so there is no network fetch —
  //     this matters because the repo is PRIVATE (raw.githubusercontent.com 404s).
  console.log(c.d("# Paste this whole block into an ELEVATED PowerShell on the target (no cmd, no internet):\n"));
  console.log("& ([scriptblock]::Create(@'");
  console.log(body);
  console.log("'@)) -PubKey '" + pub + "'");
  console.log(c.d("\nIt prints 'username:' and an IP — read those back to finish setup."));
}

// Generate ONE self-contained .ps1 the operator drops on the target. Running it
// (elevated) does the WHOLE Windows side: enable OpenSSH + authorize our key +
// firewall (provision.ps1), install the visual helper, and bootstrap it as a logon
// task (bootstrap.ps1). The three shipped scripts are embedded as base64 so there is
// no network fetch and no here-string/quoting fragility regardless of their contents.
function cmdMakeInstaller(args) {
  const pub = readPubKey();
  const helperPort = Number(args["helper-port"] || HELPER_PORT_DEFAULT);
  const b64 = (f) => Buffer.from(readFileSync(join(WINDOWS_DIR, f), "utf8"), "utf8").toString("base64");
  const provisionB64 = b64("provision.ps1");
  const helperB64 = b64("helper.ps1");
  const bootstrapB64 = b64("bootstrap.ps1");

  const installer = `<#
  Claude-Control — single-file installer (GENERATED; do not edit by hand).
  Regenerate with:  node scripts/setup.mjs make-installer

  WHAT IT DOES (the entire Windows side, from one file, no internet needed):
    1. enables the OpenSSH server, authorizes the controller's public key, opens
       inbound TCP/22 on all firewall profiles            (embedded provision.ps1)
    2. installs the visual helper to C:\\ProgramData\\ClaudeControl   (embedded helper.ps1)
    3. registers it as a logon Scheduled Task on a reserved port    (embedded bootstrap.ps1)
  Then it prints — and saves to a file — the username + IP the controller needs.

  HOW TO RUN on the target (either works):
    * Right-click this file -> "Run with PowerShell"  (it self-elevates), or
    * In an elevated PowerShell:  powershell -NoProfile -ExecutionPolicy Bypass -File .\\claude-control-install.ps1
#>
$ErrorActionPreference = 'Stop'

# --- self-elevate if not already admin ---
$principal = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltinRole]::Administrator)) {
  Write-Host '[claude-control] not elevated - relaunching as administrator...'
  if (-not $PSCommandPath) { throw 'Run this from the saved .ps1 file (right-click -> Run with PowerShell), not by pasting it.' }
  Start-Process powershell -Verb RunAs -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',$PSCommandPath)
  return
}

$PubKey     = '${pub}'
$HelperPort = ${helperPort}
$Dir        = 'C:\\ProgramData\\ClaudeControl'
function Decode([string]$b64) { [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b64)) }
$provision = Decode('${provisionB64}')
$helper    = Decode('${helperB64}')
$bootstrap = Decode('${bootstrapB64}')

Write-Host '[claude-control] (1/3) enabling OpenSSH + authorizing key + firewall...'
& ([scriptblock]::Create($provision)) -PubKey $PubKey *>&1 | Tee-Object -Variable provOut | Out-Host

Write-Host '[claude-control] (2/3) installing helper files to' $Dir '...'
New-Item -ItemType Directory -Force -Path $Dir | Out-Null
Set-Content -LiteralPath (Join-Path $Dir 'helper.ps1')    -Value $helper    -Encoding UTF8
Set-Content -LiteralPath (Join-Path $Dir 'bootstrap.ps1') -Value $bootstrap -Encoding UTF8

Write-Host '[claude-control] (3/3) registering logon task + starting helper...'
& ([scriptblock]::Create($bootstrap)) -HelperPort $HelperPort -DisableIdleLock

# --- surface + persist the connection details the controller needs ---
$uname = ''
$m = ($provOut | Out-String | Select-String 'username\\s*:\\s*(\\S+)')
if ($m) { $uname = $m.Matches[0].Groups[1].Value }
if (-not $uname) { $uname = $env:USERNAME }
$ips = (Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
        Where-Object { $_.IPAddress -notlike '169.254*' -and $_.IPAddress -ne '127.0.0.1' } |
        Select-Object -ExpandProperty IPAddress) -join ', '
$ready = @"
===================== CLAUDE-CONTROL: INSTALL COMPLETE =====================
  username : $uname
  computer : $env:COMPUTERNAME
  IPv4     : $ips
  helper   : 127.0.0.1:$HelperPort (logon Scheduled Task 'ClaudeControlHelper')
  (Prefer a Tailscale 100.x.y.z address if this box is on a tailnet.)
  Tell the 'username' and an IP to Claude on the Mac to finish setup.
============================================================================
"@
Set-Content -LiteralPath (Join-Path $Dir 'claude-control-ready.txt') -Value $ready -Encoding UTF8
Write-Host ''
Write-Host $ready
Write-Host "(also saved to $Dir\\claude-control-ready.txt)"
if ($Host.Name -eq 'ConsoleHost') { Read-Host 'Press Enter to close' | Out-Null }
`;

  const out = args.out || join(ROOT, "dist", "claude-control-install.ps1");
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, installer, "utf8");
  head("Single-file installer generated");
  ok(`wrote ${out} (${(installer.length / 1024).toFixed(1)} KB, self-contained)`);
  console.log(c.d("\nHand this file to the target however you like (RDP clipboard copy, share, USB)."));
  console.log(c.d("On the Windows box: right-click -> Run with PowerShell (it self-elevates), or run"));
  console.log(c.d("  powershell -NoProfile -ExecutionPolicy Bypass -File .\\claude-control-install.ps1"));
  console.log(c.d("It prints + saves a 'username' and IP. Read those back, then on the Mac:"));
  console.log(c.d("  node scripts/setup.mjs register --host <ip> --user <name>"));
  console.log(c.d("  node scripts/setup.mjs deploy   --host <ip> --user <name>   # (verifies + proof screenshot)"));
}

function cmdRegister(args) {
  if (!args.host || !args.user) { bad("register needs --host and --user"); process.exit(2); }
  head("Registering the MCP server with Claude Code");
  const a = ["mcp", "add", "claude-control",
    "--env", `CLAUDE_CONTROL_HOST=${args.host}`,
    "--env", `CLAUDE_CONTROL_USER=${args.user}`,
    "--env", `CLAUDE_CONTROL_IDENTITY=${args.identity || KEY}`];
  if (args["helper-port"]) a.push("--env", `CLAUDE_CONTROL_HELPER_PORT=${args["helper-port"]}`);
  a.push("--", "node", join(ROOT, "build", "index.js"));
  spawnSync("claude", ["mcp", "remove", "claude-control"], { stdio: "ignore" });
  const r = spawnSync("claude", a, { stdio: "inherit" });
  if (r.status === 0) ok("registered (restart your Claude Code session to load the tools)");
  else { bad("claude mcp add failed (is the Claude CLI installed and on PATH?)"); process.exit(1); }
}

async function cmdDeploy(args) {
  if (!args.host || !args.user) { bad("deploy needs --host and --user"); process.exit(2); }
  const helperPort = Number(args["helper-port"] || HELPER_PORT_DEFAULT);
  const { setTarget } = await import("../build/config.js");
  const { sshExec, runPowerShell, scpUpload, helperCall } = await import("../build/ssh.js");
  const { vScreenshot } = await import("../build/visual.js");
  setTarget({ host: args.host, user: args.user, os: "windows", identityFile: args.identity || KEY, helperPort });

  head(`Deploying to ${args.user}@${args.host}`);
  // 1) connect check (EncodedCommand path — avoids the remote PowerShell shell expanding the probe)
  const probe = await runPowerShell(`Write-Output $env:COMPUTERNAME`, { timeoutMs: 20000 }).catch((e) => ({ code: -1, stderr: String(e), stdout: "" }));
  if (probe.code !== 0) {
    bad(`SSH connect failed. Run \`node scripts/setup.mjs doctor --host ${args.host} --user ${args.user}\` for hints.`);
    console.log(c.d(probe.stderr?.trim() || ""));
    process.exit(1);
  }
  ok(`connected: ${probe.stdout.trim()}`);
  // 2) push helper + bootstrap
  await runPowerShell(`New-Item -ItemType Directory -Force -Path '${REMOTE_DIR}' | Out-Null`);
  for (const f of ["helper.ps1", "bootstrap.ps1"]) {
    const up = await scpUpload(join(WINDOWS_DIR, f), `${REMOTE_DIR}/${f}`);
    if (up.code !== 0) { bad(`upload ${f} failed: ${up.stderr.trim()}`); process.exit(1); }
  }
  ok("pushed helper + bootstrap");
  // 3) bootstrap (reserved port, restart-on-failure, idle-lock off)
  const r = await sshExec(`powershell -NoProfile -ExecutionPolicy Bypass -File ${REMOTE_DIR}/bootstrap.ps1 -HelperPort ${helperPort} -DisableIdleLock`, { timeoutMs: 90000 });
  if (r.code !== 0) { bad(`bootstrap failed:\n${r.stderr.trim()}`); process.exit(1); }
  ok("bootstrapped helper (port reserved, restart-on-failure, idle-lock off)");
  // 4) optional autologon
  if (args.autologon) await enableAutologon(args);
  // 5) verify + proof
  try {
    const pong = await helperCall({ op: "ping" }, { timeoutMs: 12000 });
    ok(`visual helper reachable (v${pong?.version ?? "?"})`);
    const shot = await vScreenshot();
    const out = join("/tmp", "claude-control-proof.png");
    writeFileSync(out, Buffer.from(shot.png, "base64"));
    ok(`proof screenshot saved: ${out} (${shot.width}x${shot.height})`);
  } catch (e) {
    warn(`helper not reachable yet (${e instanceof Error ? e.message : e}). If no one is logged in on the target, enable autologon or log in.`);
  }
  console.log(`\n${c.g("Done.")} Target is under control. Reboots are ${args.autologon ? "bulletproof (autologon on)" : "manual until an interactive logon (consider --autologon)"}.`);
}

async function enableAutologon(args) {
  if (!args.host || !args.user) { bad("autologon needs --host and --user"); process.exit(2); }
  const { setTarget } = await import("../build/config.js");
  const { sshExec, runPowerShell } = await import("../build/ssh.js");
  setTarget({ host: args.host, user: args.user, os: "windows", identityFile: args.identity || KEY, helperPort: Number(args["helper-port"] || HELPER_PORT_DEFAULT) });
  head("Enable autologon (bulletproof reboots)");
  const pw = await prompt("Windows password for autologon (hidden; stored only as an encrypted LSA secret on the target, never on this Mac): ", { hidden: true });
  if (!pw) { warn("no password entered — skipped"); return; }
  await runPowerShell(`New-Item -ItemType Directory -Force -Path '${REMOTE_DIR}' | Out-Null; Invoke-WebRequest -Uri 'https://live.sysinternals.com/Autologon64.exe' -OutFile '${REMOTE_DIR}/Autologon64.exe' -UseBasicParsing`).catch(() => {});
  const al = await sshExec(`powershell -NoProfile -Command "& '${REMOTE_DIR}/Autologon64.exe' '${args.user}' $env:COMPUTERNAME '${pw.replace(/'/g, "''")}' /accepteula"`, { timeoutMs: 30000 });
  const v = await runPowerShell(`(Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Winlogon').AutoAdminLogon`);
  if (v.stdout.trim() === "1") ok("autologon enabled (LSA secret; reboots auto-recover, no plaintext in registry)");
  else warn(`autologon may not have applied: ${al.stderr.trim() || al.stdout.trim()}`);
}

async function cmdDoctor(args) {
  head("Preflight (Mac side)");
  let fail = 0;
  const major = Number(process.version.slice(1).split(".")[0]);
  major >= 20 ? ok(`node ${process.version}`) : (bad(`node ${process.version} (need ≥ 20)`), fail++);
  which("ssh") ? ok("ssh present") : (bad("ssh not found"), fail++);
  which("scp") ? ok("scp present") : (bad("scp not found"), fail++);
  existsSync(join(ROOT, "build", "index.js")) ? ok("build present") : (warn("not built — run: npm install && npm run build"), fail++);
  existsSync(KEY) ? ok(`ssh key present: ${KEY}`) : warn(`no key yet — run: node scripts/setup.mjs keygen`);
  which("claude") ? ok("claude CLI present") : warn("claude CLI not found (needed to attach the MCP server)");

  if (args.host) {
    head(`Target checks (${args.host})`);
    const nc = spawnSync("nc", ["-z", "-G", "5", args.host, "22"], { encoding: "utf8" });
    nc.status === 0 ? ok("port 22 reachable") : (bad("port 22 NOT reachable — has the Windows paste been run? Is the all-profiles firewall rule present? (don't trust bash /dev/tcp)"), fail++);
    if (args.user && nc.status === 0) {
      const { setTarget } = await import("../build/config.js");
      const { runPowerShell, helperCall } = await import("../build/ssh.js");
      setTarget({ host: args.host, user: args.user, os: "windows", identityFile: args.identity || KEY, helperPort: Number(args["helper-port"] || HELPER_PORT_DEFAULT) });
      const probe = await runPowerShell(`Write-Output $env:COMPUTERNAME`, { timeoutMs: 15000 }).catch(() => ({ code: -1, stdout: "" }));
      probe.code === 0 ? ok(`ssh login OK: ${probe.stdout.trim()}`) : (bad("ssh login failed (key authorized? username right?)"), fail++);
      try { const p = await helperCall({ op: "ping" }, { timeoutMs: 10000 }); ok(`visual helper reachable (v${p?.version ?? "?"})`); }
      catch { warn("visual helper not bound — run deploy, and ensure someone is logged in (or autologon is on)"); }
    }
  }
  console.log(fail ? `\n${c.r(`${fail} issue(s) to fix above.`)}` : `\n${c.g("All good.")}`);
  if (fail) process.exit(1);
}

function guided() {
  console.log(c.b("\nClaude-Control setup\n"));
  console.log("This generates an SSH key and prints ONE command to paste on your Windows target.\n");
  cmdKeygen();
  cmdProvisionCmd({});
  head("Next");
  console.log("1. Paste the command above into an elevated PowerShell on the Windows machine.");
  console.log("2. Read back the printed 'username' + IP.");
  console.log("3. Finish from Claude Code with /claude-control-setup, or run:");
  console.log(c.d("   node scripts/setup.mjs register --host <ip> --user <name>"));
  console.log(c.d("   node scripts/setup.mjs deploy   --host <ip> --user <name> --autologon"));
}

// ---- dispatch -------------------------------------------------------------
const argv = process.argv.slice(2);
const cmd = argv[0] && !argv[0].startsWith("--") ? argv[0] : null;
const args = parseArgs(cmd ? argv.slice(1) : argv);
try {
  switch (cmd) {
    case null: guided(); break;
    case "keygen": cmdKeygen(); break;
    case "provision-cmd": cmdProvisionCmd(args); break;
    case "make-installer": cmdMakeInstaller(args); break;
    case "register": cmdRegister(args); break;
    case "deploy": await cmdDeploy(args); break;
    case "autologon": await enableAutologon(args); break;
    case "doctor": await cmdDoctor(args); break;
    default: bad(`unknown command: ${cmd}`); console.log("commands: doctor | keygen | provision-cmd | make-installer | register | deploy | autologon"); process.exit(2);
  }
} catch (e) {
  bad(e instanceof Error ? e.message : String(e));
  process.exit(1);
}
