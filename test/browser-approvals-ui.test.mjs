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
  if (element.getAttribute("role") === "radiogroup") return click([...element.querySelectorAll('[role="radio"]')].find(option => option.dataset.value === text));
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

const loadSnapshot = async (container, approvalLabel = "Approve once") => {
  const image = await dom.waitFor(() =>
    container.querySelector(".browser-approval-snapshot img"),
  );
  Object.defineProperties(image, {
    naturalWidth: { value: 1280, configurable: true },
    naturalHeight: { value: 720, configurable: true },
  });
  dom.update(() => image.dispatchEvent(new dom.window.Event("load")));
  await dom.waitFor(
    () => button(container, approvalLabel)?.disabled === false,
  );
};

test("supervised browser stages direct screen input only as a pending exact batch", async () => {
  const calls = [];
  let records = [];
  globalThis.fetch = dom.window.fetch = async (url, init = {}) => {
    const route = new URL(url).pathname;
    const method = init.method || "GET";
    const body = init.body && JSON.parse(init.body);
    calls.push([method, route, body]);
    if (route === "/api/browser")
      return reply({ name: "Muse", expiresAt: Date.now() + 3600000, roots: [], terminals: [], screen: "ask", commandRequests: true });
    if (route === "/api/browser/requests" && method === "POST") {
      const { reason, ...action } = body;
      const record = { ...pending(action), reason };
      records = [record]; return reply(record);
    }
    if (route === "/api/browser/requests") return reply(records);
    if (route === "/api/browser/requests/request-1" && method === "DELETE") return reply({ status: "cancelled" });
    if (route === "/api/browser/screen") return snapshot();
    return reply({ error: "Unexpected request" }, 404);
  };
  const view = await render(React.createElement(BrowserWorkspace, { peer, onEnd() {} }));
  const c = view.container;
  const screen = await dom.waitFor(() => c.querySelector('[aria-label="Screen controls"]'));
  await dom.waitFor(() => screen.querySelector("img")?.getAttribute("src"));
  assert.equal(button(c, "Scroll down"), undefined, "ask permission cannot use automatic scrolling");
  assert.equal(screen.querySelector('[aria-label="Requested action"]'), null, "no coordinate action form is needed");
  const image = screen.querySelector("img");
  image.getBoundingClientRect = () => ({ left: 20, top: 30, width: 200, height: 100, right: 220, bottom: 130 });
  image.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, clientX: 70, clientY: 105 }));
  await settle();
  const text = '<img src=x onerror="bad()">\nsecond line';
  await value(screen.querySelector('[aria-label="Text to type"]'), text);
  await value(screen.querySelector('[aria-label="Reason for screen request"]'), "Fill the visible editor");
  assert.equal(calls.filter(([method]) => method === "POST").length, 0, "clicking and typing only prepares actions");
  await click(button(screen, "Ask approval · 2"));
  await dom.waitFor(() => screen.querySelector('[role="status"]')?.textContent.includes("Waiting for owner"));
  assert.deepEqual(calls.filter(([method]) => method === "POST"), [["POST", "/api/browser/requests", {
    type: "batch", actions: [{ type: "click", x: 0.25, y: 0.75, button: "left", count: 1 }, { type: "text", text }], reason: "Fill the visible editor",
  }]]);
  assert.match(screen.querySelector('[role="status"]').textContent, /Waiting for owner/);
  const sequence = screen.querySelector('[aria-label="Screen action sequence"]');
  assert.equal(sequence.querySelectorAll("img,script").length, 0);
  assert.match(sequence.textContent, /\\nsecond line/);
  await click(button(screen, "Cancel request"));
  await dom.waitFor(() => screen.querySelector('[role="status"]')?.textContent.includes("cancelled"));
  assert.match(screen.querySelector('[role="status"]').textContent, /cancelled/);
  assert.equal(calls.some(([, route]) => /\/exec|\/screen\/input|\/browser\/scroll/.test(route)), false);
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

