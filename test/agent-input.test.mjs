import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { AgentInputHelper } from "../server/agent-input.mjs";
import { AgentApps } from "../server/agent-apps.mjs";

// The agent-only input helper (scripts/native/agent-input.swift) and what the
// server does with its answers. The helpers here are plain Node processes:
// nothing reaches the Mac's apps, pointer or keyboard.
const hanging = () =>
  spawn(process.execPath, ["-e", "process.stdin.resume()"], {
    stdio: ["pipe", "pipe", "ignore"],
  });
const exited = (child) =>
  child.exitCode !== null || child.signalCode !== null
    ? Promise.resolve()
    : new Promise((resolve) => child.once("exit", resolve));

test("a request the helper doesn't answer in time is unknown, and the helper is replaced", async () => {
  const child = hanging();
  const helper = new AgentInputHelper(child, { timeoutMs: 100 });
  const reply = await helper.send({ cmd: "press", x: 1, y: 1 });
  assert.equal(reply.done, false);
  assert.equal(reply.unknown, true);
  // Nothing queued behind it lands late: the busy helper is gone.
  assert.equal(helper.stopped, true);
  await exited(child);
  // A stopped helper surely sent nothing: a plain "not done".
  assert.deepEqual(await helper.send({ cmd: "press" }), {
    done: false,
    why: "input helper stopped",
  });
});

test("a helper that doesn't end on SIGTERM is killed a second later", async () => {
  const stuck = spawn(
    process.execPath,
    ["-e", 'process.on("SIGTERM", () => {}); process.stdin.resume(); setInterval(() => {}, 1000)'],
    { stdio: ["pipe", "pipe", "ignore"] },
  );
  await new Promise((resolve) => setTimeout(resolve, 200));
  const helper = new AgentInputHelper(stuck, { timeoutMs: 50 });
  assert.equal((await helper.send({ cmd: "press" })).unknown, true);
  await exited(stuck);
  assert.equal(stuck.signalCode, "SIGKILL");
});

test("a request in flight when the helper ends is unknown; answers pass through", async () => {
  const echo = spawn(
    process.execPath,
    [
      "-e",
      `require("node:readline").createInterface({ input: process.stdin }).on("line", (l) => {
        const r = JSON.parse(l);
        if (r.cmd === "quit") process.exit(0);
        console.log(JSON.stringify({ id: r.id, done: true, kind: "pressed" }));
      });`,
    ],
    { stdio: ["pipe", "pipe", "ignore"] },
  );
  const helper = new AgentInputHelper(echo, { timeoutMs: 5000 });
  assert.deepEqual(await helper.send({ cmd: "press" }), {
    done: true,
    kind: "pressed",
  });
  const reply = await helper.send({ cmd: "quit" });
  assert.equal(reply.unknown, true);
  assert.equal(reply.done, false);
  await exited(echo);
});

// An agent's app thread, as AgentApps keeps it, with nobody at the Mac.
function agentApps(targeted) {
  const thread = {
    id: "t1",
    appId: "/Applications/Google Chrome.app",
    name: "Google Chrome",
    state: "running",
    display: "901",
    region: { x: 352, y: 30, w: 500, h: 1084 },
    size: { w: 852, h: 1130 },
  };
  const pointer = [];
  const apps = new AgentApps({
    threads: {
      threads: new Map([["t1", thread]]),
      get: (id) => (id === "t1" ? thread : undefined),
      activate: async () => {},
    },
    control: { holder: () => null },
    idle: async () => 600,
    targeted,
    createInput: () => ({
      send: async (step) => (pointer.push(step), { ok: true }),
      stop() {},
    }),
  });
  apps.owners.set("t1", { clientId: "agent", agent: "Claude" });
  return { apps, pointer, client: { id: "agent" } };
}

test("a press the app may still be doing is never pressed again with the pointer, nor reported done", async (t) => {
  const children = [];
  const { apps, pointer, client } = agentApps(() => {
    const child = hanging();
    children.push(child);
    return new AgentInputHelper(child, { timeoutMs: 100 });
  });
  t.after(() => children.forEach((c) => c.kill("SIGKILL")));
  for (const action of [
    { type: "click", x: 10, y: 10 },
    { type: "type", text: "hello" },
    { type: "menu", path: ["Edit", "Select All"] },
  ])
    await assert.rejects(apps.act(client, "t1", action), {
      status: 409,
      message:
        "Not sure that went through. Look at the screen again before trying.",
    });
  assert.deepEqual(pointer, [], "no second press through the pointer");
  // Each timed-out helper was replaced by a fresh one.
  assert.equal(children.length, 3);
});

test("a reply that isn't a clear yes or no counts as unknown too", async () => {
  const { apps, pointer, client } = agentApps(() => ({
    send: async () => ({ kind: "pressed" }),
    stop() {},
  }));
  await assert.rejects(apps.act(client, "t1", { type: "click", x: 10, y: 10 }), {
    status: 409,
  });
  assert.deepEqual(pointer, []);
});

