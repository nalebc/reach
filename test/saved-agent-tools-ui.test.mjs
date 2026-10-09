import test, { before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeAction } from "../server/agent-desktop.mjs";
import { createAgentShortcuts } from "../server/agent-shortcuts.mjs";
import { startDom, settle } from "./dom/harness.mjs";

let dom, React, SavedAgentTools, AgentPage;
const peer = {
  id: "mac",
  name: "Mac",
  url: "https://mac.tail.ts.net:8443",
  token: "agent",
  platform: "darwin",
};
const shortcut = {
  id: "12345678-1234-4321-8123-123456789abc",
  name: "Open Gmail",
  stepCount: 1,
  inputs: [],
  apps: ["com.google.Chrome"],
};
const access = {
  name: "Mac",
  expiresAt: Date.now() + 600000,
  roots: [],
  terminals: [],
  preset: "apps",
  screen: true,
  control: true,
  open: true,
  savedTools: [shortcut],
};
const reply = (body) =>
  new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
  });
const views = new Set();
const button = (root, label) =>
  [...root.querySelectorAll("button")].find(
    (entry) =>
      entry.textContent.trim() === label ||
      [label, `Run ${label}`, `Recover ${label}`].includes(
        entry.getAttribute("aria-label"),
      ),
  );
before(async () => {
  dom = await startDom();
  React = dom.React;
  dom.window.URL.createObjectURL ||= () => "blob:screen";
  dom.window.URL.revokeObjectURL ||= () => {};
  ({ default: SavedAgentTools } = await dom.load("/src/SavedAgentTools.tsx"));
  ({ default: AgentPage } = await dom.load("/src/AgentPage.tsx"));
});
afterEach(async () => {
  for (const view of views) await view.unmount();
  views.clear();
});
after(async () => dom?.close());
async function render() {
  const view = await dom.render(
    React.createElement(SavedAgentTools, { peer, ended: () => {} }),
  );
  views.add(view);
  return view.container;
}
function mock({
  saved = [shortcut],
  recording = null,
  run = { status: "completed", completedSteps: 1, totalSteps: 1 },
  savedEnabled = true,
} = {}) {
  const calls = [];
  globalThis.fetch = dom.window.fetch = async (url, init = {}) => {
    const route = new URL(url).pathname,
      body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ route, method: init.method || "GET", body });
    if (route === "/api/browser")
      return reply({ ...access, savedTools: saved });
    if (route === "/api/browser/shortcuts")
      return reply({ shortcuts: saved, recording });
    if (route === "/api/browser/shortcuts/run") return reply(run);
    if (route === "/api/browser/shortcuts/save") {
      saved = savedEnabled ? [shortcut] : [];
      recording = null;
      return reply({ ...shortcut, enabled: savedEnabled });
    }
    throw Error(`Unexpected route ${route}`);
  };
  return calls;
}

test("the agent sees task names as buttons and one click executes the saved tool", async () => {
  const calls = mock();
  const c = await render();
  await dom.waitFor(() => button(c, "Open Gmail"));
  assert.equal(button(c, "Open Gmail").disabled, false);
  button(c, "Open Gmail").click();
  await dom.waitFor(() => c.textContent.includes("Executed 1 step"));
  assert.deepEqual(
    calls.filter((call) => call.route.endsWith("/run")),
    [
      {
        route: "/api/browser/shortcuts/run",
        method: "POST",
        body: { id: shortcut.id, values: {} },
      },
    ],
  );
  assert.ok(
    ![...c.querySelectorAll("select option")].some(
      (option) => option.value === shortcut.id,
    ),
    "the run control requires no shortcut-ID or agent selection",
  );
});

test("saving a completed recording immediately adds its named tool button", async () => {
  const calls = mock({
    saved: [],
    recording: { name: "Open Gmail", stepCount: 3, error: "" },
  });
  const c = await render();
  await dom.waitFor(() => button(c, "Save as tool"));
  button(c, "Save as tool").click();
  await dom.waitFor(() => button(c, "Open Gmail"));
  assert.equal(calls.filter((call) => call.route.endsWith("/save")).length, 1);
  assert.ok(c.textContent.includes("The task is now a tool in the list"));
});

