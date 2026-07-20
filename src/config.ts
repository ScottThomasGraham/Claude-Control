// src/config.ts
/**
 * Connection configuration for the active target.
 *
 * Held only in memory for the lifetime of the MCP server process. Secrets are
 * NEVER stored here or written to disk. SSH auth is delegated to the OS `ssh`
 * client (ssh-agent / identity file). The RDP password is read from the
 * environment at connect time and passed straight to the sidecar in memory.
 */
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { getCredential } from "./creds.js";

export type TargetOs = "windows" | "macos";

export interface ConnConfig {
  host?: string;
  user?: string;
  port: number;            // SSH port
  os: TargetOs;
  identityFile?: string;   // SSH key path (optional; ssh-agent otherwise)
  rdpPort: number;         // RDP port (default 3389)
  rdpWidth: number;        // negotiated desktop width
  rdpHeight: number;       // negotiated desktop height
  sidecarPath: string;     // path to the RDP sidecar binary (overridable for tests)
}

function envOs(): TargetOs {
  return process.env.CLAUDE_CONTROL_OS === "macos" ? "macos" : "windows";
}

const DEFAULT_SIDECAR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "sidecar",
  "target",
  "release",
  "cc-rdp",
);

export const config: ConnConfig = {
  host: process.env.CLAUDE_CONTROL_HOST,
  user: process.env.CLAUDE_CONTROL_USER,
  port: Number(process.env.CLAUDE_CONTROL_PORT ?? 22),
  os: envOs(),
  identityFile: process.env.CLAUDE_CONTROL_IDENTITY,
  rdpPort: Number(process.env.CLAUDE_CONTROL_RDP_PORT ?? 3389),
  rdpWidth: Number(process.env.CLAUDE_CONTROL_RDP_WIDTH ?? 1600),
  rdpHeight: Number(process.env.CLAUDE_CONTROL_RDP_HEIGHT ?? 900),
  sidecarPath: process.env.CLAUDE_CONTROL_RDP_SIDECAR ?? DEFAULT_SIDECAR,
};

export function setTarget(p: {
  host: string;
  user: string;
  port?: number;
  os?: TargetOs;
  identityFile?: string;
  rdpPort?: number;
  rdpWidth?: number;
  rdpHeight?: number;
}): void {
  config.host = p.host;
  config.user = p.user;
  if (p.port !== undefined) config.port = p.port;
  if (p.os !== undefined) config.os = p.os;
  if (p.identityFile !== undefined) config.identityFile = p.identityFile;
  if (p.rdpPort !== undefined) config.rdpPort = p.rdpPort;
  if (p.rdpWidth !== undefined) config.rdpWidth = p.rdpWidth;
  if (p.rdpHeight !== undefined) config.rdpHeight = p.rdpHeight;
}

export function requireTarget(): { host: string; user: string } {
  if (!config.host || !config.user) {
    throw new Error(
      "No target configured. Call the `connect` tool first (host + user), " +
        "or set CLAUDE_CONTROL_HOST / CLAUDE_CONTROL_USER.",
    );
  }
  return { host: config.host, user: config.user };
}

/**
 * The RDP password — env override → macOS Keychain (per target) → throw.
 * Never persisted to a file. The env var stays as an explicit override for CI /
 * power users; otherwise the Control Panel GUI / `creds.mjs` stores it in the
 * Keychain and it is looked up here at connect time.
 */
export function requireRdpPassword(target?: { host?: string; user?: string }): string {
  const env = process.env.CLAUDE_CONTROL_RDP_PASSWORD;
  if (env) return env;
  const host = target?.host ?? config.host;
  const user = target?.user ?? config.user;
  if (host && user) {
    const pw = getCredential(host, user);
    if (pw) return pw;
  }
  throw new Error(
    `RDP password not set for ${user ?? "?"}@${host ?? "?"}. ` +
      "Open Claude-Control and save the password for this target, " +
      "or export CLAUDE_CONTROL_RDP_PASSWORD.",
  );
}
