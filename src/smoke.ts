/**
 * Offline smoke test: build the server and confirm the expected tools register.
 * Does not connect any transport or touch SSH. Run: `npm run smoke`.
 */
import { buildServer } from "./server.js";

const EXPECTED = [
  "connect", "status", "run", "upload", "download",
  "screenshot", "click", "move", "scroll", "drag", "mouse_down", "mouse_up",
  "type_text", "press_keys",
  "ui_tree", "ui_find", "list_windows", "focus_window", "wait_idle",
  // Optional TIA Openness accelerator
  "tia_status", "tia_open_project", "tia_list_devices", "tia_list_blocks",
  "tia_list_tags", "tia_export_block", "tia_import_block", "tia_compile", "tia_download",
];

const server = buildServer();
// Reach into the registered tools (internal map) just to assert registration.
const registered = Object.keys((server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools ?? {});

const missing = EXPECTED.filter((t) => !registered.includes(t));
const extra = registered.filter((t) => !EXPECTED.includes(t));

console.log(`registered tools (${registered.length}): ${registered.sort().join(", ")}`);
if (missing.length) {
  console.error(`MISSING: ${missing.join(", ")}`);
  process.exit(1);
}
if (extra.length) {
  console.error(`UNEXPECTED: ${extra.join(", ")}`);
  process.exit(1);
}
console.log("SMOKE OK — all expected tools registered.");
