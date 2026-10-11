import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

// First-run matrix H3, H4: the ./reach shell launcher on a computer without
// Node.js, run from a copy of it with only the tools it names (no node, so
// it goes for its own runtime). Nothing is downloaded.
const unix = { skip: process.platform === "win32" };
function computer(t, { system = "Darwin", machine = "arm64", curl = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-launcher-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  fs.copyFileSync("reach", path.join(dir, "reach"));
  fs.chmodSync(path.join(dir, "reach"), 0o755);
  for (const tool of ["dirname", "mkdir", "chmod", "mktemp", "rm", "readlink", "cut", "mv", "tar"]) {
    const found = ["/bin", "/usr/bin"].map((d) => path.join(d, tool)).find((f) => fs.existsSync(f));
    if (found) fs.symlinkSync(found, path.join(bin, tool));
  }
  fs.writeFileSync(path.join(bin, "uname"), `#!/bin/sh\ncase "$1" in -s) echo ${system};; -m) echo ${machine};; esac\n`, { mode: 0o755 });
  if (curl) fs.writeFileSync(path.join(bin, "curl"), `#!/bin/sh\n${curl}\n`, { mode: 0o755 });
  const run = () => spawnSync("/bin/sh", [path.join(dir, "reach")], { env: { PATH: bin, HOME: dir }, encoding: "utf8", timeout: 20000 });
  return { dir, run };
}

test("H4: Git Bash on Windows is pointed to reach.cmd; another computer is named", unix, (t) => {
  const windows = computer(t, { system: "MINGW64_NT-10.0-26100", machine: "x86_64" }).run();
  assert.equal(windows.status, 1);
  assert.match(windows.stderr, /On Windows, run \.\\reach\.cmd in PowerShell or Command Prompt/);
  const pi = computer(t, { system: "Linux", machine: "armv7l" }).run();
  assert.equal(pi.status, 1);
  assert.match(pi.stderr, /this computer is Linux armv7l/);
  assert.match(pi.stderr, /Node\.js 22 or newer installed yourself/);
});

test("H3: no curl, or no internet: what to do, not curl's own error", unix, (t) => {
  const noCurl = computer(t).run();
  assert.equal(noCurl.status, 1);
  assert.match(noCurl.stderr, /Reach needs curl to download Node\.js.*nodejs\.org/);
  const offline = computer(t, { curl: 'echo "curl: (6) Could not resolve host: nodejs.org" >&2; exit 6' }).run();
  assert.equal(offline.status, 1);
  assert.match(offline.stderr, /Reach couldn't download Node\.js \(no internet here\?\)/);
  // Nothing half-downloaded is left as a runtime.
  const cache = path.join(computer(t).dir, ".reach", "runtime");
  assert.ok(!fs.existsSync(path.join(cache, "node-v22.23.3-darwin-arm64")));
});
