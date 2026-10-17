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
import { startDom, settle, replaceText } from "./dom/harness.mjs";

let dom, React, Workspace, AgentPage;
const views = new Set();
const peer = {
  id: "mac",
  name: "Studio Mac",
  url: "https://mac.tail.ts.net:8443",
  token: "agent",
  platform: "darwin",
};
const button = (root, label) =>
  [...root.querySelectorAll("button")].find(
    (item) =>
      [label, `Run ${label}`, `Recover ${label}`].includes(
        item.getAttribute("aria-label"),
      ) || item.textContent.trim() === label,
  );
const navigate = async (root, label) => {
  const control = button(
    root.querySelector('[aria-label="Workspace navigation"]'),
    label,
  );
  const menu = control.closest("details");
  if (menu && !menu.open) menu.querySelector("summary").click();
  control.click();
  await settle();
};
const click = async (root, label) => {
  const element = button(root, label);
  assert.ok(element, label);
  assert.equal(element.disabled, false, label);
  element.click();
  await settle();
};
before(async () => {
  dom = await startDom({ mobile: false });
  React = dom.React;
  dom.window.URL.createObjectURL ||= () => "blob:fixture-screen";
  dom.window.URL.revokeObjectURL ||= () => {};
  ({ default: Workspace } = await dom.load("/src/BrowserWorkspace.tsx"));
  ({ default: AgentPage } = await dom.load("/src/AgentPage.tsx"));
});
afterEach(async () => {
  for (const view of views) await view.unmount();
  views.clear();
  assert.deepEqual(dom.errors, []);
});
after(async () => dom?.close());

async function fixture(t, render) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-workspace-ui-"));
  const driver = toolBrowserFixture(),
    calls = [];
  const client = {
    id: "workspace-agent",
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
  const tools = createAgentTools(
    { dataDir },
    {
      // The DOM driver models macOS Chrome/Safari on every test host.
      platform: "darwin",
      driver,
      waitMs: 250,
      desktop: {
        catalog: async () => toolApps,
        withBrowser: async (_client, _app, auth, work) =>
          work(async () => auth()),
      },
    },
  );
  const authorize = () => client;
  const access = {
    name: peer.name,
    expiresAt: client.expiresAt,
    preset: "full",
    presetName: "Full control",
    screen: true,
    control: true,
    open: true,
    roots: [],
    terminals: [],
    apps: toolApps,
  };
  t.after(() => {
    tools.close();
    driver.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  globalThis.fetch = dom.window.fetch = async (url, init = {}) => {
    const parsed = new URL(url),
      route = parsed.pathname,
      body = init.body ? JSON.parse(init.body) : {};
    calls.push({
      route,
      body,
      signal: init.signal,
      method: init.method || "GET",
    });
    let result;
    try {
      if (route === "/api/browser")
        result = { ...access, browserTools: await tools.catalog(authorize) };
      else if (route === "/api/browser/tools")
        result = await tools.catalog(authorize);
      else if (route === "/api/browser/tools/protocol")
        result = tools.protocol(authorize);
      else if (route === "/api/browser/tools/define")
        result = await tools.define(authorize, body.definition);
      else if (route === "/api/browser/tools/run")
        result = await tools.run(authorize, body);
      else if (route.startsWith("/api/browser/tools/operations/"))
        result = tools.operation(authorize, route.split("/").at(-1));
      else if (route === "/api/browser/shortcuts")
        result = { shortcuts: [], recording: null };
      else if (route === "/api/browser/desktop/apps")
        result = { apps: toolApps };
      else if (route === "/api/browser/desktop/screen")
        return new Response(new Uint8Array([255, 216, 255, 217]), {
          headers: {
            "Content-Type": "image/jpeg",
            "X-Reach-Screen": JSON.stringify({ width: 100, height: 60 }),
          },
        });
      else throw Error(`Unexpected ${route}`);
      return new Response(JSON.stringify(result), {
        headers: { "Content-Type": "application/json" },
      });
    } catch (error) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: error.status || 409,
        headers: { "Content-Type": "application/json" },
      });
    }
  };
  const props = { peer, onEnd() {}, agentTools: true, tools: true };
  const view = await dom.render(
    render
      ? render({ ...props, access })
      : React.createElement(Workspace, props),
  );
  views.add(view);
  await dom.waitFor(() =>
    view.container.querySelector('[aria-label="Workspace navigation"]'),
  );
  await dom.waitFor(() => button(view.container, "Open Gmail account"));
  return { root: view.container, driver, tools, calls, client, access };
}

const runner = (root) => root.querySelector(".atl-runner");
const runs = (f) => f.calls.filter((call) => call.route.endsWith("/tools/run"));

const filter = async (root, value) => {
  const select = root.querySelector('[aria-label="Filter tools"]');
  select.value = value;
  select.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  await settle();
};

