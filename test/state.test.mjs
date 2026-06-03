// test/state.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), "cc-state-"));
  process.env.CLAUDE_CONTROL_STATE_DIR = dir;
  return dir;
}

test("stateRoot honors CLAUDE_CONTROL_STATE_DIR", async () => {
  const dir = fresh();
  const { stateRoot } = await import("../build/state.js");
  assert.equal(stateRoot(), dir);
});

test("constructor writes a connecting status.json", async () => {
  fresh();
  const { SessionWriter } = await import("../build/state.js");
  const w = new SessionWriter("pid-host", "1.2.3.4", "uksti", 1000);
  const rec = JSON.parse(readFileSync(join(w.dir, "status.json"), "utf8"));
  assert.equal(rec.state, "connecting");
  assert.equal(rec.host, "1.2.3.4");
  assert.equal(rec.user, "uksti");
  assert.equal(rec.since, 1000);
});

test("setTool flips to working then idle; setError records the message", async () => {
  fresh();
  const { SessionWriter } = await import("../build/state.js");
  const w = new SessionWriter("s", "h", "u", 1);
  w.setTool("screenshot", 2);
  let rec = JSON.parse(readFileSync(join(w.dir, "status.json"), "utf8"));
  assert.equal(rec.state, "working"); assert.equal(rec.currentTool, "screenshot");
  w.setTool(null, 3);
  rec = JSON.parse(readFileSync(join(w.dir, "status.json"), "utf8"));
  assert.equal(rec.state, "idle"); assert.equal(rec.currentTool, null);
  w.setError("boom", 4);
  rec = JSON.parse(readFileSync(join(w.dir, "status.json"), "utf8"));
  assert.equal(rec.state, "error"); assert.equal(rec.lastError, "boom");
});

test("writeFrame writes frame.png and bumps lastFrameAt", async () => {
  fresh();
  const { SessionWriter } = await import("../build/state.js");
  const w = new SessionWriter("s", "h", "u", 1);
  w.writeFrame(Buffer.from([0x89, 0x50, 0x4e, 0x47]), 9);
  assert.ok(existsSync(join(w.dir, "frame.png")));
  const rec = JSON.parse(readFileSync(join(w.dir, "status.json"), "utf8"));
  assert.equal(rec.lastFrameAt, 9);
});

test("dispose removes the session dir", async () => {
  fresh();
  const { SessionWriter } = await import("../build/state.js");
  const w = new SessionWriter("s", "h", "u", 1);
  w.dispose();
  assert.equal(existsSync(w.dir), false);
});
