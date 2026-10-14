import { execFile } from "node:child_process";
import { windowsFixture } from "./windows-fixtures.mjs";

// Who Windows lets open a file, folder or named pipe (`kind` "file" or
// "pipe"; a pipe by its name under \\.\pipe\), read by
// test/fixtures/windows/acl-probe.cs: { me, owner, protected, rules }.
export async function windowsAcl(kind, target) {
  const probe = await windowsFixture("acl-probe", ["System.Core.dll"]);
  const stdout = await new Promise((resolve, reject) =>
    execFile(probe, [kind, target], { windowsHide: true, timeout: 30000 }, (error, out) =>
      error ? reject(Error(`acl-probe ${kind} ${target}: ${out || error.message}`)) : resolve(out)));
  return JSON.parse(stdout);
}
export const SYSTEM = "S-1-5-18";
export const ADMINISTRATORS = "S-1-5-32-544";
// Any right that changes it, its contents or who may: write, append (a
// pipe's new instance), attributes, delete, permissions, owner, and the
// generic write and all.
export const WRITES = 0x2 | 0x4 | 0x10 | 0x40 | 0x100 | 0x10000 | 0x40000 | 0x80000 | 0x40000000 | 0x10000000;
// The rules that let anyone but this user, SYSTEM and Administrators in
// (`mask`: only those granting any of these rights). Inherit-only rules
// (for what's made inside) don't apply to it.
export const othersAllowed = (acl, mask = -1) =>
  acl.rules.filter((rule) => rule.allow && !rule.inheritOnly && (rule.rights & mask) !== 0 && ![acl.me, SYSTEM, ADMINISTRATORS].includes(rule.sid));
