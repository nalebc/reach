import test, { before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { startDom, settle } from "./dom/harness.mjs";

// The preset workspace has explicit navigation. Control tests open Screen;
// resource changes and command sequences keep the original authorization paths.
let dom, React, BrowserWorkspace;
const peer = {
  id: "mac",
  name: "My Mac",
  url: "https://mac.tail.ts.net:8443",
  token: "agent",
  platform: "darwin",
};
const reply = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
const jpeg = () =>
  new Response(new Uint8Array([255, 216, 255, 217]), {
    headers: {
      "Content-Type": "image/jpeg",
      "X-Reach-Screen": JSON.stringify({ width: 100, height: 60, hidden: 1 }),
    },
  });
const views = new Set();
before(async () => {
  dom = await startDom();
  React = dom.React;
  dom.window.URL.createObjectURL ||= () => "blob:screen";
  dom.window.URL.revokeObjectURL ||= () => {};
  dom.window.HTMLDialogElement.prototype.showModal ??= function () { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close ??= function () { this.open = false; };
  ({ default: BrowserWorkspace } = await dom.load("/src/BrowserWorkspace.tsx"));
});
afterEach(async () => {
  for (const view of views) await view.unmount();
  views.clear();
});
after(async () => dom?.close());
const click = async (element) => {
  assert.ok(element);
  element.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  await settle(40);
};
const button = (c, label) =>
  [...c.querySelectorAll("button")].find(
    (b) =>
      b.textContent.trim() === label || b.getAttribute("aria-label") === label,
  );
const type = async (element, text) => {
  Object.getOwnPropertyDescriptor(
    dom.window.HTMLInputElement.prototype,
    "value",
  ).set.call(element, text);
  element.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  await settle(20);
};
const full = {
  name: "My Mac",
  expiresAt: Date.now() + 20 * 60000,
  preset: "full",
  presetName: "Full control",
  screen: true,
  control: true,
  open: true,
  shell: true,
  write: true,
  roots: [{ index: 0, name: "Home", path: "/Users/me" }],
  terminals: [],
  apps: [],
  hidden: [],
};
function mock(
  access,
  { busy = false, input, catalog, front = "Google Chrome" } = {},
) {
  const calls = [];
  globalThis.fetch = dom.window.fetch = async (url, init = {}) => {
    const parsed = new URL(url),
      route = parsed.pathname;
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push([
      init.method || "GET",
      route,
      body,
      { at: Date.now(), width: parsed.searchParams.get("maxWidth") },
    ]);
    if (route === "/api/browser") return reply(access);
    if (route === "/api/browser/shortcuts")
      return reply({ shortcuts: [], recording: null });
    if (route === "/api/browser/desktop/screen") return jpeg();
    if (route === "/api/browser/desktop/elements")
      return reply({
        snapshot: "snap1",
        app: "Google Chrome",
        truncated: false,
        items: [
          { n: 1, role: "Link", name: "Uber Eats", x: 0.1, y: 0.1, w: 0.05, h: 0.02 },
          { n: 2, role: "Button", name: "Add to cart", x: 0.6, y: 0.4, w: 0.08, h: 0.03 },
        ],
      });
    if (route === "/api/browser/desktop/front")
      return reply({
        app: front,
        title: "Amazon",
        terminalLike: false,
        secure: false,
        blocked: "",
        holder: "",
      });
    if (route === "/api/browser/desktop/input")
      return input
        ? input(body.action)
        : busy
          ? reply(
              {
                error: "Grok is using the Mac right now.",
                kind: "busy",
                holder: "Grok",
                retryInMs: 1800,
              },
              409,
            )
          : reply({ ok: true, app: "Google Chrome" });
    if (route === "/api/browser/desktop/apps")
      return reply({
        apps: catalog || [
          {
            id: "/Applications/Google Chrome.app",
            name: "Google Chrome",
            bundleId: "com.google.Chrome",
            running: true,
          },
          {
            id: "/System/Applications/Notes.app",
            name: "Notes",
            bundleId: "com.apple.Notes",
            running: false,
          },
        ],
      });
    if (route === "/api/browser/desktop/open")
      return reply({ ok: true, app: "Notes" });
    if (route === "/api/browser/shell")
      return body.command.startsWith("sudo")
        ? reply({
            id: "r2",
            status: "blocked",
            action: { type: "shell", command: body.command },
            error: "That needs your password. The agent never gets it.",
            createdAt: Date.now(),
          })
        : reply({
            id: "r1",
            status: "executed",
            action: { type: "shell", command: body.command },
            output: "a.txt\nb.txt\n",
            exitCode: 0,
            createdAt: Date.now(),
          });
    if (route === "/api/browser/shell/history") return reply([]);
    if (route === "/api/browser/files/change") return reply({ ok: true });
    if (route === "/api/files")
      return reply({
        items: [{ name: "notes.md", path: "notes.md", type: "file" }],
      });
    if (route === "/api/files/text") return reply({ text: "# Notes" });
    return reply({ error: `Unexpected ${route}` }, 404);
  };
  return calls;
}
const inputs = (calls) =>
  calls
    .filter(
      ([method, route]) =>
        method === "POST" && route === "/api/browser/desktop/input",
    )
    .map(([, , body]) => body.action);
const shots = (calls) =>
  calls
    .filter(([, route]) => route === "/api/browser/desktop/screen")
    .map(([, , , info]) => info);
// The live screen: the picture is the Mac, a hidden field its keyboard.
const LABEL = "Mac screen. Click, drag, scroll and type here as on the Mac.";
const screen = async (c, label = LABEL) => {
  const frame = await dom.waitFor(() =>
    c.querySelector(`[aria-label="${label}"]`),
  );
  await dom.waitFor(() => frame.querySelector("img"));
  frame.getBoundingClientRect = () => ({
    left: 0,
    top: 0,
    width: 200,
    height: 100,
    right: 200,
    bottom: 100,
  });
  return frame;
};
const at = (frame, type, x, y, init = {}) =>
  frame.dispatchEvent(
    new dom.window.MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      clientX: x,
      clientY: y,
      ...init,
    }),
  );
