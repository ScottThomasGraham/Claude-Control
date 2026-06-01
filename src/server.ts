/**
 * Claude-Control MCP server.
 *
 * Exposes tools that let Claude Code drive a remote Windows PC over SSH using
 * only OS-preinstalled facilities (OpenSSH + PowerShell + .NET on the target,
 * the system `ssh`/`scp` on this machine).
 *
 *   Headless (work in any SSH session):   run, upload, download
 *   Visual  (need the interactive helper): screenshot, click, move, scroll,
 *                                          type_text, press_keys, ui_tree, ui_find
 *   Setup:                                 connect, status, bootstrap
 */
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { config, setTarget, requireTarget, type TargetOs } from "./config.js";
import {
  sshExec,
  runPowerShell,
  runRemote,
  helperCall,
  scpUpload,
  type ExecResult,
} from "./ssh.js";
import {
  vScreenshot, vMove, vClick, vScroll, vDrag, vMouseDown, vMouseUp, vType, vKeys, vUiTree, vUiFind,
  vListWindows, vFocusWindow, vWaitIdle,
} from "./visual.js";
import { tiaCall } from "./tia.js";

const WINDOWS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "windows");
const REMOTE_DIR = "C:/ProgramData/ClaudeControl";

type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
type ToolResult = { content: Content[]; isError?: boolean };

const text = (t: string): ToolResult => ({ content: [{ type: "text", text: t }] });
const fail = (t: string): ToolResult => ({ content: [{ type: "text", text: t }], isError: true });

