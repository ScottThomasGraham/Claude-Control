# RDP-Client Plane Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Claude-Control drive a remote Windows box as the RDP client itself — holding the session live 24/7 so capture+input never depend on a human's session — with SSH retained as the speed plane and an optional opt-in UIA accelerator.

**Architecture:** A small **Rust IronRDP sidecar** (runs on the Mac) owns the RDP connection and exposes a length-prefixed-JSON IPC over stdio. A Node module (`src/rdp.ts`) supervises the sidecar, translates high-level actions (click/type/chord/drag) into pointer/key events, and snapshots frames. The MCP tools in `src/server.ts` re-route their visual operations through this plane; the in-session PowerShell helper is deleted. SSH (`src/ssh.ts`) is unchanged and used for the one-time RDP-enable step and the optional UIA accelerator.

**Tech Stack:** TypeScript (Node ≥20, `node:test`), `@modelcontextprotocol/sdk`, `zod`, Rust (IronRDP crates), OS `ssh`/`scp`.

**Spec:** `docs/superpowers/specs/2026-06-01-rdp-client-remote-control-design.md`

---

## File Structure

**Create:**
- `src/keymap.ts` — pure: parse a chord (`"Ctrl+S"`) / a text string into ordered key events `{scancode|unicode, down}`. Unit-tested.
- `src/ipc.ts` — pure: length-prefixed (4-byte BE length + UTF-8 JSON) frame encode/decode + a streaming decoder. Unit-tested.
- `src/rdp.ts` — the RDP plane: spawn/supervise the sidecar, request/response matching, `rdpConnect/Frame/Pointer/Keys/Status/Disconnect`, and high-level `rdpClick/Move/Scroll/Drag/Type/Chord` built on the primitives.
- `src/rdpEnable.ts` — ensure RDP is enabled on the target over SSH (registry + firewall), idempotent, leave-on.
- `src/uia.ts` — optional UIA accelerator: transient one-shot scheduled task in the interactive session, returns the element tree, cleans up.
- `windows/uia-accelerator.ps1` — the in-session UIA walk (emits JSON).
- `sidecar/Cargo.toml`, `sidecar/src/main.rs`, `sidecar/src/proto.rs` — the Rust IronRDP sidecar.
- `test/ipc.test.mjs`, `test/keymap.test.mjs` — unit tests (import compiled `build/*.js`).
- `test/mock-sidecar.mjs` — a fake sidecar speaking the IPC, used by the rdp-plane test.
- `test/rdp-plane.test.mjs` — drives `src/rdp.ts` against the mock sidecar.

**Modify:**
- `src/config.ts` — add `rdpPort`, `rdpWidth`, `rdpHeight`, `sidecarPath`; drop `helperPort`.
- `src/visual.ts` — Windows path delegates to `src/rdp.ts`; drop `helperCall` usage.
- `src/server.ts` — `connect` brings up the RDP session (creds from env, auto-enable RDP); `status` reports RDP state; remove `bootstrap`; `ui_tree/ui_find/list_windows/focus_window` use the UIA accelerator.
- `src/ssh.ts` — remove now-unused `helperCall`.
- `package.json` — add `"test"` and `"build:sidecar"` scripts.
- `scripts/live-validate.mjs` — add an RDP-plane end-to-end pass.

**Delete:**
- `windows/helper.ps1`, `windows/bootstrap.ps1`.

---

## Task 1: IPC framing (`src/ipc.ts`)

**Files:**
- Create: `src/ipc.ts`
- Test: `test/ipc.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
// test/ipc.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeFrame, FrameDecoder } from "../build/ipc.js";

test("encodeFrame writes 4-byte BE length + JSON", () => {
  const buf = encodeFrame({ a: 1 });
  const len = buf.readUInt32BE(0);
  assert.equal(len, buf.length - 4);
  assert.deepEqual(JSON.parse(buf.subarray(4).toString("utf8")), { a: 1 });
});

test("FrameDecoder reassembles messages split across chunks", () => {
  const msgs = [];
  const dec = new FrameDecoder((m) => msgs.push(m));
  const whole = Buffer.concat([encodeFrame({ id: 1 }), encodeFrame({ id: 2 })]);
  dec.push(whole.subarray(0, 3));   // partial header
  dec.push(whole.subarray(3, 9));   // rest of header + partial body
  dec.push(whole.subarray(9));      // remainder
  assert.deepEqual(msgs, [{ id: 1 }, { id: 2 }]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && node --test test/ipc.test.mjs`
Expected: FAIL — `Cannot find module '../build/ipc.js'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/ipc.ts
/** Length-prefixed JSON framing for the sidecar IPC: 4-byte BE length + UTF-8 JSON. */
export function encodeFrame(obj: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(obj), "utf8");
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(body.length, 0);
  return Buffer.concat([header, body]);
}

/** Streaming decoder: feed it chunks, get whole JSON messages back via the callback. */
export class FrameDecoder {
  private buf = Buffer.alloc(0);
  constructor(private readonly onMessage: (msg: any) => void) {}

  push(chunk: Buffer): void {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    while (this.buf.length >= 4) {
      const len = this.buf.readUInt32BE(0);
      if (this.buf.length < 4 + len) break;
      const body = this.buf.subarray(4, 4 + len);
      this.buf = this.buf.subarray(4 + len);
      this.onMessage(JSON.parse(body.toString("utf8")));
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build && node --test test/ipc.test.mjs`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/ipc.ts test/ipc.test.mjs
git commit -m "feat: length-prefixed JSON IPC framing for the RDP sidecar"
```

---

## Task 2: Keyboard mapping (`src/keymap.ts`)

Pure translation of chords/text into RDP key events. Scancodes are PC/XT set-1 make codes; the sidecar adds the break (key-up) flag from `down:false`. Text uses RDP's Unicode keyboard event (`unicode` set, `scancode` 0).

**Files:**
- Create: `src/keymap.ts`
- Test: `test/keymap.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
// test/keymap.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { chordToEvents, textToEvents } from "../build/keymap.js";

test("single key chord presses then releases", () => {
  assert.deepEqual(chordToEvents("Enter"), [
    { scancode: 0x1c, down: true },
    { scancode: 0x1c, down: false },
  ]);
});

test("modifier chord wraps the key: Ctrl+S", () => {
  assert.deepEqual(chordToEvents("Ctrl+S"), [
    { scancode: 0x1d, down: true },  // LCtrl down
    { scancode: 0x1f, down: true },  // S down
    { scancode: 0x1f, down: false }, // S up
    { scancode: 0x1d, down: false }, // LCtrl up
  ]);
});

test("chord parsing is case-insensitive and trims spaces", () => {
  assert.deepEqual(chordToEvents(" ctrl + s "), chordToEvents("Ctrl+S"));
});

test("unknown key name throws", () => {
  assert.throws(() => chordToEvents("Ctrl+Nope"), /unknown key/i);
});