const keyboard = (c) => c.querySelector('[aria-label="Keyboard for the Mac"]');
const typeKeys = async (c, text) => {
  const field = keyboard(c);
  field.value = text;
  field.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  await settle(200);
};
const press = async (c, init) => {
  keyboard(c).dispatchEvent(
    new dom.window.KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      ...init,
    }),
  );
  await settle(40);
};
const open = async (
  access,
  options,
  initial = access.screen ? "Screen" : "Files",
) => {
  const calls = mock(access, options);
  const view = await dom.render(
    React.createElement(BrowserWorkspace, { peer, onEnd() {} }),
  );
  views.add(view);
  const c = view.container;
  await dom.waitFor(() => c.querySelector(".agent-page"));
  if (initial)
    await click(
      c.querySelector(
        `[aria-label="Workspace navigation"] [aria-label="${initial}"]`,
      ),
    );
  return { c, calls };
};

test("the workspace opens on the live screen, and other sections stay one tap away", async () => {
  const { c, calls } = await open(full, undefined, null);
  const nav = c.querySelector('[aria-label="Workspace navigation"]');
  assert.deepEqual(
    [...nav.querySelectorAll("button")].map((button) =>
      button.getAttribute("aria-label"),
    ),
    ["Screen", "Commands", "Apps", "Files", "Access", "Reload page"],
  );
  assert.equal(
    nav.querySelector('[aria-label="Screen"]').getAttribute("aria-current"),
    "page",
  );
  assert.equal(c.querySelector("#agent-section-screen").hidden, false);
  await screen(c);
  await dom.waitFor(() => /Live/.test(c.querySelector(".ap-live")?.textContent || ""));
  await dom.waitFor(() => /1 protected window left out/.test(c.querySelector(".ap-live")?.title || ""));
  assert.equal(c.querySelector(".ap-hint"), null, "the full screen carries no hint text");
  assert.equal(c.querySelector(".ap-brief"), null, "the screen alone, How to use under More");
  assert.deepEqual(
    [...c.querySelectorAll('[aria-label="Screen controls"] button')].map((item) => item.getAttribute("aria-label")),
    ["Labels", "Type text", "Shortcuts", "Full screen", "Screen options"],
    "the owner's bar: icons only",
  );
  await click(button(c, "Screen options"));
  const brief = c.querySelector(".ap-brief");
  assert.ok(brief?.open);
  assert.match(brief.textContent, /You have full control of My Mac\. Your user's request is your permission/);
  assert.match(brief.textContent, /Ask your user before you pay, send a message or delete something/);
  await click(c.querySelector('dialog[aria-label="Screen options"] [aria-label="Close panel"]'));
  await dom.waitFor(() => /Typing goes to Google Chrome/.test(c.textContent));
  assert.equal(nav.querySelector('[aria-label="Tools"]'), null, "agents work on the screen or in the terminal");
  assert.equal(c.querySelector('[aria-label="Search tools"]'), null);
  await click(nav.querySelector('[aria-label="Access"]'));
  assert.equal(c.querySelector("#agent-section-screen").hidden, true);
  const seen = shots(calls).length;
  await settle(700);
  assert.equal(shots(calls).length, seen, "the screen rests while hidden");
  await click(nav.querySelector('[aria-label="Access"]'));
  assert.match(
    c.querySelector("#agent-section-access").textContent,
    /You may see and use the whole screen, open apps, read and change files, run commands as the owner/,
  );
  assert.match(
    c.querySelector(".ap-foot").textContent,
    /Commands run as the owner and are not confined to shared folders/,
  );
  assert.ok(button(c, "Reload page"));
  assert.match(button(c, "Reload page").title, /Reloads this web page/);
});

test("the picture is the Mac: clicks, right-clicks and double-clicks land where they are made", async () => {
  const { c, calls } = await open(full);
  const frame = await screen(c);
  at(frame, "click", 50, 25);
  await dom.waitFor(() => inputs(calls).length === 1);
  assert.deepEqual(inputs(calls)[0], {
    type: "click",
    x: 0.25,
    y: 0.25,
    button: "left",
    count: 1,
  });
  await dom.waitFor(() =>
    /Done: clicked at 25%, 25% in Google Chrome\./.test(c.textContent),
  );
  assert.ok(c.querySelector(".ap-status.is-done"));
  assert.ok(c.querySelector(".ap-mark-ring"), "the last click is marked");
  at(frame, "contextmenu", 160, 10);
  await dom.waitFor(() => inputs(calls).length === 2);
  assert.deepEqual(inputs(calls)[1], {
    type: "click",
    x: 0.8,
    y: 0.1,
    button: "right",
    count: 1,
  });
  at(frame, "click", 100, 50, { detail: 1 });
  at(frame, "click", 100, 50, { detail: 2 });
  await dom.waitFor(() => inputs(calls).length === 4);
  assert.deepEqual(
    inputs(calls).slice(2),
    [
      { type: "click", x: 0.5, y: 0.5, button: "left", count: 1 },
      { type: "click", x: 0.5, y: 0.5, button: "left", count: 2 },
    ],
    "the second click of a double-click waits its turn, never dropped",
  );
  // Panels for what a browser can't pass through.
  await click(button(c, "Type text"));
  await type(c.querySelector('[aria-label="Text to type"]'), "hello");
  await click(button(c, "Type + Enter"));
  await dom.waitFor(() => inputs(calls).length === 6);
  assert.deepEqual(inputs(calls).slice(4), [
    { type: "type", text: "hello" },
    { type: "key", key: "enter" },
  ]);
  await dom.waitFor(
    () => c.querySelector('[aria-label="Text to type"]').value === "",
  );
  await click(button(c, "Shortcuts"));
  assert.equal(c.querySelector('[aria-label="Text to type"]'), null);
  assert.ok(c.querySelector('dialog[aria-label="Shortcuts"]'), "the owner's Shortcuts panel");
  await click(button(c, "Esc"));
  await dom.waitFor(() => inputs(calls).length === 7);
  assert.deepEqual(inputs(calls)[6], { type: "key", key: "escape" });
  await type(c.querySelector('[aria-label="Shortcut"]'), "cmd+l");
  await click(button(c, "Press"));
  await dom.waitFor(() => inputs(calls).length === 8);
  assert.deepEqual(inputs(calls).at(-1), {
    type: "key",
    key: "l",
    modifiers: ["cmd"],
  });
  await click(
    c.querySelector('[aria-label="Workspace navigation"] [aria-label="Apps"]'),
  );
  await dom.waitFor(
    () =>
      [...c.querySelectorAll('[aria-label="Apps you may use"] [role="radio"]')]
        .length === 2,
  );
  await click(
    [
      ...c.querySelectorAll('[aria-label="Apps you may use"] [role="radio"]'),
    ].find((item) => item.dataset.value === "/System/Applications/Notes.app"),
  );
  await dom.waitFor(() =>
    calls.some(
      ([method, route]) =>
        method === "POST" && route === "/api/browser/desktop/open",
    ),
  );
  assert.deepEqual(
    calls.find(
      ([method, route]) =>
        method === "POST" && route === "/api/browser/desktop/open",
    )[2],
    { app: "/System/Applications/Notes.app" },
  );
  await dom.waitFor(() =>
    /Open request completed for Notes\. Check the screen to verify it is in front\./.test(
      c.textContent,
    ),
  );
});

test("aiming: pictures match the page, zooming asks for full detail and maps clicks exactly", async () => {
  const { c, calls } = await open(full);
  const frame = await screen(c);
  assert.equal(
    shots(calls)[0].width,
    "1280",
    "the picture is sized to the page, no larger than needed",
  );
  await click(button(c, "Screen options"));
  const zoomIn = button(c, "Zoom in");
  await click(zoomIn);
  assert.equal(c.querySelector('dialog[aria-label="Screen options"]'), null, "choosing closes the panel");
  assert.equal(button(c, "Zoom out").getAttribute("aria-pressed"), "true");
  assert.match(c.textContent, /Click the picture where you want to look closer/);
  assert.equal(
    c.querySelector('[aria-label="Mac screen. Click where to zoom in."]'),
    frame,
  );
  at(frame, "click", 100, 50);
  await settle(40);
  assert.equal(
    inputs(calls).length,
    0,
    "choosing where to zoom never clicks the Mac",
  );
  assert.ok(
    c.querySelector(
      '[aria-label="Zoomed Mac screen. Click, drag, scroll and type here as on the Mac."]',
    ),
  );
  await dom.waitFor(
    () => shots(calls).some((shot) => shot.width === "2560"),
    "the zoomed view asks for the full picture",
  );
  frame.getBoundingClientRect = () => ({
    left: 0,
    top: 0,
    width: 400,
    height: 200,
    right: 400,
    bottom: 200,
  });
  at(frame, "click", 100, 50);
  await dom.waitFor(() => inputs(calls).length === 1);
  assert.equal(inputs(calls)[0].x.toFixed(4), "0.4375");
  assert.equal(inputs(calls)[0].y.toFixed(4), "0.4375");
  assert.ok(c.querySelector(".ap-mark-ring"), "the last click is marked");
  await click(button(c, "Move zoom right"));
  at(frame, "click", 100, 50);
  await dom.waitFor(() => inputs(calls).length === 2);
  assert.equal(inputs(calls)[1].x.toFixed(4), "0.5375");
  await click(button(c, "Zoom out"));
  assert.ok(c.querySelector(`[aria-label="${LABEL}"]`));
  assert.equal(button(c, "Move zoom right"), undefined);
});

test("another agent holding the Mac reads as waiting, not failure", async () => {
  const { c } = await open(full, { busy: true });
  const frame = await screen(c);
  at(frame, "click", 50, 25);
  await dom.waitFor(() =>
    /Not done: Grok is using the Mac\. Try again in 2 s\./.test(c.textContent),
  );
  assert.ok(c.querySelector(".ap-status.is-wait"));
});

test("pictures follow each other without waiting, within the Mac's limit", async () => {
  const { c, calls } = await open(full);
  await screen(c);
  await dom.waitFor(() => shots(calls).length >= 4, 4000);
  const times = shots(calls).map((shot) => shot.at);
  const gaps = times.slice(1).map((time, i) => time - times[i]);
  assert.ok(
    gaps.every((gap) => gap >= 100),
    `no more than ten pictures a second: ${gaps}`,
  );
  assert.ok(times.at(-1) - times[0] < 1500, `pictures keep coming: ${gaps}`);
});

test("typing on the picture reaches the Mac as whole text, keys after it, in order", async () => {
  const { c, calls } = await open(full);
  const frame = await screen(c);
  at(frame, "click", 50, 25);
  await dom.waitFor(() => inputs(calls).length === 1);
  const field = keyboard(c);
  for (const part of ["uber", "eats", ".com"]) {
    field.value = part;
    field.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  }
  await press(c, { key: "Enter" });
  await dom.waitFor(() => inputs(calls).length === 3);
  assert.deepEqual(inputs(calls).slice(1), [
    { type: "type", text: "ubereats.com" },
    { type: "key", key: "enter" },
  ]);
  assert.equal(field.value, "", "nothing piles up in the page's own field");
  await press(c, { key: "l", code: "KeyL", metaKey: true });
  await press(c, { key: "a", code: "KeyA", ctrlKey: true });
  await press(c, { key: "Tab", code: "Tab", ctrlKey: true });
  await press(c, { key: "Tab", code: "Tab", shiftKey: true });
  await dom.waitFor(() => inputs(calls).length === 7);
  assert.deepEqual(inputs(calls).slice(3), [
    { type: "key", key: "l", modifiers: ["cmd"] },
    // Not a Mac browser: Ctrl+A means ⌘A, but Ctrl+Tab stays a tab switch.
    { type: "key", key: "a", modifiers: ["cmd"] },
    { type: "key", key: "tab", modifiers: ["control"] },
    { type: "key", key: "tab", modifiers: ["shift"] },
  ]);
  await dom.waitFor(() => /Done: pressed shift\+Tab in Google Chrome\./.test(c.textContent));
  assert.match(c.textContent, /Typing goes to Google Chrome/);
});

test("after a click that didn't land, keys wait for one that does", async () => {
  let refuse = true;
  const { c, calls } = await open(full, {
    front: "Claude",
    input: (action) =>
      action.type === "click" && refuse
        ? reply(
            { error: "That's Reach. The agent can't use Reach.", kind: "blocked" },
            403,
          )
        : reply({ ok: true, app: "Google Chrome" }),
  });
  const frame = await screen(c);
  await dom.waitFor(() => /Typing goes to Claude/.test(c.textContent));
  at(frame, "click", 50, 25);
  await dom.waitFor(() =>
    /Not done: That's Reach\. The agent can't use Reach\./.test(c.textContent),
  );
  await typeKeys(c, "ubereats.com");
  await press(c, { key: "Enter" });
  await settle(200);
  assert.deepEqual(
    inputs(calls).map((action) => action.type),
    ["click"],
    "nothing typed reaches the app in front",
  );
  assert.match(
    c.textContent,
    /Not typed: your last click didn't land, so typing would go to Claude\. Click where you want to type first\./,
  );
  assert.ok(c.querySelector(".ap-status.is-blocked"));
  await click(button(c, "Type text"));
  await type(c.querySelector('[aria-label="Text to type"]'), "ubereats.com");
  await click(button(c, "Type + Enter"));
  assert.equal(inputs(calls).length, 1, "the Type panel waits too");
  refuse = false;
  at(frame, "click", 50, 25);
  await dom.waitFor(() => /Typing goes to Google Chrome/.test(c.textContent));
  await typeKeys(c, "ubereats.com");
  await dom.waitFor(() => inputs(calls).length === 3);
  assert.deepEqual(inputs(calls).at(-1), { type: "type", text: "ubereats.com" });
});

test("keys typed right after a new click wait for it, and go only if it lands", async () => {
  let refusals = 2;
  let finishClick;
  const { c, calls } = await open(full, {
    front: "Claude",
    input: (action) => {
      if (action.type !== "click")
        return reply({ ok: true, app: "Google Chrome" });
      if (refusals-- > 0)
        return reply(
          { error: "That's Reach. The agent can't use Reach.", kind: "blocked" },
          403,
        );
      return new Promise((resolve) => {
        finishClick = () => resolve(reply({ ok: true, app: "Google Chrome" }));
      });
    },
  });
  const frame = await screen(c);
  at(frame, "click", 50, 25);
  await dom.waitFor(() => /Not done: That's Reach/.test(c.textContent));
  // Clicked again and typed at once, as an agent does: refused again, so
  // the text is dropped with the click.
  at(frame, "click", 60, 25);
  await typeKeys(c, "ubereats.com");
  await dom.waitFor(() => inputs(calls).length === 2);
  await settle(200);
  assert.deepEqual(
    inputs(calls).map((action) => action.type),
    ["click", "click"],
    "text never follows a refused click",
  );
  // The third click lands: the text typed meanwhile waited and goes after it.
  at(frame, "click", 70, 25);
  await typeKeys(c, "ubereats.com");
  await dom.waitFor(() => inputs(calls).length === 3);
  assert.equal(inputs(calls).length, 3, "the text waits for its click");
  finishClick();
  await dom.waitFor(() => inputs(calls).length === 4);
  assert.deepEqual(inputs(calls).at(-1), { type: "type", text: "ubereats.com" });
});

test("long typing is split for the Mac without breaking a character", async () => {
  const { c, calls } = await open(full);
  const frame = await screen(c);
  at(frame, "click", 50, 25);
  await dom.waitFor(() => inputs(calls).length === 1);
  await typeKeys(c, "a".repeat(1999) + "😀bc");
  await dom.waitFor(() => inputs(calls).length === 3);
  assert.deepEqual(
    inputs(calls).slice(1).map((action) => action.text),
    ["a".repeat(1999), "😀bc"],
  );
});

test("dragging, scrolling and resting the pointer on the picture do the same on the Mac", async () => {
  const { c, calls } = await open(full);
  const frame = await screen(c);
  const pointer = (type, x, y) =>
    frame.dispatchEvent(
      new dom.window.PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        pointerId: 1,
        pointerType: "mouse",
        button: 0,
        clientX: x,
        clientY: y,
      }),
    );
  pointer("pointerdown", 20, 80);
  pointer("pointermove", 120, 40);
  pointer("pointerup", 180, 10);
  at(frame, "click", 180, 10);
  await dom.waitFor(() => inputs(calls).length === 1);
  await settle(60);
  assert.deepEqual(
    inputs(calls),
    [{ type: "drag", x: 0.1, y: 0.8, toX: 0.9, toY: 0.1 }],
    "a drag is never also a click",
  );
  await dom.waitFor(() =>
    /Done: dragged from 10%, 80% to 90%, 10%/.test(c.textContent),
  );
  const wheel = (init) => {
    const event = new dom.window.WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      clientX: 100,
      clientY: 50,
      ...init,
    });
    frame.dispatchEvent(event);
    return event;
  };
  assert.equal(wheel({ deltaY: 100 }).defaultPrevented, true, "the page itself stays still");
  wheel({ deltaY: 150 });
  await dom.waitFor(() => inputs(calls).length === 2);
  assert.deepEqual(
    inputs(calls)[1],
    { type: "scroll", x: 0.5, y: 0.5, dx: 0, dy: 250 },
    "a burst of wheel turns is one scroll",
  );
  wheel({ deltaX: -3, deltaMode: 1 });
  await dom.waitFor(() => inputs(calls).length === 3);
  assert.deepEqual(inputs(calls)[2], {
    type: "scroll",
    x: 0.5,
    y: 0.5,
    dx: -120,
    dy: 0,
  });
  pointer("pointermove", 40, 20);
  await dom.waitFor(() => inputs(calls).length === 4, 3000);
  assert.deepEqual(inputs(calls)[3], { type: "move", x: 0.2, y: 0.2 });
});

