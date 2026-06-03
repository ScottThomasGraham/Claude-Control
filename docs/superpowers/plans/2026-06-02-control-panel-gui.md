# Control Panel & Credential GUI — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user set the RDP password once (stored in the macOS Keychain, never a file), have the MCP server read it at connect time, and surface every live session's status + latest screen frame in a native macOS control-panel window.

**Architecture:** Thin GUI + per-session server. Two decoupled contracts: a Keychain credential scheme (`service=claude-control-rdp`, `account=user@host`) and a per-session state directory (`~/Library/Application Support/claude-control/sessions/<id>/{status.json,frame.png}`). The Node MCP server reads creds at connect time and writes its session state; the Swift/AppKit `.app` reads state and manages creds. Neither calls the other directly.

**Tech Stack:** TypeScript/Node (server, `node --test`), Swift/AppKit (`swiftc`, no extra toolchain), `iconutil`/CoreGraphics (icon), `/usr/bin/security` (Keychain).

**Spec:** `docs/superpowers/specs/2026-06-02-control-panel-gui-design.md`

---

## File Structure

- Create `src/creds.ts` — Keychain credential store (backend interface + macOS `security` impl + resolution helpers).
- Modify `src/config.ts` — `requireRdpPassword(target?)` delegates to creds (env override → Keychain → throw).
- Modify `src/rdp.ts` — pass `{host,user}` to `requireRdpPassword`.
- Create `src/state.ts` — `SessionWriter` (atomic `status.json` + `frame.png`, heartbeat & frame timers) + `stateRoot()`.
- Modify `src/server.ts` — wire `SessionWriter` into `connect`; in-flight counter in the `tool()` wrapper flips working/idle/error.
- Create `scripts/creds.mjs` — terminal CLI (`set`/`get`/`rm`) sharing the Keychain scheme (Phase-1 unblock + shared contract).
- Create `test/creds.test.mjs`, `test/state.test.mjs`.
- Create `gui/Sources/main.swift` — AppKit app (window, list+detail, dir poll, Keychain via `security`).
- Create `gui/make-icon.swift` — CoreGraphics icon B → `AppIcon.iconset` → `AppIcon.icns`.
- Create `gui/build.sh` — build icon, compile, assemble `Claude-Control.app`.
- Modify `README.md` / `docs/STATUS.md` — document the GUI + creds flow.

State enum used everywhere: `"connecting" | "working" | "idle" | "stopped" | "error"` (resting state after connect = `idle`; `connected` is folded into `idle`). Keychain scheme: service `claude-control-rdp`, account `${user}@${host}`.

---

# PHASE 1 — Keychain credentials (unblocks the live TIA task)

### Task 1: Credential store module

**Files:** Create `src/creds.ts`; Test `test/creds.test.mjs`

- [ ] **Step 1: Write the failing test** — `test/creds.test.mjs`

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { setCredBackend, getCredential, setCredential, removeCredential, accountFor } from "../build/creds.js";

function memBackend() {
  const m = new Map();
  return {
    store: m,
    get: (a) => (m.has(a) ? m.get(a) : null),
    set: (a, p) => { m.set(a, p); },
    remove: (a) => { m.delete(a); },
  };
}

test("accountFor formats user@host", () => {
  assert.equal(accountFor("1.2.3.4", "uksti"), "uksti@1.2.3.4");
});

test("set then get round-trips through the backend", () => {
  setCredBackend(memBackend());
  setCredential("1.2.3.4", "uksti", "hunter2");
  assert.equal(getCredential("1.2.3.4", "uksti"), "hunter2");
});

test("get returns null when absent", () => {
  setCredBackend(memBackend());
  assert.equal(getCredential("nope", "nobody"), null);
});

