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

function rejectAllPending(err: Error): void {
  for (const [, p] of pending) p.reject(err);
  pending.clear();
}

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
  child.stdout!.on("data", (c: Buffer) => {
    try {
      decoder!.push(c);
    } catch (e) {
      // A corrupt frame means the stream is unrecoverable — fail fast.
      const err = e instanceof Error ? e : new Error(String(e));
      rejectAllPending(err);
      try { child?.kill(); } catch { /* ignore */ }
    }
  });
  child.on("exit", (code) => {
    rejectAllPending(new Error(`RDP sidecar exited (code ${code})`));
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
