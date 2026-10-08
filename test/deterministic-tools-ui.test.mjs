import test, { before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAgentTools } from "../server/agent-tools.mjs";
import {
  toolBrowserFixture,
  toolApps,
  exampleTool,
} from "./helpers/tool-browser-fixture.mjs";
import { startDom, settle } from "./dom/harness.mjs";

let dom, React, Component;
const views = new Set(),
  peer = {
    id: "mac",
    name: "Mac",
    url: "https://mac.tail.ts.net:8443",
    token: "agent",
    platform: "darwin",
  };
const button = (root, label) =>
  [...root.querySelectorAll("button")].find(
    (entry) => entry.textContent.trim() === label,
  );
before(async () => {
  dom = await startDom();
  React = dom.React;
  ({ default: Component } = await dom.load("/src/DeterministicAgentTools.tsx"));
});
afterEach(async () => {
  for (const view of views) await view.unmount();
  views.clear();
});
after(async () => dom?.close());
async function type(element, value) {
  const prototype =
    element.tagName === "TEXTAREA"
      ? dom.window.HTMLTextAreaElement.prototype
      : dom.window.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value").set.call(element, value);
  element.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  await settle();
}
async function fixture(
  t,
  render = (props) => React.createElement(Component, props),
) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-tool-ui-")),
    driver = toolBrowserFixture(),
    calls = [];
  const client = {
    id: "agent-ui",
    name: "Visual agent",
    kind: "agent",
    status: "accepted",
    expiresAt: Date.now() + 600000,
    policy: { browser: true, preset: "full", roots: [] },
    scopes: [
      "browser:read",
      "browser:screen",
      "browser:control",
      "browser:open",
    ],
  };
  const authorize = () => client;
  const tools = createAgentTools(
    { dataDir },
    {
      driver,
      waitMs: 250,
      desktop: {
        catalog: async () => toolApps,
        withBrowser: async (_client, _app, auth, work) =>
          work(async () => auth()),
      },
    },
  );
  t.after(() => {
    tools.close();
    driver.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  globalThis.fetch = dom.window.fetch = async (url, init = {}) => {
    const route = new URL(url).pathname,
      body = init.body ? JSON.parse(init.body) : {};
    calls.push({ route, body, signal: init.signal });
    let result;
    if (route === "/api/browser")
      result = {
        name: "Mac",
        expiresAt: client.expiresAt,
        roots: [],
        terminals: [],
        preset: "full",
        screen: true,
        control: true,
        open: true,
        browserTools: await tools.catalog(authorize),
      };
    else if (route === "/api/browser/tools")
      result = await tools.catalog(authorize);
    else if (route === "/api/browser/tools/protocol")
      result = tools.protocol(authorize);
    else if (route === "/api/browser/tools/define")
      result = await tools.define(authorize, body.definition);
    else if (route === "/api/browser/tools/run")
      result = await tools.run(authorize, body);
    else throw Error(`Unexpected route ${route}`);
    return new Response(JSON.stringify(result), {
      headers: { "Content-Type": "application/json" },
    });
  };
  const view = await dom.render(render({ peer, ended: () => {} }));
  views.add(view);
  return { root: view.container, tools, driver, calls };
}

test("a screen agent sees named Chrome/Safari tools and executes one fixed operation with one click", async (t) => {
  const f = await fixture(t);
  await dom.waitFor(() => button(f.root, "Open Gmail account"));
  const browser = f.root.querySelector('[aria-label="Tool browser"]');
  assert.deepEqual(
    [...browser.options].map((option) => option.value),
    ["Chrome", "Safari"],
  );
  browser.value = "Safari";
  browser.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  await settle();
  button(f.root, "Open Gmail account").click();
  button(f.root, "Open Gmail account").click();
  await dom.waitFor(() => f.root.textContent.includes("completed · 3/3"));
  const calls = f.calls.filter((call) => call.route.endsWith("/run"));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.browser, "Safari");
  assert.equal(calls[0].body.id, "builtin_open_gmail");
  assert.match(calls[0].body.requestId, /^[a-f0-9-]{36}$/);
  assert.equal(f.driver.browsers.get("Safari").length, 1);
  assert.equal(f.driver.browsers.get("Chrome").length, 0);
});