for (const kind of ["busy", "blocked", "retry"]) {
  test(`Type + Enter preserves the draft and never presses Enter when typing is ${kind}`, async () => {
    const { c, calls } = await open(full, {
      input: () =>
        reply(
          {
            error: `Typing ${kind}.`,
            kind,
            holder: "Another agent",
            retryInMs: 1000,
          },
          kind === "blocked" ? 403 : 409,
        ),
    });
    await screen(c);
    await click(button(c, "Type text"));
    const field = c.querySelector('[aria-label="Text to type"]');
    await type(field, "Zoë García — Café déjà vu");
    await click(button(c, "Type + Enter"));
    await dom.waitFor(() => /Not done:/.test(c.textContent));
    assert.deepEqual(
      inputs(calls),
      [{ type: "type", text: "Zoë García — Café déjà vu" }],
      "refused typing must never submit the remote form",
    );
    assert.equal(
      field.value,
      "Zoë García — Café déjà vu",
      "refused text stays available to retry",
    );
    assert.ok(
      c.querySelector(
        kind === "blocked" ? ".ap-status.is-blocked" : ".ap-status.is-wait",
      ),
    );
  });
}

test("Type + Enter holds one sequence; a key pressed meanwhile waits for all of it", async () => {
  let finishType, finishEnter;
  const typing = new Promise((resolve) => {
    finishType = resolve;
  });
  const entering = new Promise((resolve) => {
    finishEnter = resolve;
  });
  let firstType = true;
  const { c, calls } = await open(full, {
    input: (action) => {
      if (action.type === "type" && firstType) {
        firstType = false;
        return typing;
      }
      if (action.type === "key" && action.key === "enter") return entering;
      return reply({ ok: true, app: "Google Chrome" });
    },
  });
  await screen(c);
  await click(button(c, "Type text"));
  const field = c.querySelector('[aria-label="Text to type"]');
  const submit = () =>
    field
      .closest("form")
      .dispatchEvent(
        new dom.window.Event("submit", { bubbles: true, cancelable: true }),
      );
  await type(field, "first draft");
  await click(button(c, "Type + Enter"));
  await dom.waitFor(() => inputs(calls).length === 1);
  await type(field, "newer draft");
  submit();
  await click(button(c, "Type + Enter"));
  await press(c, { key: "Escape" });
  assert.deepEqual(inputs(calls), [{ type: "type", text: "first draft" }]);
  assert.equal(field.value, "newer draft");
  finishType(reply({ ok: true, app: "Google Chrome" }));
  await dom.waitFor(() => inputs(calls).length === 2);
  assert.deepEqual(
    inputs(calls)[1],
    { type: "key", key: "enter" },
    "nothing comes between the text and its Enter",
  );
  assert.equal(
    field.value,
    "newer draft",
    "the first acknowledgement cannot clear a newer edit",
  );
  submit();
  await click(button(c, "Type + Enter"));
  await settle(40);
  assert.equal(
    inputs(calls).length,
    2,
    "the lock includes the awaited Enter response",
  );
  finishEnter(reply({ ok: true, app: "Google Chrome" }));
  await dom.waitFor(() => inputs(calls).length === 3);
  assert.deepEqual(
    inputs(calls)[2],
    { type: "key", key: "escape" },
    "the key pressed meanwhile runs after the whole sequence",
  );
  await dom.waitFor(() => /Done: pressed Escape/.test(c.textContent));
  await click(button(c, "Type"));
  await dom.waitFor(() => inputs(calls).length === 4);
  assert.deepEqual(inputs(calls)[3], { type: "type", text: "newer draft" });
  await dom.waitFor(() => field.value === "");
});

