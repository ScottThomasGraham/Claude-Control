/**
 * SSH transport — shells out to the OS-preinstalled `ssh`/`scp` clients.
 *
 * No SSH library is bundled: macOS ships an OpenSSH client, so we reuse it
 * (honoring ~/.ssh/config, ssh-agent, etc.). Connection multiplexing
 * (ControlMaster) keeps repeated commands fast — important because every visual
 * helper call is one short `ssh` exec.
 */
import { spawn } from "node:child_process";
import { config, requireTarget } from "./config.js";

const CONTROL_PATH = `${process.env.TMPDIR ?? "/tmp"}/cc-%r@%h-%p`;

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

interface ExecOpts {
  timeoutMs?: number;
  /** Bytes written to the child's stdin. */
  stdin?: Buffer;
}

function spawnCapture(cmd: string, args: string[], opts: ExecOpts = {}): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let settled = false;
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          if (!settled) {
            settled = true;
            child.kill("SIGKILL");
            reject(new Error(`${cmd} timed out after ${opts.timeoutMs}ms`));
          }
        }, opts.timeoutMs)
      : undefined;

    child.stdout.on("data", (d: Buffer) => out.push(d));
    child.stderr.on("data", (d: Buffer) => err.push(d));
    child.on("error", (e) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
        code: code ?? -1,
      });
    });

    if (opts.stdin) {
      child.stdin.write(opts.stdin);
    }
    child.stdin.end();
  });
}

function sshBaseArgs(): string[] {
  const a = [
    "-o", "BatchMode=yes",
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", "ControlMaster=auto",
    "-o", `ControlPath=${CONTROL_PATH}`,
    "-o", "ControlPersist=300",
    "-p", String(config.port),
  ];
  if (config.identityFile) a.push("-i", config.identityFile);
  return a;
}

/** Run a raw command string on the target over SSH. */
export function sshExec(remoteCommand: string, opts: ExecOpts = {}): Promise<ExecResult> {
  const { host, user } = requireTarget();
  const args = [...sshBaseArgs(), `${user}@${host}`, remoteCommand];
  return spawnCapture("ssh", args, { timeoutMs: 30_000, ...opts });
}

/** UTF-16LE base64 encoding for `powershell -EncodedCommand` (avoids all quoting issues). */
export function psEncode(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64");
}

/** Run a PowerShell script on the target via -EncodedCommand. */
export function runPowerShell(script: string, opts: ExecOpts = {}): Promise<ExecResult> {
  return sshExec(`powershell -NoProfile -NonInteractive -EncodedCommand ${psEncode(script)}`, opts);
}

export function scpUpload(localPath: string, remotePath: string): Promise<ExecResult> {
  const { host, user } = requireTarget();
  const args = [
    "-o", "BatchMode=yes",
    "-o", "StrictHostKeyChecking=accept-new",
    "-P", String(config.port),
  ];
  if (config.identityFile) args.push("-i", config.identityFile);
  args.push(localPath, `${user}@${host}:${remotePath}`);
  return spawnCapture("scp", args, { timeoutMs: 120_000 });
}

export function scpDownload(remotePath: string, localPath: string): Promise<ExecResult> {
  const { host, user } = requireTarget();
  const args = [
    "-o", "BatchMode=yes",
    "-o", "StrictHostKeyChecking=accept-new",
    "-P", String(config.port),
  ];
  if (config.identityFile) args.push("-i", config.identityFile);
  args.push(`${user}@${host}:${remotePath}`, localPath);
  return spawnCapture("scp", args, { timeoutMs: 120_000 });
}

/**
 * Send a JSON command to the interactive-session helper (which listens on the
 * target's loopback). We relay via a tiny PowerShell snippet run over SSH that
 * opens a TcpClient to 127.0.0.1:<helperPort> — so the helper port is never
 * exposed on the network and we need no Node-side tunnel process.
 *
 * The helper replies with a single JSON line: `{ "ok": true, ... }` or
 * `{ "ok": false, "error": "..." }`.
 */
export async function helperCall(command: object, opts: ExecOpts = {}): Promise<any> {
  const b64 = Buffer.from(JSON.stringify(command), "utf8").toString("base64");
  const relay = `
$ErrorActionPreference = 'Stop'
try {
  $payload = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}'))
  $client = New-Object Net.Sockets.TcpClient
  $client.Connect('127.0.0.1', ${config.helperPort})
  $stream = $client.GetStream()
  $writer = New-Object IO.StreamWriter($stream); $writer.AutoFlush = $true
  $reader = New-Object IO.StreamReader($stream)
  $writer.WriteLine($payload)
  $line = $reader.ReadLine()
  [Console]::Out.Write($line)
  $client.Close()
} catch {
  [Console]::Out.Write((@{ ok = $false; error = "helper-unreachable: $($_.Exception.Message)" } | ConvertTo-Json -Compress))
}
`;
  const res = await runPowerShell(relay, { timeoutMs: 30_000, ...opts });
  const text = res.stdout.trim();
  if (!text) {
    throw new Error(`helper relay produced no output (ssh code ${res.code}): ${res.stderr.trim()}`);
  }
  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`helper returned non-JSON: ${text.slice(0, 400)}`);
  }
  if (parsed && parsed.ok === false) {
    throw new Error(`helper error: ${parsed.error ?? "unknown"}`);
  }
  return parsed;
}
