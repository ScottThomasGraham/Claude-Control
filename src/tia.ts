/**
 * TIA Portal Openness bridge (OPTIONAL accelerator).
 *
 * Runs windows/tia-openness.ps1 on the target over SSH and parses its single
 * JSON line. This is a convenience fast-path for TIA only — the universal visual
 * layer (visual.ts / helper.ps1) drives TIA and every other program without it.
 *
 * The dispatcher script is uploaded to C:/ProgramData/ClaudeControl/ once per
 * server process (idempotent), so `tia_*` works even before `bootstrap`.
 */
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { sshExec, scpUpload, runPowerShell } from "./ssh.js";
import { requireTarget } from "./config.js";

const WINDOWS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "windows");
const REMOTE_DIR = "C:/ProgramData/ClaudeControl";
const REMOTE_SCRIPT = `${REMOTE_DIR}/tia-openness.ps1`;

let uploaded = false;

async function ensureScript(): Promise<void> {
  if (uploaded) return;
  requireTarget();
  const mk = await runPowerShell(`New-Item -ItemType Directory -Force -Path '${REMOTE_DIR}' | Out-Null`);
  if (mk.code !== 0) throw new Error(`Could not create ${REMOTE_DIR}: ${mk.stderr.trim() || mk.stdout.trim()}`);
  const up = await scpUpload(join(WINDOWS_DIR, "tia-openness.ps1"), REMOTE_SCRIPT);
  if (up.code !== 0) throw new Error(`Failed to upload tia-openness.ps1: ${up.stderr.trim() || up.stdout.trim()}`);
  uploaded = true;
}

/**
 * Invoke one Openness operation. Returns the parsed JSON object from the script
 * (which always carries an `ok` boolean). Throws only on transport/parse failure
 * — application-level failures come back as `{ ok: false, error }` so callers can
 * surface them cleanly (e.g. "Openness not installed").
 */
export async function tiaCall(op: string, args: Record<string, unknown> = {}): Promise<any> {
  await ensureScript();
  const b64 = Buffer.from(JSON.stringify(args), "utf8").toString("base64");
  const cmd =
    `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ${REMOTE_SCRIPT} ` +
    `-Op ${op} -ArgsB64 ${b64}`;
  const r = await sshExec(cmd, { timeoutMs: 120_000 });
  const out = r.stdout.trim();
  if (!out) {
    throw new Error(`tia-openness.ps1 produced no output (ssh code ${r.code}): ${r.stderr.trim()}`);
  }
  try {
    return JSON.parse(out);
  } catch {
    throw new Error(`tia-openness.ps1 returned non-JSON: ${out.slice(0, 600)}`);
  }
}
