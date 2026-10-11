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
    toast() {},
    ...props,
  });
const panel = (view) => view.container.querySelector(".ag-embedded");

// One agent's panel inside its sheet on Agents & people.
test("same-name agents keep their own folders, requests and activity; a review names its session", async () => {
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
    mutate: () => reply({ ...approval(first.id), status: "executed" }),
  });
  const a = await render(element({ focus: first.id }));
  await dom.waitFor(() => /1 request/.test(panel(a)?.textContent || ""));
  assert.match(panel(a).textContent, /1 request waiting for you/);
  assert.match(panel(a).textContent, /Waiting to change\s*\/Users\/me\/Desktop/);
  assert.doesNotMatch(panel(a).textContent, /second-session-only|Project/);
  const b = await render(element({ focus: second.id }));
  await dom.waitFor(() => /second-session-only/.test(panel(b)?.textContent || ""));
  assert.match(panel(b).textContent, /Working in\s*\/Users\/me\/Project/);
  assert.doesNotMatch(panel(b).textContent, /waiting for you/);
  await click(button(panel(a), "Review"));
  assert.match(dom.document.body.textContent, /Allow Muse · 11111111 to use Notes/);
  await click(button(dom.document.body, "Allow for this session"));
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

test("the panel has no Stop, Edit or ends row of its own: the sheet's rows do that", async () => {
  mock({ agents: [session("one")] });
  const view = await render(element({ focus: "one" }));
  await dom.waitFor(() => panel(view)?.querySelector(".ag-facts"));
  for (const word of ["Stop", "Stop all", "Edit access", "Invite agent"])
    assert.equal(button(view.container, word), undefined, word);
  assert.doesNotMatch(panel(view).textContent, /Access ends|Search agents/);
});

test("switching computers drops the old computer's review and shows the new one's agent", async () => {
  let changePeer;
  mock({ agents: [session("old-session")], requests: [approval("old-session")] });
  function Host() {
    const [current, setPeer] = React.useState(peer);
    changePeer = setPeer;
    return element({ peer: current, focus: current.id === "mac" ? "old-session" : "new-session" });
  }
  const view = await render(React.createElement(Host));
  await dom.waitFor(() => button(view.container, "Review"));
  await click(button(view.container, "Review"));
  assert.ok(dom.document.querySelector(".browser-approval-review, [role=dialog], dialog[open]"));
  mock({ agents: [session("new-session", { folders: ["/Users/me/Other"] })] });
  dom.update(() =>
    changePeer({
      ...peer,
      id: "other",
      url: "https://other.tail.ts.net:8443",
      token: "different-owner",
    }),
  );
  await dom.waitFor(() => /\/Users\/me\/Other/.test(panel(view)?.textContent || ""));
  assert.doesNotMatch(dom.document.body.textContent, /Allow Muse/);
});

test("a failed refresh says so and disables the panel's actions", async () => {
  mock({ agents: [session("one", { preset: "full", policy: { ...session("one").policy, preset: "full" } })] });
  const view = await render(element({ focus: "one" }));
  await dom.waitFor(() => button(view.container, "Pause"));
  mock({ fail: true });
  await dom.waitFor(() => view.container.textContent.includes("Access list unavailable"), 5000);
  assert.equal(button(view.container, "Pause").disabled, true);
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
  // An agent's invitation opens on its one question, connecting with Tools.
  await dom.waitFor(() => view.container.querySelector('[aria-label="AI browser invitation"] [aria-label="Access preset"]'));
  const connects = [...view.container.querySelectorAll(".ivt-row")].find((r) => r.textContent.includes("Connects"));
  assert.equal(connects.querySelector(".ivt-menu-button").textContent, "Tools");
  assert.doesNotMatch(
    view.container.textContent,
    /Unrestricted command access/,
  );
});

test("a pending connection is reviewed from its panel, with its session code", async () => {
  const pending = session("pending-11111111", { status: "pending" });
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
  mock({ agents: [pending], admissions: [admission] });
  const view = await render(element({ focus: pending.id }));
  await dom.waitFor(() => button(view.container, "Review connection"));
  assert.match(panel(view).textContent, /Wants to connect\. Check its code, then approve/);
  await click(button(view.container, "Review connection"));
  const review = dom.document.querySelector(".agent-admission-review");
  assert.match(review.textContent, /11111111/);
  assert.match(review.textContent, /ABCD-1234/);
});

test("without a focus: only ended agents, newest first, each opening to what it could use", async () => {
  mock({
    agents: [
      session("aaaaaaaa1111", { name: "Muse" }),
      session("bbbbbbbb2222", { name: "Older", status: "revoked", expiresAt: Date.now() - 3600000 }),
      session("cccccccc3333", {
        name: "Researcher",
        status: "expired",
        expiresAt: Date.now() - 60000,
        folders: ["/Users/me/Notes"],
      }),
    ],
  });
  const view = await render(element());
  const c = view.container;
  await dom.waitFor(() => c.querySelector('[data-agent-id="cccccccc3333"]'));
  const names = [...c.querySelectorAll(".ag-agent-title strong")].map((e) => e.textContent);
  assert.deepEqual(names, ["Researcher", "Older"]);
  const researcher = c.querySelector('[data-agent-id="cccccccc3333"]');
  assert.match(researcher.querySelector(".ag-pill").textContent, /Expired/);
  assert.match(c.querySelector('[data-agent-id="bbbbbbbb2222"] .ag-pill').textContent, /Stopped/);
  assert.doesNotMatch(researcher.querySelector(".ag-agent-title small").textContent, /cccc3333/);
  assert.equal(researcher.querySelector(".ag-agent-body").hidden, true);
  await click(researcher.querySelector(".ag-agent-head"));
  assert.match(researcher.querySelector(".ag-facts").textContent, /\/Users\/me\/Notes/);
  assert.equal(button(researcher, "Pause"), undefined);
});

test("agent session UI emits no React warnings", () =>
  assert.deepEqual(dom.errors, []));
