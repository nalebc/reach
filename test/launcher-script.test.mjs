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
function computer(t, { system = "Darwin", machine = "arm64", curl = null, omit = [] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-launcher-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  fs.copyFileSync("reach", path.join(dir, "reach"));
  fs.chmodSync(path.join(dir, "reach"), 0o755);
  for (const tool of ["dirname", "mkdir", "chmod", "mktemp", "rm", "readlink", "cut", "mv", "tar", "shasum", "sha256sum"]) {
    if (omit.includes(tool)) continue;
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
  assert.match(pi.stderr, /Node\.js 22\.12 or newer installed yourself/);
});

test("H3: no curl, or no internet: what to do, not curl's own error", unix, (t) => {
  const noCurl = computer(t).run();
  assert.equal(noCurl.status, 1);
  assert.match(noCurl.stderr, /Reach needs curl to download Node\.js.*nodejs\.org/);
  const offlineComputer = computer(t, { curl: 'echo "curl: (6) Could not resolve host: nodejs.org" >&2; exit 6' });
  const offline = offlineComputer.run();
  assert.equal(offline.status, 1);
  assert.match(offline.stderr, /Reach couldn't download Node\.js \(no internet here\?\)/);
  // Nothing half-downloaded is left as a runtime.
  const cache = path.join(offlineComputer.dir, ".reach", "runtime");
  assert.ok(!fs.existsSync(path.join(cache, "node-v22.23.3-darwin-arm64")));
  assert.deepEqual(fs.readdirSync(cache), [], "the failed download's staging folder is removed too");
});


for (const [missing, omit] of [["tar", ["tar"]], ["shasum or sha256sum", ["shasum", "sha256sum"]]]) {
  test(`H3: missing ${missing} is explained before any download`, unix, (t) => {
    const machine = computer(t, { omit, curl: 'echo download-attempted >&2; exit 6' });
    const result = machine.run();
    assert.equal(result.status, 1);
    assert.ok(result.stderr.includes(`needs ${missing}`), result.stderr);
    assert.match(result.stderr, /Install.*Node\.js 22/);
    assert.doesNotMatch(result.stderr, /download-attempted/);
  });
}

test("H2: a system Node 22 older than 22.12 is passed over for Reach's own (Vite 8 builds on 22.12)", unix, (t) => {
  const machine = computer(t);
  const bin = path.join(machine.dir, "bin"), preload = path.join(machine.dir, "old-node.mjs");
  fs.writeFileSync(preload, 'Object.defineProperty(process.versions, "node", { value: "22.11.0" });\n');
  fs.writeFileSync(path.join(bin, "node"), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} --import ${JSON.stringify(preload)} "$@"\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "npm"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const result = machine.run();
  assert.equal(result.status, 1);
  // It went for its own runtime: here, with no curl, it says how to get one.
  assert.match(result.stderr, /Reach needs curl to download Node\.js.*Node\.js 22\.12 or newer/);
});

test("reach.cmd's Node check has no double quotes for PowerShell to strip", () => {
  // PowerShell drops the " inside a native command's argument, so split(".")
  // reached Node as split(.) and every system Node looked too old (Oct 13).
  const ps1 = fs.readFileSync("scripts/bootstrap.ps1", "utf8");
  const check = ps1.match(/-e '([^']*process\.versions\.node[^']*)'/)?.[1];
  assert.ok(check, "the Node version check is there");
  assert.doesNotMatch(check, /"/);
});
