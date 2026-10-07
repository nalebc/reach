import test, { before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { startDom, settle } from "./dom/harness.mjs";
let dom, React, BrowserScreenControls, BrowserWorkspace;
const peer = { id: "mac", name: "Mac", url: "https://screen-preview.invalid", token: "muse", platform: "darwin" };
const response = (body) => new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
const active = new Set();
before(async () => { dom = await startDom(); React = dom.React; ({ default: BrowserScreenControls } = await dom.load("/src/BrowserScreenControls.tsx")); ({ default: BrowserWorkspace } = await dom.load("/src/BrowserWorkspace.tsx")); });
afterEach(async () => { for (const view of active) { await view.unmount(); active.delete(view); } });
after(async () => dom?.close());
const render = async (props = {}) => { const view = await dom.render(React.createElement(BrowserScreenControls, { peer, src: "data:image/png;base64,AAAA", alt: "Mac screen", enabled: true, onError: assert.fail, ...props })); active.add(view); return view; };
const button = (c, label) => [...c.querySelectorAll("button")].find((b) => b.textContent.trim() === label);
const click = async (element, coordinates = {}) => { assert.ok(element); element.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, ...coordinates })); await settle(40); };
const value = async (element, text) => {
  assert.ok(element);
  const prototype = element.tagName === "TEXTAREA" ? dom.window.HTMLTextAreaElement.prototype : element.tagName === "SELECT" ? dom.window.HTMLSelectElement.prototype : dom.window.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value").set.call(element, text);
  element.dispatchEvent(new dom.window.Event(element.tagName === "SELECT" ? "change" : "input", { bubbles: true })); await settle();
};
const screen = (c) => { const image = c.querySelector("img"); image.getBoundingClientRect = () => ({ left: 100, top: 50, width: 800, height: 400, right: 900, bottom: 450 }); return image; };
const pending = (action) => ({ id: "request-1", action, clientId: "muse", name: "Muse", reason: "Search", createdAt: Date.now(), expiresAt: Date.now() + 60000, status: "pending", completedCount: 0 });

test("direct click, typed text, and Enter create one exact ordered request with no coordinate form", async () => {
  const calls = [];
  const frozen = [];
  globalThis.fetch = dom.window.fetch = async (url, init = {}) => {
    calls.push([new URL(url).pathname, init.method || "GET", init.body && JSON.parse(init.body)]);
    return response(pending(JSON.parse(init.body)));
  };
  const view = await render({ onDraftChange: (active) => frozen.push(active) }); const c = view.container;
  assert.equal(c.querySelector('input[type="number"]'), null);
  await click(screen(c), { clientX: 300, clientY: 350 });
  await value(c.querySelector('[aria-label="Text to type"]'), "hello\nworld");
  assert.match(c.querySelector('[aria-label="Screen action sequence"]').textContent, /Type "hello\\nworld"/);
  await click(button(c, "Enter"));
  await value(c.querySelector('[aria-label="Reason for screen request"]'), "Search these notes");
  assert.equal(calls.length, 0, "staging never sends screen input");
  await click(button(c, "Ask approval · 3"));
  assert.deepEqual(calls, [["/api/browser/requests", "POST", { type: "batch", actions: [
    { type: "click", x: 0.25, y: 0.75, button: "left", count: 1 },
    { type: "text", text: "hello\nworld" }, { type: "key", key: "enter" },
  ], reason: "Search these notes" }]]);
  assert.match(c.textContent, /Waiting for owner approval/);
  assert.deepEqual(frozen, [false, true]);
  assert.equal(c.querySelectorAll(".browser-direct-marker").length, 1);
  assert.equal(c.querySelector(".browser-direct-marker").style.left, "25%");
  assert.equal(c.textContent.includes("0.25"), false);
  await click(screen(c), { clientX: 500, clientY: 150 });
  assert.equal(calls.length, 1, "pending sequences cannot send more requests or inputs");
});

