import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { recycle } from "../server/recycle-bin.mjs";

// On a real Windows PC: a deleted Claude chat's file leaves its folder and
// is in the Recycle Bin, restorable, with no dialog (parity audit #38).
test("Windows: a file sent to the Recycle Bin is gone from its folder and in the Recycle Bin", { skip: process.platform !== "win32", timeout: 60000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-recycle-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const name = `reach-recycle-${process.pid}-${Date.now()}.jsonl`;
  const file = path.join(dir, name);
  fs.writeFileSync(file, "{}\n");
  await recycle(file);
  assert.equal(fs.existsSync(file), false);
  const listed = execFileSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", "(New-Object -ComObject Shell.Application).Namespace(10).Items() | ForEach-Object { $_.Name }"],
    { encoding: "utf8", windowsHide: true, timeout: 30000 },
  );
  assert.ok(listed.split(/\r?\n/).some((n) => n.trim() === name || n.trim() === path.parse(name).name), `${name} in the Recycle Bin`);
});
