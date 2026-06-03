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
