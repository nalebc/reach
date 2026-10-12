import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { ForegroundServe } from "../scripts/foreground-serve.mjs";

// Windows' private route (scripts/foreground-serve.mjs) when its `tailscale
// serve` doesn't come up. The route itself is covered end to end in
// windows-commands.test.mjs, against a stand-in Tailscale.
const origin = "https://pc.example.ts.net:8443";
const target = "http://127.0.0.1:4317";
const child = ({ said = "", exitCode = null } = {}) => {
  const c = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), killed: [] });
  c.kill = (signal = "SIGTERM") => {
    c.killed.push(signal);
    setImmediate(() => c.emit("exit", null, signal));
  };
  if (exitCode !== null)
    setImmediate(() => {
      c.stderr.emit("data", said);
      c.emit("exit", exitCode, null);
    });
  return c;
};
const route = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-foreground-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, "serve-owner.json");
};

test("Windows route: Tailscale's refusal is said in its own words, with the page that fixes it", async (t) => {
  const said = "Serve is not enabled on your tailnet.\nTo enable, visit:\n\n         https://login.tailscale.com/f/serve?node=nPC\n";
  const heard = [];
  const spawned = [];
  const serve = new ForegroundServe({
    file: route(t), origin, target, pollMs: 5,
    inspect: async () => ({}),
    spawnServe: (args) => (spawned.push(args), child({ said, exitCode: 1 })),
    output: (text) => heard.push(text),
  });
  await assert.rejects(serve.start(), /Serve is not enabled on your tailnet\. To enable, visit: https:\/\/login\.tailscale\.com\/f\/serve\?node=nPC/);
  assert.deepEqual(spawned, [["serve", "--https=8443", target]], "in the foreground: no --bg");
  assert.equal(heard.join(""), said, "its words reach the log and the setup hint as they come");
  assert.equal(serve.alive, false);
});

test("Windows route: a session that never shows is ended after the wait, never left running", async (t) => {
  let held;
  const serve = new ForegroundServe({
    file: route(t), origin, target, pollMs: 5, waitMs: 50,
    inspect: async () => ({}),
    spawnServe: () => (held = child()),
  });
  await assert.rejects(serve.start(), /Tailscale took too long to answer\./);
  assert.deepEqual(held.killed, ["SIGTERM"]);
  assert.equal(serve.alive, false);
});
