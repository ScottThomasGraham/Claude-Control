// src/ipc.ts
/** Length-prefixed JSON framing for the sidecar IPC: 4-byte BE length + UTF-8 JSON. */
export function encodeFrame(obj: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(obj), "utf8");
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(body.length, 0);
  return Buffer.concat([header, body]);
}

/**
 * Streaming decoder: feed it chunks, get whole JSON messages back via the callback.
 *
 * Reads from an external subprocess, so it is defensive: a frame length larger
 * than `maxFrameBytes` (default 64 MiB) or a body that is not valid JSON throws
 * an Error with context rather than silently buffering forever or surfacing a
 * bare SyntaxError. The stream is unrecoverable after such an error (frame
 * boundaries are lost), so callers should treat a throw from `push` as fatal for
 * the connection and wrap the call accordingly.
 */
export class FrameDecoder {
  private buf: Buffer = Buffer.alloc(0);
  constructor(
    private readonly onMessage: (msg: any) => void,
    private readonly maxFrameBytes = 64 * 1024 * 1024,
  ) {}

  push(chunk: Buffer): void {
    this.buf = this.buf.length ? (Buffer.concat([this.buf, chunk]) as Buffer) : chunk;
    while (this.buf.length >= 4) {
      const len = this.buf.readUInt32BE(0);
      if (len > this.maxFrameBytes) {
        throw new Error(`IPC frame too large: ${len} bytes (max ${this.maxFrameBytes})`);
      }
      if (this.buf.length < 4 + len) break;
      const body = this.buf.subarray(4, 4 + len);
      this.buf = this.buf.subarray(4 + len);
      let msg: unknown;
      try {
        msg = JSON.parse(body.toString("utf8"));
      } catch (e) {
        throw new Error(`IPC frame is not valid JSON: ${(e as Error).message}`);
      }
      this.onMessage(msg);
    }
  }
}