/** Wrap a handler so thrown errors become clean tool errors instead of crashing the server. */
function tool<A>(fn: (args: A) => Promise<ToolResult>) {
  return async (args: A): Promise<ToolResult> => {
    try {
      return await fn(args);
    } catch (e) {
      return fail(`Error: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
}

function runResultText(r: ExecResult): string {
  const parts = [`exit_code: ${r.code}`];
  if (r.stdout.trim()) parts.push(`--- stdout ---\n${r.stdout.trimEnd()}`);
  if (r.stderr.trim()) parts.push(`--- stderr ---\n${r.stderr.trimEnd()}`);
  return parts.join("\n");
}

export function buildServer(): McpServer {
  const server = new McpServer({ name: "claude-control", version: "0.1.0" });

  // ---- Setup -------------------------------------------------------------
  server.registerTool(
    "connect",
    {
      title: "Connect to a Windows target",
      description:
        "Set the active Windows host (and verify reachability over SSH). Authentication uses your " +
        "OS ssh keys / ssh-agent — no password is ever sent or stored. Run `bootstrap` once per " +
        "machine to enable visual control.",
      inputSchema: {
        host: z.string().describe("Hostname or IP of the target"),
        user: z.string().describe("Username to log in as"),
        os: z.enum(["windows", "macos"]).optional().describe("Target OS (default windows)"),
        port: z.number().int().optional().describe("SSH port (default 22)"),
        identityFile: z.string().optional().describe("Path to a private key file (optional; uses ssh-agent otherwise)"),
        helperPort: z.number().int().optional().describe("Loopback port the Windows visual helper listens on (default 8765)"),
      },
    },
    tool(async (a: { host: string; user: string; os?: TargetOs; port?: number; identityFile?: string; helperPort?: number }) => {
      setTarget(a);
      const probe = config.os === "macos"
        ? "hostname; uname -sr; sw_vers 2>/dev/null | tr '\\n' ' '"
        : "$env:COMPUTERNAME; [Environment]::OSVersion.VersionString";
      const r = await runRemote(probe, { timeoutMs: 20_000 });
      if (r.code !== 0) return fail(`Config saved, but SSH check failed:\n${runResultText(r)}`);
      return text(`Connected to ${a.user}@${a.host}:${a.port ?? config.port} (${config.os})\n${r.stdout.trim()}`);
    }),
  );

  server.registerTool(
    "status",
    {
      title: "Show connection + helper status",
      description: "Report the active target and whether the visual helper is reachable.",
      inputSchema: {},
    },
    tool(async () => {
      if (!config.host) return text("No target connected. Use `connect`.");
      let helper = "unknown";
      try {
        const pong = await helperCall({ op: "ping" }, { timeoutMs: 12_000 });
        helper = pong?.ok !== false ? `reachable (v${pong?.version ?? "?"})` : "not reachable";
      } catch (e) {
        helper = `not reachable (${e instanceof Error ? e.message : e}). Run \`bootstrap\`.`;
      }
      return text(
        `target: ${config.user}@${config.host}:${config.port}\n` +
          `identity: ${config.identityFile ?? "ssh-agent/default"}\n` +
          `helper port: ${config.helperPort}\n` +
          `visual helper: ${helper}`,
      );
    }),
  );

  // ---- Headless ----------------------------------------------------------
  server.registerTool(
    "run",
    {
      title: "Run a shell command",
      description: "Execute a command on the target (PowerShell on Windows, /bin/sh on macOS) and return stdout/stderr/exit code. Headless — no visual helper needed.",
      inputSchema: {
        command: z.string().describe("Command to execute (PowerShell on Windows, sh on macOS)"),
        timeoutMs: z.number().int().optional().describe("Timeout in ms (default 30000)"),
      },
    },
    tool(async (a: { command: string; timeoutMs?: number }) => {
      const r = await runRemote(a.command, { timeoutMs: a.timeoutMs ?? 30_000 });
      return r.code === 0 ? text(runResultText(r)) : fail(runResultText(r));
    }),
  );

  server.registerTool(
    "upload",
    {
      title: "Upload a file to the target",
      description: "Copy a local file to the Windows PC via scp. Use forward slashes in the remote path.",
      inputSchema: {
        localPath: z.string(),
        remotePath: z.string().describe("e.g. C:/Windows/Temp/file.txt"),
      },
    },
    tool(async (a: { localPath: string; remotePath: string }) => {
      const r = await scpUpload(a.localPath, a.remotePath);
      return r.code === 0 ? text(`Uploaded -> ${a.remotePath}`) : fail(runResultText(r));
    }),
  );

  server.registerTool(
    "download",
    {
      title: "Download a file from the target",
      description: "Copy a file from the Windows PC to this machine via scp.",
      inputSchema: { remotePath: z.string(), localPath: z.string() },
    },
    tool(async (a: { remotePath: string; localPath: string }) => {
      const { scpDownload } = await import("./ssh.js");
      const r = await scpDownload(a.remotePath, a.localPath);
      return r.code === 0 ? text(`Downloaded -> ${a.localPath}`) : fail(runResultText(r));
    }),
  );

  // ---- Visual (via the interactive-session helper) -----------------------
  server.registerTool(
    "screenshot",
    {
      title: "Capture the remote desktop",
      description: "Return a PNG screenshot of the interactive desktop (Windows: via the helper — run `bootstrap` once; macOS: via screencapture — needs Screen Recording permission).",
      inputSchema: {},
    },
    tool(async () => {
      const shot = await vScreenshot();
      return {
        content: [
          { type: "text", text: `Screenshot ${shot.width ?? "?"}x${shot.height ?? "?"}` },
          { type: "image", data: shot.png, mimeType: "image/png" },
        ],
      };
    }),
  );

  server.registerTool(
    "click",
    {
      title: "Click at coordinates",
      description: "Move the mouse to (x,y) on the remote desktop and click.",
      inputSchema: {
        x: z.number().int(),
        y: z.number().int(),
        button: z.enum(["left", "right", "middle"]).optional(),
        double: z.boolean().optional(),
      },
    },
    tool(async (a: { x: number; y: number; button?: string; double?: boolean }) => {
      await vClick(a.x, a.y, a.button ?? "left", !!a.double);
      return text(`Clicked ${a.button ?? "left"}${a.double ? " (double)" : ""} at (${a.x}, ${a.y})`);
    }),
  );

  server.registerTool(
    "move",
    {
      title: "Move the mouse",
      description: "Move the mouse cursor to (x,y) without clicking.",
      inputSchema: { x: z.number().int(), y: z.number().int() },
    },
    tool(async (a: { x: number; y: number }) => {
      await vMove(a.x, a.y);
      return text(`Moved to (${a.x}, ${a.y})`);
    }),
  );

  server.registerTool(
    "scroll",
    {
      title: "Scroll the mouse wheel",
      description: "Scroll vertically. Positive = up, negative = down (in wheel notches).",
      inputSchema: { amount: z.number().int().describe("Notches; positive up, negative down") },
    },
    tool(async (a: { amount: number }) => {
      await vScroll(a.amount);
      return text(`Scrolled ${a.amount}`);
    }),
  );

  server.registerTool(
    "drag",
    {
      title: "Drag from one point to another",
      description:
        "Press the mouse button at (x1,y1), glide to (x2,y2), and release — a real drag (drag-and-drop, " +
        "sliders, marquee-select, reordering). Works in any program. Coordinates share the screenshot/ui_tree origin.",
      inputSchema: {
        x1: z.number().int(), y1: z.number().int(),
        x2: z.number().int(), y2: z.number().int(),
        button: z.enum(["left", "right", "middle"]).optional(),
        steps: z.number().int().optional().describe("Intermediate moves along the path (default 20; more = slower/smoother)"),
      },
    },
    tool(async (a: { x1: number; y1: number; x2: number; y2: number; button?: string; steps?: number }) => {
      await vDrag(a.x1, a.y1, a.x2, a.y2, a.button ?? "left", a.steps);
      return text(`Dragged ${a.button ?? "left"} (${a.x1}, ${a.y1}) -> (${a.x2}, ${a.y2})`);
    }),
  );

  server.registerTool(
    "mouse_down",
    {
      title: "Press and hold a mouse button",
      description: "Move to (x,y) and press a mouse button WITHOUT releasing it. Pair with `mouse_up` for custom gestures (e.g. press-drag-pause-release). For ordinary drags use `drag`.",
      inputSchema: { x: z.number().int(), y: z.number().int(), button: z.enum(["left", "right", "middle"]).optional() },
    },
    tool(async (a: { x: number; y: number; button?: string }) => {
      await vMouseDown(a.x, a.y, a.button ?? "left");
      return text(`Pressed ${a.button ?? "left"} at (${a.x}, ${a.y})`);
    }),
  );

  server.registerTool(
    "mouse_up",
    {
      title: "Release a held mouse button",
      description: "Move to (x,y) and release a mouse button. Pairs with `mouse_down`.",
      inputSchema: { x: z.number().int(), y: z.number().int(), button: z.enum(["left", "right", "middle"]).optional() },
    },
    tool(async (a: { x: number; y: number; button?: string }) => {
      await vMouseUp(a.x, a.y, a.button ?? "left");
      return text(`Released ${a.button ?? "left"} at (${a.x}, ${a.y})`);
    }),
  );

  server.registerTool(
    "type_text",
    {
      title: "Type text",
      description: "Type a string into whatever has focus on the remote desktop (Unicode).",
      inputSchema: { text: z.string() },
    },
    tool(async (a: { text: string }) => {
      await vType(a.text);
      return text(`Typed ${a.text.length} chars`);
    }),
  );

  server.registerTool(
    "press_keys",
    {
      title: "Press a key chord",
      description: 'Press keys / a chord, e.g. "Enter", "Ctrl+S", "Ctrl+Shift+Esc", "Alt+Tab", "Win+R".',
      inputSchema: { keys: z.string() },
    },
    tool(async (a: { keys: string }) => {
      await vKeys(a.keys);
      return text(`Pressed ${a.keys}`);
    }),
  );

  server.registerTool(
    "ui_tree",
    {
      title: "Read the UI Automation element tree",
      description:
        "Return on-screen UI elements (control type, name, and click-ready center coordinates) from the " +
        "Windows UI Automation tree — the semantic alternative to guessing from pixels.",
      inputSchema: {
        maxElements: z.number().int().optional().describe("Cap on returned elements (default 200)"),
      },
    },
    tool(async (a: { maxElements?: number }) => {
      const els = await vUiTree(a.maxElements ?? 200);
      return text(JSON.stringify(els, null, 2));
    }),
  );

  server.registerTool(
    "ui_find",
    {
      title: "Find UI elements by text",
      description: "Find UI Automation elements whose name contains the given text; returns matches with center coordinates.",
      inputSchema: { text: z.string() },
    },
    tool(async (a: { text: string }) => {
      const matches = await vUiFind(a.text);
      return text(JSON.stringify(matches, null, 2));
    }),
  );

  // ---- Windows GUI driving (heavy apps: TIA Portal, Studio 5000) ---------
  server.registerTool(
    "list_windows",
    {
      title: "List open windows",
      description: "List visible top-level windows with titles and positions — useful to orient inside multi-window apps like TIA Portal / Studio 5000. (Windows only.)",
      inputSchema: {},
    },
    tool(async () => text(JSON.stringify(await vListWindows(), null, 2))),
  );

  server.registerTool(
    "focus_window",
    {
      title: "Focus a window by title",
      description: "Bring the first visible window whose title contains the given text to the foreground (restoring it if minimized). (Windows only.)",
      inputSchema: { title: z.string().describe("Substring of the window title, e.g. 'TIA Portal' or 'Studio 5000'") },
    },
    tool(async (a: { title: string }) => {
      const found = await vFocusWindow(a.title);
      return found ? text(`Focused window matching "${a.title}"`) : fail(`No visible window matching "${a.title}"`);
    }),
  );

  server.registerTool(
    "wait_idle",
    {
      title: "Wait for the screen to stop changing",
      description: "Block until the desktop image is stable for `settleMs` (or until `timeoutMs`). Use after triggering a compile/download/load in TIA Portal or Studio 5000. (Windows only.)",
      inputSchema: {
        timeoutMs: z.number().int().optional().describe("Give up after this long (default 60000)"),
        settleMs: z.number().int().optional().describe("Screen must be unchanged this long to count as idle (default 1500)"),
      },
    },
    tool(async (a: { timeoutMs?: number; settleMs?: number }) => {
      const idle = await vWaitIdle(a.timeoutMs ?? 60_000, a.settleMs ?? 1_500);
      return idle ? text("Screen is idle.") : text("Timed out before the screen settled.");
    }),
  );

  // ---- OPTIONAL accelerator: TIA Portal via Openness ---------------------
  // A convenience API fast-path for TIA only. NOT required — the visual tools
  // above drive TIA (and any other program) without it.
  const tiaText = (r: any): ToolResult =>
    r && r.ok === false ? fail(JSON.stringify(r, null, 2)) : text(JSON.stringify(r, null, 2));

  server.registerTool(
    "tia_status",
    {
      title: "TIA Openness availability",
      description:
        "Report whether Siemens Openness is installed (version + DLL path), any running TIA Portal " +
        "processes, and whether the account is in the 'Siemens TIA Openness' group. Safe on any box — " +
        "returns openness_found:false when TIA isn't installed (the visual tools still work).",
      inputSchema: {},
    },
    tool(async () => tiaText(await tiaCall("status"))),
  );

  server.registerTool(
    "tia_open_project",
    {
      title: "Open / attach a TIA project",
      description: "Attach to a running TIA Portal (or start one with start:true) and open a project. If a project is already open, returns it.",
      inputSchema: {
        path: z.string().optional().describe("Path to a .ap* project file (omit to use the already-open project)"),
        start: z.boolean().optional().describe("Start a new TIA Portal (with UI) if none is running (default false)"),
      },
    },
    tool(async (a: { path?: string; start?: boolean }) => tiaText(await tiaCall("open_project", a))),
  );

  server.registerTool(
    "tia_list_devices",
    {
      title: "List TIA project devices",
      description: "List devices and PLC software in the open TIA project.",
      inputSchema: { path: z.string().optional() },
    },
    tool(async (a: { path?: string }) => tiaText(await tiaCall("list_devices", a))),
  );

  server.registerTool(
    "tia_list_blocks",
    {
      title: "List PLC blocks",
      description: "List code/data blocks (OB/FB/FC/DB) for a PLC in the open project. Pass plc=<name> if there is more than one PLC.",
      inputSchema: { plc: z.string().optional(), path: z.string().optional() },
    },
    tool(async (a: { plc?: string; path?: string }) => tiaText(await tiaCall("list_blocks", a))),
  );

  server.registerTool(
    "tia_list_tags",
    {
      title: "List PLC tags",
      description: "List PLC tag tables and tags (name, address, type) for a PLC in the open project.",
      inputSchema: { plc: z.string().optional(), path: z.string().optional() },
    },
    tool(async (a: { plc?: string; path?: string }) => tiaText(await tiaCall("list_tags", a))),
  );

  server.registerTool(
    "tia_export_block",
    {
      title: "Export a PLC block to XML",
      description: "Export one block to an XML file ON THE TARGET (use `download` to fetch it to this machine afterward).",
      inputSchema: {
        block: z.string().describe("Block name"),
        file: z.string().describe("Destination path on the target, e.g. C:/ProgramData/ClaudeControl/Main.xml"),
        plc: z.string().optional(),
        path: z.string().optional(),
      },
    },
    tool(async (a: { block: string; file: string; plc?: string; path?: string }) => tiaText(await tiaCall("export_block", a))),
  );

  server.registerTool(
    "tia_import_block",
    {
      title: "Import a PLC block from XML",
      description: "Import a block from an XML file on the target (overwrites a same-named block). Upload the file first with `upload`.",
      inputSchema: {
        file: z.string().describe("Source XML path on the target"),
        plc: z.string().optional(),
        path: z.string().optional(),
      },
    },
    tool(async (a: { file: string; plc?: string; path?: string }) => tiaText(await tiaCall("import_block", a))),
  );

  server.registerTool(
    "tia_compile",
    {
      title: "Compile a PLC",
      description: "Compile a PLC's software; returns compile state and error/warning counts plus messages. Pass plc=<name> if there is more than one PLC.",
      inputSchema: { plc: z.string().optional(), path: z.string().optional() },
    },
    tool(async (a: { plc?: string; path?: string }) => tiaText(await tiaCall("compile", a))),
  );

  server.registerTool(
    "tia_download",
    {
      title: "Download to a PLC (GATED — writes to real hardware)",
      description:
        "Download to a PLC station. HARD-TO-REVERSE: it writes to live hardware. Requires confirm:true AND " +
        "station:<name>, and must be human-approved before each call — never invoke autonomously. This build " +
        "verifies the download provider is reachable and reports readiness; the live download is wired up only " +
        "after validation on the real engineering box (Phase 3).",
      inputSchema: {
        station: z.string().describe("Explicit target station name (required)"),
        confirm: z.literal(true).describe("Must be exactly true — affirms you intend to write to hardware"),
        plc: z.string().optional(),
        path: z.string().optional(),
      },
    },
    tool(async (a: { station: string; confirm: true; plc?: string; path?: string }) => tiaText(await tiaCall("download", a))),
  );

  // ---- Setup: bootstrap --------------------------------------------------
  server.registerTool(
    "bootstrap",
    {
      title: "Set up the target for visual control",
      description:
        "Push the PowerShell helper to the target and register it to run in the interactive desktop session " +
        "(a logon Scheduled Task), then start it. Optionally enable RDP. Run once per machine. " +
        "Requires that the connected account is an administrator.",
      inputSchema: {
        enableRdp: z.boolean().optional().describe("Also enable Remote Desktop for human viewing (default false)"),
      },
    },
    tool(async (a: { enableRdp?: boolean }) => {
      requireTarget();
      // 1) ensure remote dir
      const mk = await runPowerShell(`New-Item -ItemType Directory -Force -Path '${REMOTE_DIR}' | Out-Null; '${REMOTE_DIR}'`);
      if (mk.code !== 0) return fail(`Could not create ${REMOTE_DIR}:\n${runResultText(mk)}`);
      // 2) push scripts
      for (const f of ["helper.ps1", "bootstrap.ps1", "tia-openness.ps1"]) {
        const up = await scpUpload(join(WINDOWS_DIR, f), `${REMOTE_DIR}/${f}`);
        if (up.code !== 0) return fail(`Failed to upload ${f}:\n${runResultText(up)}`);
      }
      // 3) run bootstrap.ps1 (registers + starts the helper task; optionally enables RDP)
      const rdpFlag = a.enableRdp ? "-EnableRdp" : "";
      const cmd =
        `powershell -NoProfile -ExecutionPolicy Bypass -File ${REMOTE_DIR}/bootstrap.ps1 ` +
        `-HelperPort ${config.helperPort} ${rdpFlag}`;
      const r = await sshExec(cmd, { timeoutMs: 90_000 });
      if (r.code !== 0) return fail(`bootstrap.ps1 failed:\n${runResultText(r)}`);
      // 4) verify helper
      let helperState = "registered (will start at next logon)";
      try {
        const pong = await helperCall({ op: "ping" }, { timeoutMs: 12_000 });
        if (pong?.ok !== false) helperState = `running (v${pong?.version ?? "?"})`;
      } catch {
        /* not yet reachable; task is registered */
      }
      return text(`Bootstrap complete.\n${runResultText(r)}\n\nvisual helper: ${helperState}`);
    }),
  );

  return server;
}
