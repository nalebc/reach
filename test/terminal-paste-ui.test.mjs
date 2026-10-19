import test, { before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { startDom, settle } from "./dom/harness.mjs";

// Paste from the phone into a terminal (TerminalPaste.tsx): Paste in the key
// row reads the phone's clipboard within the tap; a phone that won't hand it
// over gets a box that takes its own paste. In a terminal Reach started, the
// text arrives as xterm pastes it, in pieces the server takes; in a Mac or PC
// tab, each line runs as a command. Simulated: jsdom, a stand-in xterm and
// socket. The browser's clipboard permission is in journeys/terminals.
const peer = { id: "mac", name: "Mac", url: "https://reach.test", token: "t", platform: "darwin" };
let dom, React, TerminalView, MacTerminalView, Terminal;
let clipboard, toasts, asked, answer, lines, desktopSends;
class Socket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static all = [];
  constructor(url) {
    this.url = String(url);
    this.readyState = 0;
    this.sent = [];
    Socket.all.push(this);
    queueMicrotask(() => {
      this.readyState = 1;
      this.onopen?.();
    });
  }
  send(data) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.readyState = 3;
  }
  receive(message) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
  // What reached the shell, in order.
  get input() {
    return this.sent.filter((m) => m.type === "input").map((m) => m.data).join("");
  }
}
const WebSocketBefore = globalThis.WebSocket;
before(async () => {
  dom = await startDom({
    fakes: {
      "@xterm/xterm": "test/dom/fakes/xterm.mjs",
      "@xterm/addon-fit": "test/dom/fakes/xterm.mjs",
    },
    routes: {
      "/api/terminals/agents": () => ({ agents: [] }),
      "/api/terminals/desktop": () => ({ sessions: [], providers: [] }),
      ...Object.fromEntries(["t1", "t2"].map((id) => [`/api/terminals/desktop/${id}/send`, (init, url) => {
        const text = JSON.parse(init.body).text;
        lines.push(text);
        desktopSends.push({ id, origin: url.origin, token: new Headers(init.headers).get("Authorization"), text });
        return { ok: true };
      }])),
      "/api/terminals/desktop/t1": () => new Promise(() => {}),
      "/api/terminals/desktop/t2": () => new Promise(() => {}),
    },
  });
  globalThis.WebSocket = Socket;
  Object.defineProperty(dom.window.navigator, "clipboard", {
    configurable: true,
    get: () => clipboard,
  });
  React = dom.React;
  ({ TerminalView } = await dom.load("/src/Sessions.tsx"));
  ({ default: MacTerminalView } = await dom.load("/src/MacTerminalView.tsx"));
  ({ Terminal } = await dom.load("/test/dom/fakes/xterm.mjs"));
});
after(async () => {
  await dom?.close();
  globalThis.WebSocket = WebSocketBefore;
});
beforeEach(() => {
  toasts = [];
  asked = [];
  answer = true;
  lines = [];
  desktopSends = [];
  Socket.all = [];
  clipboard = { readText: async () => "" };
  globalThis.confirm = (question) => (asked.push(question), answer);
});

const tap = (element) => dom.update(() => element.click());
const pasteKey = (view) => view.container.querySelector('[aria-label="Paste"]');

// A terminal Reach started on the computer, connected.
async function reachTerminal({ connect = true } = {}) {
  let setProps;
  function Target() {
    const [props, update] = React.useState({
      desktopTerminals: false,
      peer,
      sessions: ["s1", "s2"].map((id) => ({ id, name: "zsh", cwd: "/Users/me", status: "running" })),
      selected: "s1",
      onSelect() {},
      onNew() {},
      onRefresh() {},
      toast: (message) => toasts.push(message),
      source: "reach",
      setSource() {},
      onExit() {},
    });
    setProps = update;
    return React.createElement(TerminalView, props);
  }
  const view = await dom.render(React.createElement(Target));
  const socket = await dom.waitFor(() => Socket.all.at(-1));
  await dom.waitFor(() => socket.sent.some((m) => m.type === "auth"));
  if (connect) {
    socket.receive({ type: "snapshot", data: "$ ", status: "running", heartbeat: true });
    await settle();
  }
  return { view, socket, term: Terminal.instances.at(-1),
    change: async (next) => {
      dom.update(() => setProps((previous) => ({ ...previous, ...next })));
      await settle();
      const current = Socket.all.at(-1);
      await dom.waitFor(() => current.sent.some((m) => m.type === "auth"));
      current.receive({ type: "snapshot", data: "$ ", status: "running", heartbeat: true });
      await settle();
      return current;
    },
  };
}

