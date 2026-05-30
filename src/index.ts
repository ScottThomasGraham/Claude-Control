#!/usr/bin/env node
/**
 * Claude-Control MCP server entry point (stdio transport).
 *
 * Attach to Claude Code with:
 *   claude mcp add claude-control -- npx -y claude-control-mcp
 * or point it at a local build:
 *   claude mcp add claude-control -- node /path/to/Claude-Control/build/index.js
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildServer } from "./server.js";

async function main(): Promise<void> {
  const server = buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr is safe for logging on stdio transports (stdout is the protocol channel).
  process.stderr.write("claude-control MCP server ready\n");
}

main().catch((e) => {
  process.stderr.write(`fatal: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
  process.exit(1);
});
