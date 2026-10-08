import test, { before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { startDom, settle } from "./dom/harness.mjs";

// The agent's own workspace is read and driven by AI agents in a browser:
// what it may do is written out, and every choice is a visible button.
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
const views = new Set();
before(async () => {
  dom = await startDom();
  React = dom.React;
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
  [...c.querySelectorAll("button")].find((b) => b.textContent.trim() === label);
const access = {
  name: "My Mac",
  expiresAt: Date.now() + 20 * 60000,
  roots: [
    { index: 0, name: "project", path: "/Users/me/project" },
    { index: 1, name: "notes", path: "/Users/me/notes" },
  ],
  terminals: [{ id: "reach:one", name: "Build logs" }],
  screen: "off",
  commandRequests: false,
  restrictedTerminal: true,
  terminalApproval: true,
};
function mock() {
  const calls = [];
  globalThis.fetch = dom.window.fetch = async (url, init = {}) => {
    const parsed = new URL(url),
      route = parsed.pathname;
    calls.push([init.method || "GET", route, parsed.search]);
    if (route === "/api/browser") return reply(access);
    if (route === "/api/files")
      return reply({
        items: parsed.searchParams.get("path")
          ? [{ name: "a.txt", path: "docs/a.txt", type: "file" }]
          : [{ name: "docs", path: "docs", type: "directory" }],
      });
    if (route.startsWith("/api/browser/terminals/"))
      return reply({ output: "ready" });
    if (route === "/api/browser/terminal/history") return reply([]);
    return reply({ error: "Unexpected request" }, 404);
  };
  return calls;
}

test("the workspace says what the agent may do, and Go to buttons open each place", async () => {
  mock();
  const view = await dom.render(
    React.createElement(BrowserWorkspace, { peer, onEnd() {} }),
  );
  views.add(view);
  const c = view.container;
  await dom.waitFor(() =>
    c.querySelector('[aria-label="Workspace navigation"]'),
  );
  await click(
    c.querySelector(
      '[aria-label="Workspace navigation"] [aria-label="Access"]',
    ),
  );
  const card = c.querySelector(".ag-ws-access");
  assert.equal(card.open, true, "the summary starts open");
  assert.deepEqual(
    [...card.querySelectorAll("li strong")].map((e) => e.textContent),
    ["Files", "Terminal output", "Commands"],
  );
  assert.match(
    card.textContent,
    /Read, search and download in project, notes\./,
  );
  assert.match(card.textContent, /Read Build logs\. Output only\./);
  assert.match(
    card.textContent,
    /File changes and scripts wait for the owner’s approval/,
  );
  assert.match(card.textContent, /You can’t invite anyone, share this link/);
  assert.match(c.querySelector(".aw-session").textContent, /\d+ min/);
  assert.match(
    c.querySelector(".aw-session").title,
    /Shared resources.*min left/,
  );
  // Files opens first (no screen); its row says so instead of offering a button.
  assert.match(card.querySelector("li").textContent, /Open below/);
  await click(button(card, "Go to Terminal"));
  assert.equal(
    c
      .querySelector(
        '[aria-label="Workspace navigation"] [aria-label="Commands"]',
      )
      .getAttribute("aria-current"),
    "page",
  );
  assert.equal(
    c.querySelector('[aria-label="Shared terminal"] [aria-checked="true"]')
      .textContent,
    "Build logs",
  );
});

test("folders and breadcrumbs are buttons, and example commands only fill the prompt", async () => {
  const calls = mock();
  const view = await dom.render(
    React.createElement(BrowserWorkspace, { peer, onEnd() {} }),
  );
  views.add(view);
  const c = view.container;
  await dom.waitFor(() =>
    c.querySelector('[aria-label="Workspace navigation"]'),
  );
  await click(
    c.querySelector('[aria-label="Workspace navigation"] [aria-label="Files"]'),
  );
  await dom.waitFor(() => c.querySelector('[aria-label="Open folder docs"]'));
  assert.deepEqual(
    [...c.querySelectorAll('[aria-label="Shared folder"] [role="radio"]')].map(
      (b) => [b.textContent, b.getAttribute("aria-checked")],
    ),
    [
      ["project", "true"],
      ["notes", "false"],
    ],
  );
  await click(c.querySelector('[aria-label="Open folder docs"]'));
  await dom.waitFor(() =>
    c.querySelector('[aria-label="Read file docs/a.txt"]'),
  );
  assert.deepEqual(
    [...c.querySelectorAll('[aria-label="Folder path"] button')].map((b) =>
      b.textContent.trim(),
    ),
    ["project", "docs", "Up one folder"],
  );
  assert.equal(
    c.querySelector('[aria-label="Folder path"] [aria-current="location"]')
      .textContent,
    "docs",
  );
  await click([...c.querySelectorAll('[aria-label="Folder path"] button')][0]);
  await dom.waitFor(() => c.querySelector('[aria-label="Open folder docs"]'));
  await click(c.querySelector('[aria-label="Shared folder"] [data-value="1"]'));
  assert.ok(
    calls.some(
      ([, route, query]) => route === "/api/files" && query.includes("root=1"),
    ),
  );
  await click(
    c.querySelector(
      '[aria-label="Workspace navigation"] [aria-label="Commands"]',
    ),
  );
  const before = calls.filter(([method]) => method === "POST").length;
  await click(c.querySelector('[aria-label="Put pwd in the prompt"]'));
  assert.equal(c.querySelector('[aria-label="Terminal command"]').value, "pwd");
  assert.equal(
    calls.filter(([method]) => method === "POST").length,
    before,
    "an example never runs by itself",
  );
  assert.match(
    c.textContent,
    /Read commands: pwd, cd, ls, cat, head, tail, wc, grep/,
  );
});

test("agent workspace renders without React warnings", () =>
  assert.deepEqual(dom.errors, []));
