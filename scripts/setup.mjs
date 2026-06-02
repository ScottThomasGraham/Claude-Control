#!/usr/bin/env node
/**
 * Claude-Control setup CLI — Mac-side mechanics for a fast, repeatable rollout.
 *
 * Dependency-free (uses only node built-ins, the OS ssh, and the built library).
 *
 *   node scripts/setup.mjs                      # guided: keygen -> print the Windows paste
 *   node scripts/setup.mjs keygen
 *   node scripts/setup.mjs provision-cmd        # self-contained, PowerShell-paste-safe
 *   node scripts/setup.mjs register --host H --user U [--identity PATH]
 *   node scripts/setup.mjs doctor [--host H --user U [--identity PATH]]
 *
 * The RDP model (2026-06-01):
 *   - provision.ps1 enables OpenSSH on the target and authorizes the SSH key
 *   - The MCP server auto-enables RDP over SSH the first time `connect` is called
 *     (src/rdpEnable.ts :: ensureRdpEnabled)
 *   - The Node/Rust MCP server becomes the RDP client (sidecar/cc-rdp); there is
 *     NO helper process to install, no bootstrap, no logon Scheduled Task
 *   - The RDP password is supplied at runtime via CLAUDE_CONTROL_RDP_PASSWORD
 *     (env var, NEVER written to disk)
 *
 * See docs/STATUS.md for the full architecture.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const WINDOWS_DIR = join(ROOT, "windows");
const KEY = join(homedir(), ".ssh", "claude-control_ed25519");

const c = { g: (s) => `\x1b[32m${s}\x1b[0m`, y: (s) => `\x1b[33m${s}\x1b[0m`, r: (s) => `\x1b[31m${s}\x1b[0m`, b: (s) => `\x1b[1m${s}\x1b[0m`, d: (s) => `\x1b[2m${s}\x1b[0m` };
const ok   = (s) => console.log(`${c.g("✓")} ${s}`);
const warn = (s) => console.log(`${c.y("!")} ${s}`);
const bad  = (s) => console.log(`${c.r("✗")} ${s}`);
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

/**
 * Print a self-contained, PowerShell-paste-safe command that enables OpenSSH
 * on the target and authorizes our key. No network fetch — provision.ps1 is
 * embedded as a here-string (the repo is private so raw.githubusercontent.com
 * would 404). No $k variable: avoids outer-shell expansion when pasted into an
 * interactive elevated PowerShell window.
 */
function cmdProvisionCmd() {
  const pub  = readPubKey();
  const body = readFileSync(join(WINDOWS_DIR, "provision.ps1"), "utf8");
  head("Run this ONCE in an elevated PowerShell on the Windows target");
  console.log(c.d("# Paste this whole block into an ELEVATED PowerShell on the target (no cmd, no internet):\n"));
  console.log("& ([scriptblock]::Create(@'");
  console.log(body);
  console.log("'@)) -PubKey '" + pub + "'");
  console.log(c.d("\nIt prints 'username:' and an IP — read those back to finish setup."));
}

/**
 * Register the MCP server with the Claude CLI.
 * Env vars: HOST / USER / IDENTITY (SSH key path).
 * The RDP password is NEVER baked into the registration command — it is
 * supplied at runtime via CLAUDE_CONTROL_RDP_PASSWORD.
 */
function cmdRegister(args) {
  if (!args.host || !args.user) { bad("register needs --host and --user"); process.exit(2); }
  head("Registering the MCP server with Claude Code");
  const a = [
    "mcp", "add", "claude-control",
    "--env", `CLAUDE_CONTROL_HOST=${args.host}`,
    "--env", `CLAUDE_CONTROL_USER=${args.user}`,
    "--env", `CLAUDE_CONTROL_IDENTITY=${args.identity || KEY}`,
    "--", "node", join(ROOT, "build", "index.js"),
  ];
  spawnSync("claude", ["mcp", "remove", "claude-control"], { stdio: "ignore" });
  const r = spawnSync("claude", a, { stdio: "inherit" });
  if (r.status === 0) {
    ok("registered");
    console.log(c.d("\nRestart your Claude Code session to load the tools."));
    console.log(c.d("Supply CLAUDE_CONTROL_RDP_PASSWORD at runtime when calling connect (env var, never stored)."));
  } else {
    bad("claude mcp add failed (is the Claude CLI installed and on PATH?)");
    process.exit(1);
  }
}