test("acknowledged typing clears only its own draft even when Enter fails", async () => {
  const { c, calls } = await open(full, {
    input: (action) =>
      action.type === "type"
        ? reply({ ok: true, app: "Google Chrome" })
        : reply(
            { error: "Focus changed; inspect the Mac again.", kind: "retry" },
            409,
          ),
  });
  await screen(c);
  await click(button(c, "Type text"));
  const field = c.querySelector('[aria-label="Text to type"]');
  await type(field, "already typed");
  await click(button(c, "Type + Enter"));
  await dom.waitFor(() => /Not done: Focus changed/.test(c.textContent));
  assert.deepEqual(inputs(calls), [
    { type: "type", text: "already typed" },
    { type: "key", key: "enter" },
  ]);
  assert.equal(
    field.value,
    "",
    "successful typing is not offered for accidental duplicate typing after Enter fails",
  );
});

test("typing acknowledgement preserves a newer edit even if it matches the original text", async () => {
  let finishType;
  const pending = new Promise((resolve) => {
    finishType = resolve;
  });
  const { c, calls } = await open(full, { input: () => pending });
  await screen(c);
  await click(button(c, "Type text"));
  const field = c.querySelector('[aria-label="Text to type"]');
  await type(field, "same words");
  await click(button(c, "Type"));
  await dom.waitFor(() => inputs(calls).length === 1);
  await type(field, "edited words");
  await type(field, "same words");
  finishType(reply({ ok: true, app: "Google Chrome" }));
  await dom.waitFor(() => /Done: typed/.test(c.textContent));
  assert.equal(
    field.value,
    "same words",
    "an input revision, not only string equality, identifies the submitted draft",
  );
  assert.equal(inputs(calls).length, 1);
});

