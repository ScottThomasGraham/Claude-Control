// test/rdp-plane.test.mjs
import { test, before, after } from "node:test";
import assert from "node:assert/strict";

process.env.CLAUDE_CONTROL_RDP_SIDECAR = "node";
process.env.CLAUDE_CONTROL_RDP_SIDECAR_ARGS = "test/mock-sidecar.mjs";
process.env.CLAUDE_CONTROL_HOST = "1.2.3.4";
process.env.CLAUDE_CONTROL_USER = "tester";
process.env.CLAUDE_CONTROL_RDP_PASSWORD = "x";

const rdp = await import("../build/rdp.js");

before(async () => { await rdp.rdpConnect(); });
after(async () => { await rdp.rdpShutdown(); });

test("frame returns a base64 PNG with dimensions", async () => {
  const f = await rdp.rdpFrame();
  assert.match(f.png, /^iVBOR/);
  assert.equal(f.width, 1600);
});

test("click sends a pointer command", async () => {
  await rdp.rdpClick(10, 20, "left", false); // resolves without throwing
});

test("chord sends key events", async () => {
  await rdp.rdpChord("Ctrl+S");
});

test("status reports connected", async () => {
  const s = await rdp.rdpStatus();
  assert.equal(s.connected, true);
});