test("Tools is one tap from the live screen, with compact Run controls; search, empty results, and missing inputs never execute a task", async (t) => {
  const f = await fixture(t),
    nav = f.root.querySelector('[aria-label="Workspace navigation"]');
  assert.equal(button(nav, "Screen").getAttribute("aria-current"), "page");
  await navigate(f.root, "Tools");
  assert.equal(button(nav, "Tools").getAttribute("aria-current"), "page");
  assert.equal(button(nav, "Overview"), undefined);
  assert.equal(f.root.querySelector(".atl-runner"), null);
  assert.equal(f.root.querySelector(".atl-run").textContent.trim(), "Run");
  await replaceText(
    f.root.querySelector('[aria-label="Search tools"]'),
    "Gmail",
  );
  assert.equal(f.root.querySelectorAll(".atl-card").length, 5);
  await replaceText(
    f.root.querySelector('[aria-label="Search tools"]'),
    "draft",
  );
  assert.equal(f.root.querySelectorAll(".atl-card").length, 1);
  await filter(f.root, "walmart");
  assert.equal(f.root.querySelectorAll(".atl-card").length, 0);
  assert.match(f.root.textContent, /No matching browser tools/);
  await click(f.root, "Clear tool search");
  assert.equal(f.root.querySelectorAll(".atl-card").length, 4);
  await filter(f.root, "gmail");
  await click(f.root, "Find Gmail message");
  assert.ok(
    runner(f.root).querySelector('[aria-label="Find Gmail message: query"]'),
  );
  assert.equal(
    runner(f.root).closest(".atl-card"),
    button(f.root, "Run Find Gmail message").closest(".atl-card"),
  );
  assert.match(
    f.root.querySelector('[role="alert"]').textContent,
    /Add Gmail search query/,
  );
  assert.equal(runs(f).length, 0);
  assert.equal(f.driver.counters.clicks, 0);
  await click(f.root, "Close tool details");
  assert.equal(runner(f.root), null);
  await filter(f.root, "all");
  await replaceText(
    f.root.querySelector('[aria-label="Search tools"]'),
    "Walmart",
  );
  assert.equal(f.root.querySelectorAll(".atl-card").length, 4);
});

test("Safari results feed exact message, attachment, and draft inputs through visible controls without copying handles", async (t) => {
  const f = await fixture(t);
  await navigate(f.root, "Tools");
  const browser = f.root.querySelector('[aria-label="Tool browser"]');
  browser.value = "Safari";
  browser.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  await settle();
  await click(f.root, "Inspect Find Gmail message");
  await replaceText(
    runner(f.root).querySelector('[aria-label="Find Gmail message: query"]'),
    "invoice",
  );
  await click(runner(f.root), "Run");
  await dom.waitFor(() => button(f.root, "Open this message"));
  assert.match(
    f.root.querySelector(".atl-results").textContent,
    /Invoice October/,
  );
  const message = JSON.parse(
    f.root.querySelector('[aria-label="Tool result"]').textContent,
  ).messages.items[0].handle;
  await click(f.root, "Open this message");
  assert.equal(
    runs(f).length,
    1,
    "selecting the next step supplies inputs, without executing",
  );
  assert.equal(
    runner(f.root).querySelector('[aria-label="Open Gmail message: message"]')
      .value,
    message,
  );
  await click(runner(f.root), "Run");
  await dom.waitFor(() => button(f.root, "Get this attachment"));
  await click(f.root, "Get this attachment");
  await click(runner(f.root), "Run");
  await dom.waitFor(() => button(f.root, "Use in a Gmail draft"));
  await click(f.root, "Use in a Gmail draft");
  const draft = runner(f.root);
  assert.match(
    draft.querySelector('[aria-label="Create Gmail draft with file: file"]')
      .value,
    /^[a-f0-9-]{36}$/,
  );
  await replaceText(
    draft.querySelector('[aria-label="Create Gmail draft with file: to"]'),
    "recipient@example.test",
  );
  await replaceText(
    draft.querySelector('[aria-label="Create Gmail draft with file: subject"]'),
    "Invoice snapshot",
  );
  await replaceText(
    draft.querySelector('[aria-label="Create Gmail draft with file: body"]'),
    "Hello,\nHere is the file.",
  );
  await click(draft, "Run");
  await dom.waitFor(
    () =>
      f.root.textContent.includes("Invoice snapshot") &&
      f.root.querySelector(".atl-result-heading h2").textContent ===
        "Completed",
  );
  assert.deepEqual(
    runs(f).map((call) => call.body.browser),
    ["Safari", "Safari", "Safari", "Safari"],
  );
  assert.equal(runs(f).length, 4);
  assert.equal(f.driver.counters.drafts, 1);
  assert.equal(f.driver.counters.attachments, 1);
  assert.ok(
    ![...f.root.querySelectorAll("button")].some(
      (item) => item.textContent.trim() === "Send",
    ),
  );
  await click(f.root, "Close tool details");
  assert.equal(
    f.root.querySelector(".atl-results"),
    null,
    "closing a task also hides its result panel",
  );
  await click(f.root, "Inspect Create Gmail draft with file");
  assert.equal(
    f.root.querySelector(".atl-result-heading h2").textContent,
    "Completed",
  );
  assert.equal(
    runs(f).length,
    4,
    "reopening details preserves the result without executing again",
  );
});