test("unadded typing is flushed on send and text can be removed without losing click actions", async () => {
  const writes = [];
  globalThis.fetch = dom.window.fetch = async (_url, init = {}) => { const body = JSON.parse(init.body); writes.push(body); return response(pending(body)); };
  const view = await render(); const c = view.container;
  await click(screen(c), { clientX: 300, clientY: 250 });
  await value(c.querySelector('[aria-label="Text to type"]'), "remove this");
  await click(c.querySelector('[aria-label="Remove action 2"]'));
  assert.equal(c.querySelector('[aria-label="Text to type"]').value, "");
  assert.equal(c.querySelectorAll('[aria-label="Screen action sequence"] li').length, 1);
  await value(c.querySelector('[aria-label="Text to type"]'), "keep this");
  await value(c.querySelector('[aria-label="Reason for screen request"]'), "Fill the field");
  await click(button(c, "Ask approval · 2"));
  assert.equal(writes.length, 1);
  assert.equal(writes[0].actions[1].text, "keep this");
});

test("five-action cap, explicit double/right click modes, and removals preserve exact intent", async () => {
  const writes = [];
  globalThis.fetch = dom.window.fetch = async (_url, init = {}) => { const body = JSON.parse(init.body); writes.push(body); return response(pending(body)); };
  const view = await render(); const c = view.container;
  const image = screen(c);
  await value(c.querySelector('[aria-label="Click type"]'), "double");
  await click(image, { clientX: 200, clientY: 150 });
  await value(c.querySelector('[aria-label="Click type"]'), "right");
  await click(image, { clientX: 400, clientY: 250 });
  await click(button(c, "Tab")); await click(button(c, "Escape")); await click(button(c, "Backspace"));
  await click(image, { clientX: 700, clientY: 300 });
  assert.equal(c.querySelectorAll('[aria-label="Screen action sequence"] li').length, 5);
  assert.match(c.querySelector('[role="alert"]').textContent, /up to 5 actions/);
  await click(c.querySelector('[aria-label="Remove action 4"]'));
  await click(c.querySelector('[aria-label="Add scroll down"]'));
  await value(c.querySelector('[aria-label="Reason for screen request"]'), "Inspect the menu");
  await click(button(c, "Ask approval · 5"));
  assert.equal(writes[0].actions[0].count, 2);
  assert.equal(writes[0].actions[1].button, "right");
  assert.deepEqual(writes[0].actions.map((a) => a.type), ["click", "click", "key", "key", "scroll"]);
});

test("view-only screen never stages, posts, or exposes interaction controls", async () => {
  const calls = [];
  globalThis.fetch = dom.window.fetch = async (...args) => { calls.push(args); return response([]); };
  const view = await render({ enabled: false }); const c = view.container;
  await click(screen(c), { clientX: 300, clientY: 250 });
  const frame = c.querySelector(".browser-direct-image");
  frame.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await settle();
  assert.equal(c.querySelectorAll("button,select,input,textarea").length, 0);
  assert.equal(c.querySelectorAll(".browser-direct-marker").length, 0);
  assert.equal(frame.getAttribute("tabindex"), null);
  assert.deepEqual(calls, []);
});

test("draft freezes its screenshot and clears on identity or scope change", async () => {
  let update;
  function Harness() {
    const [props, set] = React.useState({ peer, src: "frame-one", enabled: true }); update = set;
    return React.createElement(BrowserScreenControls, { ...props, alt: "Mac screen", onError: assert.fail });
  }
  const view = await dom.render(React.createElement(Harness)); active.add(view); const c = view.container;
  await click(screen(c), { clientX: 300, clientY: 250 });
  dom.update(() => update({ peer, src: "frame-two", enabled: true })); await settle();
  assert.equal(c.querySelector("img").getAttribute("src"), "frame-one");
  dom.update(() => update({ peer: { ...peer, token: "new-session" }, src: "frame-three", enabled: true })); await settle();
  assert.equal(c.querySelector('[aria-label="Screen action sequence"]'), null);
  assert.equal(c.querySelector("img").getAttribute("src"), "frame-three");
  await click(screen(c), { clientX: 300, clientY: 250 });
  dom.update(() => update({ peer: { ...peer, token: "new-session" }, src: "frame-four", enabled: false })); await settle();
  assert.equal(c.querySelectorAll("button,select,input,textarea").length, 0);
  assert.equal(c.querySelector("img").getAttribute("src"), "frame-four");
});

