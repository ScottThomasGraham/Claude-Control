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