test("a running tool stays alive across Screen and Access navigation, retaining one request and its result", async (t) => {
  const f = await fixture(t);
  await navigate(f.root, "Tools");
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
  await click(f.root, "Open Gmail account");
  await ready;
  const request = runs(f)[0];
  assert.equal(
    f.root.querySelector(".atl-recovery"),
    null,
    "an in-progress first attempt is not presented as an interrupted run",
  );
  assert.match(
    f.root.querySelector(".atl-busy").textContent,
    /Wait before running another tool/,
  );
  assert.equal(button(f.root, "Run Open Walmart account").disabled, true);
  await navigate(f.root, "Screen");
  await navigate(f.root, "Access");
  await navigate(f.root, "Screen");
  assert.equal(request.signal.aborted, false);
  assert.match(
    f.root.querySelector(".aw-activity").textContent,
    /Running Open Gmail account/,
  );
  await click(f.root, "View in Tools");
  assert.equal(f.root.querySelector("#agent-section-tools").hidden, false);
  release();
  await dom.waitFor(
    () =>
      f.root.querySelector(".atl-result-heading h2")?.textContent ===
      "Completed",
  );
  assert.equal(runs(f).length, 1);
  await dom.waitFor(() => !f.root.querySelector(".aw-activity"));
  await navigate(f.root, "Screen");
  await navigate(f.root, "Tools");
  assert.match(
    [...runner(f.root).querySelectorAll("details")].find(
      (item) => item.querySelector("summary").textContent === "Tool details",
    ).textContent,
    new RegExp(request.body.requestId),
  );
});

test("creation clears a nonmatching search and exposes the new named tool and its definition without executing it", async (t) => {
  const f = await fixture(t);
  await navigate(f.root, "Tools");
  await replaceText(
    f.root.querySelector('[aria-label="Search tools"]'),
    "no matching tool",
  );
  await click(f.root, "Create deterministic tool");
  const editor = await dom.waitFor(() =>
    f.root.querySelector('[aria-label="Tool definition JSON"]'),
  );
  assert.match(
    f.root.querySelector(".atl-editor details").textContent,
    /builtin_open_gmail/,
  );
  await replaceText(
    editor,
    JSON.stringify(exampleTool("created_in_workspace")),
  );
  await click(f.root, "Save deterministic tool");
  await dom.waitFor(() => button(f.root, "Do example task"));
  assert.equal(f.root.querySelector('[aria-label="Search tools"]').value, "");
  assert.equal(runs(f).length, 0);
  await dom.waitFor(
    () =>
      f.root.querySelector("#ap-saved-tools").textContent.trim() === "Tools 10",
  );
  await dom.waitFor(() => dom.document.activeElement === runner(f.root));
  await click(f.root, "View definition");
  await dom.waitFor(() => f.root.querySelector(".atl-definition"));
  assert.match(
    f.root.querySelector(".atl-definition").textContent,
    /reach.tool.v1/,
  );
  assert.match(
    f.root.querySelector(".atl-definition").textContent,
    /created_in_workspace/,
  );
});

test("narrowing access while a tool awaits completion removes its controls and cannot show the old result", async (t) => {
  let change;
  function Parent(props) {
    const [access, setAccess] = React.useState(props.access);
    change = setAccess;
    return React.createElement(AgentPage, { ...props, access });
  }
  const f = await fixture(t, (props) => React.createElement(Parent, props));
  await navigate(f.root, "Tools");
  let entered, release;
  const ready = new Promise((resolve) => {
      entered = resolve;
    }),
    blocked = new Promise((resolve) => {
      release = resolve;
    });
  f.driver.before = async (_browser, request) => {
    if (request.op === "assert") {
      entered();
      await blocked;
    }
  };
  await click(f.root, "Open Gmail account");
  await ready;
  f.client.scopes = ["browser:read", "browser:screen"];
  dom.update(() =>
    change({
      ...f.access,
      preset: "readonly",
      presetName: "Read only",
      control: false,
      open: false,
    }),
  );
  await settle();
  assert.equal(
    button(f.root.querySelector('[aria-label="Workspace navigation"]'), "Tools")
      .disabled,
    true,
  );
  assert.equal(f.root.querySelector("#agent-section-tools"), null);
  assert.equal(runs(f)[0].signal.aborted, true);
  release();
  await settle(100);
  assert.equal(f.root.querySelector('[aria-label="Tool result"]'), null);
  assert.notEqual(
    f.root.querySelector(".atl-result-heading h2")?.textContent,
    "Completed",
  );
  assert.equal(!!f.root.querySelector(".aw-activity"), false);
});