async function desktopTerminal() {
  let setProps;
  function Target() {
    const [props, update] = React.useState({ peer, tab: { id: "t1", name: "zsh", provider: "terminal" }, onGone() {} });
    setProps = update;
    return React.createElement(MacTerminalView, props);
  }
  const view = await dom.render(React.createElement(Target));
  return { view, change: async (next) => {
    dom.update(() => setProps((previous) => ({ ...previous, ...next })));
    await settle();
  } };
}

const targets = [
  { name: "terminal", reach: { selected: "s2" }, desktop: { tab: { id: "t2", name: "zsh", provider: "terminal" } } },
  ...[
    ["device identity", { id: "another-device" }],
    ["computer identity", { computerId: "another-computer" }],
    ["credential", { token: "replacement-credential" }],
    ["address", { url: "https://other-reach.test" }],
    ["transport", { transport: "funnel" }],
    ["grant session", { sessionId: "another-grant" }],
  ].map(([name, change]) => ({ name, reach: { peer: { ...peer, ...change } }, desktop: { peer: { ...peer, ...change } } })),
];

// These delayed clipboard promises model a prompt remaining open during a
// committed target change. No test reads or writes the OS/phone clipboard.
for (const mode of ["reach", "desktop"]) {
  const start = mode === "reach" ? reachTerminal : desktopTerminal;
  for (const target of targets) {
    for (const result of ["fulfilled", "rejected"]) {
      test(`${mode}: a ${result} clipboard read is discarded after changing ${target.name}`, async (t) => {
        let resolve, reject;
        clipboard = { readText: () => new Promise((yes, no) => { resolve = yes; reject = no; }) };
        const { view, change } = await start();
        t.after(() => view.unmount());
        tap(pasteKey(view));
        await change(target[mode]);
        if (result === "fulfilled") resolve("must stay with the original target\n");
        else reject(new DOMException("Denied", "NotAllowedError"));
        await settle();
        assert.equal(Socket.all.map((s) => s.input).join(""), "", "no old read is sent on any shell socket");
        assert.deepEqual(desktopSends, [], "no old read becomes a command in another desktop tab");
        assert.deepEqual(asked, [], "a stale read cannot open a command confirmation");
        assert.deepEqual(toasts, [], "a stale read cannot update the next target's message");
        assert.equal(view.container.querySelector(".terminal-paste"), null, "a stale rejection cannot open fallback on the next target");
      });
    }
  }
  test(`${mode}: switching away and back invalidates the old read, while a fresh paste works once`, async (t) => {
    let resolve;
    clipboard = { readText: () => new Promise((yes) => { resolve = yes; }) };
    const { view, change } = await start();
    t.after(() => view.unmount());
    tap(pasteKey(view));
    await change(targets[0][mode]);
    await change(mode === "reach" ? { selected: "s1" } : { tab: { id: "t1", name: "zsh", provider: "terminal" } });
    resolve("old read must not return\n");
    await settle();
    assert.equal(Socket.all.map((s) => s.input).join(""), "");
    assert.deepEqual(desktopSends, []);
    assert.deepEqual(asked, []);
    clipboard = { readText: async () => mode === "reach" ? "fresh paste" : "fresh paste\n" };
    tap(pasteKey(view));
    await dom.waitFor(() => mode === "reach" ? Socket.all.at(-1).input : desktopSends.length);
    assert.equal(Socket.all.map((s) => s.input).join(""), mode === "reach" ? "fresh paste" : "");
    assert.deepEqual(lines, mode === "desktop" ? ["fresh paste"] : []);
  });
  for (const result of ["fulfilled", "rejected", "empty"]) {
    test(`${mode}: an unmounted target ignores a ${result} clipboard read`, async () => {
      let resolve, reject;
      clipboard = { readText: () => new Promise((yes, no) => { resolve = yes; reject = no; }) };
      const { view } = await start();
      tap(pasteKey(view));
      await view.unmount();
      if (result === "rejected") reject(new DOMException("Denied", "NotAllowedError"));
      else resolve(result === "empty" ? "" : "must not prompt or send after unmount\n");
      await settle();
      assert.equal(Socket.all.map((s) => s.input).join(""), "");
      assert.deepEqual(desktopSends, []);
      assert.deepEqual(asked, []);
      assert.deepEqual(toasts, []);
      assert.equal(dom.document.querySelector(".terminal-paste"), null);
    });
  }
  for (const target of targets) test(`${mode}: an open manual fallback is cleared after changing ${target.name}`, async (t) => {
    clipboard = undefined;
    const { view, change } = await start();
    t.after(() => view.unmount());
    tap(pasteKey(view));
    const box = await dom.waitFor(() => view.container.querySelector(".terminal-paste textarea"));
    dom.update(() => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value").set.call(box, "only for old target");
      box.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
    await change(target[mode]);
    assert.equal(view.container.querySelector(".terminal-paste"), null);
    tap(pasteKey(view));
    const fresh = await dom.waitFor(() => view.container.querySelector(".terminal-paste textarea"));
    assert.equal(fresh.value, "", "old fallback text does not travel to a new target");
    assert.equal(Socket.all.map((s) => s.input).join(""), "");
    assert.deepEqual(desktopSends, []);
  });
  test(`${mode}: a manual draft cannot return after switching away and back`, async (t) => {
    clipboard = undefined;
    const { view, change } = await start();
    t.after(() => view.unmount());
    tap(pasteKey(view));
    const box = await dom.waitFor(() => view.container.querySelector(".terminal-paste textarea"));
    dom.update(() => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value").set.call(box, "old draft must not return");
      box.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
    await change(targets[0][mode]);
    await change(mode === "reach" ? { selected: "s1" } : { tab: { id: "t1", name: "zsh", provider: "terminal" } });
    assert.equal(view.container.querySelector(".terminal-paste"), null);
    tap(pasteKey(view));
    const fresh = await dom.waitFor(() => view.container.querySelector(".terminal-paste textarea"));
    assert.equal(fresh.value, "");
    assert.equal(Socket.all.map((s) => s.input).join(""), "");
    assert.deepEqual(desktopSends, []);
  });
  for (const target of targets.slice(0, 3)) test(`${mode}: a workspace label cannot carry a manual draft to another ${target.name}`, async (t) => {
    clipboard = undefined;
    const { view, change } = await start();
    t.after(() => view.unmount());
    const workspaceKey = JSON.stringify([peer.id, peer.url, peer.token, peer.transport, peer.sessionId]);
    await change({ peer: { ...peer, workspaceKey } });
    tap(pasteKey(view));
    const box = await dom.waitFor(() => view.container.querySelector(".terminal-paste textarea"));
    dom.update(() => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value").set.call(box, "only for this device and terminal");
      box.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
    const next = target[mode];
    await change({ ...next, ...(next.peer ? { peer: { ...next.peer, workspaceKey } } : {}) });
    assert.equal(view.container.querySelector(".terminal-paste"), null);
    tap(pasteKey(view));
    const fresh = await dom.waitFor(() => view.container.querySelector(".terminal-paste textarea"));
    assert.equal(fresh.value, "");
    assert.equal(Socket.all.map((s) => s.input).join(""), "");
    assert.deepEqual(desktopSends, []);
  });

  for (const destination of ["browser", "native"]) for (const result of ["fulfilled", "rejected"]) {
    test(`${mode}: verified private handoffs preserve a manual draft for ${destination}, while a ${result} old read is discarded`, async (t) => {
      clipboard = undefined;
      const { view, change } = await start();
      t.after(() => view.unmount());
      tap(pasteKey(view));
      const box = await dom.waitFor(() => view.container.querySelector(".terminal-paste textarea"));
      const draft = mode === "reach" ? "unsent manual draft" : "unsent manual draft\n";
      dom.update(() => {
        Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value").set.call(box, draft);
        box.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      });
      let resolve, reject;
      clipboard = { readText: () => new Promise((yes, no) => { resolve = yes; reject = no; }) };
      tap(pasteKey(view));
      // app-watch's successful same-device/scopes check adds the old peerKey
      // on its first handoff. This starts without a workspaceKey, as App does.
      const workspaceKey = JSON.stringify([peer.id, peer.url, peer.token, peer.transport, peer.sessionId]);
      let currentPeer = { ...peer, workspaceKey, url: "https://reach.test:8443", token: "approved-browser-credential" };
      await change({ peer: currentPeer });
      assert.equal(view.container.querySelector(".terminal-paste textarea"), box, "the authorized fallback keeps the mounted draft");
      assert.equal(box.value, draft);
      if (destination === "native") {
        currentPeer = { ...peer, workspaceKey };
        await change({ peer: currentPeer });
        assert.equal(view.container.querySelector(".terminal-paste textarea"), box, "returning to native preserves the same unsent draft");
        assert.equal(box.value, draft);
      }
      if (result === "fulfilled") resolve("old clipboard read must never become a command\n");
      else reject(new DOMException("Denied", "NotAllowedError"));
      await settle();
      assert.equal(view.container.querySelector(".terminal-paste textarea"), box);
      assert.equal(box.value, draft);
      assert.equal(Socket.all.map((s) => s.input).join(""), "", "a handoff or old result never dispatches the manual draft");
      assert.deepEqual(desktopSends, []);
      assert.deepEqual(asked, []);
      assert.deepEqual(toasts, []);

      // Submission is a new explicit action. It uses only the current,
      // separately approved peer, never the old grant captured before handoff.
      tap(view.container.querySelector('.terminal-paste button[type="submit"]'));
      await dom.waitFor(() => mode === "reach" ? Socket.all.at(-1).input : desktopSends.length);
      assert.equal(view.container.querySelector(".terminal-paste"), null);
      if (mode === "reach") {
        const latest = Socket.all.at(-1);
        assert.equal(latest.input, draft);
        assert.equal(latest.sent.find((m) => m.type === "auth").token, currentPeer.token);
        assert.equal(new URL(latest.url).origin, currentPeer.url.replace("https:", "wss:"));
        assert.equal(Socket.all.slice(0, -1).map((s) => s.input).join(""), "");
      } else {
        assert.deepEqual(desktopSends, [{ id: "t1", origin: currentPeer.url, token: `Bearer ${currentPeer.token}`, text: "unsent manual draft" }]);
        assert.equal(asked.length, 1, "only the current explicit submit asks to run the line");
      }
      await settle();
      assert.equal(Socket.all.map((s) => s.input).join(""), mode === "reach" ? draft : "");
      assert.equal(desktopSends.length, mode === "desktop" ? 1 : 0, "no delayed result replays the submitted draft");
    });
  }
}

test("a pending clipboard paste cannot follow a switch to another Reach terminal", async (t) => {
  let finish;
  clipboard = { readText: () => new Promise((resolve) => { finish = resolve; }) };
  const { view, socket: original, change } = await reachTerminal();
  t.after(() => view.unmount());
  tap(pasteKey(view));
  const next = await change({ selected: "s2" });
  finish("only for the original terminal");
  await settle();
  assert.equal(original.input, "", "the pending paste never reached the old terminal");
  assert.equal(next.input, "", "the pending paste must not be redirected to the new terminal");
  assert.deepEqual(toasts, []);
});

test("Paste sends the phone's clipboard to the shell, as the terminal pastes it", async () => {
  clipboard = { readText: async () => "echo pasted" };
  const { view, socket } = await reachTerminal();
  tap(pasteKey(view));
  await dom.waitFor(() => socket.input);
  assert.equal(socket.input, "echo pasted");
  assert.deepEqual(asked, [], "one line runs nothing: nothing to ask");
  await view.unmount();
});

test("a pasted letter is never taken for ctrl and a key", async () => {
  clipboard = { readText: async () => "d" };
  const { view, socket } = await reachTerminal();
  const ctrl = [...view.container.querySelectorAll(".terminal-key-row button")].find(
    (b) => b.textContent === "ctrl",
  );
  tap(ctrl);
  assert.equal(ctrl.getAttribute("aria-pressed"), "true");
  tap(pasteKey(view));
  await dom.waitFor(() => socket.input);
  assert.equal(socket.input, "d", "not ctrl-D, which ends a shell");
  assert.equal(ctrl.getAttribute("aria-pressed"), "false");
  await view.unmount();
});

test("a program that takes pastes whole gets them bracketed, without asking, and without a forged end", async () => {
  clipboard = { readText: async () => "line one\nline two\x1b[201~rm -rf ~\n" };
  const { view, socket, term } = await reachTerminal();
  term.modes.bracketedPasteMode = true; // the shell sent ESC [?2004h
  tap(pasteKey(view));
  await dom.waitFor(() => socket.input);
  assert.equal(socket.input, "\x1b[200~line one\rline two[201~rm -rf ~\r\x1b[201~");
  assert.deepEqual(asked, []);
  await view.unmount();
});

test("lines that would run as they arrive ask first; declining sends nothing", async () => {
  clipboard = { readText: async () => "cd app\nnpm test\n" };
  const { view, socket } = await reachTerminal();
  answer = false;
  tap(pasteKey(view));
  await dom.waitFor(() => asked.length);
  await settle();
  assert.deepEqual(asked, ["Pasting this runs 2 commands, one per line. Paste it?"]);
  assert.equal(socket.input, "");
  answer = true;
  tap(pasteKey(view));
  await dom.waitFor(() => socket.input);
  assert.equal(socket.input, "cd app\rnpm test\r");
  await view.unmount();
});

test("a long paste arrives whole, in pieces the server takes, in order", async () => {
  const long = Array.from({ length: 6000 }, (_, i) => `word${i}`).join(" ");
  assert.ok(long.length > 32768);
  clipboard = { readText: async () => long };
  const { view, socket } = await reachTerminal();
  tap(pasteKey(view));
  await dom.waitFor(() => socket.input.length === long.length);
  const pieces = socket.sent.filter((m) => m.type === "input");
  assert.ok(pieces.length > 1);
  assert.ok(pieces.every((m) => m.data.length <= 8192));
  assert.equal(socket.input, long);
  await view.unmount();
});

test("a terminal not connected says so, and the paste isn't kept for later", async () => {
  clipboard = { readText: async () => "make deploy" };
  const { view, socket } = await reachTerminal({ connect: false });
  tap(pasteKey(view));
  await dom.waitFor(() => toasts.length);
  assert.deepEqual(toasts, ["This terminal isn't connected. Paste again once it is."]);
  socket.receive({ type: "snapshot", data: "$ ", status: "running", heartbeat: true });
  await settle(50);
  assert.equal(socket.input, "", "never sent once it connects");
  await view.unmount();
});

test("reach: a manual draft remains after a known no-send while offline, until explicit resubmit", async (t) => {
  clipboard = undefined;
  const { view, socket } = await reachTerminal({ connect: false });
  t.after(() => view.unmount());
  tap(pasteKey(view));
  const box = await dom.waitFor(() => view.container.querySelector(".terminal-paste textarea"));
  const draft = "keep until connected";
  dom.update(() => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value").set.call(box, draft);
    box.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
  tap(view.container.querySelector('.terminal-paste button[type="submit"]'));
  await settle();
  assert.equal(socket.input, "");
  assert.deepEqual(toasts, ["This terminal isn't connected. Paste again once it is."]);
  assert.equal(view.container.querySelector(".terminal-paste textarea"), box, "known no-send keeps the mounted draft");
  assert.equal(box.value, draft);
  socket.receive({ type: "snapshot", data: "$ ", status: "running", heartbeat: true });
  await settle();
  assert.equal(socket.input, "", "becoming ready never sends the retained draft");
  assert.equal(box.value, draft);
  tap(view.container.querySelector('.terminal-paste button[type="submit"]'));
  await dom.waitFor(() => socket.input);
  assert.equal(socket.input, draft);
  assert.equal(socket.sent.filter((m) => m.type === "input").length, 1);
  assert.equal(view.container.querySelector(".terminal-paste"), null);
});

for (const mode of ["reach", "desktop"]) test(`${mode}: a manual draft remains after a known no-send from declined multiline confirmation`, async (t) => {
  clipboard = undefined;
  const { view } = await (mode === "reach" ? reachTerminal() : desktopTerminal());
  t.after(() => view.unmount());
  tap(pasteKey(view));
  const box = await dom.waitFor(() => view.container.querySelector(".terminal-paste textarea"));
  const draft = "keep this command\n";
  dom.update(() => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value").set.call(box, draft);
    box.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
  answer = false;
  tap(view.container.querySelector('.terminal-paste button[type="submit"]'));
  await settle();
  assert.equal(asked.length, 1);
  assert.equal(Socket.all.map((s) => s.input).join(""), "");
  assert.deepEqual(desktopSends, []);
  assert.equal(view.container.querySelector(".terminal-paste textarea"), box, "declining keeps the mounted draft");
  assert.equal(box.value, draft);
  answer = true;
  await settle();
  assert.equal(Socket.all.map((s) => s.input).join(""), "", "approval alone never sends anything");
  assert.deepEqual(desktopSends, []);
  tap(view.container.querySelector('.terminal-paste button[type="submit"]'));
  await dom.waitFor(() => mode === "reach" ? Socket.all.at(-1).input : desktopSends.length);
  assert.equal(asked.length, 2, "a fresh explicit submit asks again");
  assert.equal(view.container.querySelector(".terminal-paste"), null);
  if (mode === "reach") {
    assert.equal(Socket.all.at(-1).input, "keep this command\r");
    assert.equal(Socket.all.at(-1).sent.filter((m) => m.type === "input").length, 1);
  } else {
    assert.deepEqual(desktopSends, [{ id: "t1", origin: peer.url, token: `Bearer ${peer.token}`, text: "keep this command" }]);
  }
  await settle();
  assert.equal(desktopSends.length, mode === "desktop" ? 1 : 0, "no automatic desktop retry follows the explicit submit");
});

test("a phone that won't hand over its clipboard gets a box for its own paste", async () => {
  for (const refusing of [
    undefined, // no clipboard access in this browser
    { readText: () => Promise.reject(new DOMException("Denied", "NotAllowedError")) },
  ]) {
    clipboard = refusing;
    const { view, socket } = await reachTerminal();
    tap(pasteKey(view));
    const box = await dom.waitFor(() => view.container.querySelector(".terminal-paste textarea"));
    assert.equal(box.getAttribute("aria-label"), "Text to paste");
    const send = [...view.container.querySelectorAll(".terminal-paste button")].find(
      (b) => b.textContent === "Paste",
    );
    assert.equal(send.disabled, true);
    // What the phone's own Paste puts in the box.
    dom.update(() => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value").set.call(box, "ls -la");
      box.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
    tap(send);
    await dom.waitFor(() => socket.input);
    assert.equal(socket.input, "ls -la");
    assert.equal(view.container.querySelector(".terminal-paste"), null, "the box closes");
    await view.unmount();
  }
});

test("an empty clipboard says so", async () => {
  clipboard = { readText: async () => "" };
  const { view, socket } = await reachTerminal();
  tap(pasteKey(view));
  await dom.waitFor(() => toasts.length);
  assert.deepEqual(toasts, ["Nothing to paste on this phone"]);
  assert.equal(socket.input, "");
  await view.unmount();
});

test("in a Mac or PC tab, a paste is typed on the line; one with line breaks asks, then runs each line", async () => {
  clipboard = { readText: async () => "git status" };
  const view = await dom.render(
    React.createElement(MacTerminalView, { peer, tab: { id: "t1", name: "zsh", provider: "terminal" }, onGone() {} }),
  );
  const term = Terminal.instances.at(-1);
  tap(pasteKey(view));
  await settle();
  term.type("\r");
  await dom.waitFor(() => lines.length);
  assert.deepEqual(lines, ["git status"]);
  assert.deepEqual(asked, []);
  clipboard = { readText: async () => "cd app\x1b\nnpm test\n" };
  answer = false;
  tap(pasteKey(view));
  await dom.waitFor(() => asked.length);
  await settle();
  assert.deepEqual(lines, ["git status"], "declined: nothing runs");
  answer = true;
  tap(pasteKey(view));
  await dom.waitFor(() => lines.length === 3);
  assert.deepEqual(lines, ["git status", "cd app", "npm test"]);
  assert.deepEqual(asked, Array(2).fill("Pasting this runs 2 commands, one per line. Paste it?"));
  await view.unmount();
});
