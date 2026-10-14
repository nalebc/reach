import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// ./reach starts Reach again in the same window when it stopped by itself
// (crash-guard.mjs exits 70; 134 is Node out of memory), never after Ctrl+C,
// a stop or an error Reach reported, and gives up after 5 in 10 minutes.
const wrapper = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "reach");
const skip = process.platform === "win32" ? "POSIX wrapper" : false;

function run(codes, args = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-relaunch-"));
  fs.mkdirSync(path.join(dir, "scripts"));
  fs.mkdirSync(path.join(dir, "bin"));
  fs.copyFileSync(wrapper, path.join(dir, "reach"));
  fs.chmodSync(path.join(dir, "reach"), 0o755);
  // Each run notes its arguments and environment, then exits with the next code.
  fs.writeFileSync(path.join(dir, "codes.json"), JSON.stringify(codes));
  fs.writeFileSync(path.join(dir, "scripts", "bootstrap.mjs"), `
    import fs from "node:fs";
    const dir = ${JSON.stringify(dir)};
    const runs = fs.existsSync(dir + "/runs.json") ? JSON.parse(fs.readFileSync(dir + "/runs.json", "utf8")) : [];
    runs.push({ args: process.argv.slice(2), supervised: process.env.REACH_SUPERVISED || "" });
    fs.writeFileSync(dir + "/runs.json", JSON.stringify(runs));
    process.exit(JSON.parse(fs.readFileSync(dir + "/codes.json", "utf8"))[runs.length - 1] ?? 0);
  `);
  // No real waiting in the test.
  fs.writeFileSync(path.join(dir, "bin", "sleep"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  // The background service runs on Reach's private Node, downloaded the
  // first time. This test's own Node stands in for it, under the name the
  // wrapper looks for: each run downloaded Node from nodejs.org, and a slow
  // download outlasted the 30 s below (no runs.json, Oct 13 and 14).
  const version = fs.readFileSync(wrapper, "utf8").match(/^VERSION=(\S+)$/m)[1];
  const target = `${process.platform}-${process.arch}`;
  const runtime = path.join(dir, ".reach", "runtime", `node-v${version}-${target}`, "bin");
  fs.mkdirSync(runtime, { recursive: true });
  fs.symlinkSync(process.execPath, path.join(runtime, "node"));
  // And nothing here reaches the internet: a download is refused at once.
  fs.writeFileSync(path.join(dir, "bin", "curl"), "#!/bin/sh\necho 'curl: no downloads in this test' >&2\nexit 1\n", { mode: 0o755 });
  try {
    const result = spawnSync("/bin/sh", [path.join(dir, "reach"), ...args], {
      env: { ...process.env, PATH: `${path.join(dir, "bin")}:${process.env.PATH}` },
      encoding: "utf8",
      timeout: 30000,
    });
    const out = result.stdout + result.stderr;
    const file = path.join(dir, "runs.json");
    assert.ok(fs.existsSync(file), `./reach ${args.join(" ")} never started Reach (${result.error?.message || `exit ${result.status}`}): ${out}`);
    return { status: result.status, out, runs: JSON.parse(fs.readFileSync(file, "utf8")) };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("a crash starts Reach again, waiting longer each time, without restart's stopping", { skip }, () => {
  const { status, out, runs } = run([70, 134, 0], ["restart", "--yes", "--https-port", "8443"]);
  assert.equal(status, 0);
  assert.equal(runs.length, 3);
  assert.deepEqual(runs[0].args, ["restart", "--yes", "--https-port", "8443"]);
  assert.deepEqual(runs[1].args, ["--https-port", "8443"]);
  assert.deepEqual(runs[2].args, ["--https-port", "8443"]);
  assert.ok(runs.every((r) => r.supervised === "1"));
  assert.match(out, /starting again in 1s/);
  assert.match(out, /starting again in 5s/);
});

test("Ctrl+C, a stop and an error Reach reported are not relaunched", { skip }, () => {
  for (const code of [0, 1, 130, 143]) {
    const { status, runs } = run([code]);
    assert.equal(status, code);
    assert.equal(runs.length, 1, `exit ${code}`);
  }
});

test("five unexpected stops in ten minutes: it stops trying and says where to look", { skip }, () => {
  const { status, out, runs } = run([70, 70, 70, 70, 70, 70, 70, 70]);
  assert.equal(status, 70);
  assert.equal(runs.length, 6);
  assert.match(out, /5 times in 10 minutes/);
  assert.match(out, /crash\.log/);
});

test("other commands and the background service run once, as before", { skip }, () => {
  for (const args of [["status"], ["--service"], ["--background"], ["approve"]]) {
    const { runs } = run([70, 0], args);
    assert.equal(runs.length, 1, args.join(" "));
    assert.equal(runs[0].supervised, "", args.join(" "));
  }
});