test("commands and file changes live on the same page with their results", async () => {
  const { c, calls } = await open(full);
  await click(
    c.querySelector(
      '[aria-label="Workspace navigation"] [aria-label="Commands"]',
    ),
  );
  await type(
    await dom.waitFor(() => c.querySelector('[aria-label="Command"]')),
    "ls",
  );
  await click(button(c, "Run"));
  await dom.waitFor(() => /a\.txt/.test(c.textContent));
  assert.deepEqual(
    calls.find(
      ([method, route]) => method === "POST" && route === "/api/browser/shell",
    )[2],
    { command: "ls", root: 0, cwd: "" },
  );
  await type(c.querySelector('[aria-label="Command"]'), "sudo ls");
  await click(button(c, "Run"));
  await dom.waitFor(() => /That needs your password/.test(c.textContent));
  await click(
    c.querySelector('[aria-label="Workspace navigation"] [aria-label="Files"]'),
  );
  await dom.waitFor(() => c.querySelector('[aria-label="New file name"]'));
  await type(c.querySelector('[aria-label="New file name"]'), "todo.md");
  await click(button(c, "New file"));
  await dom.waitFor(() =>
    calls.some(
      ([method, route]) =>
        method === "POST" && route === "/api/browser/files/change",
    ),
  );
  assert.deepEqual(
    calls.find(
      ([method, route]) =>
        method === "POST" && route === "/api/browser/files/change",
    )[2],
    { root: 0, op: "write", path: "todo.md", content: "" },
  );
  await click(
    [...c.querySelectorAll("button")].find(
      (b) => b.getAttribute("aria-label") === "Read file notes.md",
    ),
  );
  await dom.waitFor(() => button(c, "Edit notes.md"));
  await dom.waitFor(() => /Done: read notes\.md/.test(c.textContent));
  await click(button(c, "Edit notes.md"));
  const editor = await dom.waitFor(() =>
    c.querySelector('textarea[aria-label="Edit notes.md"]'),
  );
  Object.getOwnPropertyDescriptor(
    dom.window.HTMLTextAreaElement.prototype,
    "value",
  ).set.call(editor, "# Notes\nmore");
  editor.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  await click(button(c, "Save"));
  await dom.waitFor(
    () =>
      calls.filter(
        ([method, route]) =>
          method === "POST" && route === "/api/browser/files/change",
      ).length === 2,
  );
  assert.deepEqual(
    calls.filter(
      ([method, route]) =>
        method === "POST" && route === "/api/browser/files/change",
    )[1][2],
    { root: 0, op: "write", path: "notes.md", content: "# Notes\nmore" },
  );
});

