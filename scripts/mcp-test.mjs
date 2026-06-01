/**
 * Real MCP-protocol test: spawn the built server over stdio and drive it with
 * the SDK's own Client (JSON-RPC over stdio), exercising tool listing, zod arg
 * validation, text + image content blocks — the exact path Claude Code uses.
 *   node scripts/mcp-test.mjs <host> <user> <identityFile>
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const [host, user, identityFile] = process.argv.slice(2);
const serverPath = join(dirname(fileURLToPath(import.meta.url)), "..", "build", "index.js");
const log = (m) => console.log(`\n=== ${m} ===`);

const transport = new StdioClientTransport({
  command: "node",
  args: [serverPath],
  env: { ...process.env }, // inherit PATH so ssh/scp resolve
});
const client = new Client({ name: "mcp-test", version: "0.0.0" }, { capabilities: {} });
await client.connect(transport);

log("tools/list");
const { tools } = await client.listTools();
console.log(`server advertises ${tools.length} tools:`, tools.map((t) => t.name).join(", "));

const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  return r;
};
const firstText = (r) => (r.content.find((c) => c.type === "text")?.text ?? "").trim();

log("connect");
console.log(firstText(await call("connect", { host, user, identityFile, os: "windows" })));

log("status (helper ping over MCP)");
console.log(firstText(await call("status")));

log("run (headless PowerShell over MCP)");
console.log(firstText(await call("run", { command: "$env:COMPUTERNAME; (Get-Date).ToString('s')" })));

log("screenshot (image content block over MCP)");
const shot = await call("screenshot");
const img = shot.content.find((c) => c.type === "image");
console.log(firstText(shot));
if (img) {
  writeFileSync("/tmp/cc-mcp-shot.png", Buffer.from(img.data, "base64"));
  console.log(`image block: ${img.mimeType}, saved /tmp/cc-mcp-shot.png (${Math.round(img.data.length * 0.75 / 1024)} KB)`);
} else {
  console.log("NO IMAGE BLOCK RETURNED");
}

log("list_windows");
const lw = firstText(await call("list_windows"));
console.log(lw.slice(0, 600));

log("ui_find 'Recycle' (zod string arg over MCP)");
console.log(firstText(await call("ui_find", { text: "Recycle" })).slice(0, 400));

log("press_keys 'Win' then screenshot then 'Escape'");
console.log(firstText(await call("press_keys", { keys: "Win" })));
await new Promise((s) => setTimeout(s, 1200));
const shot2 = await call("screenshot");
const img2 = shot2.content.find((c) => c.type === "image");
if (img2) { writeFileSync("/tmp/cc-mcp-shot2.png", Buffer.from(img2.data, "base64")); console.log("saved /tmp/cc-mcp-shot2.png"); }
console.log(firstText(await call("press_keys", { keys: "Escape" })));

log("drag (universal visual primitive over MCP)");
console.log(firstText(await call("drag", { x1: 320, y1: 320, x2: 440, y2: 400, steps: 12 })));

log("tia_status (OPTIONAL Openness accelerator — expect openness_found:false on the Mini)");
console.log(firstText(await call("tia_status")).slice(0, 300));

log("error-path: bad tool args (expect clean validation error, not a crash)");
try {
  const bad = await call("click", { x: "not-a-number" });
  console.log("isError:", bad.isError, "|", firstText(bad).slice(0, 200));
} catch (e) {
  console.log("rejected as:", e.message.slice(0, 200));
}

await client.close();
log("MCP TEST DONE");