test("screen and terminal tabs preserve separate drafts and display only their request histories", async () => {
  const calls = [];
  const records = [];
  globalThis.fetch = dom.window.fetch = async (url, init = {}) => {
    const route = new URL(url).pathname;
    const method = init.method || "GET";
    calls.push([method, route]);
    if (route === "/api/browser") return reply({ name: "Muse", expiresAt: Date.now() + 3600000, roots: [{ name: "Project", path: "/Project", index: 0 }], terminals: [], screen: "ask", commandRequests: true });
    if (route === "/api/browser/screen") return snapshot();
    if (route === "/api/files") return reply({ items: [] });
    if (route === "/api/browser/requests" && method === "POST") {
      const { reason, ...action } = JSON.parse(init.body);
      const record = { ...pending(action), id: `request-${records.length + 1}`, reason };
      records.push(record); return reply(record);
    }
    if (route === "/api/browser/requests") return reply(records);
    return reply({ error: "Unexpected request" }, 404);
  };
  const view = await render(React.createElement(BrowserWorkspace, { peer, onEnd() {} }));
  const c = view.container;
  const screen = await dom.waitFor(() => c.querySelector('[aria-label="Screen controls"]'));
  await dom.waitFor(() => screen.querySelector("img")?.getAttribute("src"));
  assert.equal(screen.querySelector('[aria-label="Requested action"]'), null);
  await value(screen.querySelector('[aria-label="Text to type"]'), "Visible editor text");
  await value(screen.querySelector('[aria-label="Reason for screen request"]'), "Fill this editor");
  await click(tab(c, "Terminal"));
  const terminalForm = c.querySelector('form[aria-label="Request an action"]');
  assert.equal(terminalForm.querySelector('[aria-label="Requested action"]').value, "command");
  assert.equal(terminalForm.querySelector('[aria-label="Requested action"]').options.length, 1);
  assert.equal(terminalForm.querySelector('[aria-label="Exact command"]').value, "");
  assert.equal(terminalForm.querySelector('[aria-label="Reason for request"]').value, "");
  await value(terminalForm.querySelector('[aria-label="Exact command"]'), "sudo apt update");
  await value(terminalForm.querySelector('[aria-label="Reason for request"]'), "Refresh package lists");
  await click(tab(c, "Files"));
  assert.ok(terminalForm.closest("[hidden]"));
  assert.ok(screen.closest("[hidden]"));
  await click(tab(c, "Screen"));
  assert.equal(screen.querySelector('[aria-label="Text to type"]').value, "Visible editor text");
  assert.equal(screen.querySelector('[aria-label="Reason for screen request"]').value, "Fill this editor");
  await click(button(screen, "Ask approval · 1"));
  assert.equal(records.length, 1);
  assert.match(screen.querySelector('[aria-label="Screen action sequence"]').textContent, /Visible editor text/);
  await click(tab(c, "Terminal"));
  assert.equal(terminalForm.querySelector('[aria-label="Exact command"]').value, "sudo apt update");
  assert.equal(terminalForm.querySelector('[aria-label="Reason for request"]').value, "Refresh package lists");
  const terminalHistory = terminalForm.parentElement.querySelector('[role="log"]');
  assert.doesNotMatch(terminalHistory.textContent, /Visible editor text/);
  await submit(c);
  assert.equal(records.length, 2);
  assert.deepEqual(records.map((record) => record.action), [
    { type: "batch", actions: [{ type: "text", text: "Visible editor text" }] },
    { type: "command", command: "sudo apt update" },
  ]);
  assert.match(terminalHistory.textContent, /sudo apt update/);
  await click(tab(c, "Screen"));
  assert.match(screen.querySelector('[aria-label="Screen action sequence"]').textContent, /Visible editor text/);
  assert.doesNotMatch(screen.textContent, /sudo apt update/);
  assert.equal(calls.some(([, route]) => /\/exec|\/screen\/input/.test(route)), false);
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
    "Click the marked point",
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
      return reply({ terminals: [], screenAvailable: true, appAccessAvailable: true, apps: [] });
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
  assert.ok(button(row, "Edit access"), "browser grants use their scoped access editor");
  assert.equal(
    row.querySelector(".ivt-menu-button"),
    null,
    "cannot convert a browser grant into full or command access",
  );
  await click(button(c, "Agent") || button(c, "AI assistant") || button(c, "Muse / AI browser"));
  await dom.waitFor(() =>
    c.querySelector('[aria-label="AI browser invitation"]'),
  );
  await dom.waitFor(() => c.querySelector('[aria-label="Access preset"]'));
  assert.ok(c.querySelector('[aria-label="AI browser invitation"]'));
  assert.equal(c.querySelector('input[aria-label="Name"]'), null);
  assert.ok(c.querySelector('[aria-label="Access preset"] input[aria-label="Full control"]'));
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
  await click(button(c, "Approve once"));
  assert.deepEqual(calls, [["POST", "/api/agents/browser-requests/request-1", { decision: "approve" }]]);
  await view.unmount();
});

