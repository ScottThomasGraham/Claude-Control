/**
 * Live end-to-end validation of the RDP plane against a real Windows target,
 * driving the SHIPPED code (the same functions the MCP tools call). Not part of
 * the package — a manual resume/validation harness.
 *
 * Usage:
 *   node scripts/live-validate.mjs <host> <user> [identityFile]
 *
 * The RDP password is read from CLAUDE_CONTROL_RDP_PASSWORD if set, otherwise it
 * is prompted for WITHOUT echo. It is held only in this process's memory (set on
 * process.env for rdpConnect to read) and is NEVER written to disk or logged —
 * and because it is prompted (not a CLI arg) it never lands in shell history.
 *
 * Headline check: a real screenshot of the Mini captured with NO human RDP
 * session present — the exact case that used to fail with "handle is invalid".
 */
import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { setTarget, config } from "../build/config.js";
import { ensureRdpEnabled } from "../build/rdpEnable.js";
import {
  rdpConnect, rdpFrame, rdpChord, rdpClick, rdpStatus, rdpShutdown,
} from "../build/rdp.js";

const [host, user, identityFile] = process.argv.slice(2);
if (!host || !user) {
  console.error("Usage: node scripts/live-validate.mjs <host> <user> [identityFile]");
  process.exit(2);
}
const log = (m) => console.log(`\n=== ${m} ===`);

/** Prompt for a secret on the TTY without echoing keystrokes. */
function promptHidden(query) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const onData = () => {
      // Re-draw just the prompt so typed characters never appear.
      if (process.stdout.clearLine) {
        process.stdout.clearLine(0);
        process.stdout.cursorTo(0);
        process.stdout.write(query);
      }
    };
    process.stdin.on("data", onData);
    rl.question(query, (value) => {
      process.stdin.removeListener("data", onData);
      rl.close();
      process.stdout.write("\n");
      resolve(value);
    });
  });
}

setTarget({ host, user, os: "windows", identityFile });

// Source the RDP password (env first, else hidden prompt). In-memory only.
if (!process.env.CLAUDE_CONTROL_RDP_PASSWORD) {
  const pw = await promptHidden(`RDP password for ${user}@${host} (hidden): `);
  if (!pw) { console.error("No password entered."); process.exit(2); }
  process.env.CLAUDE_CONTROL_RDP_PASSWORD = pw;
}

let failed = false;
const fail = (step, e) => { failed = true; console.log(`✗ ${step} FAILED:`, e?.message ?? e); };

try {
  // 1) Ensure RDP is reachable (auto-enable over SSH if off; leave on).
  log("1. Ensure RDP enabled (over SSH)");
  try {
    const en = await ensureRdpEnabled();
    console.log("  ", JSON.stringify(en));
  } catch (e) { fail("ensureRdpEnabled", e); }

  // 2) Connect: become the RDP client and hold the session live.
  log("2. RDP connect (become the client, hold the session)");
  try {
    const st = await rdpConnect();
    console.log(`   connected — live ${st.width}x${st.height}`);
  } catch (e) { fail("rdpConnect", e); throw e; }

  // 3) HEADLINE: capture a frame with no human connected.
  //    Give the server time to complete reactivation (DeactivateAll sequence)
  //    and send the initial desktop paint. frameAge tells us if it repainted:
  //    a small ageMs means a GraphicsUpdate landed; ageMs ~= time-since-connect
  //    means it never painted.
  log("3. Capture frame (no human session present) — settling 3.5s for first paint");
  await new Promise((s) => setTimeout(s, 3500));
  try {
    const f = await rdpFrame();
    writeFileSync("/tmp/cc-rdp-shot.png", Buffer.from(f.png, "base64"));
    console.log(`   saved /tmp/cc-rdp-shot.png  ${f.width}x${f.height}  (${Math.round(f.png.length * 0.75 / 1024)} KB)  frameAge=${f.ageMs}ms`);
    if (f.ageMs > 3000) console.log("   ⚠ frameAge is large — framebuffer may not have repainted yet");
  } catch (e) { fail("rdpFrame#1", e); }

  // 4) Input proof: Ctrl+Esc opens Start, capture, Escape closes it.
  log("4. Input test: Ctrl+Esc (open Start) -> wait 2.5s -> frame -> Escape");
  try {
    await rdpChord("Ctrl+Esc");
    await new Promise((s) => setTimeout(s, 2500));
    const f2 = await rdpFrame();
    writeFileSync("/tmp/cc-rdp-shot2.png", Buffer.from(f2.png, "base64"));
    console.log(`   saved /tmp/cc-rdp-shot2.png  ${f2.width}x${f2.height}  frameAge=${f2.ageMs}ms`);
    await rdpChord("Escape");
    console.log("   pressed Escape to close Start");
  } catch (e) { fail("input test", e); }

  // 5) Status sanity.
  log("5. Status");
  try {
    const s = await rdpStatus();
    console.log("  ", JSON.stringify(s));
  } catch (e) { fail("rdpStatus", e); }
} finally {
  await rdpShutdown().catch(() => {});
}

log(failed ? "DONE (with failures above)" : "DONE — all steps passed");
console.log("Inspect /tmp/cc-rdp-shot.png (desktop, no human present) and /tmp/cc-rdp-shot2.png (Start menu).");
process.exit(failed ? 1 : 0);