test("completion refreshes once and never replays a request; cancellation stops only the remaining actions", async () => {
  let submitted; const calls = []; let executed = 0;
  globalThis.fetch = dom.window.fetch = async (url, init = {}) => {
    const method = init.method || "GET"; calls.push(method);
    if (method === "POST") { submitted = pending(JSON.parse(init.body)); return response(submitted); }
    if (method === "DELETE") return response({ ...submitted, status: "cancelled", completedCount: 1 });
    return response([{ ...submitted, status: "executing", completedCount: 1 }]);
  };
  const view = await render({ onExecuted: () => executed++ }); const c = view.container;
  await click(screen(c), { clientX: 300, clientY: 250 }); await click(button(c, "Enter"));
  await value(c.querySelector('[aria-label="Reason for screen request"]'), "Open notes");
  await click(button(c, "Ask approval · 2"));
  await dom.waitFor(() => button(c, "Stop remaining actions"), 4000);
  await click(button(c, "Stop remaining actions"));
  assert.match(c.textContent, /cancelled · 1\/2 completed/);
  assert.match(c.textContent, /Completed actions are not undone/);
  assert.equal(executed, 1);
  await settle(1700);
  assert.equal(calls.filter((m) => m === "POST").length, 1);
  assert.equal(calls.filter((m) => m === "DELETE").length, 1);
  assert.equal(executed, 1);
  assert.deepEqual(dom.errors, []);
});

test("a response from the previous session cannot restore its draft or replay actions", async () => {
  let update, finishPost; let posts = 0;
  globalThis.fetch = dom.window.fetch = async (_url, init = {}) => {
    if (init.method !== "POST") return response([]);
    posts++;
    const body = JSON.parse(init.body);
    return new Promise((resolve) => { finishPost = () => resolve(response(pending(body))); });
  };
  function Harness() {
    const [current, set] = React.useState(peer); update = set;
    return React.createElement(BrowserScreenControls, { peer: current, src: "screen-image", alt: "Mac screen", enabled: true, onError: assert.fail });
  }
  const view = await dom.render(React.createElement(Harness)); active.add(view); const c = view.container;
  await click(screen(c), { clientX: 300, clientY: 250 });
  await value(c.querySelector('[aria-label="Reason for screen request"]'), "Open notes");
  await click(button(c, "Ask approval · 1"));
  assert.equal(posts, 1);
  dom.update(() => update({ ...peer, token: "replacement-session" })); await settle();
  finishPost(); await settle(80);
  assert.equal(c.querySelector('[aria-label="Screen action sequence"]'), null);
  assert.doesNotMatch(c.textContent, /Waiting for owner approval/);
  assert.equal(posts, 1);
});

test("screen drafts reset for device, transport, and bound session changes even with the same URL and token", async () => {
  let update;
  function Harness() {
    const [current, set] = React.useState(peer); update = set;
    return React.createElement(BrowserScreenControls, { peer: current, src: "current-screen", alt: "Mac screen", enabled: true, onError: assert.fail });
  }
  const view = await dom.render(React.createElement(Harness)); active.add(view); const c = view.container;
  let current = peer;
  for (const patch of [{ id: "other-computer" }, { transport: "funnel" }, { sessionId: "new-bound-session" }]) {
    await click(screen(c), { clientX: 300, clientY: 250 });
    assert.ok(c.querySelector('[aria-label="Screen action sequence"]'));
    current = { ...current, ...patch };
    dom.update(() => update(current));
    assert.equal(c.querySelector('[aria-label="Screen action sequence"]'), null, "identity isolation happens in the new render, before effects");
    assert.equal(c.querySelector('[aria-label="Reason for screen request"]'), null);
  }
});