test("Read only looks and never touches; Apps shows only its apps", async () => {
  const { c, calls } = await open({
    ...full,
    preset: "readonly",
    presetName: "Read only",
    control: false,
    open: false,
    shell: false,
    write: false,
  });
  assert.match(c.textContent, /You may look at the screen, read files\./);
  const frame = await screen(c, "Mac screen");
  assert.equal(c.querySelector(`[aria-label="${LABEL}"]`), null);
  assert.equal(
    c.querySelector('[aria-label="Keyboard for the Mac"]'),
    null,
    "no keyboard reaches the Mac",
  );
  assert.equal(c.querySelector('[aria-label="Text to type"]'), null);
  for (const label of ["Shortcuts", "Type text", "Esc"])
    assert.equal(
      button(c, label),
      undefined,
      `${label} must not appear for Read only`,
    );
  at(frame, "click", 50, 25);
  at(frame, "contextmenu", 50, 25);
  const wheel = new dom.window.WheelEvent("wheel", {
    bubbles: true,
    cancelable: true,
    deltaY: 300,
    clientX: 50,
    clientY: 25,
  });
  frame.dispatchEvent(wheel);
  await settle(300);
  assert.deepEqual(inputs(calls), [], "looking never touches the Mac");
  assert.equal(wheel.defaultPrevented, false, "the page scrolls as usual");
  assert.equal(c.querySelector('[aria-label="Search apps"]'), null);
  assert.equal(c.querySelector('[aria-label="Command"]'), null);
  assert.equal(c.querySelector('[aria-label="New file name"]'), null);
  assert.match(
    c.textContent,
    /Look only\. Nothing on this page clicks or types on the Mac/,
  );
  assert.equal(c.querySelector(".ap-brief"), null, "Read only gets no instructions to act");
  assert.doesNotMatch(
    c.querySelector(".ap-abilities").textContent,
    /Click the picture/,
  );
  assert.ok(!calls.some(([, route]) => route === "/api/browser/desktop/apps"));
  for (const view of views) await view.unmount();
  views.clear();
  const apps = await open({
    ...full,
    preset: "apps",
    presetName: "Apps",
    shell: false,
    write: false,
    roots: [],
    apps: [{ id: "/Applications/Google Chrome.app", name: "Google Chrome" }],
  });
  assert.match(
    apps.c.textContent,
    /You may see and use only the chosen apps, open apps\./,
  );
  assert.equal(
    apps.c.querySelector(
      '[aria-label="Workspace navigation"] [aria-label="Files"]',
    ).disabled,
    true,
  );
  assert.equal(
    apps.c.querySelector(
      '[aria-label="Workspace navigation"] [aria-label="Commands"]',
    ).disabled,
    true,
  );
  assert.match(apps.c.textContent, /Only these apps\./);
});