test("remove deletes the credential", () => {
  const b = memBackend();
  setCredBackend(b);
  setCredential("h", "u", "pw");
  removeCredential("h", "u");
  assert.equal(getCredential("h", "u"), null);
});
```

- [ ] **Step 2: Run it, expect FAIL** — `npm run build && node --test test/creds.test.mjs` → fails (module/exports missing).

- [ ] **Step 3: Implement** — `src/creds.ts`

```ts
// src/creds.ts
/**
 * RDP credential store. Secrets live in the macOS Keychain (OS-encrypted — NOT a
 * file), keyed by target. The shared contract with the GUI is the Keychain scheme:
 *   service = "claude-control-rdp", account = "<user>@<host>".
 */
import { execFileSync } from "node:child_process";

export const KEYCHAIN_SERVICE = "claude-control-rdp";
export const accountFor = (host: string, user: string): string => `${user}@${host}`;

export interface CredBackend {
  get(account: string): string | null;
  set(account: string, password: string): void;
  remove(account: string): void;
}

/** macOS Keychain via the `security` CLI. `-A` lets the server read without a prompt. */
export const keychainBackend: CredBackend = {
  get(account) {
    try {
      return execFileSync(
        "/usr/bin/security",
        ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account, "-w"],
        { encoding: "utf8" },
      ).replace(/\n$/, "");
    } catch {
      return null; // not found
    }
  },
  set(account, password) {
    execFileSync(
      "/usr/bin/security",
      ["add-generic-password", "-U", "-A", "-s", KEYCHAIN_SERVICE, "-a", account, "-w", password],
      { stdio: "ignore" },
    );
  },
  remove(account) {
    try {
      execFileSync(
        "/usr/bin/security",
        ["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account],
        { stdio: "ignore" },
      );
    } catch { /* absent is fine */ }
  },
};

let backend: CredBackend = keychainBackend;
export function setCredBackend(b: CredBackend): void { backend = b; }

export function getCredential(host: string, user: string): string | null {
  return backend.get(accountFor(host, user));
}
export function setCredential(host: string, user: string, password: string): void {
  backend.set(accountFor(host, user), password);
}
export function removeCredential(host: string, user: string): void {
  backend.remove(accountFor(host, user));
}
```

- [ ] **Step 4: Run it, expect PASS** — `npm run build && node --test test/creds.test.mjs`.

- [ ] **Step 5: Commit** — `git add src/creds.ts test/creds.test.mjs && git commit -m "feat(creds): Keychain-backed RDP credential store"`

### Task 2: Resolve the password through creds in config.ts

**Files:** Modify `src/config.ts`

- [ ] **Step 1:** Replace the existing `requireRdpPassword()` with:

```ts
import { getCredential } from "./creds.js";

/**
 * The RDP password — env override → Keychain (per target) → throw. Never persisted.
 */
export function requireRdpPassword(target?: { host?: string; user?: string }): string {
  const env = process.env.CLAUDE_CONTROL_RDP_PASSWORD;
  if (env) return env;
  const host = target?.host ?? config.host;
  const user = target?.user ?? config.user;
  if (host && user) {
    const pw = getCredential(host, user);
    if (pw) return pw;
  }
  throw new Error(
    `RDP password not set for ${user ?? "?"}@${host ?? "?"}. ` +
      "Open Claude-Control and save the password for this target, " +
      "or export CLAUDE_CONTROL_RDP_PASSWORD.",
  );
}
```

- [ ] **Step 2:** `src/rdp.ts` line ~91: change `password: requireRdpPassword(),` to `password: requireRdpPassword({ host, user }),` (`host`/`user` already destructured from `requireTarget()` above it).

- [ ] **Step 3:** `npm run build` → zero errors. `npm run smoke` → SMOKE OK (28 tools unchanged).

- [ ] **Step 4: Commit** — `git add src/config.ts src/rdp.ts && git commit -m "feat(config): resolve RDP password from Keychain at connect time"`

### Task 3: Creds CLI (terminal unblock + shared contract)

**Files:** Create `scripts/creds.mjs`

- [ ] **Step 1:** Implement (uses the built module so the scheme stays single-sourced):

```js
#!/usr/bin/env node
// scripts/creds.mjs — manage RDP creds from the terminal (same Keychain scheme as the GUI).
//   node scripts/creds.mjs set <host> <user>      (prompts hidden for the password)
//   node scripts/creds.mjs get <host> <user>
//   node scripts/creds.mjs rm  <host> <user>
import { getCredential, setCredential, removeCredential } from "../build/creds.js";
import { createInterface } from "node:readline";