test("assistant runs a read-only command from the terminal prompt and sees inert logged output", async () => {
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
    if (route === "/api/browser/terminal" && method === "POST") {
      const body = JSON.parse(init.body);
      calls.push(body);
      const created = { ...pending({ type: "terminal", ...body }), id: "new-request", status: "executed", output: "Beginning of notes", completedAt: Date.now() };
      records.unshift(created);
      return reply(created);
    }
    if (route === "/api/browser/terminal/history") return reply(records);
    return reply({ error: "Unexpected request" }, 404);
  };
  const view = await render(React.createElement(BrowserWorkspace, { peer, onEnd() {} }));
  const c = view.container;
  await click(tab(c, "Terminal"));
  await value(c.querySelector('[aria-label="Terminal shared folder"]'), "1");
  await value(c.querySelector('[aria-label="Terminal command"]'), "head -n 5 notes.txt");
  c.querySelector('form[aria-label="Terminal command prompt"]').dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
  await settle(50);
  assert.deepEqual(calls, [{ command: "head -n 5 notes.txt", root: 1, cwd: "" }]);
  assert.equal(c.querySelector('[aria-label="Command output"]').textContent, "<script>not executable</script>");
  assert.equal(c.querySelector('[aria-label="Command output"] script'), null);
  assert.match(c.querySelector('[aria-label="Command transcript"]').textContent, /Beginning of notes/);
  assert.equal(c.querySelector('[aria-label="Reason for request"]'), null);
  assert.equal(button(c, "Request owner approval"), undefined);
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

test("screen batch builder submits only the ordered list for one approval and limits it to five", async () => {
  const writes = [];
  globalThis.fetch = dom.window.fetch = async (_url, init = {}) => {
    if (init.method === "POST") {
      const { reason, ...action } = JSON.parse(init.body);
      writes.push({ ...action, reason });
      return reply({ ...pending(action), reason, completedCount: 0 });
    }
    return reply([]);
  };
  const view = await render(React.createElement(BrowserActionRequests, {
    peer, screen: true, commands: false, activeKind: "screen", onError: assert.fail,
  }));
  const c = view.container;
  await click(button(c, "Add to batch"));
  await value(c.querySelector('[aria-label="Requested action"]'), "text");
  const text = '<script>inert</script>\n\u202eexact';
  await value(c.querySelector('[aria-label="Exact text"]'), text);
  await click(button(c, "Add to batch"));
  await value(c.querySelector('[aria-label="Requested action"]'), "key");
  await click(button(c, "Add to batch"));
  await click(button(c, "Add to batch"));
  await click(button(c, "Add to batch"));
  assert.equal(c.querySelectorAll('[aria-label="Batch draft"] > li').length, 5);
  assert.equal(button(c, "Add to batch").disabled, true);
  await click(c.querySelector('[aria-label="Remove action 4"]'));
  await click(c.querySelector('[aria-label="Remove action 4"]'));
  assert.equal(c.querySelectorAll('[aria-label="Batch draft"] > li').length, 3);
  assert.equal(button(c, "Add to batch").disabled, false);
  assert.equal(c.querySelector('[aria-label="Batch draft"] script'), null);
  assert.match(c.querySelector('[aria-label="Batch draft"]').textContent, /\\n\\u202eexact/);
  await value(c.querySelector('[aria-label="Reason for request"]'), "Fill and submit the visible field");
  await click(button(c, "Request approval for 3 actions"));
  assert.deepEqual(writes, [{
    type: "batch", actions: [
      { type: "click", x: 0.5, y: 0.5, button: "left", count: 1 },
      { type: "text", text },
      { type: "key", key: "enter" },
    ], reason: "Fill and submit the visible field",
  }]);
  assert.equal(c.querySelector('[aria-label="Batch draft"]'), null);
  assert.match(c.querySelector('[role="log"]').textContent, /0 of 3 actions completed/);
});

test("owner reviews a screen batch once and keeps partial execution results visible", async () => {
  const actions = [
    { type: "click", x: 0.25, y: 0.75, button: "left", count: 1 },
    { type: "text", text: "hello\n\u202eworld" },
    { type: "key", key: "enter" },
  ];
  const item = { ...pending({ type: "batch", actions }), completedCount: 0 };
  const writes = [];
  let resolved = 0;
  globalThis.fetch = dom.window.fetch = async (url, init = {}) => {
    if (new URL(url).pathname.endsWith("/screen")) return snapshot();
    writes.push(JSON.parse(init.body));
    return reply({ ...item, status: "failed", completedCount: 1,
      error: "Screen control became unavailable.",
      steps: actions.map((action, index) => ({ action, status: ["executed", "failed", "skipped"][index] })),
    });
  };
  const view = await render(React.createElement(BrowserApprovalReview, {
    peer, item, onClose() {}, onResolved() { resolved++; },
  }));
  const c = view.container;
  assert.equal(c.querySelectorAll('[aria-label="Exact action sequence"] > li').length, 3);
  assert.match(c.textContent, /screen may change between the listed actions/);
  assert.match(c.textContent, /does not classify clicks or typing as safe or dangerous/);
  assert.match(c.textContent, /checks this screen before the first action/);
  assert.match(c.textContent, /20 seconds/);
  assert.equal(button(c, "Approve 3 actions once").disabled, true);
  await loadSnapshot(c, "Approve 3 actions once");
  await click(button(c, "Approve 3 actions once"));
  assert.deepEqual(writes, [{ decision: "approve", reviewedBatch: true }]);
  assert.equal(resolved, 0, "batch results stay open for review");
  assert.match(c.textContent, /1 of 3 actions completed/);
  assert.match(c.querySelector('[aria-label="Batch action results"]').textContent, /executed[\s\S]*failed[\s\S]*skipped/);
  assert.equal(button(c, "Approve 3 actions once").disabled, true);
});

test("owner can stop the remainder while an approved batch is running", async () => {
  const actions = [{ type: "key", key: "tab" }, { type: "key", key: "enter" }];
  const item = { ...pending({ type: "batch", actions }), status: "executing", completedCount: 1,
    steps: actions.map((action, index) => ({ action, status: index ? "executing" : "executed" })),
  };
  const writes = [];
  globalThis.fetch = dom.window.fetch = async (url, init = {}) => {
    if (new URL(url).pathname.endsWith("/screen")) return snapshot();
    writes.push(JSON.parse(init.body));
    return reply({ ...item, status: "cancelled", steps: [item.steps[0], { ...item.steps[1], status: "skipped" }] });
  };
  const view = await render(React.createElement(BrowserApprovalReview, { peer, item, onClose() {}, onResolved() {} }));
  const c = view.container;
  assert.equal(button(c, "Approve 2 actions once").disabled, true);
  assert.match(c.textContent, /1 of 2 actions completed/);
  await click(button(c, "Stop remaining actions"));
  assert.deepEqual(writes, [{ decision: "deny" }]);
  assert.equal(button(c, "Stop remaining actions"), undefined);
  assert.match(c.textContent, /cancelled/);
  assert.match(c.textContent, /Completed actions are not undone/);
});

test("terminal batch review shows every exact root and cwd with no screen fetch", async () => {
  const actions = [
    { type: "terminal", command: "ls", root: 0, cwd: "nested" },
    { type: "terminal", command: "cat note.txt", root: 1 },
  ];
  const item = { ...pending({ type: "batch", actions }), steps: [
    { action: actions[0], status: "pending", folder: "/shared/project" },
    { action: actions[1], status: "pending", folder: "/shared/notes" },
  ] };
  const calls = [];
  globalThis.fetch = dom.window.fetch = async (url, init = {}) => {
    calls.push([new URL(url).pathname, init.body && JSON.parse(init.body)]);
    return reply({ ...item, status: "executed", completedCount: 2, steps: item.steps.map((step) => ({ ...step, status: "executed", output: "<img src=x>" })) });
  };
  const view = await render(React.createElement(BrowserApprovalReview, { peer, item, onClose() {}, onResolved() {} }));
  const c = view.container;
  const list = c.querySelector('[aria-label="Exact action sequence"]');
  assert.match(list.textContent, /"ls"[\s\S]*"\/shared\/project"[\s\S]*"\/nested"/);
  assert.match(list.textContent, /"cat note.txt"[\s\S]*"\/shared\/notes"[\s\S]*"\/"/);
  assert.equal(calls.length, 0);
  assert.match(c.textContent, /30 seconds/);
  await click(button(c, "Approve 2 actions once"));
  assert.deepEqual(calls, [["/api/agents/browser-requests/request-1", { decision: "approve", reviewedBatch: true }]]);
  assert.equal(c.querySelector('[aria-label="Action 1 output"]').textContent, "<img src=x>");
  assert.equal(c.querySelector('[aria-label="Action 1 output"] img'), null);
});

test("manual commands cannot be batched and tab changes keep screen batches separate", async () => {
  let setKind;
  const writes = [];
  globalThis.fetch = dom.window.fetch = async (_url, init = {}) => {
    if (init.method === "POST") {
      const { reason, ...action } = JSON.parse(init.body);
      writes.push({ ...action, reason });
      return reply({ ...pending(action), reason });
    }
    return reply([]);
  };
  function Requests() {
    const [activeKind, set] = React.useState("screen");
    setKind = set;
    return React.createElement(BrowserActionRequests, { peer, screen: true, commands: true, activeKind, onError: assert.fail });
  }
  const view = await render(React.createElement(Requests));
  const c = view.container;
  await click(button(c, "Add to batch"));
  dom.update(() => setKind("command"));
  await settle();
  assert.equal(button(c, "Add to batch"), undefined);
  assert.equal(c.querySelector('[aria-label="Batch draft"]'), null);
  await value(c.querySelector('[aria-label="Exact command"]'), "sudo test");
  await value(c.querySelector('[aria-label="Reason for request"]'), "Owner handles this");
  await click(button(c, "Request owner approval"));
  assert.deepEqual(writes, [{ type: "command", command: "sudo test", reason: "Owner handles this" }]);
  dom.update(() => setKind("screen"));
  await settle();
  assert.equal(c.querySelectorAll('[aria-label="Batch draft"] > li').length, 1);
  assert.doesNotMatch(c.querySelector('[aria-label="Batch draft"]').textContent, /sudo/);
});

test("guest stops executing batches and keeps successful terminal cwd from partial results", async () => {
  const actions = [
    { type: "terminal", command: "cd nested", root: 0 },
    { type: "terminal", command: "cat missing.txt", root: 0 },
  ];
  const item = { ...pending({ type: "batch", actions }), status: "executing", completedCount: 1, steps: [
    { action: actions[0], status: "executed", directory: "nested", completedAt: Date.now(), output: "nested" },
    { action: actions[1], status: "executing" },
  ] };
  const calls = [];
  globalThis.fetch = dom.window.fetch = async (url, init = {}) => {
    if (init.method === "DELETE") {
      calls.push(["DELETE", new URL(url).pathname]);
      return reply({ ...item, status: "cancelled", steps: [item.steps[0], { ...item.steps[1], status: "skipped" }] });
    }
    return reply([item]);
  };
  const view = await render(React.createElement(BrowserActionRequests, {
    peer, screen: false, commands: true, restrictedTerminal: true, activeKind: "command",
    roots: [{ index: 0, name: "Project", path: "/shared/project" }], onError: assert.fail,
  }));
  const c = view.container;
  await dom.waitFor(() => c.querySelector('[aria-label="Working folder"]')?.textContent.endsWith("/nested"));
  await click(button(c, "Stop remaining actions"));
  assert.deepEqual(calls, [["DELETE", "/api/browser/requests/request-1"]]);
  assert.match(c.querySelector('[role="log"]').textContent, /1 of 2 actions completed/);
  assert.match(c.querySelector('[role="log"]').textContent, /Remaining actions stopped/);
  assert.match(c.querySelector('[aria-label="Batch action results"]').textContent, /skipped/);
  await value(c.querySelector('[aria-label="Exact command"]'), "cat notes.txt");
  await click(button(c, "Add to batch"));
  assert.match(c.querySelector('[aria-label="Batch draft"]').textContent, /Working folder: \/nested/);
  assert.deepEqual(dom.errors, []);
});

test("owner can reopen progress for an executing batch from Needs you", async () => {
  const actions = [{ type: "key", key: "tab" }, { type: "key", key: "enter" }];
  globalThis.fetch = dom.window.fetch = async (url) => new URL(url).pathname.endsWith("/screen")
    ? snapshot()
    : reply([{ ...pending({ type: "batch", actions }), status: "executing", completedCount: 1 }]);
  function Prompts() {
    const approvals = useBrowserApprovals(peer, true);
    return React.createElement(React.Fragment, null,
      React.createElement(NeedsYouStrip, { items: approvals.items }), approvals.review);
  }
  const view = await render(React.createElement(Prompts));
  const c = view.container;
  await dom.waitFor(() => button(c, "View progress"));
  assert.match(c.textContent, /Muse is running approved actions/);
  await click(button(c, "View progress"));
  assert.ok(button(c, "Stop remaining actions"));
  assert.equal(button(c, "Approve 2 actions once").disabled, true);
});

test("owner approves one scoped terminal change with explicit review acknowledgement and sees its result", async () => {
  const calls = [];
  let resolved = 0;
  const item = { ...pending({ type: "terminal-change", command: 'mkdir "new notes"', root: 0, cwd: "research" }), folder: "/shared/project/research" };
  globalThis.fetch = dom.window.fetch = async (url, init = {}) => {
    calls.push([init.method || "GET", new URL(url).pathname, init.body && JSON.parse(init.body)]);
    return reply({ ...item, status: "executed", output: "Created new notes" });
  };
  const view = await render(React.createElement(BrowserApprovalReview, { peer, item, onClose() {}, onResolved() { resolved++; } }));
  const c = view.container;
  assert.equal(c.querySelector('[aria-label="Requested command"]').textContent, JSON.stringify('mkdir "new notes"'));
  assert.equal(c.querySelector('[aria-label="Command folder"]').textContent, '"/shared/project/research"');
  assert.match(c.textContent, /changes files inside the shared folder/);
  assert.match(c.textContent, /never grants access to other folders/);
  assert.match(c.textContent, /Scripts, sudo, and unrestricted shells remain blocked/);
  assert.doesNotMatch(c.textContent, /Assistant’s reason/);
  assert.equal(calls.length, 0, "file changes need no screen capture and cannot execute before review");
  assert.equal(button(c, "Approve once").disabled, false);
  await click(button(c, "Approve once"));
  assert.deepEqual(calls, [["POST", "/api/agents/browser-requests/request-1", { decision: "approve", reviewedTerminalChange: true }]]);
  assert.match(c.textContent, /Created new notes/);
  assert.equal(resolved, 0, "result stays visible");
  assert.equal(button(c, "Approve once").disabled, true);
});

test("denying a scoped terminal change never grants review acknowledgement or execution", async () => {
  const calls = [];
  const item = { ...pending({ type: "terminal-change", command: "rm draft.txt", root: 0 }), folder: "/shared/project" };
  globalThis.fetch = dom.window.fetch = async (_url, init = {}) => { calls.push(JSON.parse(init.body)); return reply({ ...item, status: "denied" }); };
  const view = await render(React.createElement(BrowserApprovalReview, { peer, item, onClose() {}, onResolved() {} }));
  await click(button(view.container, "Deny"));
  assert.deepEqual(calls, [{ decision: "deny" }]);
  assert.equal(button(view.container, "Approve once").disabled, true);
});

test("screen approval controls stay available alongside a scoped terminal with approved file changes", async () => {
  const terminalRecords = [], screenRecords = [];
  const posts = [];
  globalThis.fetch = dom.window.fetch = async (url, init = {}) => {
    const route = new URL(url).pathname;
    const method = init.method || "GET";
    if (route === "/api/browser") return reply({ name: "Muse", roots: [{ index: 0, name: "Project", path: "/shared/project" }], terminals: [], screen: "ask", restrictedTerminal: true, terminalApproval: true, expiresAt: Date.now() + 60000 });
    if (route === "/api/browser/screen") return snapshot();
    if (route === "/api/browser/terminal/history") return reply(terminalRecords);
    if (route === "/api/browser/terminal" && method === "POST") {
      const body = JSON.parse(init.body); posts.push([route, body]);
      const item = { ...pending({ type: "terminal", ...body }), id: "terminal-ls", status: "executed", output: "notes.txt" };
      terminalRecords.push(item); return reply(item);
    }
    if (route === "/api/browser/requests" && method === "POST") {
      const { reason, ...action } = JSON.parse(init.body); posts.push([route, { ...action, reason }]);
      const item = { ...pending(action), reason }; screenRecords.push(item); return reply(item);
    }
    if (route === "/api/browser/requests") return reply(screenRecords);
    if (route === "/api/files") return reply({ items: [] });
    return reply({ error: "Unexpected route" }, 404);
  };
  const view = await render(React.createElement(BrowserWorkspace, { peer, onEnd: assert.fail })); const c = view.container;
  const screen = await dom.waitFor(() => c.querySelector('[aria-label="Screen controls"]'));
  await dom.waitFor(() => screen.querySelector("img")?.getAttribute("src"));
  await value(screen.querySelector('[aria-label="Text to type"]'), "project notes");
  await value(screen.querySelector('[aria-label="Reason for screen request"]'), "Fill the selected search field");
  await click(tab(c, "Terminal"));
  assert.ok(screen.closest("[hidden]"));
  assert.ok(c.querySelector('[aria-label="Terminal command"]'));
  assert.equal(c.querySelector('[aria-label="Reason for request"]'), null);
  await value(c.querySelector('[aria-label="Terminal command"]'), "ls");
  c.querySelector('form[aria-label="Terminal command prompt"]').dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
  await dom.waitFor(() => c.querySelector('[aria-label="Command transcript"]').textContent.includes("notes.txt"));
  await click(tab(c, "Screen"));
  assert.equal(screen.closest("[hidden]"), null);
  assert.equal(screen.querySelector('[aria-label="Text to type"]').value, "project notes");
  assert.equal(button(screen, "Ask approval · 1").disabled, false);
  await click(button(screen, "Ask approval · 1"));
  assert.deepEqual(posts, [
    ["/api/browser/terminal", { command: "ls", root: 0, cwd: "" }],
    ["/api/browser/requests", { type: "batch", actions: [{ type: "text", text: "project notes" }], reason: "Fill the selected search field" }],
  ]);
  assert.match(screen.textContent, /Waiting for owner approval/);
  assert.deepEqual(dom.errors, []);
});

test('script review is an exact command and folder with Approve once and Deny',async()=>{
 const item={...pending({type:'terminal-script',command:'node report.js',root:0}),folder:'/Users/test/Desktop'};
 const calls=[];globalThis.fetch=dom.window.fetch=async(url,init={})=>{calls.push([new URL(url).pathname,JSON.parse(init.body)]);return reply({...item,status:'executed',exitCode:0,output:'Report ready'});};
 const view=await render(React.createElement(BrowserApprovalReview,{peer,item,onClose(){},onResolved(){}}));const c=view.container;
 assert.match(c.textContent,/node report.js/);assert.match(c.textContent,/\/Users\/test\/Desktop/);assert.equal(c.querySelector('img'),null);assert.ok(button(c,'Deny'));assert.equal(button(c,'Approve once').disabled,false);assert.equal(c.querySelector('textarea'),null);
 await click(button(c,'Approve once'));assert.deepEqual(calls,[[`/api/agents/browser-requests/${item.id}`,{decision:'approve',reviewedScript:true}]]);assert.match(c.textContent,/Report ready/);assert.equal(button(c,'Approve once').disabled,true);
});

test('session approval button sends a distinct reviewed owner decision and explains invitation boundaries',async()=>{
 const item={...pending({type:'terminal-script',command:'node report.js',root:0}),folder:'/Users/test/Desktop'};const writes=[];
 globalThis.fetch=dom.window.fetch=async(_url,init={})=>{writes.push(JSON.parse(init.body));return reply({...item,status:'executed',output:'done'});};
 const view=await render(React.createElement(BrowserApprovalReview,{peer,item,onClose(){},onResolved(){}}));const c=view.container;
 assert.ok(button(c,'Approve once'));assert.ok(button(c,'Deny'));assert.match(c.textContent,/exact command and folder/);assert.match(c.textContent,/new invite starts fresh/);
 await click(button(c,'Always approve this session'));assert.deepEqual(writes,[{decision:'approve-session',reviewedScript:true}]);assert.equal(button(c,'Always approve this session').disabled,true);
});