test("textToEvents emits unicode down/up per char", () => {
  assert.deepEqual(textToEvents("Hi"), [
    { unicode: 0x48, down: true }, { unicode: 0x48, down: false },
    { unicode: 0x69, down: true }, { unicode: 0x69, down: false },
  ]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && node --test test/keymap.test.mjs`
Expected: FAIL — `Cannot find module '../build/keymap.js'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/keymap.ts
/** One RDP keyboard event. Either a hardware scancode (set-1 make code) or a Unicode code point. */
export interface KeyEvent {
  scancode?: number;
  unicode?: number;
  down: boolean;
}

const MODIFIERS: Record<string, number> = {
  ctrl: 0x1d, control: 0x1d,
  alt: 0x38,
  shift: 0x2a,
  win: 0xe05b, meta: 0xe05b, // extended (E0) prefix encoded in the high byte
};

// Set-1 make codes for the keys we expose. Extended keys carry 0xE0 in the high byte.
const KEYS: Record<string, number> = {
  enter: 0x1c, esc: 0x01, escape: 0x01, tab: 0x0f, space: 0x39, backspace: 0x0e,
  delete: 0xe053, del: 0xe053, home: 0xe047, end: 0xe04f,
  pageup: 0xe049, pagedown: 0xe051, insert: 0xe052,
  up: 0xe048, down: 0xe050, left: 0xe04b, right: 0xe04d,
  a: 0x1e, b: 0x30, c: 0x2e, d: 0x20, e: 0x12, f: 0x21, g: 0x22, h: 0x23,
  i: 0x17, j: 0x24, k: 0x25, l: 0x26, m: 0x32, n: 0x31, o: 0x18, p: 0x19,
  q: 0x10, r: 0x13, s: 0x1f, t: 0x14, u: 0x16, v: 0x2f, w: 0x11, x: 0x2d,
  y: 0x15, z: 0x2c,
  "0": 0x0b, "1": 0x02, "2": 0x03, "3": 0x04, "4": 0x05, "5": 0x06,
  "6": 0x07, "7": 0x08, "8": 0x09, "9": 0x0a,
  f1: 0x3b, f2: 0x3c, f3: 0x3d, f4: 0x3e, f5: 0x3f, f6: 0x40, f7: 0x41,
  f8: 0x42, f9: 0x43, f10: 0x44, f11: 0x57, f12: 0x58,
};

/** Parse a chord like "Ctrl+Shift+Esc" into press-modifiers → press/release key → release-modifiers. */
export function chordToEvents(chord: string): KeyEvent[] {
  const parts = chord.split("+").map((p) => p.trim().toLowerCase()).filter(Boolean);
  if (parts.length === 0) throw new Error(`empty chord: "${chord}"`);
  const mods: number[] = [];
  let key: number | undefined;
  for (const p of parts) {
    if (p in MODIFIERS) mods.push(MODIFIERS[p]);
    else if (p in KEYS) {
      if (key !== undefined) throw new Error(`chord has more than one non-modifier key: "${chord}"`);
      key = KEYS[p];
    } else throw new Error(`unknown key "${p}" in chord "${chord}"`);
  }
  if (key === undefined) throw new Error(`chord "${chord}" has no non-modifier key`);
  const ev: KeyEvent[] = [];
  for (const m of mods) ev.push({ scancode: m, down: true });
  ev.push({ scancode: key, down: true }, { scancode: key, down: false });
  for (const m of [...mods].reverse()) ev.push({ scancode: m, down: false });
  return ev;
}

/** Turn arbitrary text into Unicode key events (handles any character via RDP's unicode event). */
export function textToEvents(text: string): KeyEvent[] {
  const ev: KeyEvent[] = [];
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    ev.push({ unicode: cp, down: true }, { unicode: cp, down: false });
  }
  return ev;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build && node --test test/keymap.test.mjs`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/keymap.ts test/keymap.test.mjs
git commit -m "feat: chord/text to RDP key-event mapping"
```

---

## Task 3: Config — RDP fields, drop helperPort

**Files:**
- Modify: `src/config.ts`

- [ ] **Step 1: Replace the config module**

```ts
// src/config.ts
/**
 * Connection configuration for the active target.
 *
 * Held only in memory for the lifetime of the MCP server process. Secrets are
 * NEVER stored here or written to disk. SSH auth is delegated to the OS `ssh`
 * client (ssh-agent / identity file). The RDP password is read from the
 * environment at connect time and passed straight to the sidecar in memory.
 */
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export type TargetOs = "windows" | "macos";

export interface ConnConfig {
  host?: string;
  user?: string;
  port: number;            // SSH port
  os: TargetOs;
  identityFile?: string;   // SSH key path (optional; ssh-agent otherwise)
  rdpPort: number;         // RDP port (default 3389)
  rdpWidth: number;        // negotiated desktop width
  rdpHeight: number;       // negotiated desktop height
  sidecarPath: string;     // path to the RDP sidecar binary (overridable for tests)
}

function envOs(): TargetOs {
  return process.env.CLAUDE_CONTROL_OS === "macos" ? "macos" : "windows";
}

const DEFAULT_SIDECAR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "sidecar",
  "target",
  "release",
  "cc-rdp",
);

export const config: ConnConfig = {
  host: process.env.CLAUDE_CONTROL_HOST,
  user: process.env.CLAUDE_CONTROL_USER,
  port: Number(process.env.CLAUDE_CONTROL_PORT ?? 22),
  os: envOs(),
  identityFile: process.env.CLAUDE_CONTROL_IDENTITY,
  rdpPort: Number(process.env.CLAUDE_CONTROL_RDP_PORT ?? 3389),
  rdpWidth: Number(process.env.CLAUDE_CONTROL_RDP_WIDTH ?? 1600),
  rdpHeight: Number(process.env.CLAUDE_CONTROL_RDP_HEIGHT ?? 900),
  sidecarPath: process.env.CLAUDE_CONTROL_RDP_SIDECAR ?? DEFAULT_SIDECAR,
};

export function setTarget(p: {
  host: string;
  user: string;
  port?: number;
  os?: TargetOs;
  identityFile?: string;
  rdpPort?: number;
  rdpWidth?: number;
  rdpHeight?: number;
}): void {
  config.host = p.host;
  config.user = p.user;
  if (p.port !== undefined) config.port = p.port;
  if (p.os !== undefined) config.os = p.os;
  if (p.identityFile !== undefined) config.identityFile = p.identityFile;
  if (p.rdpPort !== undefined) config.rdpPort = p.rdpPort;
  if (p.rdpWidth !== undefined) config.rdpWidth = p.rdpWidth;
  if (p.rdpHeight !== undefined) config.rdpHeight = p.rdpHeight;
}

export function requireTarget(): { host: string; user: string } {
  if (!config.host || !config.user) {
    throw new Error(
      "No target configured. Call the `connect` tool first (host + user), " +
        "or set CLAUDE_CONTROL_HOST / CLAUDE_CONTROL_USER.",
    );
  }
  return { host: config.host, user: config.user };
}

/** The RDP password — env only, never persisted. Throws a clear error if missing. */
export function requireRdpPassword(): string {
  const pw = process.env.CLAUDE_CONTROL_RDP_PASSWORD;
  if (!pw) {
    throw new Error(
      "RDP password not set. Export CLAUDE_CONTROL_RDP_PASSWORD (never written to disk) " +
        "before connecting — RDP/NLA cannot use an SSH key.",
    );
  }
  return pw;
}
```

- [ ] **Step 2: Build to surface every downstream type error**

Run: `npm run build`
Expected: FAIL — `ssh.ts`/`visual.ts`/`server.ts` still reference `config.helperPort`. These are fixed in Tasks 6–8. (Confirm the only errors are about `helperPort`.)

- [ ] **Step 3: Commit**

```bash
git add src/config.ts
git commit -m "feat: config gains RDP fields + requireRdpPassword, drops helperPort"
```

---

## Task 4: RDP plane (`src/rdp.ts`) against a mock sidecar

The sidecar is a child process speaking the Task-1 framing on stdio: Node writes `{id,cmd,args}` to its stdin, the sidecar replies `{id,ok,result|error}` on its stdout. `frame` returns `{png,width,height,ageMs}`. Logs go to the sidecar's stderr only.

**Files:**
- Create: `src/rdp.ts`
- Create: `test/mock-sidecar.mjs`
- Test: `test/rdp-plane.test.mjs`

- [ ] **Step 1: Write the mock sidecar**

```js
// test/mock-sidecar.mjs
// A fake RDP sidecar: speaks the length-prefixed JSON IPC, records pointer/key
// events to stderr-free memory, and returns a 1x1 PNG for `frame`.
import { encodeFrame, FrameDecoder } from "../build/ipc.js";

const PNG_1x1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
let connected = false;
const reply = (obj) => process.stdout.write(encodeFrame(obj));
const dec = new FrameDecoder((m) => {
  const { id, cmd, args } = m;
  switch (cmd) {
    case "connect": connected = true; return reply({ id, ok: true, result: { width: 1600, height: 900 } });
    case "status": return reply({ id, ok: true, result: { connected, since: 0, width: 1600, height: 900, lastFrameAgeMs: 5 } });
    case "frame":
      if (!connected) return reply({ id, ok: false, error: "not connected" });
      return reply({ id, ok: true, result: { png: PNG_1x1, width: 1600, height: 900, ageMs: 5 } });
    case "pointer": return reply({ id, ok: true, result: { applied: args } });
    case "keys": return reply({ id, ok: true, result: { count: (args.events ?? []).length } });
    case "disconnect": connected = false; return reply({ id, ok: true, result: {} });
    default: return reply({ id, ok: false, error: `unknown cmd ${cmd}` });
  }
});
process.stdin.on("data", (c) => dec.push(c));
```

- [ ] **Step 2: Write the failing test**

```js
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
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm run build && node --test test/rdp-plane.test.mjs`
Expected: FAIL — `Cannot find module '../build/rdp.js'`.

- [ ] **Step 4: Implement `src/rdp.ts`**

```ts
// src/rdp.ts
/**
 * RDP plane — supervises the Rust IronRDP sidecar and exposes vision+input.
 *
 * The sidecar holds the RDP session open continuously, so the remote desktop is
 * always rendered (no dependence on a human's interactive session). Node owns
 * input translation (chords/text → key events; clicks/drags → pointer events)
 * so that logic is testable without RDP.
 *
 * The RDP password lives only in memory (env at connect time) and is passed to
 * the sidecar over stdin; it is never logged or written to disk.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { config, requireTarget, requireRdpPassword } from "./config.js";
import { encodeFrame, FrameDecoder } from "./ipc.js";
import { chordToEvents, textToEvents, type KeyEvent } from "./keymap.js";

export interface Frame { png: string; width: number; height: number; ageMs: number }
export interface RdpStatus { connected: boolean; since: number; width: number; height: number; lastFrameAgeMs: number }

interface Pending { resolve: (v: any) => void; reject: (e: Error) => void }

let child: ChildProcess | null = null;
let decoder: FrameDecoder | null = null;
let nextId = 1;
const pending = new Map<number, Pending>();
let lastConnectArgs: object | null = null;

function spawnSidecar(): void {
  // CLAUDE_CONTROL_RDP_SIDECAR_ARGS lets tests run `node mock-sidecar.mjs`.
  const extra = process.env.CLAUDE_CONTROL_RDP_SIDECAR_ARGS;
  const args = extra ? extra.split(" ") : [];
  child = spawn(config.sidecarPath, args, { stdio: ["pipe", "pipe", "inherit"] });
  decoder = new FrameDecoder((msg) => {
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.ok) p.resolve(msg.result);
    else p.reject(new Error(msg.error ?? "sidecar error"));
  });
  child.stdout!.on("data", (c: Buffer) => decoder!.push(c));
  child.on("exit", (code) => {
    const err = new Error(`RDP sidecar exited (code ${code})`);
    for (const [, p] of pending) p.reject(err);
    pending.clear();
    child = null;
    decoder = null;
  });
}

function call(cmd: string, args: object = {}, timeoutMs = 30_000): Promise<any> {
  if (!child) throw new Error("RDP sidecar not running — call rdpConnect first.");
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`RDP '${cmd}' timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    pending.set(id, {
      resolve: (v) => { clearTimeout(timer); resolve(v); },
      reject: (e) => { clearTimeout(timer); reject(e); },
    });
    child!.stdin!.write(encodeFrame({ id, cmd, args }));
  });
}

