/**
 * Connection configuration for the active target.
 *
 * Held only in memory for the lifetime of the MCP server process. Secrets are
 * NEVER stored here or written to disk — authentication is delegated entirely to
 * the OS `ssh` client (ssh-agent / default identity / an identity FILE path the
 * user points at). We only keep host/user/port and the helper's loopback port.
 */
export type TargetOs = "windows" | "macos";

export interface ConnConfig {
  host?: string;
  user?: string;
  port: number;
  /** Target operating system — selects PowerShell vs shell, and the visual backend. */
  os: TargetOs;
  /** Optional path to a private key file. If unset, ssh-agent / default keys are used. */
  identityFile?: string;
  /** Loopback TCP port the Windows interactive-session helper listens on. */
  helperPort: number;
}

function envOs(): TargetOs {
  return process.env.CLAUDE_CONTROL_OS === "macos" ? "macos" : "windows";
}

export const config: ConnConfig = {
  host: process.env.CLAUDE_CONTROL_HOST,
  user: process.env.CLAUDE_CONTROL_USER,
  port: Number(process.env.CLAUDE_CONTROL_PORT ?? 22),
  os: envOs(),
  identityFile: process.env.CLAUDE_CONTROL_IDENTITY,
  helperPort: Number(process.env.CLAUDE_CONTROL_HELPER_PORT ?? 8765),
};

export function setTarget(p: {
  host: string;
  user: string;
  port?: number;
  os?: TargetOs;
  identityFile?: string;
  helperPort?: number;
}): void {
  config.host = p.host;
  config.user = p.user;
  if (p.port !== undefined) config.port = p.port;
  if (p.os !== undefined) config.os = p.os;
  if (p.identityFile !== undefined) config.identityFile = p.identityFile;
  if (p.helperPort !== undefined) config.helperPort = p.helperPort;
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
