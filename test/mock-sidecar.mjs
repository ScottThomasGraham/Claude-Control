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