test("the visual protocol editor registers a new definition and its named button executes the real interpreter", async (t) => {
  const f = await fixture(t);
  await dom.waitFor(() => button(f.root, "Create deterministic tool"));
  button(f.root, "Create deterministic tool").click();
  await dom.waitFor(() =>
    f.root.querySelector('[aria-label="Tool definition JSON"]'),
  );
  assert.match(
    f.root.querySelector("details").textContent,
    /builtin_open_gmail/,
  );
  await type(
    f.root.querySelector('[aria-label="Tool definition JSON"]'),
    JSON.stringify(exampleTool("visual_custom")),
  );
  button(f.root, "Save deterministic tool").click();
  await dom.waitFor(() => button(f.root, "Do example task"));
  assert.equal(
    f.calls.filter((call) => call.route.endsWith("/define")).length,
    1,
  );
  button(f.root, "Do example task").click();
  await dom.waitFor(() => f.root.textContent.includes("completed · 5/5"));
  assert.equal(f.driver.counters.clicks, 1);
  assert.match(
    f.root.querySelector('[aria-label="Tool result"]').textContent,
    /Done/,
  );
});

test("an uncertain visual run retains its request ID and never creates a second draft or click on recovery", async (t) => {
  const f = await fixture(t);
  await f.tools.define(
    () => ({
      id: "agent-ui",
      name: "Visual agent",
      kind: "agent",
      status: "accepted",
      expiresAt: Date.now() + 600000,
      policy: { browser: true, preset: "full", roots: [] },
      scopes: [
        "browser:read",
        "browser:screen",
        "browser:control",
        "browser:open",
      ],
    }),
    exampleTool("uncertain_visual"),
  );
  await dom.waitFor(() => button(f.root, "Do example task"), 5000);
  f.driver.after = async (_browser, request) => {
    if (request.op === "click")
      throw Object.assign(Error("Lost response"), {
        code: "uncertain",
        uncertain: true,
      });
  };
  button(f.root, "Do example task").click();
  await dom.waitFor(() => f.root.textContent.includes("uncertain ·"));
  button(f.root, "Do example task").click();
  await dom.waitFor(
    () => f.calls.filter((call) => call.route.endsWith("/run")).length === 2,
  );
  const runs = f.calls.filter((call) => call.route.endsWith("/run"));
  assert.equal(runs[0].body.requestId, runs[1].body.requestId);
  assert.equal(f.driver.counters.clicks, 1);
  assert.ok(button(f.root, "Start another run"));
});

test("a pending deterministic tool survives equivalent peer objects and parent callbacks", async (t) => {
  let update;
  function Parent(props) {
    const [value, setValue] = React.useState(0);
    update = setValue;
    return React.createElement(Component, {
      ...props,
      peer: { ...props.peer, name: `Mac ${value}` },
      ended: () => {},
    });
  }
  const f = await fixture(t, (props) => React.createElement(Parent, props));
  await dom.waitFor(() => button(f.root, "Open Gmail account"));
  let release, entered;
  const ready = new Promise((resolve) => {
      entered = resolve;
    }),
    blocking = new Promise((resolve) => {
      release = resolve;
    });
  f.driver.before = async (_browser, request) => {
    if (request.op === "assert") {
      entered();
      await blocking;
    }
  };
  button(f.root, "Open Gmail account").click();
  await ready;
  dom.update(() => update(1));
  await settle();
  assert.equal(
    f.calls.find((call) => call.route.endsWith("/run")).signal.aborted,
    false,
  );
  release();
  await dom.waitFor(() => f.root.textContent.includes("completed · 3/3"));
  assert.equal(f.calls.filter((call) => call.route.endsWith("/run")).length, 1);
});

test("changing credentials clears private output and cannot display the previous session's late result", async (t) => {
  let update;
  function Parent(props) {
    const [token, setToken] = React.useState(props.peer.token);
    update = setToken;
    return React.createElement(Component, {
      ...props,
      peer: { ...props.peer, token },
      ended: () => {},
    });
  }
  const f = await fixture(t, (props) => React.createElement(Parent, props));
  await dom.waitFor(() => button(f.root, "Open Gmail account"));
  const oldFetch = globalThis.fetch;
  globalThis.fetch = dom.window.fetch = async (url, init = {}) => {
    if (new Headers(init.headers).get("authorization") === "Bearer new-agent")
      return new Response(
        JSON.stringify({
          preset: "readonly",
          expiresAt: Date.now() + 600000,
          roots: [],
          terminals: [],
          screen: true,
          control: false,
          open: false,
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    return oldFetch(url, init);
  };
  let release, entered;
  const ready = new Promise((resolve) => {
      entered = resolve;
    }),
    blocking = new Promise((resolve) => {
      release = resolve;
    });
  f.driver.before = async (_browser, request) => {
    if (request.op === "assert") {
      entered();
      await blocking;
    }
  };
  button(f.root, "Open Gmail account").click();
  await ready;
  dom.update(() => update("new-agent"));
  await settle();
  assert.equal(
    f.calls.find((call) => call.route.endsWith("/run")).signal.aborted,
    true,
  );
  release();
  await settle(80);
  assert.ok(!f.root.textContent.includes("completed"));
  assert.equal(f.root.querySelector('[aria-label="Tool result"]'), null);
});
