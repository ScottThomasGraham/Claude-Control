#!/bin/zsh
# Launch Claude Code with the Mini's RDP password in the environment so the
# Claude-Control MCP server can drive the RDP plane. The password is typed at a
# hidden prompt into this shell's environment only — never written to disk,
# never echoed, never placed in shell history.
cd "$HOME/Projects/Claude-Control" || exit 1

if [ -z "$CLAUDE_CONTROL_RDP_PASSWORD" ]; then
  print -n "Mini RDP password (user@100.x.x.x, hidden): "
  read -rs CLAUDE_CONTROL_RDP_PASSWORD
  export CLAUDE_CONTROL_RDP_PASSWORD
  print ""
fi

if [ -z "$CLAUDE_CONTROL_RDP_PASSWORD" ]; then
  print "No password entered — aborting (RDP/NLA cannot use an SSH key)."
  exit 1
fi

print "RDP password loaded into env. Launching Claude Code…"
exec claude