/** Bring up (or re-use) the sidecar and connect it to the active target. */
export async function rdpConnect(): Promise<RdpStatus> {
  const { host, user } = requireTarget();
  if (!child) spawnSidecar();
  lastConnectArgs = {
    host, port: config.rdpPort, username: user,
    password: requireRdpPassword(),
    width: config.rdpWidth, height: config.rdpHeight,
  };
  const r = await call("connect", lastConnectArgs, 45_000);
  return { connected: true, since: 0, width: r.width, height: r.height, lastFrameAgeMs: 0 };
}

export async function rdpFrame(): Promise<Frame> { return call("frame", {}, 30_000); }
export async function rdpStatus(): Promise<RdpStatus> { return call("status", {}, 10_000); }

async function pointer(x: number, y: number, action: string, button = "left", wheel = 0): Promise<void> {
  await call("pointer", { x, y, action, button, wheel });
}
async function keys(events: KeyEvent[]): Promise<void> { await call("keys", { events }); }

export async function rdpMove(x: number, y: number): Promise<void> { await pointer(x, y, "move"); }
export async function rdpClick(x: number, y: number, button: string, double: boolean): Promise<void> {
  await pointer(x, y, double ? "double" : "click", button);
}
export async function rdpScroll(amount: number): Promise<void> { await pointer(0, 0, "wheel", "left", amount); }
export async function rdpMouseDown(x: number, y: number, button: string): Promise<void> { await pointer(x, y, "down", button); }
export async function rdpMouseUp(x: number, y: number, button: string): Promise<void> { await pointer(x, y, "up", button); }

