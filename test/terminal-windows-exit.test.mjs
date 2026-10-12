import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

test("Windows natural shell exits release their console hosts and let the parent exit", {
  skip: process.platform !== "win32", timeout: 50000,
}, (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "reach-pty-exit-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "probe.mjs");
  fs.writeFileSync(file, `
    import assert from 'node:assert/strict';
    import { execFileSync } from 'node:child_process';
    import { Terminals } from ${JSON.stringify(new URL("../server/terminal.mjs", import.meta.url).href)};
    const consoleHosts = () => {
      const command = "@(Get-CimInstance Win32_Process -Filter 'ParentProcessId = " + process.pid + "' | Where-Object { $_.Name -in @('conhost.exe', 'OpenConsole.exe') } | ForEach-Object { $_.ProcessId }) | ConvertTo-Json -Compress";
      const text = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', timeout: 10000 }).trim();
      const value = text ? JSON.parse(text) : [];
      return Array.isArray(value) ? value : [value];
    };
    const before = new Set(consoleHosts());
    const terminals = new Terminals();
    for (let i = 0; i < 3; i++) {
      const created = terminals.create({ cwd: ${JSON.stringify(directory)}, clientId: 'windows-exit-fixture', command: 'Write-Output REACH_NATURAL_EXIT_OK; exit 0' });
      const session = terminals.get(created.id);
      let timer;
      try {
        await Promise.race([session.ended, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Synthetic PowerShell did not finish')), 10000); })]);
      } finally { clearTimeout(timer); }
      assert.equal(session.exitCode, 0);
      assert.match(session.buffer, /REACH_NATURAL_EXIT_OK/);
    }
    // Check while the owning Node process is still alive: exiting the parent
    // would conceal leaked native console hosts.
    await new Promise(resolve => setTimeout(resolve, 2500));
    assert.deepEqual(consoleHosts().filter(pid => !before.has(pid)), [], 'natural exits must not leave console hosts owned by Reach');
    await terminals.dispose();
    assert.ok(!process.getActiveResourcesInfo().includes('MessagePort'), 'exited terminals must release their worker message ports');
    console.log('THREE_NATURAL_EXITS_RELEASED');
    // No process.exit: an orphan worker or pipe must fail the parent deadline.
  `);
  const result = spawnSync(process.execPath, [file], {
    cwd: directory, env: process.env, encoding: "utf8", timeout: 40000,
    maxBuffer: 64 * 1024,
  });
  assert.equal(result.error, undefined, `${result.error?.message || ""}\n${result.stdout}\n${result.stderr}`);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /THREE_NATURAL_EXITS_RELEASED/);
});
