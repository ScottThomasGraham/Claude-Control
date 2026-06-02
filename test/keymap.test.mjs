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