test("a press the app surely refused still falls back to the pointer when nobody is at the Mac", async () => {
  const { apps, pointer, client } = agentApps(() => ({
    send: async () => ({ done: false, why: "press refused" }),
    stop() {},
  }));
  assert.deepEqual(await apps.act(client, "t1", { type: "click", x: 10, y: 10 }), {
    done: true,
    lane: "pointer",
  });
  assert.equal(pointer.length, 1);
});

const swift = () =>
  fs.readFile(
    new URL("../scripts/native/agent-input.swift", import.meta.url),
    "utf8",
  );
const between = (source, start, end) =>
  source.split(start)[1]?.split("\n").slice(1).join("\n").split(end)[0];

test("the input helper bounds Accessibility, answers unknown when the app is slow, and lets go of keys when stopped", async () => {
  const source = await swift();
  // C5: a timeout well under the server's 5 s, for every call of the process.
  assert.match(
    source,
    /AXUIElementSetMessagingTimeout\(AXUIElementCreateSystemWide\(\), 1(\.0)?\)/,
  );
  // Every change (focus, press, insert, menu) goes through `outcome`, which
  // maps only known refusals to "not done"; anything else is unknown.
  assert.doesNotMatch(source, /AXUIElement(PerformAction|SetAttributeValue)\([^\n]*\) == \.success/);
  assert.equal(source.match(/outcome\(error, /g)?.length, 4);
  const outcome = source.split("func outcome(")[1].split("\n}")[0];
  assert.match(outcome, /if error == \.success \{ return done \}/);
  assert.match(outcome, /refusedErrors\.contains\(error\)/);
  assert.match(outcome, /"unknown": true/);
  assert.doesNotMatch(source.split("let refusedErrors")[1].split("\n\n")[0].split("]")[0], /cannotComplete|failure/);
  // Inserted text that may have landed is never typed a second time.
  const text = source.split('case "text":')[1].split('case "key":')[0];
  assert.match(text, /inserted\["unknown"\] as\? Bool == true \{ return inserted \}/);
  // C6: a stop between a key's down and up lets go of it first.
  assert.match(source, /termination\.setEventHandler \{ letGo\(\); exit\(0\) \}/);
  assert.match(source.split("func send(")[1].split("\n}")[0], /if stopping \{ return \}[\s\S]*postToPid[\s\S]*heldKey = down/);
  assert.doesNotMatch(source.replace(/func send\([\s\S]*?\n}/, "").replace(/func letGo\([\s\S]*?\n}/, ""), /postToPid/);
});

test("the input helper types one whole character per event, like the desktop helper", async () => {
  const source = await swift();
  const desktop = await fs.readFile(
    new URL("../scripts/native/agent-desktop.swift", import.meta.url),
    "utf8",
  );
  const mine = between(source, "// BEGIN PURE INPUT TEXT", "// END PURE INPUT TEXT");
  const theirs = between(desktop, "// BEGIN PURE DESKTOP TEXT", "// END PURE DESKTOP TEXT");
  assert.ok(mine && theirs);
  assert.equal(mine, theirs, "the same chunking in both helpers");
  const post = source.split("func post(_ pid: pid_t, text: String)")[1].split("\n}")[0];
  assert.doesNotMatch(post, /\.utf16|stringLength: 1\b/);
  assert.match(post, /for chunk in keyboardChunks\(text\)/);
  assert.match(post, /stringLength: chunk\.count, unicodeString: chunk/);
});

test("compiled: the input helper's chunks keep emoji and combined characters whole", {
  skip: process.platform !== "darwin" || process.env.REACH_TEST_APP_NATIVE !== "1",
}, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "agent-input-text-"));
  try {
    const pure = between(await swift(), "// BEGIN PURE INPUT TEXT", "// END PURE INPUT TEXT");
    const checks = `
func check(_ value: Bool, _ label: String) { if !value { print("FAILED: " + label); exit(1) } }
for text in ["🙂", "a🙂b", "👨‍👩‍👧‍👦", "e\\u{301}", "日本語", "🇫🇷🇩🇪"] {
  let chunks = keyboardChunks(text)
  check(chunks.flatMap { $0 } == Array(text.utf16), "code units preserved: " + text)
  check(chunks.allSatisfy { String(decoding: $0, as: UTF16.self).unicodeScalars.allSatisfy { $0 != "\\u{FFFD}" } }, "no split pair: " + text)
}
check(keyboardChunks("🙂").count == 1, "an emoji is one event")
check(keyboardChunks("a🙂b").count == 3, "one event per character")
print("agent input chunks passed")
`;
    const main = path.join(directory, "main.swift"), binary = path.join(directory, "chunks");
    await fs.writeFile(main, "import Foundation\n" + pure + checks);
    const build = spawnSync("/usr/bin/xcrun", ["swiftc", "-module-cache-path", path.join(directory, "cache"), main, "-o", binary], { encoding: "utf8", timeout: 120000 });
    assert.equal(build.status, 0, build.stderr);
    const run = spawnSync(binary, [], { encoding: "utf8", timeout: 10000 });
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.match(run.stdout, /agent input chunks passed/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
