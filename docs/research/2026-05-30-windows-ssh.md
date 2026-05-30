# Research: Windows remote management over SSH (the fast path)

*Captured 2026-05-30. Sourced web research synthesized into a brief.*

## 1. OpenSSH Server: install, enable, firewall, default shell
OpenSSH Server is a built-in **Feature on Demand**. From an elevated PowerShell prompt:

```powershell
Get-WindowsCapability -Online | Where-Object Name -like 'OpenSSH*'
Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0
Start-Service sshd
Set-Service -Name sshd -StartupType 'Automatic'
New-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -DisplayName 'OpenSSH Server (sshd)' `
  -Enabled True -Direction Inbound -Protocol TCP -Action Allow -LocalPort 22
```
Default shell is **cmd.exe**; switch to PowerShell via a registry value (config + host keys live in
`C:\ProgramData\ssh\sshd_config`):
```powershell
New-ItemProperty -Path "HKLM:\SOFTWARE\OpenSSH" -Name DefaultShell `
  -Value "C:\Program Files\PowerShell\7\pwsh.exe" -PropertyType String -Force
```
Sources: [install/firstuse](https://learn.microsoft.com/en-us/windows-server/administration/openssh/openssh_install_firstuse),
[server config](https://learn.microsoft.com/en-us/windows-server/administration/openssh/openssh-server-configuration),
[DefaultShell wiki](https://github.com/PowerShell/Win32-OpenSSH/wiki/DefaultShell).

## 2. Auth
Password and public-key auth both work for local/AD accounts (Entra ID accounts can't use keys).
Key file locations differ:
- **Standard user:** `C:\Users\<user>\.ssh\authorized_keys`
- **Administrator:** `C:\ProgramData\ssh\administrators_authorized_keys` (shared by all admins; the
  per-user file is ignored for admins). Strict ACL required:
```powershell
icacls.exe "C:\ProgramData\ssh\administrators_authorized_keys" /inheritance:r `
  /grant "Administrators:F" /grant "SYSTEM:F"
```
A key-based session has **no cached credentials**, so it can't authenticate outbound as the user
(network shares etc.). Source: [key management](https://learn.microsoft.com/en-us/windows-server/administration/openssh/openssh_keymanagement).

## 3. Running commands / PowerShell over SSH
`ssh user@host "pwsh -c <cmd>"` for one-shots. **PowerShell 7 remoting** rides SSH as a named
subsystem (`Subsystem powershell c:/progra~1/powershell/7/pwsh.exe -sshs -nologo`), then
`Enter-PSSession -HostName host -UserName user`. Versus **WinRM**: SSH is cross-platform, simpler, no
HTTPS cert/5985-5986 plumbing, but lacks JEA/named endpoints/credential delegation. SSH sessions run
**non-interactively in session 0** — fine for CLI/file/registry/service work, but anything needing a
logged-in desktop/GUI/user-credential context won't work directly.
Source: [SSH remoting in PowerShell](https://learn.microsoft.com/en-us/powershell/scripting/security/remoting/ssh-remoting-in-powershell).

## 4. File transfer
`scp` and `sftp` work (`Subsystem sftp sftp-server.exe` must be in `sshd_config`). OpenSSH 9.x scp
uses the SFTP backend; **use forward slashes and quote paths** (`scp file user@host:C:/Users/me/app.exe`)
— Windows backslashes get mangled.

## 5. Installing/running a helper as a service — the session-0 trap
Fully doable over SSH: `scp` the exe, `New-Service`/`sc.exe create`, `Start-Service`. **But a service
runs in session 0, isolated from the interactive desktop** (no screen, window handles, or UIA tree of
the logged-in user; "interact with desktop" was neutered and UI0Detect removed on Win10 1803+/Win11).
Workarounds:
- SYSTEM service finds the active console session (`WTSGetActiveConsoleSessionId`), grabs the user's
  token (`WTSQueryUserToken`) and **`CreateProcessAsUser`** to spawn the UI helper *into* the
  interactive session.
- **Simpler:** a **Scheduled Task triggered "At log on"** (`schtasks`/`Register-ScheduledTask`) runs
  natively in the user's interactive session — no token juggling.
Sources: [Session 0 isolation](https://techcommunity.microsoft.com/blog/askperf/application-compatibility---session-0-isolation/372361),
[sc create](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/sc-create).

## 6. Bootstrap / chicken-and-egg
Minimum manual step: **one local action to open the first channel** (enable SSH or RDP once by hand,
or via provisioning/Autounattend/Intune). After that everything automates, and **each channel can
enable the other**. From SSH, enable RDP remotely:
```powershell
Set-ItemProperty 'HKLM:\System\CurrentControlSet\Control\Terminal Server' -Name fDenyTSConnections -Value 0
Enable-NetFirewallRule -DisplayGroup "Remote Desktop"
```
And the reverse from an RDP GUI session. So only **one** channel needs bootstrapping by hand.

## 7. Rust SSH client crates
- **`openssh`** — wraps system `ssh`, ControlMaster multiplexing; least code; honors `~/.ssh/config`;
  shells out (needs `ssh`/`scp` present).
- **`russh`** (+ `russh-sftp`) — pure-Rust async (Tokio), actively maintained, full auth control
  (password, pubkey, agent, certs), SFTP client. **Best for a self-contained binary.**
- **`ssh2`** — libssh2 bindings; mature but synchronous + C dependency.
Sources: [russh](https://github.com/Eugeny/russh), [ssh2](https://docs.rs/ssh2), [openssh](https://docs.rs/openssh).

## Bottom line
Install OpenSSH Server as a FoD, startup Automatic + firewall rule, DefaultShell = `pwsh`, and use
**public-key auth into an admin account** (key in `administrators_authorized_keys`, locked-down ACL).
Drive from Rust with **`russh` + `russh-sftp`** (pure-Rust, no external binary) for command/SFTP.
**Critical gotcha:** SSH sessions and any service you create both live in **session 0**, isolated
from the interactive desktop — so the UIA helper must *not* run as a plain service; use a
**logon-triggered Scheduled Task** (or a SYSTEM launcher using `WTSQueryUserToken` +
`CreateProcessAsUser`) to spawn it into the active session. Keep RDP separate for GUI work; either
channel can enable the other, so only one needs a single manual bootstrap.
