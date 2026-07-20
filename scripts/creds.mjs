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