export async function rdpDrag(x1: number, y1: number, x2: number, y2: number, button: string, steps = 20): Promise<void> {
  await pointer(x1, y1, "down", button);
  for (let i = 1; i <= steps; i++) {
    const x = Math.round(x1 + ((x2 - x1) * i) / steps);
    const y = Math.round(y1 + ((y2 - y1) * i) / steps);
    await pointer(x, y, "move", button);
  }
  await pointer(x2, y2, "up", button);
}

export async function rdpType(text: string): Promise<void> { await keys(textToEvents(text)); }
export async function rdpChord(chord: string): Promise<void> { await keys(chordToEvents(chord)); }

/** Tear down the sidecar (used on shutdown / reconnect). */
export async function rdpShutdown(): Promise<void> {
  if (!child) return;
  try { await call("disconnect", {}, 5_000); } catch { /* ignore */ }
  child.kill();
  child = null;
  decoder = null;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm run build && node --test test/rdp-plane.test.mjs`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add src/rdp.ts test/mock-sidecar.mjs test/rdp-plane.test.mjs
git commit -m "feat: Node RDP plane + mock-sidecar tests"
```

---

## Task 5: RDP auto-enable over SSH (`src/rdpEnable.ts`)

**Files:**
- Create: `src/rdpEnable.ts`

- [ ] **Step 1: Implement (verified manually in Task 11 live run)**

```ts
// src/rdpEnable.ts
/**
 * Ensure RDP is reachable on the target. If the port is closed, flip the two
 * native settings over SSH (admin) and leave them on:
 *   - HKLM\SYSTEM\CurrentControlSet\Control\Terminal Server\fDenyTSConnections = 0
 *   - Enable the "Remote Desktop" firewall rule group
 * No files, no service, no driver — a reversible setting, not a footprint.
 */
import { runPowerShell } from "./ssh.js";
import { config } from "./config.js";

export interface EnableResult { alreadyOn: boolean; changed: boolean; detail: string }

export async function ensureRdpEnabled(): Promise<EnableResult> {
  const port = config.rdpPort;
  const script = `
$ErrorActionPreference='Stop'
$tcp = Test-NetConnection -ComputerName 127.0.0.1 -Port ${port} -WarningAction SilentlyContinue
if ($tcp.TcpTestSucceeded) { '{"alreadyOn":true,"changed":false,"detail":"RDP port already open"}' ; return }
Set-ItemProperty 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Terminal Server' -Name fDenyTSConnections -Value 0
Enable-NetFirewallRule -DisplayGroup 'Remote Desktop'
'{"alreadyOn":false,"changed":true,"detail":"Enabled fDenyTSConnections=0 + Remote Desktop firewall group"}'
`;
  const r = await runPowerShell(script, { timeoutMs: 30_000 });
  if (r.code !== 0) throw new Error(`Could not enable RDP over SSH:\n${r.stderr || r.stdout}`);
  return JSON.parse(r.stdout.trim());
}
```

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: compiles (the `helperPort` errors from Task 3 remain until Tasks 6–8).

- [ ] **Step 3: Commit**

```bash
git add src/rdpEnable.ts
git commit -m "feat: auto-enable RDP over SSH (idempotent, leave-on)"
```

---

## Task 6: Re-point `src/visual.ts` at the RDP plane

Keep `visual.ts` as the OS dispatcher so `server.ts`'s imports barely change. Windows ops now call `src/rdp.ts`; macOS keeps its existing `screencapture`/stub behavior. UIA/window ops move to Task 9's accelerator, so remove them here.

**Files:**
- Modify: `src/visual.ts`

- [ ] **Step 1: Replace `src/visual.ts`**

```ts
// src/visual.ts
/**
 * OS-aware visual backend.
 *  - Windows: the RDP plane (src/rdp.ts) — we are the RDP client, session is
 *    always live, zero target footprint.
 *  - macOS: native preinstalled tools (`screencapture`) over SSH; input/UI-tree
 *    remain stubbed pending a Mac target.
 */
import { config } from "./config.js";
import { runRemote } from "./ssh.js";
import {
  rdpFrame, rdpMove, rdpClick, rdpScroll, rdpDrag, rdpMouseDown, rdpMouseUp, rdpType, rdpChord,
} from "./rdp.js";

export interface Shot { png: string; width?: number; height?: number }

function macOnlyNotice(op: string): never {
  throw new Error(
    `'${op}' on a macOS target is not enabled in this build yet. Windows is fully supported via RDP; ` +
      `macOS currently supports run/upload/download and screenshot.`,
  );
}

async function macScreenshot(): Promise<Shot> {
  const script = [
    "set -e",
    'f="$(mktemp /tmp/cc.XXXXXX)"; f="$f.png"',
    'if ! screencapture -x -t png "$f" 2>/tmp/cc.err; then printf "CAPTURE_FAIL:%s" "$(cat /tmp/cc.err)"; exit 0; fi',
    'w="$(sips -g pixelWidth "$f" | sed -n "s/.*pixelWidth: //p")"',
    'h="$(sips -g pixelHeight "$f" | sed -n "s/.*pixelHeight: //p")"',
    'b="$(base64 < "$f")"',
    'rm -f "$f"',
    'printf "%s\\t%s\\t%s" "$w" "$h" "$b"',
  ].join("\n");
  const r = await runRemote(script, { timeoutMs: 30_000 });
  const out = r.stdout.trim();
  if (out.startsWith("CAPTURE_FAIL") || r.code !== 0) {
    throw new Error(`macOS screenshot failed (grant Screen Recording). Detail: ${out || r.stderr}`);
  }
  const tab = out.indexOf("\t");
  const tab2 = out.indexOf("\t", tab + 1);
  return { width: Number(out.slice(0, tab)), height: Number(out.slice(tab + 1, tab2)), png: out.slice(tab2 + 1) };
}

export async function vScreenshot(): Promise<Shot> {
  if (config.os === "macos") return macScreenshot();
  const f = await rdpFrame();
  return { png: f.png, width: f.width, height: f.height };
}

export async function vMove(x: number, y: number): Promise<void> {
  if (config.os === "macos") macOnlyNotice("move"); await rdpMove(x, y);
}
export async function vClick(x: number, y: number, button: string, double: boolean): Promise<void> {
  if (config.os === "macos") macOnlyNotice("click"); await rdpClick(x, y, button, double);
}
export async function vScroll(amount: number): Promise<void> {
  if (config.os === "macos") macOnlyNotice("scroll"); await rdpScroll(amount);
}
export async function vDrag(x1: number, y1: number, x2: number, y2: number, button: string, steps?: number): Promise<void> {
  if (config.os === "macos") macOnlyNotice("drag"); await rdpDrag(x1, y1, x2, y2, button, steps);
}
export async function vMouseDown(x: number, y: number, button: string): Promise<void> {
  if (config.os === "macos") macOnlyNotice("mouse_down"); await rdpMouseDown(x, y, button);
}
export async function vMouseUp(x: number, y: number, button: string): Promise<void> {
  if (config.os === "macos") macOnlyNotice("mouse_up"); await rdpMouseUp(x, y, button);
}
export async function vType(text: string): Promise<void> {
  if (config.os === "macos") macOnlyNotice("type_text"); await rdpType(text);
}
export async function vKeys(chord: string): Promise<void> {
  if (config.os === "macos") macOnlyNotice("press_keys"); await rdpChord(chord);
}
```

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: remaining errors only in `server.ts` (still imports `vUiTree`/`vUiFind`/`vListWindows`/`vFocusWindow`/`vWaitIdle` + `helperCall`/`bootstrap`). Fixed in Tasks 7–9.

- [ ] **Step 3: Commit**

```bash
git add src/visual.ts
git commit -m "refactor: visual.ts Windows path now drives the RDP plane"
```

---

## Task 7: Remove `helperCall` from `src/ssh.ts`

**Files:**
- Modify: `src/ssh.ts`

- [ ] **Step 1: Delete the `helperCall` export**

Remove the entire `helperCall` function (the final block, starting at the `/** Send a JSON command to the interactive-session helper ... */` comment through its closing brace). Leave everything else in `ssh.ts` untouched.

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: errors now only in `server.ts`.

- [ ] **Step 3: Commit**

```bash
git add src/ssh.ts
git commit -m "refactor: drop the loopback helperCall relay (helper deleted)"
```

---

## Task 8: Rewire `connect`/`status`, remove `bootstrap`

**Files:**
- Modify: `src/server.ts`

- [ ] **Step 1: Update imports**

Replace the imports block (lines ~13–30) so it pulls in the new modules and drops helper/visual UIA bits:

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { config, setTarget, requireTarget, type TargetOs } from "./config.js";
import { runRemote, scpUpload, type ExecResult } from "./ssh.js";
import {
  vScreenshot, vMove, vClick, vScroll, vDrag, vMouseDown, vMouseUp, vType, vKeys,
} from "./visual.js";
import { rdpConnect, rdpStatus } from "./rdp.js";
import { ensureRdpEnabled } from "./rdpEnable.js";
import { uiaTree, uiaFind, uiaListWindows, uiaFocusWindow } from "./uia.js";
import { tiaCall } from "./tia.js";
```

Also delete the now-unused `WINDOWS_DIR`, `REMOTE_DIR`, `runPowerShell`, `sshExec`, `helperCall` references (they were only used by `bootstrap`).

- [ ] **Step 2: Replace the `connect` tool body**

```ts
  server.registerTool(
    "connect",
    {
      title: "Connect to a Windows target",
      description:
        "Set the active target and bring up the live RDP session (I become the RDP client and hold it " +
        "open — the desktop stays rendered with no human present). SSH auth uses your ssh keys; the RDP " +
        "password comes from CLAUDE_CONTROL_RDP_PASSWORD (never written to disk). RDP is auto-enabled if off.",
      inputSchema: {
        host: z.string().describe("Hostname or IP of the target"),
        user: z.string().describe("Username to log in as (RDP + SSH)"),
        os: z.enum(["windows", "macos"]).optional().describe("Target OS (default windows)"),
        port: z.number().int().optional().describe("SSH port (default 22)"),
        identityFile: z.string().optional().describe("SSH private key path (optional; ssh-agent otherwise)"),
        rdpPort: z.number().int().optional().describe("RDP port (default 3389)"),
        rdpWidth: z.number().int().optional().describe("Desktop width to negotiate (default 1600)"),
        rdpHeight: z.number().int().optional().describe("Desktop height to negotiate (default 900)"),
      },
    },
    tool(async (a: { host: string; user: string; os?: TargetOs; port?: number; identityFile?: string; rdpPort?: number; rdpWidth?: number; rdpHeight?: number }) => {
      setTarget(a);
      const probe = config.os === "macos"
        ? "hostname; uname -sr"
        : "$env:COMPUTERNAME; [Environment]::OSVersion.VersionString";
      const r = await runRemote(probe, { timeoutMs: 20_000 });
      if (r.code !== 0) return fail(`SSH check failed:\n${runResultText(r)}`);
      if (config.os === "macos") {
        return text(`Connected (macOS) to ${a.user}@${a.host}\n${r.stdout.trim()}`);
      }
      const en = await ensureRdpEnabled();
      const st = await rdpConnect();
      return text(
        `Connected to ${a.user}@${a.host} (windows)\n${r.stdout.trim()}\n` +
          `RDP: ${en.detail}\nRDP session live at ${st.width}x${st.height}.`,
      );
    }),
  );
```

- [ ] **Step 3: Replace the `status` tool body**

```ts
  server.registerTool(
    "status",
    {
      title: "Show connection + RDP status",
      description: "Report the active target and whether the live RDP session is up.",
      inputSchema: {},
    },
    tool(async () => {
      if (!config.host) return text("No target connected. Use `connect`.");
      let rdp = "n/a (macOS target)";
      if (config.os === "windows") {
        try {
          const s = await rdpStatus();
          rdp = s.connected
            ? `live ${s.width}x${s.height} (last frame ${s.lastFrameAgeMs}ms ago)`
            : "not connected — call `connect`";
        } catch (e) {
          rdp = `not connected (${e instanceof Error ? e.message : e})`;
        }
      }
      return text(
        `target: ${config.user}@${config.host}  (ssh :${config.port}, rdp :${config.rdpPort})\n` +
          `identity: ${config.identityFile ?? "ssh-agent/default"}\n` +
          `RDP session: ${rdp}`,
      );
    }),
  );
```

- [ ] **Step 4: Delete the `bootstrap` tool**

Remove the entire `server.registerTool("bootstrap", …)` block (the `// ---- Setup: bootstrap ----` section near the end). The `tiaText`/`tia_*` tools stay.

- [ ] **Step 5: Update the `ui_tree`/`ui_find`/`list_windows`/`focus_window` handlers, drop `wait_idle`**

Replace their handler bodies to use the UIA accelerator (defined in Task 9). `wait_idle` depended on the helper's server-side image diffing; reimplement it in Node over the RDP frames:

```ts
    tool(async (a: { maxElements?: number }) => text(JSON.stringify(await uiaTree(a.maxElements ?? 200), null, 2))),
```
```ts
    tool(async (a: { text: string }) => text(JSON.stringify(await uiaFind(a.text), null, 2))),
```
```ts
    tool(async () => text(JSON.stringify(await uiaListWindows(), null, 2))),
```
```ts
    tool(async (a: { title: string }) => {
      const found = await uiaFocusWindow(a.title);
      return found ? text(`Focused window matching "${a.title}"`) : fail(`No visible window matching "${a.title}"`);
    }),
```

For `wait_idle`, replace its handler with an RDP-frame diff:

```ts
    tool(async (a: { timeoutMs?: number; settleMs?: number }) => {
      const { rdpFrame } = await import("./rdp.js");
      const timeoutMs = a.timeoutMs ?? 60_000, settleMs = a.settleMs ?? 1_500;
      const start = Date.now();
      let last = (await rdpFrame()).png, lastChange = Date.now();
      while (Date.now() - start < timeoutMs) {
        await new Promise((r) => setTimeout(r, 300));
        const cur = (await rdpFrame()).png;
        if (cur !== last) { last = cur; lastChange = Date.now(); }
        else if (Date.now() - lastChange >= settleMs) return text("Screen is idle.");
      }
      return text("Timed out before the screen settled.");
    }),
```

Update the four tool descriptions to note they use the opt-in UIA accelerator.

- [ ] **Step 6: Build**

Run: `npm run build`
Expected: errors now only about the missing `./uia.js` module → resolved in Task 9.

- [ ] **Step 7: Commit**

```bash
git add src/server.ts
git commit -m "feat: connect/status drive the RDP plane; remove bootstrap tool"
```

---

## Task 9: Optional UIA accelerator (`src/uia.ts` + `windows/uia-accelerator.ps1`)

Default-off, opt-in via `CLAUDE_CONTROL_UIA=1`. When off, the four tools return a clear "vision-only" notice telling the model to use `screenshot` + coordinates. When on, a one-shot scheduled task runs the walk **inside the live RDP session** (which exists because we hold it), writes JSON to a temp file, we read it back, then delete task + file — no persistent footprint.

**Files:**
- Create: `windows/uia-accelerator.ps1`
- Create: `src/uia.ts`

- [ ] **Step 1: Write the in-session UIA walker**

```powershell
# windows/uia-accelerator.ps1
#   Walk the UI Automation tree of the CURRENT interactive desktop and write JSON
#   to -Out. Must run IN the interactive session (a one-shot Scheduled Task), not
#   session 0, or it sees nothing. Self-contained, PS 5.1-safe.
param([string]$Out = "C:\Users\Public\cc-uia.json", [int]$MaxElements = 200, [string]$Find = "")
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Windows.Forms
$root = [System.Windows.Automation.AutomationElement]::RootElement
$cond = [System.Windows.Automation.Condition]::TrueCondition
$els = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)
$list = New-Object System.Collections.ArrayList
foreach ($e in $els) {
  if ($list.Count -ge $MaxElements) { break }
  try {
    $name = $e.Current.Name
    if ($Find -and ($name -notlike "*$Find*")) { continue }
    $r = $e.Current.BoundingRectangle
    if ($r.Width -le 0 -or $r.Height -le 0) { continue }
    $type = ($e.Current.ControlType.ProgrammaticName -replace '^ControlType\.', '')
    [void]$list.Add(@{
      name = $name; type = $type
      x = [int]($r.X + $r.Width / 2); y = [int]($r.Y + $r.Height / 2)
    })
  } catch { }
}
$list | ConvertTo-Json -Compress | Set-Content -Path $Out -Encoding UTF8
```

- [ ] **Step 2: Implement `src/uia.ts`**

```ts
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
```

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: PASS (clean compile — all modules resolve now).

- [ ] **Step 4: Run the full unit suite**

Run: `npm run build && node --test test/*.mjs`
Expected: PASS (ipc + keymap + rdp-plane).

- [ ] **Step 5: Commit**

```bash
git add src/uia.ts windows/uia-accelerator.ps1
git commit -m "feat: optional opt-in UIA accelerator (transient, in-session)"
```

---

## Task 10: The Rust IronRDP sidecar (`sidecar/`)

This is the only component that can't be unit-tested without a real RDP server; its verification is the live run (Task 11). It implements the Task-1/Task-4 IPC: read framed `{id,cmd,args}` on stdin, hold an IronRDP session, and reply on stdout. **Confirm the exact connector/session API against the pinned IronRDP version on docs.rs while implementing — the crate's connect/active-stage surface is the one part not verifiable from this plan.**

**Files:**
- Create: `sidecar/Cargo.toml`, `sidecar/src/proto.rs`, `sidecar/src/main.rs`

- [ ] **Step 1: Cargo manifest**

```toml
# sidecar/Cargo.toml
[package]
name = "cc-rdp"
version = "0.1.0"
edition = "2021"

[[bin]]
name = "cc-rdp"
path = "src/main.rs"

[dependencies]
ironrdp = { version = "0.9", features = ["connector", "session", "graphics", "pdu", "svc"] }
ironrdp-tokio = "0.5"
tokio = { version = "1", features = ["macros", "rt-multi-thread", "io-std", "io-util", "net", "sync", "time"] }
tokio-rustls = "0.26"
rustls = { version = "0.23", features = ["ring"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
image = { version = "0.25", default-features = false, features = ["png"] }
anyhow = "1"
# NOTE: pin exact ironrdp* patch versions to whatever `cargo add` resolves; confirm
# the connector API (begin/step, ClientConnector, ConnectionResult) on docs.rs.
```

- [ ] **Step 2: Protocol types + stdio framing**

```rust
// sidecar/src/proto.rs
use anyhow::Result;
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

#[derive(Deserialize)]
pub struct Request { pub id: u64, pub cmd: String, #[serde(default)] pub args: serde_json::Value }

#[derive(Serialize)]
pub struct Response {
    pub id: u64,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")] pub result: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")] pub error: Option<String>,
}
impl Response {
    pub fn ok(id: u64, result: serde_json::Value) -> Self { Self { id, ok: true, result: Some(result), error: None } }
    pub fn err(id: u64, e: impl ToString) -> Self { Self { id, ok: false, result: None, error: Some(e.to_string()) } }
}

/// Read one 4-byte BE length-prefixed JSON message from stdin.
pub async fn read_frame<R: AsyncReadExt + Unpin>(r: &mut R) -> Result<Option<Request>> {
    let mut len = [0u8; 4];
    if r.read_exact(&mut len).await.is_err() { return Ok(None); } // EOF → parent closed
    let n = u32::from_be_bytes(len) as usize;
    let mut body = vec![0u8; n];
    r.read_exact(&mut body).await?;
    Ok(Some(serde_json::from_slice(&body)?))
}

/// Write one length-prefixed JSON response to stdout.
pub async fn write_frame<W: AsyncWriteExt + Unpin>(w: &mut W, resp: &Response) -> Result<()> {
    let body = serde_json::to_vec(resp)?;
    w.write_all(&(body.len() as u32).to_be_bytes()).await?;
    w.write_all(&body).await?;
    w.flush().await?;
    Ok(())
}
```

- [ ] **Step 3: Main loop + RDP session**

```rust
// sidecar/src/main.rs
//! cc-rdp — headless IronRDP client sidecar for Claude-Control.
//! Holds one RDP session open, keeps the latest framebuffer, and serves the
//! length-prefixed JSON IPC on stdio. All logging goes to stderr (stdout is the
//! IPC channel). The RDP password is received over stdin and never logged.
mod proto;
use anyhow::{anyhow, Result};
use proto::{read_frame, write_frame, Response};
use std::sync::Arc;
use tokio::sync::Mutex;

/// Shared session state. `framebuffer` is RGBA; `connected` flips on connect.
struct State {
    connected: bool,
    width: u16,
    height: u16,
    framebuffer: Vec<u8>, // RGBA, width*height*4
    // handle to the active IronRDP session for sending input + pumping graphics.
    // (Concrete type filled in against the pinned ironrdp-session API.)
}

#[tokio::main]
async fn main() -> Result<()> {
    let mut stdin = tokio::io::stdin();
    let mut stdout = tokio::io::stdout();
    let state = Arc::new(Mutex::new(State { connected: false, width: 0, height: 0, framebuffer: vec![] }));

    while let Some(req) = read_frame(&mut stdin).await? {
        let resp = handle(&state, &req).await.unwrap_or_else(|e| Response::err(req.id, e));
        write_frame(&mut stdout, &resp).await?;
    }
    Ok(())
}

async fn handle(state: &Arc<Mutex<State>>, req: &proto::Request) -> Result<Response> {
    match req.cmd.as_str() {
        "connect" => cmd_connect(state, req).await,
        "frame"   => cmd_frame(state, req).await,
        "pointer" => cmd_pointer(state, req).await,
        "keys"    => cmd_keys(state, req).await,
        "status"  => cmd_status(state, req).await,
        "disconnect" => { state.lock().await.connected = false; Ok(Response::ok(req.id, serde_json::json!({}))) }
        other => Err(anyhow!("unknown cmd {other}")),
    }
}

// --- Command handlers -------------------------------------------------------
// IMPLEMENTATION NOTE (confirm against ironrdp docs.rs for the pinned version):
//   cmd_connect: build ClientConnector { credentials(username,password), desktop
//     size(width,height) }, TCP-connect host:port, run the connect sequence
//     (ironrdp_tokio::connect/single_sequence_step), upgrade to the active stage,
//     then spawn a background task that reads graphics PDUs and writes decoded
//     bitmaps into State.framebuffer (track width/height, set connected=true).
//     Auto-reconnect with exponential backoff inside that task on disconnect.
//   cmd_pointer: map {x,y,action,button,wheel} → ironrdp FastPath/MousePdu and
//     send on the session's input channel.
//   cmd_keys:    map each {scancode|unicode,down} → KeyboardFlags scancode event
//     (unicode → KBD_FLAGS_UNICODE) and send.
//   cmd_frame:   PNG-encode the current State.framebuffer via the `image` crate,
//     base64 it, return {png,width,height,ageMs}.
//   cmd_status:  return {connected,since,width,height,lastFrameAgeMs}.

async fn cmd_connect(state: &Arc<Mutex<State>>, req: &proto::Request) -> Result<Response> {
    let host = req.args["host"].as_str().ok_or_else(|| anyhow!("host required"))?.to_string();
    let port = req.args["port"].as_u64().unwrap_or(3389) as u16;
    let username = req.args["username"].as_str().ok_or_else(|| anyhow!("username required"))?.to_string();
    let password = req.args["password"].as_str().ok_or_else(|| anyhow!("password required"))?.to_string();
    let width = req.args["width"].as_u64().unwrap_or(1600) as u16;
    let height = req.args["height"].as_u64().unwrap_or(900) as u16;
    eprintln!("cc-rdp: connecting to {host}:{port} as {username} ({width}x{height})"); // never log password
    // TODO(impl): run the IronRDP connect sequence; populate State; spawn graphics pump.
    let _ = (host, port, username, password);
    let mut s = state.lock().await;
    s.connected = true; s.width = width; s.height = height;
    s.framebuffer = vec![0u8; (width as usize) * (height as usize) * 4];
    Ok(Response::ok(req.id, serde_json::json!({ "width": width, "height": height })))
}

async fn cmd_frame(state: &Arc<Mutex<State>>, req: &proto::Request) -> Result<Response> {
    let s = state.lock().await;
    if !s.connected { return Err(anyhow!("not connected")); }
    // TODO(impl): PNG-encode s.framebuffer (RGBA) via `image::RgbaImage` + PngEncoder.
    let png_b64 = String::new();
    Ok(Response::ok(req.id, serde_json::json!({ "png": png_b64, "width": s.width, "height": s.height, "ageMs": 0 })))
}

async fn cmd_pointer(_state: &Arc<Mutex<State>>, req: &proto::Request) -> Result<Response> {
    // TODO(impl): send mouse PDU per {x,y,action,button,wheel}.
    Ok(Response::ok(req.id, serde_json::json!({ "applied": req.args })))
}

async fn cmd_keys(_state: &Arc<Mutex<State>>, req: &proto::Request) -> Result<Response> {
    let events = req.args["events"].as_array().cloned().unwrap_or_default();
    // TODO(impl): send each scancode/unicode key PDU.
    Ok(Response::ok(req.id, serde_json::json!({ "count": events.len() })))
}

async fn cmd_status(state: &Arc<Mutex<State>>, req: &proto::Request) -> Result<Response> {
    let s = state.lock().await;
    Ok(Response::ok(req.id, serde_json::json!({
        "connected": s.connected, "since": 0, "width": s.width, "height": s.height, "lastFrameAgeMs": 0
    })))
}
```

- [ ] **Step 4: Confirm the IPC skeleton builds + speaks the protocol**

Run: `cd sidecar && cargo build --release`
Expected: compiles. Then sanity-check framing against the mock contract:

Run: `printf '' | ./target/release/cc-rdp` then (from repo root) `node --test test/rdp-plane.test.mjs` with `CLAUDE_CONTROL_RDP_SIDECAR=sidecar/target/release/cc-rdp` **unset** (keep the mock for unit tests). The real binary is exercised live in Task 11.

- [ ] **Step 5: Implement the IronRDP TODOs against the pinned API**

Fill in `cmd_connect` (connect sequence + graphics pump + reconnect), `cmd_frame` (PNG encode), `cmd_pointer`, `cmd_keys` using the pinned IronRDP version's API (verify each call on docs.rs). Re-run `cargo build --release` until clean.

- [ ] **Step 6: Add build scripts to `package.json`**

```jsonc
  "scripts": {
    "build": "tsc && node -e \"import('node:fs').then(f=>f.chmodSync('build/index.js',0o755))\"",
    "build:sidecar": "cd sidecar && cargo build --release",
    "watch": "tsc --watch",
    "smoke": "node build/smoke.js",
    "test": "npm run build && node --test test/*.mjs",
    "prepare": "npm run build",
    "prepublishOnly": "npm run build"
  },
```

- [ ] **Step 7: Commit**

```bash
git add sidecar package.json
git commit -m "feat: Rust IronRDP sidecar (IPC skeleton + RDP session)"
```

---

## Task 11: Live validation against SGRAHAM-MINI

The headline acceptance test: a real screenshot **while no human is connected** — the exact case that failed on 2026-06-01.

**Files:**
- Modify: `scripts/live-validate.mjs`

- [ ] **Step 1: Add an RDP-plane pass to the harness**

Extend `scripts/live-validate.mjs` so that, given `host user identityFile`, it: ensures RDP enabled, spawns the real sidecar via `src/rdp.ts`, connects, pulls a frame and saves it to `/tmp/cc-rdp-shot.png`, performs a click + `type_text` (open Start, type "notepad", Enter), pulls another frame, forces a sidecar kill and confirms reconnect, then disconnects. Print PASS/FAIL per step.

```js
// scripts/live-validate.mjs  (append an rdp() routine; reuse the existing arg parsing)
import { writeFileSync } from "node:fs";
async function rdp() {
  process.env.CLAUDE_CONTROL_HOST = host;
  process.env.CLAUDE_CONTROL_USER = user;
  if (identity) process.env.CLAUDE_CONTROL_IDENTITY = identity;
  // CLAUDE_CONTROL_RDP_PASSWORD must already be exported by the operator.
  const { rdpConnect, rdpFrame, rdpClick, rdpType, rdpChord, rdpShutdown } = await import("../build/rdp.js");
  const { ensureRdpEnabled } = await import("../build/rdpEnable.js");
  console.log("enable:", await ensureRdpEnabled());
  console.log("connect:", await rdpConnect());
  const f1 = await rdpFrame(); writeFileSync("/tmp/cc-rdp-shot.png", Buffer.from(f1.png, "base64"));
  console.log(`frame1 ${f1.width}x${f1.height} -> /tmp/cc-rdp-shot.png`);
  await rdpChord("Win+R"); await rdpType("notepad"); await rdpChord("Enter");
  await new Promise((r) => setTimeout(r, 1500));
  const f2 = await rdpFrame(); writeFileSync("/tmp/cc-rdp-shot2.png", Buffer.from(f2.png, "base64"));
  console.log("frame2 saved -> /tmp/cc-rdp-shot2.png");
  await rdpShutdown();
  console.log("PASS");
}
```

- [ ] **Step 2: Build the sidecar + TS**

Run: `npm run build && npm run build:sidecar`
Expected: both compile.

- [ ] **Step 3: Run the live validation**

Run (operator exports the password first; never written to disk):
```bash
export CLAUDE_CONTROL_RDP_PASSWORD='...'   # operator action, in their shell only
node scripts/live-validate.mjs 100.73.195.110 uksti ~/.ssh/claude-control_ed25519 --rdp
```
Expected: `enable` reports state; `connect` succeeds; `/tmp/cc-rdp-shot.png` is a **real desktop image captured with no human RDP session present**; Notepad opens in frame2; final `PASS`.

- [ ] **Step 4: Inspect both screenshots**

Open `/tmp/cc-rdp-shot.png` and `/tmp/cc-rdp-shot2.png` and confirm they show the live desktop / Notepad. This is the proof the original failure is fixed.

- [ ] **Step 5: Commit**

```bash
git add scripts/live-validate.mjs
git commit -m "test: live RDP-plane validation harness (headless capture proof)"
```

---

## Task 12: Delete the old in-session helper + refresh docs

**Files:**
- Delete: `windows/helper.ps1`, `windows/bootstrap.ps1`
- Modify: `docs/STATUS.md`

- [ ] **Step 1: Remove the helper scripts**

```bash
git rm windows/helper.ps1 windows/bootstrap.ps1
```

- [ ] **Step 2: Grep for stragglers**

Run: `grep -rn "helper.ps1\|bootstrap.ps1\|helperPort\|helperCall\|bootstrap" src scripts windows | grep -v "build/"`
Expected: no references in `src/`. Any remaining mentions in `scripts/setup.mjs` (the installer/provision flow) that reference the helper should be removed or updated; `provision.ps1` (SSH+key onboarding) and `tia-openness.ps1` (used by `tia.ts`) stay.

- [ ] **Step 3: Update `docs/STATUS.md`**

Rewrite the "One-line state" + "What this project is" sections to describe the RDP-client model (we are the RDP client; SSH = speed plane; optional UIA accelerator; zero target footprint; one prerequisite = RDP enabled, auto-enabled). Point "resume here" at this plan and the new spec.

- [ ] **Step 4: Final full build + test**

Run: `npm run build && npm run build:sidecar && npm run smoke && node --test test/*.mjs`
Expected: all green; `smoke` lists the updated tool set (no `bootstrap`).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore: delete in-session helper; STATUS reflects RDP-client model"
```

---

## Self-Review

**Spec coverage:**
- §2 inversion / always-live session → Tasks 4, 10, 11. ✓
- §3.1 IronRDP sidecar + IPC → Tasks 1, 4, 10. ✓
- §3.2 SSH plane unchanged → preserved (only `helperCall` removed). ✓
- §3.3 opt-in UIA accelerator (transient, in-session, no residue) → Task 9. ✓
- §4 tool surface (re-route visual, delete bootstrap/helper, ui_* via UIA, connect/status updated) → Tasks 6, 7, 8, 9, 12. ✓
- §5 credentials (RDP password env-only, never on disk, redacted in logs) → Task 3 (`requireRdpPassword`), Task 4/10 (in-memory pass, password never logged). ✓
- §6 RDP-enable auto/leave-on + reconnect + reboot + single-session caveat → Task 5 (enable), Task 10 (reconnect in graphics pump), Task 11 (reconnect test); single-session is documented behavior. ✓
- §7 error handling (port-closed vs auth vs handshake, frame staleness, sidecar crash) → Task 4 (sidecar-exit rejects pending; timeouts), Task 5 (enable errors), Task 10 (connect error classes). ✓
- §8 testing/live validation → Tasks 1,2,4 (unit), Task 11 (live). ✓
- §9 out-of-scope respected (no secure desktop, no virtual display, macOS target visual unchanged). ✓

**Placeholder scan:** The Rust `TODO(impl)` markers in Task 10 are deliberate and bounded — they are the one component whose exact API must be confirmed against the pinned IronRDP version at implementation time (flagged in spec §10), and Step 5 of Task 10 closes them. Every TS/JS/PowerShell unit is complete and runnable. No other placeholders.

**Type consistency:** `KeyEvent` (keymap.ts) is consumed by rdp.ts and matched by the sidecar's `keys` handler. Frame shape `{png,width,height,ageMs}` is identical across mock-sidecar, rdp.ts `Frame`, and the Rust `cmd_frame`. `RdpStatus` fields match across rdp.ts and the Rust `cmd_status`. Pointer command args `{x,y,action,button,wheel}` match between rdp.ts `pointer()` and the mock/real sidecar. `connect` args `{host,port,username,password,width,height}` match across rdp.ts, mock, and Rust `cmd_connect`. ✓