test("More opens secondary resources, closes on navigation and Escape, and keeps technical details collapsed", async (t) => {
  const f = await fixture(t);
  const menu = f.root.querySelector(".aw-more");
  assert.equal(menu.open, false);
  menu.querySelector("summary").click();
  assert.equal(menu.open, true);
  await navigate(f.root, "Access");
  assert.equal(menu.open, false);
  assert.equal(f.root.querySelector("#agent-section-access").hidden, false);
  menu.querySelector("summary").click();
  menu.dispatchEvent(
    new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
  );
  assert.equal(menu.open, false);
  await navigate(f.root, "Tools");
  await click(f.root, "Inspect Find Gmail message");
  await replaceText(
    runner(f.root).querySelector('[aria-label="Find Gmail message: query"]'),
    "invoice",
  );
  await replaceText(
    f.root.querySelector('[aria-label="Search tools"]'),
    "Walmart",
  );
  assert.equal(
    runner(f.root).querySelector('[aria-label="Find Gmail message: query"]')
      .value,
    "invoice",
  );
  assert.match(
    runner(f.root).closest(".atl-card").textContent,
    /Selected tool/,
  );
  assert.equal(runner(f.root).querySelector("details").open, false);
  assert.equal(runs(f).length, 0);
});

test("owner setup errors stop before account navigation; checking status preserves the failure and Run retries with a fresh ID", async (t) => {
  const f = await fixture(t);
  f.driver.before = async () => {
    throw Object.assign(
      Error(
        "/Users/sample/Reach/scripts/native/tool-browser.js: execution error: Enable Allow JavaScript from Apple Events and macOS Automation",
      ),
      { code: "setup_required" },
    );
  };
  await click(f.root, "Open Walmart account");
  await dom.waitFor(
    () =>
      button(f.root, "Run Open Walmart account") &&
      !button(f.root, "Run Open Walmart account").disabled &&
      f.root.querySelector(".atl-result-heading h2")?.textContent ===
        "Needs the owner",
  );
  assert.match(
    f.root.querySelector('[role="alert"]').textContent,
    /Chrome needs setup by the owner/,
  );
  assert.doesNotMatch(
    f.root.textContent,
    /\/Users\/|tool-browser\.js|execution error/,
  );
  assert.equal(f.root.querySelector(".atl-recovery"), null);
  assert.equal(f.driver.counters.clicks, 0);
  assert.equal(f.driver.browsers.get("Chrome").length, 0);
  const details = [...runner(f.root).querySelectorAll("details")].find(
    (item) => item.querySelector("summary").textContent === "Tool details",
  );
  details.querySelector("summary").click();
  await click(f.root, "Check run status");
  assert.equal(runs(f).length, 1);
  assert.ok(
    f.calls.some(
      (call) =>
        call.route.includes("/tools/operations/") && call.method === "GET",
    ),
  );
  f.driver.before = null;
  assert.equal(
    runs(f).length,
    1,
    "fixing setup does not automatically run a task",
  );
  await click(f.root, "Run Open Walmart account");
  await dom.waitFor(
    () =>
      f.root.querySelector(".atl-result-heading h2")?.textContent ===
      "Completed",
  );
  assert.notEqual(runs(f)[0].body.requestId, runs(f)[1].body.requestId);
  f.driver.before = async () => {
    throw Error(
      "/Users/sample/Reach/scripts/native/tool-browser.js: execution error: Error: Error: (-2700)",
    );
  };
  // Keep the native error digits inside a legitimate Run ID to guard the
  // privacy assertion's scope.
  const runId = "5d0c49f3-8be0-421b-bd39-9270045718aa";
  t.mock.method(globalThis.crypto, "randomUUID", () => runId);
  await click(f.root, "Run Open Gmail account");
  await dom.waitFor(
    () =>
      f.root.querySelector(".atl-result-heading h2")?.textContent === "Stopped",
  );
  assert.equal(runs(f).at(-1).body.requestId, runId);
  assert.equal(runner(f.root).querySelector(".atl-raw code").textContent, runId);
  const error = f.root.querySelector('[role="alert"]').textContent;
  assert.match(error, /browser command failed/);
  assert.doesNotMatch(error, /2700/);
  assert.doesNotMatch(
    f.root.querySelector('[aria-label="Tool results"]').textContent,
    /2700/,
  );
  assert.doesNotMatch(
    f.root.textContent,
    /\/Users\/|tool-browser\.js|execution error|\(-2700\)/,
  );
});