/**
 * Preflight doctor — checks Mac-side tools and (if --host given) SSH + RDP
 * reachability on the target. The RDP check is done over SSH (Test-NetConnection
 * localhost -Port 3389) rather than a full RDP handshake from here.
 */
async function cmdDoctor(args) {
  head("Preflight (Mac side)");
  let fail = 0;
  const major = Number(process.version.slice(1).split(".")[0]);
  major >= 20 ? ok(`node ${process.version}`) : (bad(`node ${process.version} (need ≥ 20)`), fail++);
  which("ssh") ? ok("ssh present")   : (bad("ssh not found"), fail++);
  which("scp") ? ok("scp present")   : (bad("scp not found"), fail++);
  existsSync(join(ROOT, "build", "index.js"))
    ? ok("build present")
    : (warn("not built — run: npm install && npm run build"), fail++);
  existsSync(KEY) ? ok(`ssh key present: ${KEY}`) : warn(`no key yet — run: node scripts/setup.mjs keygen`);
  which("claude") ? ok("claude CLI present") : warn("claude CLI not found (needed to attach the MCP server)");

  if (args.host) {
    head(`Target checks (${args.host})`);

    // SSH port reachable?
    const nc = spawnSync("nc", ["-z", "-G", "5", args.host, "22"], { encoding: "utf8" });
    nc.status === 0
      ? ok("port 22 (SSH) reachable")
      : (bad("port 22 NOT reachable — has the Windows paste been run? All-profiles firewall rule present?"), fail++);

    if (args.user && nc.status === 0) {
      const { setTarget }    = await import("../build/config.js");
      const { runPowerShell } = await import("../build/ssh.js");
      setTarget({ host: args.host, user: args.user, os: "windows", identityFile: args.identity || KEY });

      // SSH login OK?
      const probe = await runPowerShell(`Write-Output $env:COMPUTERNAME`, { timeoutMs: 15000 })
        .catch(() => ({ code: -1, stdout: "" }));
      probe.code === 0
        ? ok(`SSH login OK: ${probe.stdout.trim()}`)
        : (bad("SSH login failed (key authorized? username right?)"), fail++);

      // RDP port reachable (checked over SSH — no full RDP handshake needed)?
      if (probe.code === 0) {
        const rdp = await runPowerShell(
          `$t = Test-NetConnection 127.0.0.1 -Port 3389 -WarningAction SilentlyContinue; Write-Output $t.TcpTestSucceeded`,
          { timeoutMs: 20000 },
        ).catch(() => ({ code: -1, stdout: "False" }));
        rdp.stdout.trim() === "True"
          ? ok("RDP port 3389 open on target")
          : warn("RDP port 3389 not open yet — connect will auto-enable it over SSH (ensureRdpEnabled)");
      }
    }
  }

  console.log(fail ? `\n${c.r(`${fail} issue(s) to fix above.`)}` : `\n${c.g("All good.")}`);
  if (fail) process.exit(1);
}

function guided() {
  console.log(c.b("\nClaude-Control setup\n"));
  console.log("This generates an SSH key and prints ONE command to paste on your Windows target.");
  console.log("The MCP server auto-enables RDP over SSH on first connect — nothing else to install.\n");
  cmdKeygen();
  cmdProvisionCmd();
  head("Next");
  console.log("1. Paste the command above into an elevated PowerShell on the Windows machine.");
  console.log("2. Read back the printed 'username' + IP.");
  console.log("3. Register from the Mac:");
  console.log(c.d("   node scripts/setup.mjs register --host <ip> --user <name>"));
  console.log("4. Set CLAUDE_CONTROL_RDP_PASSWORD in your shell (or in a .env that is NOT committed).");
  console.log("5. In Claude Code: call the `connect` tool. RDP will be enabled automatically if needed.");
}

// ---- dispatch -------------------------------------------------------------
const argv = process.argv.slice(2);
const cmd  = argv[0] && !argv[0].startsWith("--") ? argv[0] : null;
const args = parseArgs(cmd ? argv.slice(1) : argv);

try {
  switch (cmd) {
    case null:             guided();           break;
    case "keygen":         cmdKeygen();        break;
    case "provision-cmd":  cmdProvisionCmd();  break;
    case "register":       cmdRegister(args);  break;
    case "doctor":         await cmdDoctor(args); break;
    default:
      bad(`unknown command: ${cmd}`);
      console.log("commands: keygen | provision-cmd | register | doctor");
      process.exit(2);
  }
} catch (e) {
  bad(e instanceof Error ? e.message : String(e));
  process.exit(1);
}