test("workspace peer switch cannot carry the previous screenshot or ask scope into a new grant", async () => {
  let update, releaseNewAccess; let accessRequests = 0;
  const writes = [];
  const ask = { name: "Muse", screen: "ask", roots: [], terminals: [], expiresAt: Date.now() + 60000 };
  globalThis.fetch = dom.window.fetch = async (url, init = {}) => {
    const route = new URL(url).pathname;
    if (init.method === "POST") writes.push(route);
    if (route === "/api/browser") {
      accessRequests++;
      if (accessRequests === 1) return response(ask);
      return new Promise((resolve) => { releaseNewAccess = () => resolve(response({ ...ask, screen: "view" })); });
    }
    if (route === "/api/browser/screen") return new Response(new Uint8Array([255, 216, 255, 217]), { headers: { "Content-Type": "image/jpeg" } });
    if (route === "/api/browser/requests") return response([]);
    return response({});
  };
  function Harness() {
    const [current, set] = React.useState(peer); update = set;
    return React.createElement(BrowserWorkspace, { peer: current, onEnd: assert.fail });
  }
  const view = await dom.render(React.createElement(Harness)); active.add(view); const c = view.container;
  await dom.waitFor(() => c.querySelector(".browser-screen-image"));
  const oldSrc = c.querySelector(".browser-screen-image").getAttribute("src");
  await click(screen(c), { clientX: 300, clientY: 250 });
  assert.ok(c.querySelector('[aria-label="Screen action sequence"]'));
  dom.update(() => update({ ...peer, id: "another-device", sessionId: "replacement-session" }));
  assert.match(c.textContent, /Opening your shared workspace/);
  assert.equal(c.querySelector(".browser-screen-image"), null);
  assert.equal(c.querySelector('[aria-label="Screen controls"]'), null);
  assert.equal(c.querySelector('[aria-label="Screen action sequence"]'), null);
  await dom.waitFor(() => releaseNewAccess);
  releaseNewAccess();
  await dom.waitFor(() => c.querySelector(".browser-screen-image"));
  assert.notEqual(c.querySelector(".browser-screen-image").getAttribute("src"), oldSrc);
  assert.equal(c.querySelector('[aria-label="Screen controls"]'), null, "replacement view-only access cannot inherit ask controls");
  assert.ok(c.querySelector('[aria-label="Shared screen, view only"]'));
  await click(screen(c), { clientX: 300, clientY: 250 });
  assert.deepEqual(writes, []);
});

test("late failure from an unmounted screen request cannot end the replacement session", async () => {
  let update, rejectPost; let failed = 0;
  globalThis.fetch = dom.window.fetch = async (_url, init = {}) => {
    if (init.method === "POST") return new Promise((_resolve, reject) => { rejectPost = reject; });
    return response([]);
  };
  function Harness() {
    const [current, set] = React.useState(peer); update = set;
    return React.createElement(BrowserScreenControls, { peer: current, src: "screen-image", alt: "Mac screen", enabled: true, onError: () => failed++ });
  }
  const view = await dom.render(React.createElement(Harness)); active.add(view); const c = view.container;
  await click(screen(c), { clientX: 300, clientY: 250 });
  await value(c.querySelector('[aria-label="Reason for screen request"]'), "Open notes");
  await click(button(c, "Ask approval · 1"));
  dom.update(() => update({ ...peer, sessionId: "new-session" }));
  rejectPost(Object.assign(new Error("Old session expired"), { status: 401 }));
  await settle(80);
  assert.equal(failed, 0);
  assert.equal(c.querySelector('[role="alert"]'), null);
  assert.equal(c.querySelector('[aria-label="Screen action sequence"]'), null);
  assert.deepEqual(dom.errors, []);
});
