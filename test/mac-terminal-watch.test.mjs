import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { WebSocket } from "ws";
import { createReach } from "../server/index.mjs";
import { ALL_SCOPES } from "../server/core.mjs";
import {
  MacTerminalWatch,
  terminalWatchHelper,
} from "../server/mac-terminal-watch.mjs";

// The Mac's Terminal windows reach the phone by events, not polling: the
// helper says when a tab opens, closes or prints; only then does Reach run
// the slow AppleScript list or read, and the phone is told at once.
const settle = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (check, timeout = 3000) => {
  const end = Date.now() + timeout;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > end) throw Error(`Timed out: ${check}`);
    await settle(5);
  }
};

function fakeMac() {
  const mac = {
    tabs: [
      { session: "/dev/ttys101", name: "reach — -zsh — 80×24", text: "one" },
      { session: "/dev/ttys102", name: "notes — vim — 80×24", text: "two" },
    ],
    calls: [],
    slowRead: 0,
    helpers: [],
    run: async (p) => {
      mac.calls.push(p.action);
      if (p.action === "list")
        return {
          running: p.provider === "terminal",
          sessions:
            p.provider === "terminal"
              ? mac.tabs.map((t) => ({
                  target: { epoch: "e", window: "1", session: t.session },
                  name: t.name,
                  tty: t.session,
                }))
              : [],
        };
      const t = mac.tabs.find((x) => x.session === p.target.session);
      if (!t)
        return Promise.reject(Object.assign(Error("gone"), { status: 404 }));
      if (p.action === "read") {
        if (mac.slowRead) await settle(mac.slowRead);
        return { text: t.text };
      }
      return { ok: true };
    },
    // The helper as Reach sees it: events in, tty lists out.
    start: async () => {
      const helper = new EventEmitter();
      helper.sent = [];
      helper.send = (m) => helper.sent.push(m);
      helper.stop = () => (helper.stopped = true);
      mac.helpers.push(helper);
      return helper;
    },
    emit: (event) => mac.helpers.at(-1).emit("event", event),
    reads: () => mac.calls.filter((c) => c === "read").length,
    lists: () => mac.calls.filter((c) => c === "list").length,
  };
  return mac;
}

