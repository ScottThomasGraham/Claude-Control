// test/creds.test.mjs
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
