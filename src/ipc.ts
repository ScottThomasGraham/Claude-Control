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
  private buf: Buffer = Buffer.alloc(0);
  constructor(private readonly onMessage: (msg: any) => void) {}

  push(chunk: Buffer): void {
    this.buf = this.buf.length ? (Buffer.concat([this.buf, chunk]) as Buffer) : chunk;
    while (this.buf.length >= 4) {
      const len = this.buf.readUInt32BE(0);
      if (this.buf.length < 4 + len) break;
      const body = this.buf.subarray(4, 4 + len);
      this.buf = this.buf.subarray(4 + len);
      this.onMessage(JSON.parse(body.toString("utf8")));
    }
  }
}