function promptHidden(q) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const out = process.stdout;
    rl._writeToOutput = (s) => { if (s.includes(q)) out.write(q); }; // hide echo of typed chars
    rl.question(q, (a) => { rl.close(); out.write("\n"); resolve(a); });
  });
}

const [cmd, host, user] = process.argv.slice(2);
if (!cmd || !host || !user) {
  console.error("usage: creds.mjs <set|get|rm> <host> <user>");
  process.exit(2);
}
if (cmd === "get") {
  const pw = getCredential(host, user);
  console.log(pw ? "set (hidden)" : "not set");
} else if (cmd === "rm") {
  removeCredential(host, user);
  console.log(`removed ${user}@${host}`);
} else if (cmd === "set") {
  const pw = await promptHidden(`RDP password for ${user}@${host}: `);
  if (!pw) { console.error("empty password — aborted"); process.exit(1); }
  setCredential(host, user, pw);
  console.log(`saved ${user}@${host} to Keychain`);
} else {
  console.error(`unknown command: ${cmd}`); process.exit(2);
}
```

- [ ] **Step 2:** `npm run build`. Manual check (owner): `node scripts/creds.mjs set 100.73.195.110 uksti` then `node scripts/creds.mjs get 100.73.195.110 uksti` → "set (hidden)".

- [ ] **Step 3: Commit** — `git add scripts/creds.mjs && git commit -m "feat(creds): terminal CLI for setting/removing RDP creds"`

> **Phase 1 gate / live unblock:** with the password saved via Task 3, `connect` to sgraham-mini works without `CLAUDE_CONTROL_RDP_PASSWORD`. Run the original TIA task here (focus TIA Portal, open last project, open PLC properties, read the **ProfiNet name**) before continuing to Phase 2.

---

# PHASE 2 — Session state (status + latest frame)

### Task 4: SessionWriter — state directory & atomic writes

**Files:** Create `src/state.ts`; Test `test/state.test.mjs`

- [ ] **Step 1: Write the failing test** — `test/state.test.mjs`

```js
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
```

- [ ] **Step 2: Run it, expect FAIL** — `npm run build && node --test test/state.test.mjs`.

- [ ] **Step 3: Implement** — `src/state.ts`

```ts
// src/state.ts
/**
 * Per-session state directory. Each MCP server instance writes its status and the
 * latest screen frame here; the Control Panel GUI reads them. Local I/O only — no
 * model tokens. Writes are atomic (temp + rename) so the GUI never sees a half file.
 */
import { mkdirSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type SessionState = "connecting" | "working" | "idle" | "stopped" | "error";

export function stateRoot(): string {
  return (
    process.env.CLAUDE_CONTROL_STATE_DIR ??
    join(homedir(), "Library", "Application Support", "claude-control")
  );
}

export interface StatusRecord {
  sessionId: string;
  host: string;
  user: string;
  label: string | null;
  state: SessionState;
  since: number;
  lastActivityAt: number;
  lastFrameAt: number;
  lastHeartbeatAt: number;
  currentTool: string | null;
  lastError: string | null;
}

export class SessionWriter {
  readonly dir: string;
  private rec: StatusRecord;

  constructor(sessionId: string, host: string, user: string, now: number) {
    this.dir = join(stateRoot(), "sessions", sessionId);
    mkdirSync(this.dir, { recursive: true });
    this.rec = {
      sessionId, host, user, label: null, state: "connecting",
      since: now, lastActivityAt: now, lastFrameAt: 0, lastHeartbeatAt: now,
      currentTool: null, lastError: null,
    };
    this.flush();
  }

  private flush(): void {
    const tmp = join(this.dir, "status.json.tmp");
    writeFileSync(tmp, JSON.stringify(this.rec, null, 2));
    renameSync(tmp, join(this.dir, "status.json"));
  }

  setState(s: SessionState, now: number): void {
    this.rec.state = s;
    this.rec.lastActivityAt = now;
    this.rec.lastHeartbeatAt = now;
    if (s !== "error") this.rec.lastError = null;
    this.flush();
  }

  setTool(tool: string | null, now: number): void {
    this.rec.currentTool = tool;
    this.rec.state = tool ? "working" : "idle";
    this.rec.lastActivityAt = now;
    this.rec.lastHeartbeatAt = now;
    this.flush();
  }

  setError(msg: string, now: number): void {
    this.rec.state = "error";
    this.rec.lastError = msg;
    this.rec.lastActivityAt = now;
    this.rec.lastHeartbeatAt = now;
    this.flush();
  }

  heartbeat(now: number): void { this.rec.lastHeartbeatAt = now; this.flush(); }

  writeFrame(png: Buffer, now: number): void {
    const tmp = join(this.dir, "frame.png.tmp");
    writeFileSync(tmp, png);
    renameSync(tmp, join(this.dir, "frame.png"));
    this.rec.lastFrameAt = now;
    this.flush();
  }

  dispose(): void { rmSync(this.dir, { recursive: true, force: true }); }
}
```

- [ ] **Step 4: Run it, expect PASS** — `npm run build && node --test test/state.test.mjs`.

- [ ] **Step 5: Commit** — `git add src/state.ts test/state.test.mjs && git commit -m "feat(state): per-session status + frame writer"`

### Task 5: Wire SessionWriter into the server

**Files:** Modify `src/server.ts`

- [ ] **Step 1:** Add imports + module state near the top of `src/server.ts` (after existing imports):

```ts
import { SessionWriter } from "./state.js";
import { rdpFrame } from "./rdp.js";

let session: SessionWriter | null = null;
let inFlight = 0;
let frameTimer: ReturnType<typeof setInterval> | null = null;
const nowMs = () => Date.now();
```

- [ ] **Step 2:** Replace the `tool()` wrapper so every call drives session state via the in-flight counter:

```ts
function tool<A>(fn: (args: A) => Promise<ToolResult>) {
  return async (args: A): Promise<ToolResult> => {
    if (++inFlight === 1) session?.setState("working", nowMs());
    try {
      return await fn(args);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      session?.setError(msg, nowMs());
      return fail(`Error: ${msg}`);
    } finally {
      if (--inFlight === 0 && session) session.setState("idle", nowMs());
    }
  };
}
```

- [ ] **Step 3:** In the `connect` handler, after the Windows branch succeeds (right before `return text(` for the windows case), start the session + frame pump:

```ts
      // Begin a GUI-visible session: status + ~1fps frame pump.
      session?.dispose();
      session = new SessionWriter(`${process.pid}-${a.host}`, a.host, a.user, nowMs());
      session.setState("idle", nowMs());
      if (frameTimer) clearInterval(frameTimer);
      frameTimer = setInterval(() => {
        if (!session) return;
        rdpFrame()
          .then((f) => session && session.writeFrame(Buffer.from(f.png, "base64"), nowMs()))
          .catch(() => session && session.heartbeat(nowMs()));
      }, 1000);
      (frameTimer as NodeJS.Timeout).unref?.();
```

- [ ] **Step 4:** `npm run build` → zero errors. `npm run smoke` → SMOKE OK (28 tools). `node --test test/ipc.test.mjs test/keymap.test.mjs test/rdp-plane.test.mjs test/creds.test.mjs test/state.test.mjs` → all pass.

- [ ] **Step 5: Commit** — `git add src/server.ts && git commit -m "feat(server): publish session status + live frame for the GUI"`

---

# PHASE 3 — Native control-panel app (Swift/AppKit) + icon

### Task 6: Icon B generator

**Files:** Create `gui/make-icon.swift`

- [ ] **Step 1:** Implement a CoreGraphics renderer that draws the squircle + targeting brackets + cursor + green accent at each iconset size and emits PNGs.

```swift
// gui/make-icon.swift — draws Icon B (targeting cursor) into AppIcon.iconset, then iconutil.
import AppKit

func draw(_ size: Int) -> Data {
    let s = CGFloat(size)
    let img = NSImage(size: NSSize(width: s, height: s))
    img.lockFocus()
    let ctx = NSGraphicsContext.current!.cgContext
    // squircle background
    let inset = s * 0.06
    let rect = CGRect(x: inset, y: inset, width: s - 2*inset, height: s - 2*inset)
    let bg = NSBezierPath(roundedRect: rect, xRadius: s*0.22, yRadius: s*0.22)
    let grad = NSGradient(starting: NSColor(white: 0.17, alpha: 1), ending: NSColor(white: 0.09, alpha: 1))!
    grad.draw(in: bg, angle: -70)
    // targeting brackets
    ctx.setStrokeColor(NSColor(white: 0.92, alpha: 1).cgColor)
    ctx.setLineWidth(s*0.045); ctx.setLineCap(.round)
    let m = s*0.30, g = s*0.12, b = s*0.10
    func bracket(_ cx: CGFloat, _ cy: CGFloat, _ dx: CGFloat, _ dy: CGFloat) {
        ctx.move(to: CGPoint(x: cx, y: cy + dy*b)); ctx.addLine(to: CGPoint(x: cx, y: cy))
        ctx.addLine(to: CGPoint(x: cx + dx*b, y: cy)); ctx.strokePath()
    }
    bracket(m, s-m, 1, -1); bracket(s-m, s-m, -1, -1); bracket(m, m, 1, 1); bracket(s-m, m, -1, 1)
    // cursor arrow (center)
    let c = s*0.5
    ctx.setFillColor(NSColor(white: 0.92, alpha: 1).cgColor)
    ctx.move(to: CGPoint(x: c - s*0.06, y: c + s*0.12))
    ctx.addLine(to: CGPoint(x: c - s*0.06, y: c - s*0.10))
    ctx.addLine(to: CGPoint(x: c - s*0.005, y: c - s*0.04))
    ctx.addLine(to: CGPoint(x: c + s*0.03, y: c - s*0.075))
    ctx.addLine(to: CGPoint(x: c + s*0.065, y: c - s*0.055))
    ctx.addLine(to: CGPoint(x: c + s*0.03, y: c - s*0.02))
    ctx.addLine(to: CGPoint(x: c + s*0.085, y: c - s*0.005))
    ctx.closePath(); ctx.fillPath()
    // green live dot (upper-right)
    ctx.setFillColor(NSColor(red: 0.20, green: 0.78, blue: 0.35, alpha: 1).cgColor)
    ctx.fillEllipse(in: CGRect(x: s*0.66, y: s*0.66, width: s*0.12, height: s*0.12))
    img.unlockFocus()
    let tiff = img.tiffRepresentation!
    return NSBitmapImageRep(data: tiff)!.representation(using: .png, properties: [:])!
}

let out = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "AppIcon.iconset"
try? FileManager.default.createDirectory(atPath: out, withIntermediateDirectories: true)
for (size, name) in [(16,"16x16"),(32,"16x16@2x"),(32,"32x32"),(64,"32x32@2x"),
                     (128,"128x128"),(256,"128x128@2x"),(256,"256x256"),(512,"256x256@2x"),
                     (512,"512x512"),(1024,"512x512@2x")] {
    try! draw(size).write(to: URL(fileURLWithPath: "\(out)/icon_\(name).png"))
}
print("wrote \(out)")
```

- [ ] **Step 2:** Manual run (done by build.sh in Task 8): `swift gui/make-icon.swift /tmp/AppIcon.iconset && iconutil -c icns /tmp/AppIcon.iconset -o /tmp/AppIcon.icns && sips -g pixelWidth /tmp/AppIcon.icns` → reports 1024. Eyeball `/tmp/AppIcon.icns` opens in Preview, non-blank.

- [ ] **Step 3: Commit** — `git add gui/make-icon.swift && git commit -m "feat(gui): CoreGraphics generator for the targeting-cursor app icon"`

### Task 7: AppKit control-panel window (Layout A)

**Files:** Create `gui/Sources/main.swift`

- [ ] **Step 1:** Implement the app: poll `~/Library/Application Support/claude-control/sessions/*/status.json` every ~1s; left `NSTableView` of sessions with a colored status dot; right detail pane with `NSImageView` (reloads `frame.png`), target labels, an `NSSecureTextField` + Save button that writes the Keychain item via `/usr/bin/security` using the shared scheme.

```swift
// gui/Sources/main.swift — Claude-Control panel (Layout A: session list + detail).
import AppKit

let SERVICE = "claude-control-rdp"
func stateRoot() -> String {
    if let e = ProcessInfo.processInfo.environment["CLAUDE_CONTROL_STATE_DIR"] { return e }
    return NSString(string: "~/Library/Application Support/claude-control").expandingTildeInPath
}
func sessionsDir() -> String { (stateRoot() as NSString).appendingPathComponent("sessions") }

struct Session: Decodable {
    var sessionId: String; var host: String; var user: String
    var label: String?; var state: String
    var since: Double; var lastActivityAt: Double; var lastFrameAt: Double
    var lastHeartbeatAt: Double; var currentTool: String?; var lastError: String?
    var dir: String = ""
    enum CodingKeys: String, CodingKey {
        case sessionId, host, user, label, state, since, lastActivityAt, lastFrameAt, lastHeartbeatAt, currentTool, lastError
    }
}

func loadSessions() -> [Session] {
    let fm = FileManager.default
    guard let ids = try? fm.contentsOfDirectory(atPath: sessionsDir()) else { return [] }
    var out: [Session] = []
    for id in ids.sorted() {
        let dir = (sessionsDir() as NSString).appendingPathComponent(id)
        let sj = (dir as NSString).appendingPathComponent("status.json")
        guard let data = fm.contents(atPath: sj),
              var s = try? JSONDecoder().decode(Session.self, from: data) else { continue }
        s.dir = dir; out.append(s)
    }
    return out
}

func setKeychain(host: String, user: String, password: String) {
    let p = Process(); p.launchPath = "/usr/bin/security"
    p.arguments = ["add-generic-password", "-U", "-A", "-s", SERVICE, "-a", "\(user)@\(host)", "-w", password]
    try? p.run(); p.waitUntilExit()
}

func dotColor(_ state: String, stale: Bool) -> NSColor {
    if stale { return NSColor.systemGray }
    switch state {
    case "working", "connecting": return NSColor.systemGreen
    case "idle": return NSColor.systemYellow
    case "error": return NSColor.systemRed
    default: return NSColor.systemGray
    }
}

final class Controller: NSObject, NSApplicationDelegate, NSTableViewDataSource, NSTableViewDelegate {
    var window: NSWindow!
    var table: NSTableView!
    var sessions: [Session] = []
    var selected: Int = -1
    // detail views
    var titleLabel = NSTextField(labelWithString: "")
    var stateLabel = NSTextField(labelWithString: "")
    var image = NSImageView()
    var pwField = NSSecureTextField()

    func applicationDidFinishLaunching(_ n: Notification) {
        let rect = NSRect(x: 0, y: 0, width: 880, height: 560)
        window = NSWindow(contentRect: rect, styleMask: [.titled, .closable, .miniaturizable, .resizable],
                          backing: .buffered, defer: false)
        window.title = "Claude-Control"
        window.center()
        let split = NSSplitView(frame: rect); split.isVertical = true; split.dividerStyle = .thin
        split.autoresizingMask = [.width, .height]

        // left: sessions table
        let leftScroll = NSScrollView(frame: NSRect(x: 0, y: 0, width: 240, height: 560))
        table = NSTableView(); table.headerView = nil
        let col = NSTableColumn(identifier: .init("s")); col.width = 220
        table.addTableColumn(col); table.dataSource = self; table.delegate = self
        table.rowHeight = 44
        leftScroll.documentView = table; leftScroll.hasVerticalScroller = true

        // right: detail
        let right = NSView(frame: NSRect(x: 0, y: 0, width: 620, height: 560))
        titleLabel.font = .boldSystemFont(ofSize: 15)
        let stack = NSStackView(views: [titleLabel, stateLabel]); stack.orientation = .vertical
        stack.alignment = .leading; stack.frame = NSRect(x: 16, y: 510, width: 580, height: 40)
        stack.autoresizingMask = [.width, .minYMargin]
        image.frame = NSRect(x: 16, y: 120, width: 588, height: 360)
        image.imageScaling = .scaleProportionallyUpOrDown
        image.wantsLayer = true; image.layer?.backgroundColor = NSColor.black.cgColor
        image.autoresizingMask = [.width, .height]
        let pwLabel = NSTextField(labelWithString: "RDP password:")
        pwLabel.frame = NSRect(x: 16, y: 70, width: 110, height: 24)
        pwField.frame = NSRect(x: 130, y: 68, width: 320, height: 26)
        let save = NSButton(title: "Save", target: self, action: #selector(savePassword))
        save.frame = NSRect(x: 458, y: 66, width: 80, height: 30)
        right.addSubview(stack); right.addSubview(image)
        right.addSubview(pwLabel); right.addSubview(pwField); right.addSubview(save)

        split.addSubview(leftScroll); split.addSubview(right)
        window.contentView = split
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)

        refresh()
        Timer.scheduledTimer(withTimeInterval: 1.0, repeats: true) { _ in self.refresh() }
    }

    func refresh() {
        sessions = loadSessions()
        table.reloadData()
        if selected >= 0 && selected < sessions.count { showDetail(sessions[selected]) }
        else { titleLabel.stringValue = sessions.isEmpty ? "No active sessions" : "Select a session" }
    }

    func showDetail(_ s: Session) {
        let stale = Date().timeIntervalSince1970 - s.lastHeartbeatAt > 10
        titleLabel.stringValue = "\(s.label ?? s.host)  ·  \(s.user)@\(s.host)"
        var line = stale ? "stopped (no response)" : s.state
        if let t = s.currentTool, s.state == "working" { line += " · \(t)" }
        if let e = s.lastError, s.state == "error" { line += " — \(e)" }
        stateLabel.stringValue = line
        let fp = (s.dir as NSString).appendingPathComponent("frame.png")
        if let img = NSImage(contentsOfFile: fp) { image.image = img }
    }

    @objc func savePassword() {
        guard selected >= 0 && selected < sessions.count else { return }
        let s = sessions[selected]
        setKeychain(host: s.host, user: s.user, password: pwField.stringValue)
        pwField.stringValue = ""
        let a = NSAlert(); a.messageText = "Saved password for \(s.user)@\(s.host)"; a.runModal()
    }

    // table data source / delegate
    func numberOfRows(in t: NSTableView) -> Int { sessions.count }
    func tableView(_ t: NSTableView, viewFor col: NSTableColumn?, row: Int) -> NSView? {
        let s = sessions[row]
        let stale = Date().timeIntervalSince1970 - s.lastHeartbeatAt > 10
        let v = NSView(frame: NSRect(x: 0, y: 0, width: 220, height: 44))
        let dot = NSView(frame: NSRect(x: 10, y: 16, width: 12, height: 12))
        dot.wantsLayer = true; dot.layer?.cornerRadius = 6
        dot.layer?.backgroundColor = dotColor(s.state, stale: stale).cgColor
        let lbl = NSTextField(labelWithString: "\(s.label ?? s.host)\n\(stale ? "stopped" : s.state)")
        lbl.frame = NSRect(x: 30, y: 4, width: 185, height: 36); lbl.font = .systemFont(ofSize: 12)
        lbl.maximumNumberOfLines = 2
        v.addSubview(dot); v.addSubview(lbl)
        return v
    }
    func tableViewSelectionDidChange(_ n: Notification) {
        selected = table.selectedRow
        if selected >= 0 && selected < sessions.count { showDetail(sessions[selected]) }
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.regular)
let c = Controller()
app.delegate = c
app.run()
```

- [ ] **Step 2: Commit** — `git add gui/Sources/main.swift && git commit -m "feat(gui): AppKit control-panel window (Layout A)"`

### Task 8: Build script → Claude-Control.app

**Files:** Create `gui/build.sh`

- [ ] **Step 1:** Implement:

```bash
#!/usr/bin/env bash
# gui/build.sh — build Claude-Control.app (icon + binary + bundle) into gui/dist/.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
DIST="$HERE/dist"; APP="$DIST/Claude-Control.app"
rm -rf "$DIST"; mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

# 1) icon
ICONSET="$(mktemp -d)/AppIcon.iconset"
swift "$HERE/make-icon.swift" "$ICONSET"
iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/AppIcon.icns"

# 2) binary
swiftc -O "$HERE/Sources/main.swift" -o "$APP/Contents/MacOS/Claude-Control" \
  -framework AppKit

# 3) Info.plist
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>Claude-Control</string>
  <key>CFBundleDisplayName</key><string>Claude-Control</string>
  <key>CFBundleIdentifier</key><string>com.scottgraham.claude-control</string>
  <key>CFBundleVersion</key><string>0.1.0</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>Claude-Control</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>NSHighResolutionCapable</key><true/>
</dict></plist>
PLIST

echo "built $APP"
```

- [ ] **Step 2:** `chmod +x gui/build.sh && bash gui/build.sh` → "built …/Claude-Control.app", zero errors. `test -f gui/dist/Claude-Control.app/Contents/Resources/AppIcon.icns`.

- [ ] **Step 3:** Smoke-launch headless-safe: `open gui/dist/Claude-Control.app` (owner confirms a window appears with the icon in the Dock; with no sessions it reads "No active sessions"). Add `gui/dist/` to `.gitignore`.

- [ ] **Step 4: Commit** — `git add gui/build.sh .gitignore && git commit -m "feat(gui): build script assembling Claude-Control.app with icon"`

### Task 9: Docs

**Files:** Modify `README.md`, `docs/STATUS.md`

- [ ] **Step 1:** Document: set the password with `node scripts/creds.mjs set <host> <user>` or the GUI; build the GUI with `bash gui/build.sh`; what the status dots mean; the Keychain scheme + state dir contract. Note `CLAUDE_CONTROL_RDP_PASSWORD` is now an optional override.

- [ ] **Step 2: Commit** — `git add README.md docs/STATUS.md && git commit -m "docs: Control Panel GUI + Keychain credential flow"`

---

## Verification & push

- [ ] `npm run build` (zero errors), `npm run smoke` (SMOKE OK, 28 tools), `node --test test/*.test.mjs` (all pass), `bash gui/build.sh` (app built).
- [ ] Live: `connect` to sgraham-mini with no env password (reads Keychain); GUI shows the session green + a live frame.
- [ ] `git push -u origin feat/control-panel-gui` (personal remote: github.com/ScottThomasGraham).

## Self-review notes

- Spec coverage: creds (T1–3), connect-time resolution (T2), state dir + status + frame (T4–5), multi-session (sessionId = `pid-host`, GUI lists all), Layout A (T7), icon B (T6,T8), Keychain scheme shared by node+Swift+CLI, env override retained. Disconnect = out of scope (spec Phase 3 optional) — omitted deliberately.
- Headless-read gotcha handled via `security -A` in both `creds.ts` and the GUI.
- Type consistency: `StatusRecord` fields match the Swift `Session` decoder keys and the GUI's `dotColor` states (`connecting|working|idle|stopped|error`).
