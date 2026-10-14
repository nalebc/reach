import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { DesktopTerminals } from "../server/desktop-terminals.mjs";
import { createReach } from "../server/index.mjs";
import { ALL_SCOPES } from "../server/core.mjs";

const allow = () => {};
const tab = (session, name = "Same title") => ({
  target: { epoch: "process:start", window: "42", session },
  name,
  tty: session,
});
const fixture = () => {
  const calls = [];
  let tabs = [tab("/dev/ttys1"), tab("/dev/ttys2")];
  return {
    calls,
    setTabs: (value) => {
      tabs = value;
    },
    run: async (p) => {
      calls.push(p);
      if (p.action === "list")
        return {
          running: p.provider === "terminal",
          sessions: p.provider === "terminal" ? tabs : [],
        };
      if (p.action === "read")
        return { text: "<script>literal terminal output</script>" };
      return { ok: true };
    },
  };
};
test("desktop tabs have distinct stable identities independent of titles and order", async () => {
  const f = fixture(),
    d = new DesktopTerminals({ platform: "darwin", run: f.run });
  const a = await d.list(allow);
  assert.equal(a.sessions.length, 2);
  assert.notEqual(a.sessions[0].id, a.sessions[1].id);
  f.setTabs([tab("/dev/ttys2", "Renamed"), tab("/dev/ttys1")]);
  const b = await d.list(allow);
  assert.equal(a.sessions[1].id, b.sessions[0].id);
  const command = "printf '%s' 'quotes \" and $(literal)';\nhello";
  await d.action(a.sessions[1].id, "send", { text: command }, allow);
  assert.equal(f.calls.at(-1).target.session, "/dev/ttys2");
  assert.equal(f.calls.at(-1).text, command);
  f.setTabs([]);
  await d.list(allow);
  await assert.rejects(
    d.action(a.sessions[0].id, "send", { text: "echo test" }, allow),
    { status: 404 },
  );
});
test("desktop commands validate input, close confirmation, provider and platform before execution", async () => {
  const f = fixture(),
    d = new DesktopTerminals({ platform: "darwin", run: f.run });
  const {
    sessions: [s],
  } = await d.list(allow);
  const before = f.calls.length;
  for (const text of [
    undefined,
    " ",
    "x".repeat(16001),
    "\0",
    "\x03",
    "\x1b[A",
  ])
    await assert.rejects(d.action(s.id, "send", { text }, allow), {
      status: 400,
    });
  // Return on its own (accepting a prompt) goes through as an empty line.
  await d.action(s.id, "send", { text: "" }, allow);
  assert.equal(f.calls.at(-1).action, "send");
  assert.equal(f.calls.at(-1).text, "");
  await assert.rejects(d.action(s.id, "close", {}, allow), { status: 400 });
  await assert.rejects(d.action(s.id, "arbitrary", {}, allow), { status: 400 });
  await assert.rejects(d.create("some-user-app", allow), { status: 400 });
  assert.equal(f.calls.length, before + 1);
  await d.action(s.id, "close", { confirm: true }, allow);
  assert.equal(f.calls.at(-1).action, "close");
  await assert.rejects(d.action(s.id, "read", {}, allow), { status: 404 });
  await assert.rejects(
    new DesktopTerminals({ platform: "linux", run: f.run }).list(allow),
    { status: 409 },
  );
});
test("one unavailable app does not hide another; revoked access cannot publish results", async () => {
  let authorized = true;
  const run = async (p) => {
    if (p.provider === "iterm2") throw Error("Automation denied");
    return { sessions: [tab("tty")], running: true };
  };
  const d = new DesktopTerminals({ platform: "darwin", run });
  const result = await d.list(allow);
  assert.equal(result.sessions.length, 1);
  assert.match(result.providers[1].error, /denied/);
  d.run = async () => {
    authorized = false;
    return { sessions: [], running: false };
  };
  await assert.rejects(
    d.list(() => {
      if (!authorized) throw Error("revoked");
    }),
    /revoked/,
  );
});
test("overlapping native operations are bounded and never silently repeated", async () => {
  let done;
  const d = new DesktopTerminals({
    platform: "darwin",
    run: () =>
      new Promise((r) => {
        done = r;
      }),
  });
  const creating = d.create("terminal", allow);
  await assert.rejects(d.create("terminal", allow), { status: 409 });
  done({ ok: true });
  await creating;
  assert.equal(d.busy, false);
});
test("a line typed while the phone is still reading the tab waits for the read and goes, never refused", async () => {
  // Oct 14, the user journeys: Enter in a computer's terminal on the phone
  // came back 409 while the phone's own read of that tab was running, and
  // the person's line didn't go.
  const f = fixture();
  const held = [];
  let hold = false;
  const d = new DesktopTerminals({
    platform: "darwin",
    run: (p) => (hold && (p.action === "read" || p.action === "list") ? new Promise((r) => held.push(() => r(f.run(p)))) : f.run(p)),
  });
  const { sessions } = await d.list(allow);
  hold = true;
  const pause = () => new Promise((r) => setTimeout(r, 20));
  for (const look of [() => d.action(sessions[0].id, "read", { scrollback: true }, allow), () => d.list(allow)]) {
    const looking = look();
    const sent = d.action(sessions[0].id, "send", { text: "echo hi" }, allow);
    await pause();
    assert.equal(f.calls.some((c) => c.action === "send"), false, "it waits for the look");
    // The look finishes (a list asks Terminal, then iTerm2).
    for (let i = 0; i < 4; i++) {
      while (held.length) held.shift()();
      await pause();
    }
    await looking;
    assert.deepEqual(await sent, { ok: true });
    assert.equal(f.calls.filter((c) => c.action === "send").length, 1, "sent once");
    f.calls.length = 0;
  }
  // Two of a person's own changes still never overlap.
  let done;
  d.run = (p) => (p.action === "send" ? new Promise((r) => (done = () => r({ ok: true }))) : f.run(p));
  const first = d.action(sessions[0].id, "send", { text: "one" }, allow);
  await assert.rejects(d.action(sessions[0].id, "send", { text: "two" }, allow), { status: 409 });
  done();
  await first;
});

