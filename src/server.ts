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
  vScreenshot, vMove, vClick, vScroll, vType, vKeys, vUiTree, vUiFind,
  vListWindows, vFocusWindow, vWaitIdle,
} from "./visual.js";

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
      for (const f of ["helper.ps1", "bootstrap.ps1"]) {
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
