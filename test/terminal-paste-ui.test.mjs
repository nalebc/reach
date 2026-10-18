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
let clipboard, toasts, asked, answer, lines;
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
      "/api/terminals/desktop/t1/send": (init) => {
        lines.push(JSON.parse(init.body).text);
        return { ok: true };
      },
      "/api/terminals/desktop/t1": () => new Promise(() => {}),
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
  Socket.all = [];
  clipboard = { readText: async () => "" };
  globalThis.confirm = (question) => (asked.push(question), answer);
});

const tap = (element) => dom.update(() => element.click());
const pasteKey = (view) => view.container.querySelector('[aria-label="Paste"]');

// A terminal Reach started on the computer, connected.
async function reachTerminal({ connect = true } = {}) {
  const view = await dom.render(
    React.createElement(TerminalView, {
      desktopTerminals: false,
      peer,
      sessions: [{ id: "s1", name: "zsh", cwd: "/Users/me", status: "running" }],
      selected: "s1",
      onSelect() {},
      onNew() {},
      onRefresh() {},
      toast: (message) => toasts.push(message),
      source: "reach",
      setSource() {},
      onExit() {},
    }),
  );
  const socket = await dom.waitFor(() => Socket.all.at(-1));
  await dom.waitFor(() => socket.sent.some((m) => m.type === "auth"));
  if (connect) {
    socket.receive({ type: "snapshot", data: "$ ", status: "running", heartbeat: true });
    await settle();
  }
  return { view, socket, term: Terminal.instances.at(-1) };
}

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