const helper = await fs.readFile(
  new URL("../scripts/native/mac-terminals.js", import.meta.url),
  "utf8",
);
// Terminal as its scripting has it: windows of tabs. `ttys`: the tabs of one
// window; `alone`: one more window with just this tab. A hangup on a tab's
// terminal ends what runs there unless `stubborn` keeps it running. Only a
// window can be closed: a tab "doesn't understand" close (Oct 14, the user
// journeys: the old stand-in took a tab, the real Terminal never did).
function nativeFixture(payload, { running = true, epoch = "start", ttys = ["tty1", "tty2"], alone, stubborn = false } = {}) {
  const calls = [];
  const ended = new Set(["tty2"]);
  const pane = (tty) => ({
    tty: () => tty,
    customTitle: () => "",
    contents: () => `output:${tty}`,
    history: () => `earlier:${tty}\noutput:${tty}`,
    // tty2's command has finished: Terminal keeps the tab, nothing runs in it.
    processes: () => (ended.has(tty) ? [] : ["login", "-zsh"]),
    close: () => {
      throw Error("Message not understood.");
    },
  });
  const panes = ttys.map(pane);
  const win = { id: () => 42, name: () => "Window", tabs: () => panes };
  const single = alone && { id: () => 43, name: () => "Alone", tabs: () => [pane(alone)] };
  const app = {
    windows: () => (single ? [win, single] : [win]),
    doScript: (...args) => calls.push(["send", ...args]),
    close: (what) => {
      if (what !== win && what !== single) throw Error("Message not understood.");
      calls.push(["close", what]);
    },
    activate: () => calls.push(["focus"]),
  };
  // The hangup, as `do shell script` runs it: what runs on the named
  // terminal ends (unless `stubborn`).
  const Application = () => {
    calls.push(["application"]);
    return app;
  };
  Application.currentApplication = () => ({
    doShellScript: (command) => {
      calls.push(["shell", command]);
      const tty = /-t (ttys\d+) /.exec(command)?.[1];
      if (tty && !stubborn) ended.add(`/dev/${tty}`);
      return "";
    },
  });
  const context = vm.createContext({
    delay: () => {},
    ObjC: { import() {}, unwrap: (v) => v },
    $: {
      NSFileHandle: {
        fileHandleWithStandardInput: {
          readDataToEndOfFile: JSON.stringify(payload),
        },
      },
      NSString: { alloc: { initWithDataEncoding: (v) => v } },
      NSUTF8StringEncoding: 4,
      NSRunningApplication: {
        runningApplicationsWithBundleIdentifier: () => ({
          count: running ? "1" : "0",
          objectAtIndex: () => ({
            processIdentifier: 10,
            launchDate: { timeIntervalSince1970: epoch },
          }),
        }),
      },
    },
    Application,
  });
  vm.runInContext(helper, context);
  return {
    result: JSON.parse(vm.runInContext("run()", context)),
    calls,
    panes,
  };
}
test("a viewed Terminal tab reads its scrollback; peeks read only the screen", () => {
  const { target } = nativeFixture({ provider: "terminal", action: "list" })
    .result.sessions[0];
  const read = (extra) =>
    nativeFixture({ provider: "terminal", action: "read", target, ...extra })
      .result.text;
  assert.equal(read({ scrollback: true }), "earlier:tty1\noutput:tty1");
  assert.equal(read({}), "output:tty1");
});
test("Terminal tabs whose command has finished are not listed", async () => {
  const listed = nativeFixture({ provider: "terminal", action: "list" });
  assert.deepEqual(
    listed.result.sessions.map((s) => [s.tty, s.ended]),
    [
      ["tty1", false],
      ["tty2", true],
    ],
  );
  const f = fixture();
  f.setTabs([tab("/dev/ttys1", "owner — -zsh"), { ...tab("/dev/ttys9", "owner — local.command — 80×24"), ended: true }]);
  const d = new DesktopTerminals({ platform: "darwin", run: f.run });
  const { sessions } = await d.list(allow);
  assert.deepEqual(sessions.map((s) => s.name), ["owner — -zsh"]);
});
test("native helper targets the exact tab, never launches apps during discovery, and rejects stale app epochs", () => {
  const absent = nativeFixture(
    { provider: "terminal", action: "list" },
    { running: false },
  );
  assert.deepEqual(absent.result, { sessions: [], running: false });
  assert.equal(absent.calls.length, 0);
  const listed = nativeFixture({ provider: "terminal", action: "list" });
  const target = listed.result.sessions[1].target;
  const sent = nativeFixture({
    provider: "terminal",
    action: "send",
    target,
    text: 'hello "quoted"',
  });
  assert.equal(sent.calls[1][2].in, sent.panes[1]);
  assert.equal(sent.calls[1][1], 'hello "quoted"');
  const stale = nativeFixture(
    { provider: "terminal", action: "close", target },
    { epoch: "new-launch" },
  );
  assert.equal(stale.result.status, 404);
  assert.equal(stale.calls.length, 1);
});
test("closing a Mac Terminal tab from the phone ends what runs in it, then closes its window, never leaving Terminal's question on the Mac", () => {
  const listed = (options) => nativeFixture({ provider: "terminal", action: "list" }, options).result.sessions;
  const close = (target, options) => nativeFixture({ provider: "terminal", action: "close", target }, options);
  // A tab alone in its window, as a new Terminal window is: hung up, then
  // the window closes (Terminal closes windows, not tabs).
  const options = { ttys: ["/dev/ttys004", "/dev/ttys006"], alone: "/dev/ttys005" };
  const alone = listed(options).find((s) => s.tty === "/dev/ttys005");
  const closed = close(alone.target, options);
  assert.deepEqual(closed.result, { ok: true });
  const [, hangup] = closed.calls.find(([kind]) => kind === "shell");
  assert.match(hangup, /^\/bin\/ps -t ttys005 -o pid= -o uid= \| /, "only that tab's terminal");
  assert.match(hangup, /\$2 == me/, "only the owner's programs on it");
  assert.match(hangup, /\/bin\/kill -HUP/, "a hangup, as Terminal's Terminate gives");
  const windowClosed = closed.calls.find(([kind]) => kind === "close");
  assert.equal(windowClosed[1].name(), "Alone", "its own window, nothing else");
  // One tab among others: hung up; its window, with the other tab, stays.
  const shared = close(listed(options).find((s) => s.tty === "/dev/ttys004").target, options);
  assert.deepEqual(shared.result, { ok: true });
  assert.ok(shared.calls.some(([kind]) => kind === "shell"));
  assert.equal(shared.calls.some(([kind]) => kind === "close"), false);
  // Something that keeps running: left as it is, and said, so Terminal
  // never asks about it on the Mac.
  const kept = close(alone.target, { ...options, stubborn: true });
  assert.equal(kept.result.status, 409);
  assert.match(kept.result.error, /still running\. Close it on the Mac/);
  assert.equal(kept.calls.some(([kind]) => kind === "close"), false);
  // A tab whose terminal isn't one of Terminal's: nothing is run at all.
  const odd = close(listed().find((s) => s.tty === "tty1").target);
  assert.equal(odd.result.status, 502);
  assert.equal(odd.calls.some(([kind]) => kind === "shell" || kind === "close"), false);
});
test("desktop HTTP API excludes agents and unauthenticated clients and preserves the Reach PTY API", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "reach-desktop-test-"));
  const f = fixture();
  const reach = await createReach({
    roots: [root],
    dataDir: path.join(root, ".reach"),
    desktopTerminals: { platform: "darwin", run: f.run },
  });
  await new Promise((r) => reach.server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${reach.server.address().port}`;
  const owner = reach.auth.issue("owner", ALL_SCOPES);
  const agent = reach.auth.issue("agent", ["terminal"], "agent");
  const call = async (route, token, body) => {
    const r = await fetch(url + route, {
      method: body ? "POST" : "GET",
      headers: {
        Authorization: `Bearer ${token || ""}`,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, body: await r.json() };
  };
  try {
    assert.equal((await call("/api/terminals/desktop")).status, 401);
    assert.equal(
      (await call("/api/terminals/desktop", agent.token)).status,
      403,
    );
    assert.equal(
      (await call("/api/TeRmiNals/desktop", agent.token)).status,
      403,
    );
    assert.equal(f.calls.length, 0);
    const listed = await call("/api/terminals/desktop", owner.token);
    assert.equal(listed.status, 200);
    const id = listed.body.sessions[0].id;
    for (const action of ["send", "close", "focus"])
      assert.equal(
        (
          await call(`/api/terminals/desktop/${id}/${action}`, agent.token, {
            text: "whoami",
            confirm: true,
          })
        ).status,
        403,
      );
    assert.equal(
      (await call(`/api/terminals/desktop/${id}`, agent.token)).status,
      403,
    );
    assert.equal(
      (await call(`/api/terminals/desktop/${id}/close`, owner.token, {}))
        .status,
      400,
    );
    assert.equal(
      (
        await call(`/api/terminals/desktop/${id}/send`, owner.token, {
          text: "echo fixture",
        })
      ).status,
      200,
    );
    assert.match(
      (await call(`/api/terminals/desktop/${id}`, owner.token)).body.text,
      /literal terminal output/,
    );
    assert.deepEqual((await call("/api/terminals", owner.token)).body, []);
    assert.equal(
      (
        await call("/api/terminals/desktop", owner.token, {
          provider: "terminal",
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await call(`/api/terminals/desktop/${id}/close`, owner.token, {
          confirm: true,
        })
      ).status,
      200,
    );
    assert.equal(
      (await call(`/api/terminals/desktop/${id}`, owner.token)).status,
      404,
    );
  } finally {
    await reach.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