test("a visual agent records screen actions, saves a tool and replays it without a global MCP bridge", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-visual-tool-"));
  const chrome = {
    id: "/Applications/Google Chrome.app",
    name: "Google Chrome",
    bundleId: "com.google.Chrome",
    running: true,
  };
  const client = {
    id: "visual-agent",
    kind: "agent",
    status: "accepted",
    name: "Visual agent",
    expiresAt: access.expiresAt,
    scopes: [
      "browser:read",
      "browser:control",
      "browser:open",
      "browser:screen",
    ],
    policy: { preset: "apps", apps: [chrome] },
  };
  const authorize = () => client;
  const applied = [],
    requests = [];
  const desktop = {
    front: async () => ({
      app: chrome.name,
      bundle: chrome.bundleId,
      path: chrome.id,
      title: "Gmail",
      layout: "100,60|0,0,100,60|address",
      secure: false,
      blocked: "",
    }),
    act: async (_, action) => {
      applied.push(normalizeAction(action));
      return { ok: true, app: chrome.name, bundle: chrome.bundleId };
    },
    open: async () => ({ ok: true, app: chrome.name, bundle: chrome.bundleId }),
  };
  const shortcuts = createAgentShortcuts({
    dataDir,
    desktop,
    wait: async () => {},
  });
  t.after(() => {
    shortcuts.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  globalThis.fetch = dom.window.fetch = async (url, init = {}) => {
    const route = new URL(url).pathname;
    const body = init.body ? JSON.parse(init.body) : undefined;
    requests.push({ route, method: init.method || "GET", body });
    if (route === "/api/browser")
      return reply({
        ...access,
        apps: [chrome],
        savedTools: shortcuts.list(authorize).shortcuts,
      });
    if (route === "/api/browser/shortcuts")
      return reply(shortcuts.list(authorize));
    if (route === "/api/browser/shortcuts/record")
      return reply(shortcuts.start(authorize, body.name));
    if (route === "/api/browser/shortcuts/save")
      return reply(shortcuts.save(authorize));
    if (route === "/api/browser/shortcuts/run")
      return reply(await shortcuts.run(authorize, body.id, body.values));
    if (route === "/api/browser/desktop/input")
      return reply(await shortcuts.act(client, body.action, authorize));
    if (route === "/api/browser/desktop/open")
      return reply(await shortcuts.open(client, body.app, authorize));
    if (route === "/api/browser/desktop/apps") return reply({ apps: [chrome] });
    if (route === "/api/browser/desktop/front")
      return reply(await desktop.front());
    if (route === "/api/browser/desktop/screen")
      return new Response(new Uint8Array([255, 216, 255, 217]), {
        headers: {
          "Content-Type": "image/jpeg",
          "X-Reach-Screen": JSON.stringify({ width: 100, height: 60 }),
        },
      });
    throw Error(`Unexpected route ${route}`);
  };
  assert.equal(dom.window.reach, undefined);
  const view = await dom.render(
    React.createElement(AgentPage, {
      peer,
      access: { ...access, apps: [chrome] },
      onEnd() {},
      tools: true,
    }),
  );
  views.add(view);
  const c = view.container;
  button(c, "Tools").click();
  await settle();
  const type = async (field, text) => {
    Object.getOwnPropertyDescriptor(
      dom.window.HTMLInputElement.prototype,
      "value",
    ).set.call(field, text);
    field.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    await settle();
  };
  await type(
    c.querySelector('[aria-label="New saved tool name"]'),
    "Open Gmail",
  );
  button(c, "Record new tool").click();
  await dom.waitFor(() => button(c, "Save as tool"));
  assert.equal(button(c, "Save as tool").disabled, true);
  assert.equal(shortcuts.ownerList().recordings[0].name, "Open Gmail");
  button(c, "Screen").click();
  await settle();
  const frame = await dom.waitFor(() =>
    c.querySelector(
      '[aria-label="Mac screen. Click, drag, scroll and type here as on the Mac."]',
    ),
  );
  await dom.waitFor(() => frame.querySelector("img"));
  frame.getBoundingClientRect = () => ({
    left: 0,
    top: 0,
    width: 200,
    height: 100,
  });
  frame.dispatchEvent(
    new dom.window.MouseEvent("click", {
      bubbles: true,
      clientX: 50,
      clientY: 25,
    }),
  );
  await dom.waitFor(() => applied.length === 1);
  button(c, "Keys").click();
  await settle();
  await type(c.querySelector('[aria-label="Shortcut"]'), "cmd+l");
  button(c, "Press").click();
  await dom.waitFor(() => applied.length === 2);
  button(c, "Type text").click();
  await settle();
  await type(
    c.querySelector('[aria-label="Text to type"]'),
    "https://mail.google.com/",
  );
  button(c, "Type + Enter").click();
  await dom.waitFor(() => applied.length === 4);
  assert.deepEqual(applied, [
    {
      type: "click",
      x: 0.25,
      y: 0.25,
      button: "left",
      count: 1,
      modifiers: [],
    },
    { type: "key", key: "l", modifiers: ["cmd"] },
    { type: "type", text: "https://mail.google.com/" },
    { type: "key", key: "enter", modifiers: [] },
  ]);
  button(c, "Tools").click();
  await settle();
  await dom.waitFor(() => !button(c, "Save as tool").disabled);
  button(c, "Save as tool").click();
  await dom.waitFor(() => button(c, "Open Gmail"));
  assert.deepEqual(
    shortcuts.ownerList().shortcuts[0].steps.map((step) => step.type),
    ["action", "website"],
  );
  assert.equal(
    JSON.parse(
      fs.readFileSync(path.join(dataDir, "agent-shortcuts.json"), "utf8"),
    )[0].name,
    "Open Gmail",
  );
  const recorded = [...applied];
  applied.length = 0;
  button(c, "Open Gmail").click();
  await dom.waitFor(() => c.textContent.includes("Executed 2 steps"));
  assert.deepEqual(applied, recorded);
  assert.equal(
    requests.filter((request) => request.route.endsWith("/record")).length,
    1,
  );
  assert.equal(
    requests.filter((request) => request.route.endsWith("/save")).length,
    1,
  );
  assert.equal(
    requests.filter((request) => request.route.endsWith("/run")).length,
    1,
  );
  assert.equal(dom.window.reach, undefined);
  assert.equal(dom.errors.length, 0, dom.errors.join("\n"));
});

test("tools with inputs require fresh values and a stopped run is never automatically repeated", async () => {
  const calls = mock({
    saved: [{ ...shortcut, inputs: ["text1"] }],
    run: {
      status: "stopped",
      completedSteps: 0,
      totalSteps: 1,
      error: "The focused field changed.",
    },
  });
  const c = await render();
  await dom.waitFor(() => button(c, "Open Gmail"));
  assert.equal(button(c, "Open Gmail").disabled, true);
  const field = c.querySelector('[aria-label="Open Gmail text1"]');
  Object.getOwnPropertyDescriptor(
    dom.window.HTMLInputElement.prototype,
    "value",
  ).set.call(field, "a value for this run");
  field.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  await settle();
  assert.equal(button(c, "Open Gmail").disabled, false);
  button(c, "Open Gmail").click();
  await dom.waitFor(() => c.textContent.includes("Stopped after 0/1 steps"));
  assert.equal(field.value, "");
  assert.equal(calls.filter((call) => call.route.endsWith("/run")).length, 1);
  assert.equal(
    calls.find((call) => call.route.endsWith("/run")).body.values.text1,
    "a value for this run",
  );
  assert.equal(dom.errors.length, 0, dom.errors.join("\n"));
});

test("relearning an owner-disabled task explains why it remains unavailable", async () => {
  const calls = mock({
    saved: [],
    savedEnabled: false,
    recording: { name: "Open Gmail", stepCount: 1, error: "" },
  });
  const c = await render();
  await dom.waitFor(() => button(c, "Save as tool"));
  button(c, "Save as tool").click();
  await dom.waitFor(() => calls.some((call) => call.route.endsWith("/save")));
  await settle();
  assert.match(c.textContent, /owner.*disabled|disabled.*owner/i);
  assert.equal(button(c, "Open Gmail"), undefined);
  assert.doesNotMatch(c.textContent, /task is now a tool in the list/);
  assert.equal(calls.filter((call) => call.route.endsWith("/save")).length, 1);
});

for (const replacement of [false, true])
  test(`pending saved replay ${replacement ? "is isolated on credential change" : "survives an ordinary parent render"}`, async () => {
    let rerender, resolveRun, oldSignal;
    let runs = 0;
    globalThis.fetch = dom.window.fetch = async (url, init = {}) => {
      const route = new URL(url).pathname;
      if (route === "/api/browser") return reply(access);
      if (route === "/api/browser/shortcuts")
        return reply({ shortcuts: [shortcut], recording: null });
      assert.equal(route, "/api/browser/shortcuts/run");
      runs++;
      oldSignal = init.signal;
      return new Promise((resolve, reject) => {
        resolveRun = () =>
          resolve(
            reply({ status: "completed", completedSteps: 1, totalSteps: 1 }),
          );
        init.signal.addEventListener(
          "abort",
          () => reject(Error("old fixture request aborted")),
          { once: true },
        );
      });
    };
    function Parent() {
      const [version, setVersion] = React.useState(0);
      rerender = () => setVersion((n) => n + 1);
      return React.createElement(SavedAgentTools, {
        peer: {
          ...peer,
          token: replacement && version ? "replacement-token" : peer.token,
        },
        ended: () => {},
      });
    }
    const view = await dom.render(React.createElement(Parent));
    views.add(view);
    await dom.waitFor(() => button(view.container, "Open Gmail"));
    dom.update(() => button(view.container, "Open Gmail").click());
    await dom.waitFor(() => !!resolveRun);
    dom.update(rerender);
    await settle();
    assert.equal(
      oldSignal.aborted,
      replacement,
      "only changed credentials end the bridge",
    );
    resolveRun();
    if (!replacement)
      await dom.waitFor(() =>
        view.container.textContent.includes("Executed 1 step"),
      );
    else {
      await settle();
      assert.doesNotMatch(
        view.container.textContent,
        /old fixture request aborted|Executed 1 step/,
      );
      assert.equal(button(view.container, "Open Gmail").disabled, false);
    }
    assert.equal(runs, 1, "rerender never repeats a dispatched action");
  });

for (const failedRoute of ["/api/browser", "/api/browser/shortcuts"])
  test(`saved polling clears recovered 429 from ${failedRoute}`, async (t) => {
    const polls = [];
    let rejected = true;
    const interval = globalThis.setInterval;
    t.mock.method(globalThis, "setInterval", (callback, ms, ...args) => {
      if (ms === 3000) {
        polls.push(callback);
        return interval(() => {}, 3600000);
      }
      return interval(callback, ms, ...args);
    });
    const calls = mock();
    const fetch = globalThis.fetch;
    globalThis.fetch = dom.window.fetch = (url, init) =>
      rejected && new URL(url).pathname === failedRoute
        ? Promise.resolve(
            Response.json(
              { error: "Too many agent requests. Wait briefly and retry." },
              { status: 429 },
            ),
          )
        : fetch(url, init);
    const c = await render();
    await dom.waitFor(() => c.textContent.includes("Too many agent requests"));
    rejected = false;
    for (const poll of polls) poll();
    await dom.waitFor(() => button(c, "Open Gmail"));
    await settle();
    assert.doesNotMatch(c.textContent, /Too many agent requests/);
    assert.equal(calls.filter((call) => call.method !== "GET").length, 0);
  });

for (const partial of [false, true])
  test(`saved polling recovery preserves ${partial ? "partial completion" : "unknown action outcome"} without replay`, async (t) => {
    const polls = [];
    let throttled = false,
      runs = 0;
    const interval = globalThis.setInterval;
    t.mock.method(globalThis, "setInterval", (callback, ms, ...args) => {
      if (ms === 3000) {
        polls.push(callback);
        return interval(() => {}, 3600000);
      }
      return interval(callback, ms, ...args);
    });
    const calls = mock();
    const fetch = globalThis.fetch;
    globalThis.fetch = dom.window.fetch = (url, init = {}) => {
      const route = new URL(url).pathname;
      if (route.endsWith("/run")) {
        runs++;
        return Promise.resolve(
          partial
            ? reply({
                status: "stopped",
                completedSteps: 1,
                totalSteps: 2,
                error: "Focus changed.",
              })
            : Response.json(
                {
                  error:
                    "Completion unknown. Inspect the screen before retrying.",
                },
                { status: 503 },
              ),
        );
      }
      if (throttled && route === "/api/browser/shortcuts")
        return Promise.resolve(
          Response.json(
            { error: "Too many agent requests. Wait briefly and retry." },
            { status: 429 },
          ),
        );
      return fetch(url, init);
    };
    const c = await render();
    await dom.waitFor(() => button(c, "Open Gmail"));
    button(c, "Open Gmail").click();
    const outcome = partial ? "Stopped after 1/2 steps" : "Completion unknown";
    await dom.waitFor(() => c.textContent.includes(outcome));
    await settle();
    throttled = true;
    for (const poll of polls) poll();
    await dom.waitFor(() => c.textContent.includes("Too many agent requests"));
    assert.ok(
      c.textContent.includes(outcome),
      "polling failure must not overwrite the action outcome",
    );
    throttled = false;
    for (const poll of polls) poll();
    await settle();
    assert.doesNotMatch(c.textContent, /Too many agent requests/);
    assert.ok(
      c.textContent.includes(outcome),
      "polling recovery must not dismiss the action outcome",
    );
    assert.equal(runs, 1, "background recovery never repeats a write");
  });

test("Discard recording uses the bodyless shared plan and clears recording controls", async () => {
  mock({
    saved: [],
    recording: { name: "Synthetic recording", stepCount: 1, error: "" },
  });
  const fallback = globalThis.fetch;
  let discarded = false,
    deletes = 0;
  globalThis.fetch = dom.window.fetch = async (url, init = {}) => {
    const route = new URL(url).pathname;
    if (route === "/api/browser/shortcuts/record" && init.method === "DELETE") {
      deletes++;
      assert.equal(
        init.body,
        undefined,
        "Funnel does not permit a DELETE body",
      );
      discarded = true;
      return reply({ ok: true });
    }
    if (discarded && route === "/api/browser/shortcuts")
      return reply({ shortcuts: [], recording: null });
    return fallback(url, init);
  };
  const c = await render();
  await dom.waitFor(() => button(c, "Discard recording"));
  button(c, "Discard recording").click();
  await dom.waitFor(() => c.textContent.includes("Recording discarded."));
  await dom.waitFor(() => !button(c, "Discard recording"));
  assert.ok(button(c, "Record new tool"));
  assert.equal(deletes, 1);
});
