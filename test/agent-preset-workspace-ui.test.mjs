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
function mock(access, { busy = false, input, catalog } = {}) {
  const calls = [];
  globalThis.fetch = dom.window.fetch = async (url, init = {}) => {
    const parsed = new URL(url),
      route = parsed.pathname;
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push([init.method || "GET", route, body]);
    if (route === "/api/browser") return reply(access);
    if (route === "/api/browser/shortcuts")
      return reply({ shortcuts: [], recording: null });
    if (route === "/api/browser/desktop/screen") {
      assert.equal(
        parsed.searchParams.get("maxWidth"),
        "2560",
        "the page asks for the display's own pixels",
      );
      return jpeg();
    }
    if (route === "/api/browser/desktop/front")
      return reply({
        app: "Google Chrome",
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

test("the workspace starts with tools discovery and explicit navigation, and Screen updates only when opened", async () => {
  const { c, calls } = await open(full, undefined, null);
  const nav = c.querySelector('[aria-label="Workspace navigation"]');
  assert.deepEqual(
    [...nav.querySelectorAll("button")].map((button) =>
      button.getAttribute("aria-label"),
    ),
    ["Overview", "Tools", "Screen", "Apps", "Files", "Commands", "Access"],
  );
  assert.equal(
    nav.querySelector('[aria-label="Overview"]').getAttribute("aria-current"),
    "page",
  );
  assert.equal(c.querySelector("#agent-section-screen").hidden, true);
  assert.ok(c.querySelector('[aria-label="Find a tool from workspace"]'));
  assert.ok(!calls.some(([, route]) => route.endsWith("/desktop/screen")));
  await click(nav.querySelector('[aria-label="Access"]'));
  assert.match(
    c.querySelector("#agent-section-access").textContent,
    /You may see and use the whole screen, open apps, read and change files, run commands as the owner/,
  );
  assert.match(
    c.querySelector(".ap-foot").textContent,
    /Commands run as the owner and are not confined to shared folders/,
  );
  await click(nav.querySelector('[aria-label="Screen"]'));
  await dom.waitFor(() => /Live · updated/.test(c.textContent));
  assert.match(c.textContent, /1 protected window left out/);
  assert.equal(c.querySelector("#agent-section-screen").hidden, false);
  assert.ok(button(c, "Reload page"));
  assert.match(button(c, "Reload page").title, /Reloads this web page/);
  assert.ok(button(c, "Take a screenshot now"));
});

test("clicking the picture clicks the Mac and the result is written next to the actions", async () => {
  const { c, calls } = await open(full);
  const frame = await dom.waitFor(() =>
    c.querySelector('[aria-label="Mac screen. Click to click there."]'),
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
  frame.dispatchEvent(
    new dom.window.MouseEvent("click", {
      bubbles: true,
      clientX: 50,
      clientY: 25,
    }),
  );
  await dom.waitFor(() => inputs(calls).length === 1);
  assert.deepEqual(inputs(calls)[0], {
    type: "click",
    x: 0.25,
    y: 0.25,
    button: "left",
    count: 1,
  });
  await dom.waitFor(() =>
    /Done: clicked at 25%, 25% in Google Chrome\. The screen below is updating\./.test(
      c.textContent,
    ),
  );
  assert.ok(c.querySelector(".ap-status.is-done"));
  // Clicking by typed coordinates, in right-click mode.
  await click(
    [...c.querySelectorAll('[aria-label="Click mode"] [role="radio"]')].find(
      (item) => item.dataset.value === "right",
    ),
  );
  await type(c.querySelector('[aria-label="X percent"]'), "80");
  await type(c.querySelector('[aria-label="Y percent"]'), "10");
  await click(button(c, "Click there"));
  await dom.waitFor(() => inputs(calls).length === 2);
  assert.deepEqual(inputs(calls)[1], {
    type: "click",
    x: 0.8,
    y: 0.1,
    button: "right",
    count: 1,
  });
  await type(c.querySelector('[aria-label="Text to type"]'), "hello");
  await click(button(c, "Type + Enter"));
  await dom.waitFor(() => inputs(calls).length === 4);
  assert.deepEqual(inputs(calls).slice(2), [
    { type: "type", text: "hello" },
    { type: "key", key: "enter" },
  ]);
  await dom.waitFor(
    () => c.querySelector('[aria-label="Text to type"]').value === "",
  );
  await click(button(c, "Esc"));
  await dom.waitFor(() => inputs(calls).length === 5);
  await type(c.querySelector('[aria-label="Shortcut"]'), "cmd+l");
  await click(button(c, "Press"));
  await dom.waitFor(() => inputs(calls).length === 6);
  assert.deepEqual(inputs(calls).at(-1), {
    type: "key",
    key: "l",
    modifiers: ["cmd"],
  });
  await click(button(c, "Check what's in front"));
  await dom.waitFor(() =>
    /In front: Google Chrome · Amazon/.test(c.textContent),
  );
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

test("aiming: the picture is requested at the display's resolution, a zoomed quarter maps clicks exactly, and the last click is marked", async () => {
  const { c, calls } = await open(full);
  const frame = await dom.waitFor(() =>
    c.querySelector('[aria-label="Mac screen. Click to click there."]'),
  );
  await dom.waitFor(() => frame.querySelector("img"));
  assert.ok(
    calls.some(([, route, ,]) => route === "/api/browser/desktop/screen"),
    "screenshots are fetched",
  );
  const shotUrl =
    [...c.ownerDocument.defaultView.document.querySelectorAll("img")].length >=
      0 && calls.find(([, route]) => route === "/api/browser/desktop/screen");
  assert.ok(shotUrl);
  await dom.waitFor(
    () => /100×60 px/.test(c.textContent),
    "the picture's pixel size is written next to the live readout",
  );
  const zoomIn = button(c, "Zoom in");
  assert.equal(zoomIn.getAttribute("aria-pressed"), "false");
  await click(zoomIn);
  assert.equal(button(c, "Zoom out").getAttribute("aria-pressed"), "true");
  assert.match(
    c.textContent,
    /Zoom mode: click the picture where you want to look closer/,
  );
  const zoomFrame = c.querySelector(
    '[aria-label="Mac screen. Click where to zoom in."]',
  );
  zoomFrame.getBoundingClientRect = () => ({
    left: 0,
    top: 0,
    width: 200,
    height: 100,
    right: 200,
    bottom: 100,
  });
  zoomFrame.dispatchEvent(
    new dom.window.MouseEvent("click", {
      bubbles: true,
      clientX: 100,
      clientY: 50,
    }),
  );
  await settle(40);
  assert.equal(
    inputs(calls).length,
    0,
    "choosing where to zoom never clicks the Mac",
  );
  assert.match(c.textContent, /Zoomed view/);
  assert.match(c.textContent, /X 38%–63%, Y 38%–63% · 4×/);
  const zoomed = c.querySelector(
    '[aria-label="Zoomed view. Click to click there."]',
  );
  assert.ok(zoomed);
  zoomed.getBoundingClientRect = () => ({
    left: 0,
    top: 0,
    width: 400,
    height: 200,
    right: 400,
    bottom: 200,
  });
  zoomed.dispatchEvent(
    new dom.window.MouseEvent("click", {
      bubbles: true,
      clientX: 100,
      clientY: 50,
    }),
  );
  await dom.waitFor(() => inputs(calls).length === 1);
  const sent = inputs(calls)[0];
  assert.equal(sent.type, "click");
  assert.equal(sent.x.toFixed(4), "0.4375");
  assert.equal(sent.y.toFixed(4), "0.4375");
  assert.ok(c.querySelector(".ap-mark-ring"), "the last click is marked");
  await click(button(c, "Move zoom right"));
  assert.match(c.textContent, /X 48%–73%, Y 38%–63%/);
  await click(button(c, "Zoom out"));
  assert.equal(
    c.querySelector('[aria-label="Zoomed view. Click to click there."]'),
    null,
  );
  assert.ok(button(c, "Full screen"));
});

test("another agent holding the Mac reads as waiting, not failure", async () => {
  const { c } = await open(full, { busy: true });
  const frame = await dom.waitFor(() =>
    c.querySelector('[aria-label="Mac screen. Click to click there."]'),
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
  frame.dispatchEvent(
    new dom.window.MouseEvent("click", {
      bubbles: true,
      clientX: 50,
      clientY: 25,
    }),
  );
  await dom.waitFor(() =>
    /Not done: Grok is using the Mac\. Try again in 2 s\./.test(c.textContent),
  );
  assert.ok(c.querySelector(".ap-status.is-wait"));
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
    await dom.waitFor(() => c.querySelector(".ap-frame img"));
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

test("Type + Enter holds one sequence while preserving a newer draft and ignoring overlapping actions", async () => {
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
  await dom.waitFor(() => c.querySelector(".ap-frame img"));
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
  await click(button(c, "Esc"));
  assert.deepEqual(inputs(calls), [{ type: "type", text: "first draft" }]);
  assert.equal(field.value, "newer draft");
  finishType(reply({ ok: true, app: "Google Chrome" }));
  await dom.waitFor(() => inputs(calls).length === 2);
  assert.deepEqual(inputs(calls)[1], { type: "key", key: "enter" });
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
  await dom.waitFor(() => /Done: pressed Enter/.test(c.textContent));
  await click(button(c, "Type"));
  await dom.waitFor(() => inputs(calls).length === 3);
  assert.deepEqual(inputs(calls)[2], { type: "type", text: "newer draft" });
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
  await dom.waitFor(() => c.querySelector(".ap-frame img"));
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
  await dom.waitFor(() => c.querySelector(".ap-frame img"));
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
  await dom.waitFor(() => c.querySelector('[aria-label="Mac screen"]'));
  assert.equal(
    c.querySelector('[aria-label="Mac screen. Click to click there."]'),
    null,
  );
  assert.equal(c.querySelector('[aria-label="Text to type"]'), null);
  for (const label of [
    "Move pointer",
    "Drag there",
    "Scroll up",
    "Scroll down",
    "Scroll left",
    "Scroll right",
  ])
    assert.equal(
      button(c, label),
      undefined,
      `${label} must not appear for Read only`,
    );
  assert.equal(c.querySelector('[aria-label="Destination X percent"]'), null);
  assert.equal(c.querySelector('[aria-label="Search apps"]'), null);
  assert.equal(button(c, "Esc"), undefined);
  assert.equal(c.querySelector('[aria-label="Command"]'), null);
  assert.equal(c.querySelector('[aria-label="New file name"]'), null);
  assert.match(
    c.textContent,
    /Look only\. Nothing on this page clicks or types on the Mac/,
  );
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

test("pointer movement, dragging and both scroll axes send the chosen screen coordinates", async () => {
  const { c, calls } = await open(full);
  await dom.waitFor(() => c.querySelector(".ap-frame img"));
  const field = (label) => c.querySelector(`[aria-label="${label}"]`);
  assert.equal(field("X percent").value, "50");
  assert.equal(field("Y percent").value, "50");
  await click(button(c, "Move pointer"));
  assert.deepEqual(inputs(calls), [{ type: "move", x: 0.5, y: 0.5 }]);
  await type(field("X percent"), "25");
  await type(field("Y percent"), "80");
  await type(field("Destination X percent"), "100");
  await type(field("Destination Y percent"), "0");
  await click(button(c, "Drag there"));
  assert.deepEqual(inputs(calls).at(-1), {
    type: "drag",
    x: 0.25,
    y: 0.8,
    toX: 1,
    toY: 0,
  });
  await dom.waitFor(() =>
    /Done: dragged from 25%, 80% to 100%, 0%/.test(c.textContent),
  );
  for (const label of [
    "Scroll left",
    "Scroll right",
    "Scroll up",
    "Scroll down",
  ])
    await click(button(c, label));
  assert.deepEqual(inputs(calls).slice(2), [
    { type: "scroll", x: 0.25, y: 0.8, dx: -600, dy: 0 },
    { type: "scroll", x: 0.25, y: 0.8, dx: 600, dy: 0 },
    { type: "scroll", x: 0.25, y: 0.8, dx: 0, dy: -600 },
    { type: "scroll", x: 0.25, y: 0.8, dx: 0, dy: 600 },
  ]);
});

test("empty or invalid pointer and drag coordinates never dispatch an input request", async () => {
  const { c, calls } = await open(full);
  await dom.waitFor(() => c.querySelector(".ap-frame img"));
  const field = (label) => c.querySelector(`[aria-label="${label}"]`);
  await type(field("X percent"), "");
  await type(field("Destination X percent"), "75");
  await type(field("Destination Y percent"), "75");
  for (const label of [
    "Click there",
    "Move pointer",
    "Drag there",
    "Scroll left",
    "Scroll down",
  ])
    await click(button(c, label));
  assert.deepEqual(
    inputs(calls),
    [],
    "an empty coordinate must not become zero",
  );
  assert.match(c.textContent, /give X and Y as percentages from 0 to 100/);
  await type(field("X percent"), "50");
  for (const invalid of [" ", "-1", "101", "NaN", "Infinity"]) {
    await type(field("Y percent"), invalid);
    await click(button(c, "Move pointer"));
  }
  await type(field("Y percent"), "50");
  for (const [label, invalid] of [
    ["Destination X percent", ""],
    ["Destination X percent", "-0.1"],
    ["Destination X percent", "100.1"],
    ["Destination X percent", "NaN"],
    ["Destination Y percent", " "],
  ]) {
    await type(field("Destination X percent"), "75");
    await type(field("Destination Y percent"), "75");
    await type(field(label), invalid);
    await click(button(c, "Drag there"));
  }
  assert.deepEqual(inputs(calls), []);
  assert.match(
    c.textContent,
    /give destination X and Y as percentages from 0 to 100/,
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
