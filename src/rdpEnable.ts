// src/rdpEnable.ts
/**
 * Ensure RDP is reachable on the target. If the port is closed, flip the two
 * native settings over SSH (admin) and leave them on:
 *   - HKLM\SYSTEM\CurrentControlSet\Control\Terminal Server\fDenyTSConnections = 0
 *   - Enable the "Remote Desktop" firewall rule group
 * No files, no service, no driver — a reversible setting, not a footprint.
 */
import { runPowerShell } from "./ssh.js";
import { config } from "./config.js";

export interface EnableResult { alreadyOn: boolean; changed: boolean; detail: string }

export async function ensureRdpEnabled(): Promise<EnableResult> {
  const port = config.rdpPort;
  const script = `
$ErrorActionPreference='Stop'
$tcp = Test-NetConnection -ComputerName 127.0.0.1 -Port ${port} -WarningAction SilentlyContinue
if ($tcp.TcpTestSucceeded) { '{"alreadyOn":true,"changed":false,"detail":"RDP port already open"}' ; return }
Set-ItemProperty 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Terminal Server' -Name fDenyTSConnections -Value 0
Enable-NetFirewallRule -DisplayGroup 'Remote Desktop'
'{"alreadyOn":false,"changed":true,"detail":"Enabled fDenyTSConnections=0 + Remote Desktop firewall group"}'
`;
  const r = await runPowerShell(script, { timeoutMs: 30_000 });
  if (r.code !== 0) throw new Error(`Could not enable RDP over SSH:\n${r.stderr || r.stdout}`);
  return JSON.parse(r.stdout.trim());
}