async function start(t, mac = fakeMac()) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-mac-watch-"));
  const reach = await createReach({
    roots: [dir],
    dataDir: path.join(dir, "private"),
    desktopTerminals: { platform: "darwin", run: mac.run },
    terminalWatch: mac.start,
    macTerminalWatch: { linger: 50, renameCheck: 150, wait: 400, peekGap: 50 },
  });
  await new Promise((r) => reach.server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${reach.server.address().port}`;
  const owner = reach.auth.issue("owner", ALL_SCOPES);
  const sockets = [];
  t.after(async () => {
    for (const ws of sockets) ws.terminate();
    await reach.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const call = (route, { method = "GET", body } = {}) =>
    fetch(url + route, {
      method,
      headers: {
        Authorization: `Bearer ${owner.token}`,
        "Content-Type": "application/json",
      },
      body: body && JSON.stringify(body),
    }).then(async (r) => ({ status: r.status, body: await r.json() }));
  // The phone's live connection.
  const presence = async () => {
    const ws = new WebSocket(url.replace("http:", "ws:") + "/ws/presence");
    sockets.push(ws);
    const seen = [];
    ws.on("message", (b) => {
      const m = JSON.parse(b);
      if (m.type === "presence")
        seen.push({ at: Date.now(), changes: m.changes });
    });
    await once(ws, "open");
    ws.send(
      JSON.stringify({ type: "auth", token: owner.token, kind: "phone" }),
    );
    return { ws, seen, latest: () => seen.at(-1)?.changes?.macTerminals };
  };
  return { mac, call, presence, reach };
}

for (const duringPeek of [false, true]) test(`opening an idle tab loads scrollback ${duringPeek ? "during" : "after"} a Home peek`, async (t) => {
  const mac = fakeMac();
  const run = mac.run;
  mac.slowRead = duringPeek ? 40 : 0;
  mac.run = async (payload) => {
    const result = await run(payload);
    return payload.action === "read" && payload.scrollback
      ? { text: `earlier output\n${result.text}` }
      : result;
  };
  const { call, presence } = await start(t, mac);
  const phone = await presence();
  await until(phone.latest);
  const id = (await call("/api/terminals/desktop")).body.sessions[0].id;
  const peek = call("/api/terminals/desktop/activity?after=-1");
  if (duringPeek) await until(() => mac.reads() > 0);
  else await peek;
  const viewed = await call(`/api/terminals/desktop/${id}?after=0`);
  assert.equal(viewed.status, 200);
  assert.equal(viewed.body.text, "earlier output\none");
  await peek;
});

test("a connected phone is told about Mac terminal changes at once, from a cached list", async (t) => {
  const { mac, call, presence } = await start(t);
  const phone = await presence();
  const first = await until(phone.latest);
  assert.deepEqual(mac.helpers.at(-1).sent.at(-1), {
    ttys: ["/dev/ttys101", "/dev/ttys102"],
  });

  // The phone's list comes from what the Mac already reported.
  const lists = mac.lists();
  const listed = await call("/api/terminals/desktop");
  assert.equal(listed.body.sessions.length, 2);
  assert.equal(mac.lists(), lists, "no AppleScript for a cached list");

  // A new tab: pushed well before the 2-second presence look.
  mac.tabs.push({
    session: "/dev/ttys103",
    name: "api — npm run dev — 80×24",
    text: "",
  });
  const opened = Date.now();
  mac.emit({ type: "opened" });
  await until(() => phone.latest() !== first);
  const pushedIn = phone.seen.at(-1).at - opened;
  assert.ok(pushedIn < 1000, `pushed in ${pushedIn} ms`);
  assert.equal((await call("/api/terminals/desktop")).body.sessions.length, 3);

  // A closed tab: its tty is let go.
  const before = phone.latest();
  mac.tabs.splice(0, 1);
  mac.emit({ type: "closed" });
  await until(() => phone.latest() !== before);
  assert.deepEqual(mac.helpers.at(-1).sent.at(-1), {
    ttys: ["/dev/ttys102", "/dev/ttys103"],
  });

  // An agent's spinner in its title is not a change worth telling.
  const steady = phone.latest();
  mac.tabs[0].name = "notes — ✳ Fixing — claude — 80×24";
  mac.emit({ type: "opened" });
  await until(() => phone.latest() !== steady);
  const titled = phone.latest();
  for (const frame of ["✻", "·", "⠂"]) {
    mac.tabs[0].name = `notes — ${frame} Fixing — claude — 80×24`;
    const looked = mac.lists();
    mac.emit({ type: "opened" });
    await until(() => mac.lists() > looked);
    await settle(100);
    assert.equal(phone.latest(), titled, `"${frame}" is not a change`);
  }
});

test("an open Mac tab's text arrives when it prints, and nothing is read while it's idle", async (t) => {
  const { mac, call, presence } = await start(t);
  await until((await presence()).latest);
  const id = (await call("/api/terminals/desktop")).body.sessions[0].id;
  const first = await call(`/api/terminals/desktop/${id}?after=0`);
  assert.deepEqual(first.body, { text: "one", version: 1 });

  // Waiting for more: answered as soon as the tab prints.
  const waiting = call(`/api/terminals/desktop/${id}?after=1`);
  await settle(50);
  mac.tabs[0].text = "one\ntwo";
  const printed = Date.now();
  mac.emit({ type: "output", tty: "/dev/ttys101" });
  const next = await waiting;
  assert.deepEqual(next.body, { text: "one\ntwo", version: 2 });
  assert.ok(Date.now() - printed < 400);

  // Idle: no reads at all; the wait just ends with nothing new.
  const reads = mac.reads();
  const idle = await call(`/api/terminals/desktop/${id}?after=2`);
  assert.deepEqual(idle.body, { version: 2, unchanged: true });
  assert.equal(mac.reads(), reads);

  // Output in a tab nobody is looking at isn't read either.
  mac.emit({ type: "output", tty: "/dev/ttys102" });
  await settle(50);
  assert.equal(mac.reads(), reads);
});

test("sending while Reach reads in the background waits instead of failing", async (t) => {
  const { mac, call, presence } = await start(t);
  await until((await presence()).latest);
  const id = (await call("/api/terminals/desktop")).body.sessions[0].id;
  await call(`/api/terminals/desktop/${id}?after=0`);
  mac.slowRead = 150;
  mac.emit({ type: "output", tty: "/dev/ttys101" });
  await settle(20);
  const sent = await call(`/api/terminals/desktop/${id}/send`, {
    method: "POST",
    body: { text: "ls" },
  });
  assert.equal(sent.status, 200);
  assert.equal(mac.calls.at(-1), "send");
});

test("Home hears each tab's last line when it changes, not on a timer", async (t) => {
  const { mac, call, presence } = await start(t);
  await until((await presence()).latest);
  const first = await call("/api/terminals/desktop/activity?after=-1");
  assert.equal(Object.keys(first.body.peeks).length, 2);
  assert.deepEqual(Object.values(first.body.peeks).sort(), ["one", "two"]);

  const waiting = call(
    `/api/terminals/desktop/activity?after=${first.body.version}`,
  );
  await settle(30);
  mac.tabs[1].text = "two\nsaved notes.txt";
  mac.emit({ type: "output", tty: "/dev/ttys102" });
  const next = await waiting;
  assert.ok(Object.values(next.body.peeks).includes("saved notes.txt"));

  const reads = mac.reads();
  const idle = await call(
    `/api/terminals/desktop/activity?after=${next.body.version}`,
  );
  assert.equal(idle.body.version, next.body.version);
  assert.equal(mac.reads(), reads, "no reads while nothing prints");
});

test("the watch stops when the last phone leaves, and phones fall back to asking", async (t) => {
  const { mac, call, presence } = await start(t);
  const phone = await presence();
  await until(phone.latest);
  phone.ws.close();
  await until(() => mac.helpers.at(-1).stopped, 2000);
  const lists = mac.lists();
  const listed = await call("/api/terminals/desktop");
  assert.equal(listed.body.sessions.length, 2);
  assert.equal(mac.lists(), lists + 2, "asked the Mac directly again");
  const activity = await call("/api/terminals/desktop/activity?after=-1");
  assert.equal(activity.status, 409);
});

test(
  "the real helper hears a terminal print within milliseconds",
  { skip: process.platform !== "darwin" },
  async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-terminal-watch-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    // A real terminal device, held by a small process we control.
    const holder = spawn("python3", [
      "-u",
      "-c",
      "import os,sys\nm,s=os.openpty()\nprint(os.ttyname(s),flush=True)\nfor line in sys.stdin: os.write(s, line.encode())",
    ]);
    t.after(() => holder.kill());
    const [tty] = (await once(holder.stdout, "data")).map((d) =>
      String(d).trim(),
    );
    let text = "ready";
    const actions = [];
    const terminals = {
      list: async () => ({
        sessions: [{ id: "t1", provider: "terminal", name: "test", tty }],
        providers: [{ id: "terminal", running: true }],
      }),
      action: async (id, action) => {
        actions.push(action);
        return { text };
      },
    };
    const watch = new MacTerminalWatch({
      terminals,
      start: terminalWatchHelper({ dataDir: dir }),
      readGap: 0,
      wait: 1500,
    });
    t.after(() => watch.end());
    watch.retain();
    await until(() => watch.helper, 120000);
    let watching = false;
    watch.helper.on("event", (e) => {
      if (e.type === "watching" && e.ttys === 1) watching = true;
    });
    await until(() => watching, 5000);
    assert.deepEqual(await watch.text("t1", 0, () => {}), {
      text: "ready",
      version: 1,
    });
    const waiting = watch.text("t1", 1, () => {});
    text = "ready\nhello";
    const wrote = performance.now();
    holder.stdin.write("hello\n");
    assert.deepEqual(await waiting, { text: "ready\nhello", version: 2 });
    const took = performance.now() - wrote;
    assert.ok(took < 250, `text arrived ${took.toFixed(0)} ms after the write`);
    const reads = actions.length;
    assert.deepEqual(await watch.text("t1", 2, () => {}), {
      version: 2,
      unchanged: true,
    });
    assert.equal(
      actions.length,
      reads,
      "nothing read while the terminal was idle",
    );
  },
);


test("ending a watch aborts preparation and discards a helper that arrives after close", async () => {
  let prepared, signal, stopped = false;
  const helper = new EventEmitter();
  helper.stop = () => { stopped = true; };
  const watch = new MacTerminalWatch({
    terminals: { list: () => assert.fail("a closed watch cannot inspect terminals") },
    start: ({ signal: pending }) => {
      signal = pending;
      return new Promise(resolve => { prepared = resolve; });
    },
  });
  watch.retain();
  const starting = watch.starting;
  watch.end();
  assert.equal(signal.aborted, true, "pending native compilation receives cancellation");
  prepared(helper); // even a dependency that ignores cancellation cannot install a helper
  await starting;
  assert.equal(stopped, true);
  assert.equal(watch.helper, null);
  assert.deepEqual(watch.timers, {});
});

test("ending a watch during its first refresh cannot reinstall its safety timer", async () => {
  let listed;
  const helper = new EventEmitter();
  helper.send = () => {};
  helper.stop = () => {};
  const watch = new MacTerminalWatch({
    terminals: { list: () => new Promise(resolve => { listed = resolve; }) },
    start: async () => helper,
  });
  watch.retain();
  await until(() => listed);
  const starting = watch.starting;
  watch.end();
  listed({ sessions: [], providers: [] });
  await starting;
  assert.equal(watch.helper, null);
  assert.deepEqual(watch.timers, {});
});


test("a new phone can prepare a watch before an aborted preparation settles", async () => {
  const pending = [];
  const watch = new MacTerminalWatch({
    terminals: { list: async () => ({ sessions: [], providers: [] }) },
    start: ({ signal }) => new Promise(resolve => pending.push({ signal, resolve })),
  });
  const helper = () => {
    const h = new EventEmitter();
    h.send = () => {};
    h.stop = () => { h.stopped = true; };
    return h;
  };
  watch.retain();
  const first = watch.starting;
  watch.end();
  assert.equal(pending[0].signal.aborted, true);
  assert.equal(pending.length, 1, "end must not restart just because users remain");
  watch.retain();
  const replacement = watch.starting;
  assert.equal(pending.length, 2, "an explicit new retain starts fresh preparation");
  assert.notEqual(replacement, first);
  const stale = helper();
  pending[0].resolve(stale); // the cancelled dependency ignores its signal
  await first;
  assert.equal(stale.stopped, true);
  assert.equal(watch.starting, replacement, "old finally cannot clear the replacement's ownership");
  assert.equal(watch.preparing.signal, pending[1].signal);
  assert.equal(pending[1].signal.aborted, false);
  const current = helper();
  pending[1].resolve(current);
  await replacement;
  assert.equal(watch.helper, current);
  assert.equal(watch.ready, true);
  watch.end();
  assert.equal(current.stopped, true);
});


test("late events from a stopped or replaced helper cannot restart terminal discovery", async (t) => {
  let lists = 0;
  const helpers = [];
  const watch = new MacTerminalWatch({
    terminals: { list: async () => { lists++; return { sessions: [], providers: [] }; } },
    start: async () => {
      const helper = new EventEmitter();
      helper.send = () => {};
      helper.stop = () => {};
      helpers.push(helper);
      return helper;
    },
  });
  t.after(() => watch.end());
  watch.retain();
  await watch.starting;
  assert.equal(lists, 1);
  const old = helpers[0];
  watch.end();
  old.emit("event", { type: "opened" });
  old.emit("event", { type: "output", tty: "/dev/synthetic" });
  assert.deepEqual(watch.timers, {}, "a stopped helper must not enqueue discovery");
  await settle(300);
  assert.equal(lists, 1);
  watch.retain();
  await watch.starting;
  assert.equal(lists, 2);
  old.emit("event", { type: "opened" });
  old.emit("event", { type: "output", tty: "/dev/synthetic" });
  assert.equal(watch.timers.soon, undefined, "a replaced helper must not enqueue discovery");
  assert.equal(watch.timers.rename, undefined);
  helpers[1].emit("event", { type: "opened" });
  await until(() => lists === 3);
});


test("ending a crashed terminal watch cancels its pending helper restart", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const helpers = [];
  const watch = new MacTerminalWatch({
    terminals: { list: async () => ({ sessions: [], providers: [] }) },
    start: async () => {
      const helper = new EventEmitter(); helper.stop = () => {}; helper.send = () => {};
      helpers.push(helper); return helper;
    },
  });
  try {
    watch.retain(); await watch.starting;
    helpers[0].emit("exit");
    watch.end();
    t.mock.timers.tick(10000); await Promise.resolve();
    assert.equal(helpers.length, 1, "shutdown must not resurrect the watcher while users still unwind");
    assert.equal(watch.helper, null);
  } finally { watch.end(); }
});

test("terminal watch crash recovery survives an old pending initial read and keeps bounded backoff", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const helpers = [];
  let finishRead;
  const firstRead = new Promise(resolve => { finishRead = resolve; });
  const watch = new MacTerminalWatch({
    terminals: { list: async () => firstRead },
    start: async () => {
      const helper = new EventEmitter(); helper.stop = () => {}; helper.send = () => {};
      helpers.push(helper); return helper;
    },
  });
  try {
    watch.retain(); await Promise.resolve();
    const old = watch.starting;
    helpers[0].emit("exit");
    t.mock.timers.tick(999); await Promise.resolve(); assert.equal(helpers.length, 1);
    t.mock.timers.tick(1); await Promise.resolve(); assert.equal(helpers.length, 2);
    const replacement = watch.starting;
    finishRead({ sessions: [], providers: [] }); await old; await replacement;
    assert.equal(watch.helper, helpers[1]);
    helpers[1].emit("exit");
    t.mock.timers.tick(1999); await Promise.resolve(); assert.equal(helpers.length, 2);
    t.mock.timers.tick(1); await Promise.resolve(); assert.equal(helpers.length, 3);
    await watch.starting;
  } finally { finishRead({ sessions: [], providers: [] }); watch.end(); }
});
