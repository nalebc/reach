import test, { before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { startDom, settle } from "./dom/harness.mjs";

let dom,
  React,
  BrowserInvite,
  InviteSheet,
  BrowserWorkspace,
  BrowserApprovalReview,
  BrowserActionRequests,
  useBrowserApprovals,
  NeedsYouStrip;
const peer = {
  id: "mac",
  name: "My Mac",
  url: "https://mac.tail.ts.net:8443",
  token: "owner",
  platform: "darwin",
};
const device = { name: "My Mac", roots: [] };
const reply = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
const snapshot = () =>
  new Response(new Uint8Array([255, 216, 255, 217]), {
    headers: { "Content-Type": "image/jpeg" },
  });
const pending = (
  action = { type: "click", x: 0.25, y: 0.75, button: "left", count: 1 },
) => ({
  id: "request-1",
  clientId: "muse",
  name: "Muse",
  action,
  reason: "Inspect the project",
  status: "pending",
  createdAt: Date.now(),
  expiresAt: Date.now() + 60000,
});
before(async () => {
  dom = await startDom();
  React = dom.React;
  // jsdom has no native modal presentation.
  dom.window.HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  dom.window.HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  ({ default: BrowserInvite } = await dom.load("/src/BrowserInvite.tsx"));
  ({ InviteSheet } = await dom.load("/src/InviteSheet.tsx"));
  ({ default: BrowserWorkspace } = await dom.load("/src/BrowserWorkspace.tsx"));
  ({ BrowserApprovalReview, BrowserActionRequests, useBrowserApprovals } = await dom.load(
    "/src/browser-approvals.tsx",
  ));
  ({ NeedsYouStrip } = await dom.load("/src/NeedsYou.tsx"));
});
after(async () => dom?.close());
const activeViews = new Set();
const render = async (element) => {
  const view = await dom.render(element);
  const unmount = view.unmount;
  view.unmount = async () => {
    activeViews.delete(view);
    await unmount();
  };
  activeViews.add(view);
  return view;
};
afterEach(async () => {
  for (const view of activeViews) await view.unmount();
});
const button = (container, label) =>
  [...container.querySelectorAll("button")].find(
    (b) => b.textContent.trim() === label,
  );
const tab = (container, label) =>
  [...container.querySelectorAll('[role="tab"]')].find(
    (item) => item.textContent.trim() === label,
  );
const click = async (element) => {
  assert.ok(element);
  element.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  await settle(40);
};
const value = async (element, text) => {
  assert.ok(element);
  const prototype =
    element.tagName === "SELECT"
      ? dom.window.HTMLSelectElement.prototype
      : element.tagName === "TEXTAREA"
        ? dom.window.HTMLTextAreaElement.prototype
        : dom.window.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value").set.call(element, text);
  element.dispatchEvent(
    new dom.window.Event(element.tagName === "SELECT" ? "change" : "input", {
      bubbles: true,
    }),
  );
  await settle();
};
const submit = async (container) => {
  container
    .querySelector('form[aria-label="Request an action"]')
    .dispatchEvent(
      new dom.window.Event("submit", { bubbles: true, cancelable: true }),
    );
  await settle(40);
};

const loadSnapshot = async (container) => {
  const image = await dom.waitFor(() =>
    container.querySelector(".browser-approval-snapshot img"),
  );
  Object.defineProperties(image, {
    naturalWidth: { value: 1280, configurable: true },
    naturalHeight: { value: 720, configurable: true },
  });
  dom.update(() => image.dispatchEvent(new dom.window.Event("load")));
  await dom.waitFor(
    () => button(container, "Approve once")?.disabled === false,
  );
};

test("restricted terminal requires folders, disables screen control and creates a separate restricted grant", async () => {
  const calls = [];
  globalThis.fetch = dom.window.fetch = async (url, init = {}) => {
    const route = new URL(url).pathname;
    if (init.method === "POST") calls.push([route, JSON.parse(init.body)]);
    if (route === "/api/agents/browser-options")
      return reply({ terminals: [], screenAvailable: true });
    if (route === "/api/agents/browser-invitations")
      return reply({
        invitation: "b".repeat(43),
        url: `https://mac.tail.ts.net/agent-browser#invite=${"b".repeat(43)}`,
        clientId: "muse",
        expiresAt: Date.now() + 3600000,
        joinBy: Date.now() + 900000,
      });
    if (route === "/api/guests/key")
      return reply({
        key: "tskey-auth-kTEST123456-abcdef",
        hostname: "rg-ab12-k3m9x2p7qa",
      });
    return reply({});
  };
  const view = await render(
    React.createElement(BrowserInvite, {
      peer,
      device: { ...device, roots: [{ id: 0, name: "Projects", path: "/shared" }] },
      keyPeer: peer,
      onSetup() {},
      onCreated() {},
    }),
  );
  const c = view.container;
  assert.equal(button(c, "Create invite link").disabled, true);
  await value(c.querySelector('[aria-label="Screen permission"]'), "ask");
  assert.match(c.textContent, /Approve actions in any app, including Terminal/);
  await click(
    [...c.querySelectorAll("label")]
      .find((l) => l.textContent.includes("Run read-only commands"))
      .querySelector("input"),
  );
  assert.equal(button(c, "Create invite link").disabled, true, "a shared folder is required");
  assert.equal(c.querySelector('[aria-label="Screen permission"]').value, "view");
  assert.ok(![...c.querySelector('[aria-label="Screen permission"]').options].some((option) => option.value === "ask"));
  await click(c.querySelector('[aria-label="Share Projects"]'));
  assert.equal(button(c, "Create invite link").disabled, false);
  await click(button(c, "Create invite link"));
  await dom.waitFor(() =>
    calls.some(([route]) => route.endsWith("browser-invitations")),
  );
  assert.deepEqual(
    calls.find(([route]) => route.endsWith("browser-invitations"))[1],
    {
      name: "Assistant",
      transport: "funnel",
      ttlSeconds: 900,
      folders: [{ root: 0, path: "" }],
      terminalIds: [],
      screen: "view",
      restrictedTerminal: true,
    },
  );
  assert.match(c.textContent, /No sudo, deletion or file changes/);
  assert.match(c.textContent, /Screen control is off/);
  await view.unmount();
});

test("supervised browser submits inert exact inputs only as pending approval requests", async () => {
  const calls = [];
  let records = [];
  globalThis.fetch = dom.window.fetch = async (url, init = {}) => {
    const route = new URL(url).pathname;
    const method = init.method || "GET";
    const body = init.body && JSON.parse(init.body);
    calls.push([method, route, body]);
    if (route === "/api/browser")
      return reply({
        name: "Muse",
        expiresAt: Date.now() + 3600000,
        roots: [],
        terminals: [],
        screen: "ask",
        commandRequests: true,
      });
    if (route === "/api/browser/requests" && method === "POST") {
      const { reason, ...action } = body;
      const record = { ...pending(action), reason };
      records = [record];
      return reply(record);
    }
    if (route === "/api/browser/requests") return reply(records);
    if (route === "/api/browser/requests/request-1" && method === "DELETE")
      return reply({ ok: true });
    if (route === "/api/browser/screen") return snapshot();
    return reply({ error: "Unexpected request" }, 404);
  };
  const view = await render(
    React.createElement(BrowserWorkspace, { peer, onEnd() {} }),
  );
  const c = view.container;
  await dom.waitFor(() => c.querySelector('[aria-label="Requested action"]'));
  assert.equal(
    button(c, "Scroll down"),
    undefined,
    "ask permission cannot use automatic scrolling",
  );
  await value(c.querySelector('[aria-label="Requested action"]'), "text");
  const text = '<img src=x onerror="bad()">\nsecond line';
  await value(c.querySelector('[aria-label="Exact text"]'), text);
  await value(
    c.querySelector('[aria-label="Reason for request"]'),
    "Fill the visible editor",
  );
  await submit(c);
  await dom.waitFor(() =>
    c.querySelector('[role="log"]')?.textContent.includes("Waiting for owner"),
  );
  assert.deepEqual(
    calls.filter(([m]) => m === "POST"),
    [
      [
        "POST",
        "/api/browser/requests",
        { type: "text", text, reason: "Fill the visible editor" },
      ],
    ],
  );
  assert.match(
    c.querySelector('[role="log"]').textContent,
    /Waiting for owner/,
  );
  assert.equal(
    c.querySelectorAll('[role="log"] img, [role="log"] script').length,
    0,
  );
  assert.match(
    c.querySelector('[role="log"] pre').textContent,
    /\\nsecond line/,
  );
  await click(button(c, "Cancel request"));
  await dom.waitFor(() =>
    c.querySelector('[role="log"]')?.textContent.includes("cancelled"),
  );
  assert.match(c.querySelector('[role="log"]').textContent, /cancelled/);
  await view.unmount();
});

test("command-only browser has no screen actions or execution control", async () => {
  const writes = [];
  globalThis.fetch = dom.window.fetch = async (url, init = {}) => {
    const route = new URL(url).pathname;
    if (route === "/api/browser")
      return reply({
        name: "Muse",
        expiresAt: Date.now() + 3600000,
        roots: [],
        terminals: [],
        screen: "off",
        commandRequests: true,
      });
    if (init.method === "POST") {
      const { reason, ...action } = JSON.parse(init.body);
      writes.push([route, action, reason]);
      return reply({ ...pending(action), reason });
    }
    return reply([]);
  };
  const view = await render(
    React.createElement(BrowserWorkspace, { peer, onEnd() {} }),
  );
  const c = view.container;
  await dom.waitFor(() => c.querySelector('[aria-label="Requested action"]'));
  assert.equal(
    c.querySelector('[aria-label="Requested action"]').options.length,
    1,
  );
  await value(
    c.querySelector('[aria-label="Exact command"]'),
    "sudo apt update",
  );
  await value(
    c.querySelector('[aria-label="Reason for request"]'),
    "Refresh package lists",
  );
  await submit(c);
  await dom.waitFor(() => writes.length === 1);
  assert.deepEqual(writes, [
    [
      "/api/browser/requests",
      { type: "command", command: "sudo apt update" },
      "Refresh package lists",
    ],
  ]);
  assert.match(
    c.textContent,
    /never execute from this workspace, including sudo/,
  );
  assert.equal(button(c, "Run"), undefined);
  await view.unmount();
});

test("screen and terminal tabs preserve separate approval drafts and shared request history", async () => {
  const calls = [];
  const records = [];
  globalThis.fetch = dom.window.fetch = async (url, init = {}) => {
    const route = new URL(url).pathname;
    const method = init.method || "GET";
    calls.push([method, route]);
    if (route === "/api/browser")
      return reply({
        name: "Muse",
        expiresAt: Date.now() + 3600000,
        roots: [{ name: "Project", path: "/Project", index: 0 }],
        terminals: [],
        screen: "ask",
        commandRequests: true,
      });
    if (route === "/api/browser/screen") return snapshot();
    if (route === "/api/files") return reply({ items: [] });
    if (route === "/api/browser/requests" && method === "POST") {
      const { reason, ...action } = JSON.parse(init.body);
      const record = {
        ...pending(action),
        id: `request-${records.length + 1}`,
        reason,
      };
      records.push(record);
      return reply(record);
    }
    if (route === "/api/browser/requests") return reply(records);
    return reply({ error: "Unexpected request" }, 404);
  };
  const view = await render(
    React.createElement(BrowserWorkspace, { peer, onEnd() {} }),
  );
  const c = view.container;
  await dom.waitFor(() => c.querySelector('[aria-label="Requested action"]'));
  assert.deepEqual(
    [...c.querySelector('[aria-label="Requested action"]').options].map(
      (item) => item.value,
    ),
    ["click", "text", "key", "scroll"],
    "screen requests never offer commands",
  );
  await value(c.querySelector('[aria-label="Requested action"]'), "text");
  await value(
    c.querySelector('[aria-label="Exact text"]'),
    "Visible editor text",
  );
  await value(
    c.querySelector('[aria-label="Reason for request"]'),
    "Fill this editor",
  );
  await click(tab(c, "Terminal"));
  assert.equal(
    c.querySelector('[aria-label="Requested action"]').value,
    "command",
  );
  assert.equal(
    c.querySelector('[aria-label="Requested action"]').options.length,
    1,
  );
  assert.equal(c.querySelector('[aria-label="Exact command"]').value, "");
  assert.equal(c.querySelector('[aria-label="Reason for request"]').value, "");
  await value(
    c.querySelector('[aria-label="Exact command"]'),
    "sudo apt update",
  );
  await value(
    c.querySelector('[aria-label="Reason for request"]'),
    "Refresh package lists",
  );
  await click(tab(c, "Files"));
  assert.ok(
    c.querySelector('form[aria-label="Request an action"]').closest("[hidden]"),
  );
  await click(tab(c, "Screen"));
  assert.equal(
    c.querySelector('[aria-label="Requested action"]').value,
    "text",
  );
  assert.equal(
    c.querySelector('[aria-label="Exact text"]').value,
    "Visible editor text",
  );
  assert.equal(
    c.querySelector('[aria-label="Reason for request"]').value,
    "Fill this editor",
  );
  await submit(c);
  assert.equal(records.length, 1);
  assert.match(
    c.querySelector('[role="log"]').textContent,
    /Visible editor text/,
  );
  await click(tab(c, "Terminal"));
  assert.equal(
    c.querySelector('[aria-label="Exact command"]').value,
    "sudo apt update",
  );
  assert.equal(
    c.querySelector('[aria-label="Reason for request"]').value,
    "Refresh package lists",
  );
  assert.doesNotMatch(
    c.querySelector('[role="log"]').textContent,
    /Visible editor text/,
  );
  await submit(c);
  assert.equal(records.length, 2);
  assert.deepEqual(
    records.map((record) => record.action),
    [
      { type: "text", text: "Visible editor text" },
      { type: "command", command: "sudo apt update" },
    ],
  );
  assert.match(c.querySelector('[role="log"]').textContent, /sudo apt update/);
  await click(tab(c, "Screen"));
  assert.match(
    c.querySelector('[role="log"]').textContent,
    /Visible editor text/,
  );
  assert.doesNotMatch(
    c.querySelector('[role="log"]').textContent,
    /sudo apt update/,
  );
  assert.equal(
    calls.filter(
      ([method, route]) =>
        method === "GET" && route === "/api/browser/requests",
    ).length,
    1,
    "tab changes keep a single request-history poller",
  );
  assert.equal(
    calls.some(([, route]) => /\/exec|\/screen\/input/.test(route)),
    false,
  );
  await view.unmount();
});

test("owner reviews recorded target and grants exactly one screen action", async () => {
  const calls = [];
  let resolved = 0;
  globalThis.fetch = dom.window.fetch = async (url, init = {}) => {
    const route = new URL(url).pathname;
    calls.push([
      init.method || "GET",
      route,
      init.body && JSON.parse(init.body),
    ]);
    return route.endsWith("/screen")
      ? snapshot()
      : reply({ status: "completed" });
  };
  const view = await render(
    React.createElement(BrowserApprovalReview, {
      peer,
      item: pending(),
      onClose() {},
      onResolved() {
        resolved++;
      },
    }),
  );
  const c = view.container;
  assert.equal(
    c.querySelector('[aria-label="Exact input"]').textContent,
    "Click left button at x=0.25, y=0.75 (25% across, 75% down)",
  );
  await loadSnapshot(c);
  assert.equal(c.querySelector(".browser-click-marker").style.left, "25%");
  assert.match(
    c.textContent,
    /Screen actions can operate any app, including Terminal/,
  );
  assert.equal(calls.filter(([m]) => m !== "GET").length, 0);
  await click(button(c, "Approve once"));
  await dom.waitFor(() => resolved === 1);
  assert.deepEqual(
    calls.filter(([m]) => m === "POST"),
    [
      [
        "POST",
        "/api/agents/browser-requests/request-1",
        { decision: "approve" },
      ],
    ],
  );
  assert.equal(resolved, 1);
  await view.unmount();
});

test("a fetched snapshot cannot be approved before image decoding, and display failures leave Deny available", async () => {
  const writes = [];
  globalThis.fetch = dom.window.fetch = async (url, init = {}) => {
    if (init.method === "POST") {
      writes.push(JSON.parse(init.body));
      return reply({ status: "denied" });
    }
    return snapshot();
  };
  const view = await render(
    React.createElement(BrowserApprovalReview, {
      peer,
      item: pending(),
      onClose() {},
      onResolved() {},
    }),
  );
  const c = view.container;
  const image = await dom.waitFor(() =>
    c.querySelector(".browser-approval-snapshot img"),
  );
  assert.ok(image, "the successful fetch has created an image URL");
  assert.equal(button(c, "Approve once").disabled, true);
  assert.equal(c.querySelector(".browser-click-marker"), null);
  await click(button(c, "Approve once"));
  assert.deepEqual(writes, []);
  dom.update(() => image.dispatchEvent(new dom.window.Event("load")));
  assert.equal(
    button(c, "Approve once").disabled,
    true,
    "a load event with zero image dimensions is insufficient",
  );
  await loadSnapshot(c);
  assert.equal(button(c, "Approve once").disabled, false);
  assert.ok(c.querySelector(".browser-click-marker"));
  dom.update(() => image.dispatchEvent(new dom.window.Event("error")));
  await dom.waitFor(() =>
    c
      .querySelector('[role="alert"]')
      ?.textContent.includes("snapshot could not be displayed"),
  );
  assert.equal(button(c, "Approve once").disabled, true);
  assert.equal(c.querySelector(".browser-click-marker"), null);
  assert.match(
    c.querySelector('[role="alert"]').textContent,
    /snapshot could not be displayed/,
  );
  assert.equal(button(c, "Deny").disabled, false);
  await click(button(c, "Deny"));
  await dom.waitFor(() => writes.length === 1);
  assert.deepEqual(writes, [{ decision: "deny" }]);
  await view.unmount();
});

test("changing the peer resets snapshot approval readiness until its new image loads", async () => {
  let changePeer;
  function Review() {
    const [currentPeer, setPeer] = React.useState(peer);
    changePeer = setPeer;
    return React.createElement(BrowserApprovalReview, {
      peer: currentPeer,
      item: pending(),
      onClose() {},
      onResolved() {},
    });
  }
  globalThis.fetch = dom.window.fetch = async () => snapshot();
  const view = await render(React.createElement(Review));
  const c = view.container;
  await loadSnapshot(c);
  assert.equal(button(c, "Approve once").disabled, false);
  const previousImage = c.querySelector(".browser-approval-snapshot img");
  dom.update(() => changePeer({ ...peer, token: "new-owner-session" }));
  await dom.waitFor(() => {
    const nextImage = c.querySelector(".browser-approval-snapshot img");
    return nextImage && nextImage.src !== previousImage.src;
  });
  assert.equal(button(c, "Approve once").disabled, true);
  assert.equal(c.querySelector(".browser-click-marker"), null);
  assert.notEqual(
    c.querySelector(".browser-approval-snapshot img").src,
    previousImage.src,
  );
  dom.update(() => previousImage.dispatchEvent(new dom.window.Event("load")));
  assert.equal(
    button(c, "Approve once").disabled,
    true,
    "a stale image load cannot approve the replacement snapshot",
  );
  await loadSnapshot(c);
  assert.equal(button(c, "Approve once").disabled, false);
  await view.unmount();
});

test("owner manual command review preserves exact command and cannot execute it", async () => {
  const calls = [];
  const command = "sudo sh -c 'echo test'\n<img src=x onerror=bad()>";
  globalThis.fetch = dom.window.fetch = async (url, init = {}) => {
    calls.push([
      init.method || "GET",
      new URL(url).pathname,
      init.body && JSON.parse(init.body),
    ]);
    return reply({ status: "handled" });
  };
  const view = await render(
    React.createElement(BrowserApprovalReview, {
      peer,
      item: pending({ type: "command", command }),
      onClose() {},
      onResolved() {},
    }),
  );
  const c = view.container;
  assert.equal(
    c.querySelector('[aria-label="Requested command"]').textContent,
    JSON.stringify(command),
  );
  assert.equal(c.querySelectorAll("pre img").length, 0);
  assert.equal(button(c, "Approve once"), undefined);
  assert.match(c.textContent, /does not execute anything/);
  assert.equal(calls.length, 0);
  await click(button(c, "Mark handled"));
  await dom.waitFor(() => calls.some(([method]) => method === "POST"));
  assert.deepEqual(calls, [
    ["POST", "/api/agents/browser-requests/request-1", { decision: "handled" }],
  ]);
  await view.unmount();
});

test("expired requests and unavailable snapshots cannot be approved", async () => {
  const calls = [];
  globalThis.fetch = dom.window.fetch = async (url, init = {}) => {
    calls.push(init.method || "GET");
    return reply({ error: "Unavailable" }, 404);
  };
  let view = await render(
    React.createElement(BrowserApprovalReview, {
      peer,
      item: pending(),
      onClose() {},
      onResolved() {},
    }),
  );
  await dom.waitFor(() => view.container.querySelector('[role="alert"]'));
  assert.equal(button(view.container, "Approve once").disabled, true);
  assert.match(
    view.container.querySelector('[role="alert"]').textContent,
    /snapshot could not be loaded/,
  );
  await view.unmount();
  view = await render(
    React.createElement(BrowserApprovalReview, {
      peer,
      item: {
        ...pending({ type: "command", command: "whoami" }),
        expiresAt: Date.now() - 1,
      },
      onClose() {},
      onResolved() {},
    }),
  );
  assert.equal(button(view.container, "Mark handled").disabled, true);
  assert.equal(button(view.container, "Deny").disabled, true);
  assert.ok(calls.every((m) => m === "GET"));
  await view.unmount();
});

test("Needs you shows browser prompts only for the owner and opens exact review", async () => {
  const calls = [];
  globalThis.fetch = dom.window.fetch = async (url, init = {}) => {
    const route = new URL(url).pathname;
    calls.push([init.method || "GET", route]);
    if (route.endsWith("/screen")) return snapshot();
    return reply([
      pending(),
      { ...pending(), id: "expired", expiresAt: Date.now() - 1 },
      { ...pending(), id: "done", status: "completed" },
    ]);
  };
  function Prompts({ enabled }) {
    const approvals = useBrowserApprovals(
      peer,
      enabled,
      JSON.stringify({ browserRequests: "one" }),
    );
    return React.createElement(
      React.Fragment,
      null,
      React.createElement(NeedsYouStrip, { items: approvals.items }),
      approvals.review,
    );
  }
  let view = await render(React.createElement(Prompts, { enabled: false }));
  assert.equal(calls.length, 0);
  await view.unmount();
  view = await render(React.createElement(Prompts, { enabled: true }));
  await dom.waitFor(
    () => view.container.querySelectorAll(".need-card").length === 1,
  );
  assert.equal(view.container.querySelectorAll(".need-card").length, 1);
  assert.match(view.container.textContent, /Muse needs your approval/);
  assert.equal(button(view.container, "Approve once"), undefined);
  await click(button(view.container, "Review request"));
  await dom.waitFor(() =>
    view.container.querySelector('[aria-label="Exact input"]'),
  );
  assert.ok(view.container.querySelector('[aria-label="Exact input"]'));
  assert.ok(button(view.container, "Approve once"));
  assert.ok(calls.every(([m]) => m === "GET"));
  await view.unmount();
});

test("control characters cannot hide the reviewed command and a failed approval stays visible", async () => {
  const command = "echo safe\n\u202etouch important\u2069";
  globalThis.fetch = dom.window.fetch = async () =>
    reply({ status: "handled" });
  let view = await render(
    React.createElement(BrowserApprovalReview, {
      peer,
      item: pending({ type: "command", command }),
      onClose() {},
      onResolved() {},
    }),
  );
  const quoted = view.container.querySelector(
    '[aria-label="Requested command"]',
  ).textContent;
  assert.ok(quoted.includes(String.raw`\n\u202e`));
  assert.ok(quoted.includes(String.raw`\u2069`));
  assert.ok(!quoted.includes("\u202e"));
  await view.unmount();
  let resolved = 0;
  globalThis.fetch = dom.window.fetch = async (url) =>
    new URL(url).pathname.endsWith("/screen")
      ? snapshot()
      : reply({
          status: "failed",
          error: "The screen changed. Send a fresh request.",
        });
  view = await render(
    React.createElement(BrowserApprovalReview, {
      peer,
      item: pending(),
      onClose() {},
      onResolved() {
        resolved++;
      },
    }),
  );
  await loadSnapshot(view.container);
  await click(button(view.container, "Approve once"));
  await dom.waitFor(() =>
    view.container
      .querySelector('[role="alert"]')
      ?.textContent.includes("screen changed"),
  );
  assert.equal(resolved, 0);
  assert.match(
    view.container.querySelector('[role="alert"]').textContent,
    /screen changed/,
  );
  assert.equal(button(view.container, "Approve once").disabled, true);
  await view.unmount();
});

test("Invite someone exposes the AI browser flow without a generic access upgrade", async () => {
  globalThis.fetch = dom.window.fetch = async (url) => {
    const route = new URL(url).pathname;
    if (route === "/api/clients")
      return reply({
        clients: [
          {
            id: "muse",
            name: "Muse",
            kind: "agent",
            policy: { invite: true, browser: { screen: "ask" } },
            scopes: ["device", "browser:read"],
            expiresAt: Date.now() + 3600000,
            status: "accepted",
          },
        ],
      });
    if (route === "/api/guests/keys")
      return reply({ configured: true, policy: {} });
    if (route === "/api/agents/browser-options")
      return reply({ terminals: [], screenAvailable: true });
    return reply({});
  };
  const host = {
    ...device,
    platform: "darwin",
    capabilities: {
      files: true,
      terminal: true,
      apps: true,
      screen: true,
      screenSupported: true,
      codex: true,
    },
    network: { connected: true, peers: [] },
  };
  const view = await render(
    React.createElement(InviteSheet, { peer, device: host }),
  );
  const c = view.container;
  const row = await dom.waitFor(() =>
    [...c.querySelectorAll(".ivt-person")].find((r) =>
      r.textContent.includes("Muse"),
    ),
  );
  assert.ok(row);
  assert.match(row.textContent, /AI browser · scoped access/);
  assert.equal(
    row.querySelector(".ivt-menu-button"),
    null,
    "cannot convert a browser grant into full or command access",
  );
  await click(button(c, "Agent"));
  await dom.waitFor(() =>
    c.querySelector('[aria-label="AI browser invitation"]'),
  );
  await dom.waitFor(() =>
    [
      ...(c.querySelector('[aria-label="Screen permission"]')?.options || []),
    ].some((option) => option.value === "ask"),
  );
  assert.ok(c.querySelector('[aria-label="AI browser invitation"]'));
  assert.equal(c.querySelector('input[aria-label="Name"]'), null);
  assert.ok(
    [...c.querySelector('[aria-label="Screen permission"]').options].some(
      (option) => option.value === "ask",
    ),
  );
  await view.unmount();
});

test("approval surfaces render without React warnings", () =>
  assert.deepEqual(dom.errors, []));

test("restricted terminal review shows the exact folder and runs only after an explicit owner decision", async () => {
  const calls = [];
  globalThis.fetch = dom.window.fetch = async (url, init = {}) => {
    calls.push([init.method || "GET", new URL(url).pathname, init.body && JSON.parse(init.body)]);
    return reply({ status: "executed", output: "notes.txt" });
  };
  const view = await render(React.createElement(BrowserApprovalReview, {
    peer,
    item: { ...pending({ type: "terminal", command: "ls", root: 0 }), folder: "/shared/project" },
    onClose() {}, onResolved() {},
  }));
  const c = view.container;
  assert.equal(c.querySelector('[aria-label="Command folder"]').textContent, '"/shared/project"');
  assert.equal(c.querySelector('[aria-label="Requested command"]').textContent, '"ls"');
  assert.match(c.textContent, /read-only command allowlist/);
  assert.equal(calls.length, 0, "no capture or command before approval");
  assert.equal(button(c, "Mark handled"), undefined);
  await click(button(c, "Approve and run once"));
  assert.deepEqual(calls, [["POST", "/api/agents/browser-requests/request-1", { decision: "approve" }]]);
  await view.unmount();
});

test("assistant submits a restricted command with the selected root and sees inert output in terminal history", async () => {
  const calls = [];
  const records = [{ ...pending({ type: "terminal", command: "ls", root: 1 }), status: "executed", output: "<script>not executable</script>" }];
  globalThis.fetch = dom.window.fetch = async (url, init = {}) => {
    const route = new URL(url).pathname;
    const method = init.method || "GET";
    if (route === "/api/browser") return reply({
      name: "My Mac", expiresAt: Date.now() + 3600000,
      roots: [{ index: 0, name: "Project", path: "/shared/project" }, { index: 1, name: "Notes", path: "/shared/notes" }],
      terminals: [], screen: "off", restrictedTerminal: true,
    });
    if (route === "/api/files") return reply({ items: [] });
    if (route === "/api/browser/requests" && method === "POST") {
      const { reason, ...action } = JSON.parse(init.body);
      calls.push({ ...action, reason });
      const created = { ...pending(action), id: "new-request", reason };
      records.unshift(created);
      return reply(created);
    }
    if (route === "/api/browser/requests") return reply(records);
    return reply({ error: "Unexpected request" }, 404);
  };
  const view = await render(React.createElement(BrowserWorkspace, { peer, onEnd() {} }));
  const c = view.container;
  await click(tab(c, "Terminal"));
  await value(c.querySelector('[aria-label="Command folder"]'), "1");
  await value(c.querySelector('[aria-label="Exact command"]'), "head -n 5 notes.txt");
  await value(c.querySelector('[aria-label="Reason for request"]'), "Read the beginning of the notes");
  await click(button(c, "Request owner approval"));
  assert.deepEqual(calls, [{ type: "terminal", command: "head -n 5 notes.txt", root: 1, reason: "Read the beginning of the notes" }]);
  assert.equal(c.querySelector('[aria-label="Command output"]').textContent, "<script>not executable</script>");
  assert.equal(c.querySelector('[aria-label="Command output"] script'), null);
  assert.match(c.querySelector('[aria-label="Action request history"]').textContent, /Waiting for owner/);
  assert.deepEqual(dom.errors, []);
  await view.unmount();
});

test("approved cd updates subsequent commands but denied cd does not", async () => {
  const writes = [];
  const records = [
    { ...pending({ type: "terminal", command: "cd elsewhere", root: 0 }), id: "denied-cd", status: "denied" },
    { ...pending({ type: "terminal", command: "cd nested", root: 0 }), id: "approved-cd", status: "executed", directory: "nested", completedAt: Date.now() },
  ];
  globalThis.fetch = dom.window.fetch = async (_url, init = {}) => {
    if (init.method === "POST") {
      const { reason, ...action } = JSON.parse(init.body);
      writes.push({ ...action, reason });
      return reply({ ...pending(action), id: "read-request", reason });
    }
    return reply(records);
  };
  const view = await render(React.createElement(BrowserActionRequests, {
    peer, screen: false, commands: true, restrictedTerminal: true,
    roots: [{ name: "Project", index: 0, path: "/shared/project" }], onError: assert.fail,
  }));
  await settle(60);
  assert.match(view.container.querySelector('[aria-label="Working folder"]').textContent, /\/nested$/);
  await value(view.container.querySelector('[aria-label="Exact command"]'), "cat notes.txt");
  await value(view.container.querySelector('[aria-label="Reason for request"]'), "Read notes");
  await click(button(view.container, "Request owner approval"));
  assert.deepEqual(writes, [{ type: "terminal", command: "cat notes.txt", root: 0, cwd: "nested", reason: "Read notes" }]);
  await view.unmount();
});
