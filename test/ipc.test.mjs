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

test("encode -> decode round-trips an object", () => {
  const msgs = [];
  const dec = new FrameDecoder((m) => msgs.push(m));
  const original = { id: 7, cmd: "frame", args: { x: 1, nested: [true, "z"] } };
  dec.push(encodeFrame(original));
  assert.deepEqual(msgs, [original]);
});

test("oversize frame length throws", () => {
  const dec = new FrameDecoder(() => {}, 16); // tiny max for the test
  const big = encodeFrame({ payload: "this body is definitely longer than sixteen bytes" });
  assert.throws(() => dec.push(big), /too large/);
});

test("malformed JSON body throws with context", () => {
  const dec = new FrameDecoder(() => {});
  const bad = Buffer.from("not json");
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(bad.length, 0);
  assert.throws(() => dec.push(Buffer.concat([header, bad])), /not valid JSON/);
});