test("Files describes only shared files, without offering absent screen controls", async () => {
  const { c, calls } = await open({
    ...full,
    preset: "files",
    presetName: "Files",
    screen: false,
    control: false,
    open: false,
    shell: false,
    write: false,
  });
  assert.equal(
    c.querySelector(".ap-abilities").textContent,
    "You may read files. Everything else is closed.",
  );
  assert.ok(button(c, "Reload page"));
  assert.ok(
    !calls.some(([, route]) => route.startsWith("/api/browser/desktop/")),
  );
  await click(await dom.waitFor(() => button(c, "Read file notes.md")));
  await dom.waitFor(() => /Done: read notes\.md/.test(c.textContent));
  assert.match(c.querySelector(".ap-file pre").textContent, /# Notes/);
});

// Oct 12: the invite message is two lines; once in, the agent reads what it
// may do and the owner's rules on its page (its guide from /api/browser),
// a row a line, on every section, folded once it has read them.
test("the agent's instructions show on its page once it's in, and fold away", async () => {
  dom.window.sessionStorage.removeItem("reach.agent-guide-closed");
  const guide = 'You get only "Notes", on my screen. Nothing else.\nFill passwords from your vault with Sign in, and stay out of password apps, Reach and Tailscale.\nAsk me before paying, sending or deleting anything.\nDon\'t share your Reach credentials.';
  const { c } = await open({ ...full, preset: "apps", presetName: "Apps", shell: false, write: false, roots: [], guide });
  const block = await dom.waitFor(() => c.querySelector("details.ap-guide"));
  assert.equal(block.open, true, "open the first time");
  assert.equal(block.querySelector("summary").textContent.trim(), "Your instructions");
  assert.deepEqual([...block.querySelectorAll("li")].map((li) => li.textContent), guide.split("\n"));
  // On every section, not only Access.
  await click(c.querySelector('[aria-label="Workspace navigation"] [aria-label="Screen"]'));
  assert.ok(c.querySelector("details.ap-guide"));
  block.open = false;
  block.dispatchEvent(new dom.window.Event("toggle"));
  await settle(20);
  assert.equal(dom.window.sessionStorage.getItem("reach.agent-guide-closed"), "1", "kept folded in this tab");
  for (const view of views) await view.unmount();
  views.clear();
  const again = await open({ ...full, guide });
  assert.equal((await dom.waitFor(() => again.c.querySelector("details.ap-guide"))).open, false);
  dom.window.sessionStorage.removeItem("reach.agent-guide-closed");
  for (const view of views) await view.unmount();
  views.clear();
  // A computer that says none: no block.
  const older = await open({ ...full });
  assert.equal(older.c.querySelector(".ap-guide"), null);
});

test("the agent page renders without React warnings", () =>
  assert.deepEqual(dom.errors, []));

test("Run command shows an allowed shell result after the ordinary browser request deadline", async (t) => {
  const deadlines = [];
  t.mock.method(AbortSignal, "timeout", (ms) => {
    const controller = new AbortController();
    deadlines.push({ ms, controller });
    return controller.signal;
  });
  const { c } = await open(full);
  const existing = globalThis.fetch;
  globalThis.fetch = dom.window.fetch = async (url, init = {}) => {
    if (new URL(url).pathname === "/api/browser/shell") {
      const chosen = deadlines.find((d) => d.controller.signal === init.signal);
      assert.ok(
        chosen,
        "the UI supplies no custom signal; peerFetch chooses the deadline",
      );
      if (chosen.ms <= 35000) chosen.controller.abort();
      if (init.signal.aborted)
        throw Error("allowed shell result lost to the ordinary deadline");
      return reply({
        id: "late",
        status: "executed",
        action: { type: "shell", command: "printf fixture" },
        output: "LATE-SHELL-OK",
        exitCode: 0,
        createdAt: Date.now(),
      });
    }
    return existing(url, init);
  };
  const command = await dom.waitFor(() =>
    c.querySelector('[aria-label="Command"]'),
  );
  assert.ok(command);
  await type(command, "printf fixture");
  await click(button(c, "Run"));
  await dom.waitFor(() => /LATE-SHELL-OK/.test(c.textContent));
  assert.ok(deadlines.some((d) => d.ms === 70000));
  assert.ok(
    deadlines.some((d) => d.ms === 35000),
    "ordinary reads retain their shorter budget",
  );
});

test("app search reaches allowed catalog entries beyond the first eighty and reports limits", async () => {
  const catalog = Array.from({ length: 100 }, (_, i) => ({
    id: `/Applications/Fixture ${i}.app`,
    name: `Fixture ${i}`,
    bundleId: `org.fixture.app${i}`,
    running: false,
  }));
  catalog.push({
    id: "/Applications/Zebra Browser.app",
    name: "Zebra Browser",
    bundleId: "org.fixture.late-browser",
    running: false,
  });
  const { c, calls } = await open(full, { catalog });
  await click(
    c.querySelector('[aria-label="Workspace navigation"] [aria-label="Apps"]'),
  );
  const search = await dom.waitFor(() =>
    c.querySelector('[aria-label="Search apps"]'),
  );
  const options = () => [
    ...c.querySelectorAll('[aria-label="Apps you may use"] [role="radio"]'),
  ];
  assert.equal(options().length, 80);
  assert.match(
    c.textContent,
    /Showing 80 of 101 apps\. Narrow your search to see the rest/,
  );
  assert.ok(
    !options().some((option) => option.dataset.value === catalog.at(-1).id),
  );
  await type(search, "zEbRa");
  assert.equal(options().length, 1);
  assert.equal(options()[0].dataset.value, catalog.at(-1).id);
  assert.match(c.textContent, /1 app matches your search \(101 available\)/);
  await click(options()[0]);
  assert.deepEqual(
    calls.find(
      ([method, route]) =>
        method === "POST" && route === "/api/browser/desktop/open",
    )[2],
    { app: catalog.at(-1).id },
  );
  await type(search, "org.fixture.late-browser");
  assert.equal(
    options().length,
    1,
    "bundle ID search also considers the whole catalog",
  );
  await type(search, "no-app-matches");
  assert.equal(options().length, 0);
  assert.match(c.textContent, /No apps match your search \(101 available\)/);
  await type(search, "");
  assert.equal(options().length, 80);
  assert.match(c.textContent, /Showing 80 of 101 apps/);
});

for (const actionFailure of [false, true])
  test(`app catalog polling recovery ${actionFailure ? "preserves an uncertain open action" : "clears its transient 429"}`, async (t) => {
    let poll,
      throttled = !actionFailure,
      opens = 0;
    const interval = globalThis.setInterval;
    t.mock.method(globalThis, "setInterval", (callback, ms, ...args) => {
      if (ms === 15000) {
        poll = callback;
        return interval(() => {}, 3600000);
      }
      return interval(callback, ms, ...args);
    });
    mock(full);
    const fetch = globalThis.fetch;
    globalThis.fetch = dom.window.fetch = (url, init = {}) => {
      const route = new URL(url).pathname;
      if (route === "/api/browser/desktop/apps" && throttled)
        return Promise.resolve(
          reply(
            { error: "Too many agent requests. Wait briefly and retry." },
            429,
          ),
        );
      if (route === "/api/browser/desktop/open") {
        opens++;
        return Promise.resolve(
          reply(
            {
              error: "Completion unknown. Inspect the screen before retrying.",
            },
            503,
          ),
        );
      }
      return fetch(url, init);
    };
    const view = await dom.render(
      React.createElement(BrowserWorkspace, { peer, onEnd() {} }),
    );
    views.add(view);
    const c = view.container;
    // The apps list only polls while its section is showing.
    await click(c.querySelector('[aria-label="Workspace navigation"] [aria-label="Apps"]'));
    if (actionFailure) {
      const app = await dom.waitFor(() =>
        c.querySelector(
          '[aria-label="Apps you may use"] [data-value="/System/Applications/Notes.app"]',
        ),
      );
      await click(app);
      await dom.waitFor(() => c.textContent.includes("Completion unknown"));
      throttled = true;
      poll();
    }
    await dom.waitFor(() => c.textContent.includes("Too many agent requests"));
    if (actionFailure)
      assert.match(
        c.textContent,
        /Completion unknown/,
        "polling failure must not replace action status",
      );
    throttled = false;
    poll();
    await dom.waitFor(() => c.querySelector('[aria-label="Apps you may use"]'));
    await settle();
    assert.doesNotMatch(c.textContent, /Too many agent requests/);
    if (actionFailure) assert.match(c.textContent, /Completion unknown/);
    assert.equal(
      opens,
      actionFailure ? 1 : 0,
      "recovery never repeats app opening",
    );
  });

test("Sign in fills from the agent's vault without the value ever showing", async () => {
  const { c, calls } = await open(full);
  await screen(c);
  await click(button(c, "Screen options"));
  await click(button(c, "Sign in"));
  const user = c.querySelector('[aria-label="Email or username for the Mac"]');
  const pass = c.querySelector('[aria-label="Password for the Mac"]');
  assert.equal(pass.type, "password");
  assert.equal(pass.autocomplete, "current-password");
  user.value = "me@example.com";
  await click(button(c, "Fill email"));
  await dom.waitFor(() => inputs(calls).length === 1);
  pass.value = "hunter2-secret";
  await click(button(c, "Fill + Enter"));
  await dom.waitFor(() => inputs(calls).length === 3);
  assert.deepEqual(inputs(calls), [
    { type: "type", text: "me@example.com", secret: true },
    { type: "type", text: "hunter2-secret", secret: true },
    { type: "key", key: "enter" },
  ]);
  assert.equal(user.value, "");
  assert.equal(pass.value, "");
  await dom.waitFor(() => /pressed Enter/.test(c.textContent));
  assert.doesNotMatch(c.innerHTML, /hunter2-secret|me@example\.com/, "the page never shows a vault value");
  assert.match(c.textContent, /hidden/i);
});

test("Full screen fills the window with the Mac and a button brings the page back", async () => {
  const { c, calls } = await open(full);
  await screen(c);
  const card = c.querySelector(".ap-screen");
  assert.ok(!card.classList.contains("is-full"));
  await click(button(c, "Full screen"));
  assert.ok(card.classList.contains("is-full"));
  assert.ok(c.querySelector('[aria-label^="Mac screen. Click"]'), "the screen stays usable in full screen");
  await click(button(c, "Exit full screen"));
  assert.ok(!card.classList.contains("is-full"));
  assert.equal(inputs(calls).length, 0, "the button never touches the Mac");
});

test("numbered labels sit over the picture and a click on one presses that exact element", async () => {
  const { c, calls } = await open(full);
  await screen(c);
  const label = await dom.waitFor(() => c.querySelector('.ap-label[aria-label="2: Add to cart"]'));
  assert.equal(label.style.left, "60%");
  assert.equal(label.style.top, "40%");
  await click(label);
  await dom.waitFor(() => inputs(calls).length === 1);
  assert.deepEqual(inputs(calls)[0], { type: "element", snapshot: "snap1", n: 2 }, "the label, not a guessed point");
  await settle(200);
  assert.equal(inputs(calls).length, 1, "the picture under the label is not clicked too");
  await dom.waitFor(() => /Done: clicked 2 \(Add to cart\)/.test(c.textContent));
  await click(button(c, "Labels"));
  assert.equal(c.querySelector(".ap-label"), null, "Labels hides them");
});
