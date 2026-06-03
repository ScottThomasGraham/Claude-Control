// src/creds.ts
/**
 * RDP credential store. Secrets live in the macOS Keychain (OS-encrypted — NOT a
 * file), keyed by target. The shared contract with the GUI is the Keychain scheme:
 *   service = "claude-control-rdp", account = "<user>@<host>".
 */
import { execFileSync } from "node:child_process";

export const KEYCHAIN_SERVICE = "claude-control-rdp";
export const accountFor = (host: string, user: string): string => `${user}@${host}`;

export interface CredBackend {
  get(account: string): string | null;
  set(account: string, password: string): void;
  remove(account: string): void;
}

/** macOS Keychain via the `security` CLI. `-A` lets the server read without a prompt. */
export const keychainBackend: CredBackend = {
  get(account) {
    try {
      return execFileSync(
        "/usr/bin/security",
        ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account, "-w"],
        { encoding: "utf8" },
      ).replace(/\n$/, "");
    } catch {
      return null; // not found
    }
  },
  set(account, password) {
    execFileSync(
      "/usr/bin/security",
      ["add-generic-password", "-U", "-A", "-s", KEYCHAIN_SERVICE, "-a", account, "-w", password],
      { stdio: "ignore" },
    );
  },
  remove(account) {
    try {
      execFileSync(
        "/usr/bin/security",
        ["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account],
        { stdio: "ignore" },
      );
    } catch { /* absent is fine */ }
  },
};

let backend: CredBackend = keychainBackend;
export function setCredBackend(b: CredBackend): void { backend = b; }

export function getCredential(host: string, user: string): string | null {
  return backend.get(accountFor(host, user));
}
export function setCredential(host: string, user: string, password: string): void {
  backend.set(accountFor(host, user), password);
}
export function removeCredential(host: string, user: string): void {
  backend.remove(accountFor(host, user));
}
