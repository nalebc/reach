import test, { before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { startDom, settle } from "./dom/harness.mjs";

let dom, React, BrowserAgents, InviteSheet;
const peer = {
  id: "mac",
  name: "My Mac",
  url: "https://mac.tail.ts.net:8443",
  token: "owner",
  platform: "darwin",
};
const device = {
  name: "My Mac",
  roots: [{ id: 0, path: "/Users/me", name: "Home" }],
  capabilities: { screen: true },
};
const reply = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
const session = (id, overrides = {}) => ({
  id,
  name: "Muse",
  kind: "agent",
  status: "accepted",
  createdAt: Date.now() - 60000,
  expiresAt: Date.now() + 900000,
  folders: ["/Users/me/Desktop"],
  pendingApprovals: 0,
  activity: { state: "idle" },
  scopes: ["device", "browser:read", "browser:request"],
  policy: {
    invite: true,
    browser: true,
    roots: ["/Users/me/Desktop"],
    restrictedTerminal: true,
    terminalApproval: true,
    screen: "off",
  },
  ...overrides,
});
const approval = (clientId, id = `request-${clientId}`, overrides = {}) => ({
  id,
  clientId,
  name: "Muse",
  createdAt: Date.now(),
  expiresAt: Date.now() + 60000,
  sessionExpiresAt: Date.now() + 900000,
  reason: "",
  status: "pending",
  action: {
    type: "app-access",
    appId: "notes",
    appName: "Notes",
    mode: "view",
  },
  ...overrides,
});
const button = (root, text) =>
  [...root.querySelectorAll("button")].find(
    (entry) => entry.textContent.trim() === text,
  );
const click = async (element) => {
  assert.ok(element);
  element.click();
  await settle(30);
};
const views = new Set();
const render = async (element) => {
  const view = await dom.render(element);
  views.add(view);
  return view;
};
before(async () => {
  dom = await startDom();
  React = dom.React;
  dom.window.HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  dom.window.HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  ({ default: BrowserAgents } = await dom.load("/src/BrowserAgents.tsx"));
  ({ InviteSheet } = await dom.load("/src/InviteSheet.tsx"));
});
afterEach(async () => {
  for (const view of views) await view.unmount();
  views.clear();
});
after(async () => dom?.close());
function mock({
  agents = [],
  requests = [],
  history = [],
  admissions = [],
  mutate,
  fail,
} = {}) {
  const calls = [];
  globalThis.fetch = dom.window.fetch = async (url, init = {}) => {
    const route = new URL(url).pathname;
    calls.push({
      route,
      method: init.method || "GET",
      body: init.body && JSON.parse(init.body),
      host: new URL(url).hostname,
    });
    if (init.method === "POST")
      return (
        mutate?.(route, JSON.parse(init.body), init) ||
        reply({ stopped: JSON.parse(init.body).clientIds })
      );
    if (fail && route === "/api/browser/agents")
      return reply({ error: "Access list unavailable" }, 503);
    if (route === "/api/browser/agents")
      return reply({
        agents: typeof agents === "function" ? agents() : agents,
        at: Date.now(),
      });
    if (route === "/api/agents/browser-requests") return reply(requests);
    if (route === "/api/agents/browser-terminal-history") return reply(history);
    if (route === "/api/agents/admissions") return reply(admissions);
    return reply({}, 404);
  };
  return calls;
}
const element = (props = {}) =>
  React.createElement(BrowserAgents, {
    peer,
    device,
    invite() {},
    toast() {},
    ...props,
  });

test("same-name agents retain distinct sessions, folders, queue status and approval attribution", async () => {
  const first = session("session-11111111", {
    pendingApprovals: 1,
    activity: { state: "waiting", folder: "/Users/me/Desktop" },
  });
  const second = session("session-22222222", {
    folders: ["/Users/me/Project"],
    activity: { state: "running", folder: "/Users/me/Project" },
  });
  const calls = mock({
    agents: [first, second],
    requests: [approval(first.id)],
    history: [
      approval(second.id, "command-second", {
        status: "executed",
        action: { type: "terminal", command: "ls", root: 0 },
        output: "second-session-only",
      }),
    ],
    mutate: (route) => reply({ ...approval(first.id), status: "executed" }),
  });
  const view = await render(element());
  await dom.waitFor(
    () => view.container.querySelectorAll(".ba-session").length === 2,
  );
  const a = view.container.querySelector('[data-agent-id="session-11111111"]');
  const b = view.container.querySelector('[data-agent-id="session-22222222"]');
  assert.match(a.textContent, / · 11111111/);
  assert.match(b.textContent, / · 22222222/);
  assert.match(a.textContent, /Waiting for folder/);
  assert.match(b.textContent, /Working/);
  assert.match(a.textContent, /1 request waiting for you/);
  assert.doesNotMatch(b.textContent, /waiting for you/);
  assert.doesNotMatch(a.textContent, /second-session-only/);
  assert.match(b.textContent, /second-session-only/);
  await click(button(a, "Review"));
  assert.match(
    view.container.textContent,
    /Allow Muse · 11111111 to use Notes/,
  );
  await click(button(view.container, "Allow for this session"));
  assert.deepEqual(
    calls
      .filter((call) => call.method === "POST")
      .map(({ route, body }) => ({ route, body })),
    [
      {
        route: "/api/agents/browser-requests/request-session-11111111",
        body: { decision: "approve" },
      },
    ],
  );
});

test("Stop all freezes displayed session IDs and never includes a later invitation", async () => {
  let agents = [session("old-one"), session("old-two")];
  const calls = mock({ agents: () => agents });
  const view = await render(element());
  await dom.waitFor(
    () => view.container.querySelectorAll(".ba-session").length === 2,
  );
  await click(button(view.container, "Stop all"));
  agents = [...agents, session("new-three")];
  await click(
    view.container.querySelector('[aria-label="Refresh agent sessions"]'),
  );
  await dom.waitFor(
    () => view.container.querySelectorAll(".ba-session").length === 3,
  );
  assert.doesNotMatch(
    view.container.querySelector(".ba-stop-confirm").textContent,
    /new-three/,
  );
  await click(button(view.container, "Stop these sessions"));
  assert.deepEqual(
    calls
      .filter((call) => call.method === "POST")
      .map(({ route, body }) => ({ route, body })),
    [
      {
        route: "/api/browser/agents/stop",
        body: { clientIds: ["old-one", "old-two"] },
      },
    ],
  );
  assert.match(
    view.container.querySelector('[data-agent-id="new-three"]').textContent,
    /Ready/,
  );
  assert.equal(
    button(view.container.querySelector('[data-agent-id="old-one"]'), "Stop"),
    undefined,
  );
});

test("individual stop sends only its ID and failure keeps access visible for retry", async () => {
  const notices = [];
  const calls = mock({
    agents: [session("one"), session("two")],
    mutate: () => reply({ error: "Could not stop this session" }, 503),
  });
  const view = await render(
    element({ toast: (message) => notices.push(message) }),
  );
  await dom.waitFor(
    () => view.container.querySelectorAll(".ba-session").length === 2,
  );
  await click(
    button(view.container.querySelector('[data-agent-id="two"]'), "Stop"),
  );
  assert.deepEqual(calls.find((call) => call.method === "POST").body, {
    clientIds: ["two"],
  });
  assert.match(view.container.textContent, /Could not stop this session/);
  assert.equal(
    button(view.container.querySelector('[data-agent-id="two"]'), "Stop")
      .disabled,
    false,
  );
  assert.deepEqual(notices, []);
});

test("switching computers aborts pending mutations and removes captured stop IDs and dialogs", async () => {
  let release, stopSignal, changePeer;
  const calls = mock({
    agents: [session("old-session")],
    mutate: (_route, _body, init) => {
      stopSignal = init.signal;
      return new Promise((resolve) => {
        release = () => resolve(reply({ stopped: ["old-session"] }));
      });
    },
  });
  const notices = [];
  function Host() {
    const [current, setPeer] = React.useState(peer);
    changePeer = setPeer;
    return element({
      peer: current,
      toast: (message) => notices.push(message),
    });
  }
  const view = await render(React.createElement(Host));
  await dom.waitFor(() => view.container.querySelector(".ba-session"));
  await click(button(view.container, "Stop all"));
  await click(button(view.container, "Stop these sessions"));
  assert.ok(release);
  mock({ agents: [session("new-session")] });
  dom.update(() =>
    changePeer({
      ...peer,
      id: "other",
      url: "https://other.tail.ts.net:8443",
      token: "different-owner",
    }),
  );
  await dom.waitFor(() =>
    view.container.querySelector('[data-agent-id="new-session"]'),
  );
  assert.equal(stopSignal.aborted, true);
  assert.equal(view.container.querySelector(".ba-stop-confirm"), null);
  release();
  await settle(50);
  assert.deepEqual(notices, []);
  assert.match(
    view.container.querySelector('[data-agent-id="new-session"]').textContent,
    /Ready/,
  );
  assert.equal(calls.filter((call) => call.method === "POST").length, 1);
});

test("failed session refresh disables stale stop controls and cannot present an empty success", async () => {
  mock({ agents: [session("one")] });
  const view = await render(element());
  await dom.waitFor(() => view.container.querySelector(".ba-session"));
  mock({ fail: true });
  await click(
    view.container.querySelector('[aria-label="Refresh agent sessions"]'),
  );
  await dom.waitFor(() =>
    view.container.textContent.includes("Access list unavailable"),
  );
  assert.equal(button(view.container, "Stop all").disabled, true);
  assert.equal(button(view.container, "Stop").disabled, true);
  assert.doesNotMatch(view.container.textContent, /No agent invitations/);
});

test("agent invite preselection opens browser permissions without advanced MCP access", async () => {
  globalThis.fetch = dom.window.fetch = async (url) => {
    const route = new URL(url).pathname;
    if (route === "/api/agents/browser-options")
      return reply({
        terminals: [],
        screenAvailable: true,
        appAccessAvailable: true,
        apps: [],
      });
    if (route === "/api/clients")
      return reply({ clients: [], current: "owner" });
    if (route === "/api/guests/setup") return reply({ keyed: true });
    return reply({});
  };
  const view = await render(
    React.createElement(InviteSheet, { peer, device, initialKind: "browser" }),
  );
  await dom.waitFor(() =>
    view.container.querySelector('[aria-label="Assistant connection"]'),
  );
  assert.equal(
    view.container.querySelector('[aria-label="Assistant connection"] [aria-pressed="true"]').textContent,
    "Browser link",
  );
  await dom.waitFor(() => view.container.querySelector('[aria-label="Access preset"]'));
  assert.doesNotMatch(
    view.container.textContent,
    /Unrestricted command access/,
  );
});

test("pending and approved connections remain stoppable and connection review targets its session", async () => {
  const pending = session("pending-11111111", { status: "pending" });
  const connecting = session("approved-22222222", { status: "approved" });
  const denied = session("denied-33333333", { status: "denied" });
  const admission = {
    requestId: "join-one",
    clientId: pending.id,
    name: "Muse",
    scopes: ["browser:read"],
    roots: pending.folders,
    browser: true,
    screen: "off",
    requestedAt: Date.now(),
    expiresAt: Date.now() + 60000,
    accessExpiresAt: pending.expiresAt,
    verificationCode: "ABCD-1234",
  };
  const calls = mock({
    agents: [pending, connecting, denied],
    admissions: [admission],
  });
  const view = await render(element());
  await dom.waitFor(
    () => view.container.querySelectorAll(".ba-session").length === 3,
  );
  const card = view.container.querySelector(
    '[data-agent-id="pending-11111111"]',
  );
  assert.match(card.textContent, /Wants to connect\. Check its code, then approve/);
  assert.match(
    view.container.querySelector('[data-agent-id="approved-22222222"]')
      .textContent,
    /Connecting/,
  );
  assert.match(
    view.container.querySelector('[data-agent-id="denied-33333333"]')
      .textContent,
    /Connection denied/,
  );
  assert.ok(button(card, "Stop"));
  await click(button(card, "Review connection"));
  assert.match(
    view.container.querySelector(".agent-admission-review").textContent,
    /11111111/,
  );
  assert.match(
    view.container.querySelector(".agent-admission-review").textContent,
    /ABCD-1234/,
  );
  await click(
    view.container.querySelector(
      '.agent-admission-review [aria-label="Close panel"]',
    ),
  );
  await click(button(view.container, "Stop all"));
  await click(button(view.container, "Stop these sessions"));
  assert.deepEqual(calls.find((call) => call.method === "POST").body, {
    clientIds: [pending.id, connecting.id],
  });
});

test("agents: active and ended groups, search by name, folder or app, and rows open in place", async () => {
  mock({
    agents: [
      session("aaaaaaaa1111", { name: "Muse" }),
      session("bbbbbbbb2222", {
        name: "Researcher",
        folders: ["/Users/me/Notes"],
        policy: { invite: true, browser: true, roots: ["/Users/me/Notes"], screen: "apps", appAccess: [{ id: "/Applications/Safari.app", name: "Safari", mode: "view" }] },
      }),
      session("cccccccc3333", { name: "Old helper", status: "revoked", expiresAt: Date.now() - 60000 }),
    ],
    requests: [approval("aaaaaaaa1111")],
  });
  const view = await render(element());
  const c = view.container;
  await dom.waitFor(() => c.querySelector('[data-agent-id="cccccccc3333"]'));
  const names = (root) => [...root.querySelectorAll(".ag-agent-title strong")].map((e) => e.textContent);
  const [activeGroup, endedGroup] = c.querySelectorAll(".ag-group");
  assert.deepEqual(names(activeGroup), ["Muse", "Researcher"]);
  assert.deepEqual(names(endedGroup), ["Old helper"]);
  assert.equal(endedGroup.open, false, "ended agents stay folded while some are active");
  assert.match(c.querySelector(".ag-agents-head").textContent, /2 active · 1 needs you/);
  // The agent that needs you opens by itself; the other stays a single row.
  const muse = c.querySelector('[data-agent-id="aaaaaaaa1111"]');
  const researcher = c.querySelector('[data-agent-id="bbbbbbbb2222"]');
  assert.equal(muse.querySelector(".ag-agent-head").getAttribute("aria-expanded"), "true");
  assert.equal(researcher.querySelector(".ag-agent-body").hidden, true);
  assert.equal(muse.querySelector(".ag-count").textContent, "1");
  await click(researcher.querySelector(".ag-agent-head"));
  assert.equal(researcher.querySelector(".ag-agent-body").hidden, false);
  assert.match(researcher.querySelector(".ag-facts").textContent, /Safari/);
  const search = c.querySelector('[aria-label="Search agents"]');
  const type = async (text) => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value").set.call(search, text);
    search.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    await settle(30);
  };
  await type("safari");
  assert.deepEqual(names(c), ["Researcher"], "finds an agent by an app it can see");
  await type("notes");
  assert.deepEqual(names(c), ["Researcher"], "and by a folder");
  await type("old");
  assert.deepEqual(names(c), ["Old helper"]);
  assert.equal(c.querySelector(".ag-ended").open, true, "a search opens ended matches");
  await type("nobody");
  assert.match(c.textContent, /No agent matches “nobody”/);
});

test("agent session UI emits no React warnings", () =>
  assert.deepEqual(dom.errors, []));
