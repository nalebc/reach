import test, { before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { startDom, settle } from "./dom/harness.mjs";

let dom, React, BrowserInvite, BrowserWorkspace;
const peer = {
  id: "mac",
  name: "My Mac",
  url: "https://mac.tail.ts.net:8443",
  token: "owner",
  platform: "darwin",
};
const device = {
  name: "My Mac",
  roots: [{ id: 0, name: "Project", path: "/Users/me/Project" }],
};
const secret = "b".repeat(43);
before(async () => {
  dom = await startDom();
  React = dom.React;
  ({ default: BrowserInvite } = await dom.load("/src/BrowserInvite.tsx"));
  ({ default: BrowserWorkspace } = await dom.load("/src/BrowserWorkspace.tsx"));
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
  delete dom.document.hidden;
  delete dom.document.visibilityState;
});
const click = async (element) => {
  assert.ok(element, "element exists");
  element.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  await settle(40);
};
const value = async (element, text) => {
  const prototype =
    element.tagName === "SELECT"
      ? dom.window.HTMLSelectElement.prototype
      : dom.window.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value").set.call(element, text);
  element.dispatchEvent(
    new dom.window.Event(element.tagName === "SELECT" ? "change" : "input", {
      bubbles: true,
    }),
  );
  await settle();
};
const button = (container, label) =>
  [...container.querySelectorAll("button")].find(
    (item) =>
      item.textContent.trim() === label ||
      item.getAttribute("aria-label") === label,
  );
const tab = (container, label) =>
  [
    ...container.querySelectorAll('[aria-label="Workspace navigation"] button'),
  ].find(
    (item) =>
      item.getAttribute("aria-label") ===
      (label === "Terminal" ? "Commands" : label),
  );
const snapshot = () =>
  new Response(new Uint8Array([255, 216, 255, 217]), {
    headers: { "Content-Type": "image/jpeg" },
  });
const setVisible = async (visible) => {
  Object.defineProperties(dom.document, {
    hidden: { configurable: true, value: !visible },
    visibilityState: {
      configurable: true,
      value: visible ? "visible" : "hidden",
    },
  });
  dom.document.dispatchEvent(new dom.window.Event("visibilitychange"));
  await settle(40);
};
const reply = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

test("shared files download as authenticated bytes without exposing a credential link", async (t) => {
  const calls = [],
    saved = [];
  const oldClick = dom.window.HTMLAnchorElement.prototype.click;
  const oldCreate = URL.createObjectURL;
  const oldTimeout = globalThis.setTimeout;
  let payload;
  URL.createObjectURL = (blob) => {
    payload = blob;
    return "blob:shared-download";
  };
  dom.window.HTMLAnchorElement.prototype.click = function () {
    saved.push({ href: this.href, name: this.download });
  };
  globalThis.setTimeout = (fn, ms, ...args) =>
    oldTimeout(fn, ms === 60000 ? 0 : ms, ...args);
  t.after(() => {
    URL.createObjectURL = oldCreate;
    dom.window.HTMLAnchorElement.prototype.click = oldClick;
    globalThis.setTimeout = oldTimeout;
  });
  globalThis.fetch = dom.window.fetch = async (url, init = {}) => {
    const u = new URL(url);
    if (u.pathname === "/api/browser")
      return reply({
        name: "Reader",
        expiresAt: Date.now() + 600000,
        roots: [{ name: "Shared", path: "/Shared", index: 0 }],
        terminals: [],
        screen: "off",
      });
    if (u.pathname === "/api/files")
      return reply({
        items: [{ name: "report.pdf", path: "report.pdf", type: "file" }],
      });
    if (u.pathname === "/api/files/content") {
      calls.push({
        path: u.searchParams.get("path"),
        root: u.searchParams.get("root"),
        auth: new Headers(init.headers).get("Authorization"),
      });
      return new Response("pdf bytes", {
        headers: { "Content-Type": "application/pdf" },
      });
    }
    return reply({}, 404);
  };
  const view = await render(
    React.createElement(BrowserWorkspace, { peer, onEnd() {} }),
  );
  await dom.waitFor(() => tab(view.container, "Files"));
  await click(tab(view.container, "Files"));
  await click(button(view.container, "Download file report.pdf"));
  assert.deepEqual(calls, [
    { path: "report.pdf", root: "0", auth: "Bearer owner" },
  ]);
  assert.deepEqual(saved, [
    { href: "blob:shared-download", name: "report.pdf" },
  ]);
  assert.equal(await payload.text(), "pdf bytes");
  assert.equal(payload.type, "application/pdf");
  await view.unmount();
});

test("browser workspace searches confined files and renders file and terminal output as inert text", async () => {
  const calls = [];
  const untrusted =
    '<img src=x onerror="window.compromised=true"> & <script>bad()</script>';
  globalThis.fetch = dom.window.fetch = async (url, init = {}) => {
    const u = new URL(url);
    calls.push([init.method || "GET", u.pathname, u.search]);
    if (u.pathname === "/api/browser")
      return reply({
        name: "Muse",
        expiresAt: Date.now() + 3600000,
        roots: [{ name: "Project", path: "/Project", index: 0 }],
        terminals: [{ id: "reach:one", name: "Build logs" }],
        screen: "view",
      });
    if (u.pathname === "/api/files")
      return reply({
        items: [{ name: "notes.txt", path: "notes.txt", type: "file" }],
      });
    if (u.pathname === "/api/browser/files/search")
      return reply({
        items: [{ name: "brief.txt", path: "nested/brief.txt", type: "file" }],
        truncated: false,
      });
    if (u.pathname === "/api/files/text") return reply({ text: untrusted });
    if (u.pathname === "/api/browser/terminals/reach%3Aone")
      return reply({ output: untrusted });
    if (u.pathname === "/api/browser/screen") return snapshot();
    return reply({ error: "Unexpected request" }, 404);
  };
  const view = await render(
    React.createElement(BrowserWorkspace, {
      peer,
      onEnd() {
        assert.fail("Unexpected access end");
      },
    }),
  );
  const c = view.container;
  await dom.waitFor(() => tab(c, "Screen"));
  assert.equal(tab(c, "Screen").getAttribute("aria-current"), "page");
  await click(tab(c, "Screen"));
  assert.equal(tab(c, "Screen").getAttribute("aria-current"), "page");
  assert.ok(c.querySelector(".browser-screen-image"));
  assert.equal(
    calls.some(
      ([, route]) => route === "/api/files" || route.includes("/terminals/"),
    ),
    false,
    "inactive resources are not fetched in the background",
  );
  await click(tab(c, "Files"));
  await value(c.querySelector('[aria-label="Find a file"]'), "brief");
  c.querySelector("form").dispatchEvent(
    new dom.window.Event("submit", { bubbles: true, cancelable: true }),
  );
  await settle(40);
  assert.ok(
    calls.some(
      ([, route, search]) =>
        route === "/api/browser/files/search" && search === "?root=0&q=brief",
    ),
  );
  await click(c.querySelector('[aria-label="Read file nested/brief.txt"]'));
  assert.equal(
    c.querySelector(".browser-file-content pre").textContent,
    untrusted,
  );
  await click(tab(c, "Terminal"));
  assert.equal(
    c.querySelector('[aria-label="Terminal transcript"]').textContent,
    untrusted,
  );
  assert.equal(
    c.querySelector('[aria-label="Shared terminal"] [aria-checked="true"]')
      .dataset.value,
    "reach:one",
  );
  await click(tab(c, "Files"));
  assert.equal(c.querySelector('[aria-label="Find a file"]').value, "brief");
  assert.equal(
    c.querySelector(".browser-file-content pre").textContent,
    untrusted,
    "reading another tab preserves the open file and search",
  );
  assert.equal(
    calls.filter(([, route]) => route === "/api/files/text").length,
    1,
    "returning to Files does not read the same file again",
  );
  assert.equal(c.querySelectorAll("pre img, pre script, textarea").length, 0);
  assert.equal(button(c, "Scroll up"), undefined, "view-only cannot scroll");
  assert.ok(
    calls.every(([method]) => method === "GET"),
    "reading never issues write requests",
  );
  assert.doesNotMatch(
    [...c.querySelectorAll("button")].map((item) => item.textContent).join(" "),
    /Run|Send|Edit|Delete|Upload|Control/,
  );
  await view.unmount();
});

test("a revoked browser session ends instead of offering owner pairing", async () => {
  let ended = 0;
  globalThis.fetch = dom.window.fetch = async () =>
    reply({ error: "Expired" }, 401);
  const view = await render(
    React.createElement(BrowserWorkspace, { peer, onEnd: () => ended++ }),
  );
  await settle(40);
  assert.equal(ended, 1);
  assert.doesNotMatch(view.container.textContent, /Pair this device/);
  await view.unmount();
});

test("screen navigation uses the scroll-only endpoint and refreshes the image", async () => {
  const calls = [];
  let firstFrame;
  globalThis.fetch = dom.window.fetch = async (url, init = {}) => {
    const route = new URL(url).pathname;
    calls.push([
      init.method || "GET",
      route,
      init.body && JSON.parse(init.body),
    ]);
    if (route === "/api/browser")
      return reply({
        name: "My Mac",
        expiresAt: Date.now() + 3600000,
        roots: [],
        terminals: [],
        screen: "scroll",
      });
    if (route === "/api/browser/screen") {
      if (!firstFrame)
        return new Promise((resolve) => {
          firstFrame = resolve;
        });
      return snapshot();
    }
    if (route === "/api/browser/scroll") return reply({ ok: true });
    return reply({ error: "Unexpected route" }, 404);
  };
  const view = await render(
    React.createElement(BrowserWorkspace, { peer, onEnd() {} }),
  );
  const c = view.container;
  await dom.waitFor(() => tab(c, "Screen"));
  await click(tab(c, "Screen"));
  assert.equal(
    button(c, "Scroll down").disabled,
    true,
    "first read the current screen",
  );
  assert.equal(
    calls.filter(([, route]) => route === "/api/browser/screen").length,
    1,
  );
  firstFrame(snapshot());
  await dom.waitFor(() => c.querySelector(".browser-screen-image"));
  assert.ok(c.querySelector(".browser-screen-image"));
  await click(button(c, "Scroll down"));
  assert.deepEqual(
    calls.filter(([method]) => method === "POST"),
    [["POST", "/api/browser/scroll", { direction: "down", amount: 3 }]],
  );
  assert.equal(
    calls.filter(([, route]) => route === "/api/browser/screen").length,
    2,
  );
  assert.equal(
    c.querySelector(".browser-screen-image").getAttribute("tabindex"),
    null,
  );
  await view.unmount();
});

test("screen refresh stays serial and stops when hidden, off tab, or unmounted", async () => {
  const frames = [];
  globalThis.fetch = dom.window.fetch = async (url, init = {}) => {
    const route = new URL(url).pathname;
    if (route === "/api/browser")
      return reply({
        name: "Muse",
        expiresAt: Date.now() + 3600000,
        roots: [{ name: "Project", path: "/Project", index: 0 }],
        terminals: [],
        screen: "view",
      });
    if (route === "/api/files") return reply({ items: [] });
    if (route === "/api/browser/screen")
      return new Promise((resolve, reject) => {
        frames.push({ resolve, signal: init.signal });
        init.signal.addEventListener(
          "abort",
          () => reject(new DOMException("Aborted", "AbortError")),
          { once: true },
        );
      });
    return reply({ error: "Unexpected request" }, 404);
  };
  const view = await render(
    React.createElement(BrowserWorkspace, { peer, onEnd() {} }),
  );
  const c = view.container;
  await dom.waitFor(() => tab(c, "Screen"));
  await click(tab(c, "Screen"));
  await dom.waitFor(() => frames.length === 1);
  await settle(2200);
  assert.equal(frames.length, 1, "a slow capture never queues another capture");
  assert.equal(button(c, "Refresh screen").disabled, true);
  frames[0].resolve(snapshot());
  await dom.waitFor(() => c.querySelector(".browser-screen-image"));
  await dom.waitFor(() => frames.length === 2, 3500);

  await setVisible(false);
  await dom.waitFor(() => frames[1].signal.aborted);
  assert.equal(
    frames[1].signal.aborted,
    true,
    "hiding aborts the pending capture",
  );
  await settle(2200);
  assert.equal(frames.length, 2, "hidden pages do not capture the screen");
  await setVisible(true);
  await dom.waitFor(() => frames.length === 3);
  await click(tab(c, "Files"));
  await dom.waitFor(() => frames[2].signal.aborted);
  assert.equal(
    frames[2].signal.aborted,
    true,
    "changing tabs aborts the pending capture",
  );
  await settle(2200);
  assert.equal(frames.length, 3, "the Files tab does not capture the screen");
  await click(tab(c, "Screen"));
  await dom.waitFor(() => frames.length === 4);
  await view.unmount();
  assert.equal(
    frames[3].signal.aborted,
    true,
    "leaving ends the pending capture",
  );
  assert.equal(
    c.querySelector('[role="alert"]'),
    null,
    "aborts are not user errors",
  );
});

test("navigation opens the first shared resource and never fetches unavailable resources", async () => {
  for (const permissions of [
    {
      roots: [{ name: "Project", path: "/Project", index: 0 }],
      terminals: [],
      screen: "off",
      selected: "Files",
    },
    {
      roots: [],
      terminals: [{ id: "reach:one", name: "Logs" }],
      screen: "off",
      selected: "Terminal",
    },
    {
      roots: [],
      terminals: [],
      screen: "off",
      commandRequests: true,
      selected: "Terminal",
    },
  ]) {
    const calls = [];
    globalThis.fetch = dom.window.fetch = async (url) => {
      const route = new URL(url).pathname;
      calls.push(route);
      if (route === "/api/browser")
        return reply({
          name: "Muse",
          expiresAt: Date.now() + 3600000,
          ...permissions,
        });
      if (route === "/api/files") return reply({ items: [] });
      if (route.startsWith("/api/browser/terminals/"))
        return reply({ output: "ready" });
      if (route === "/api/browser/requests") return reply([]);
      return reply({ error: "Unexpected request" }, 404);
    };
    const view = await render(
      React.createElement(BrowserWorkspace, { peer, onEnd() {} }),
    );
    const c = view.container;
    await dom.waitFor(() => tab(c, permissions.selected));
    assert.equal(
      tab(c, permissions.selected).getAttribute("aria-current"),
      "page",
    );
    await click(tab(c, permissions.selected));
    await dom.waitFor(() => calls.length >= 2);
    assert.deepEqual(
      [...c.querySelectorAll('[aria-label="Workspace navigation"] button')].map(
        (item) => item.getAttribute("aria-label"),
      ),
      ["Tools", "Screen", "Apps", "Files", "Commands", "Access", "Reload page"],
    );
    assert.equal(
      tab(c, permissions.selected).getAttribute("aria-current"),
      "page",
    );
    assert.equal(tab(c, "Screen").disabled, true);
    assert.equal(tab(c, "Files").disabled, !permissions.roots.length);
    assert.equal(
      tab(c, "Terminal").disabled,
      !(permissions.terminals.length || permissions.commandRequests),
    );
    assert.equal(
      calls.some((route) => route === "/api/browser/screen"),
      false,
    );
    assert.equal(
      calls.some((route) => route === "/api/files"),
      !!permissions.roots.length,
    );
    assert.equal(
      calls.some((route) => route.includes("/terminals/")),
      !!permissions.terminals.length,
    );
    const selected = tab(c, permissions.selected);
    assert.equal(
      c.querySelector('[role="region"]').id,
      selected.getAttribute("aria-controls"),
    );
    if (permissions.commandRequests) {
      assert.equal(
        c.querySelector('[aria-label="Requested action"]').value,
        "command",
      );
      assert.equal(c.querySelector('[aria-label="Shared terminal"]'), null);
    }
    await view.unmount();
  }
});

test("switching resource tabs aborts file and terminal reads", async () => {
  const reads = [];
  globalThis.fetch = dom.window.fetch = async (url, init = {}) => {
    const route = new URL(url).pathname;
    if (route === "/api/browser")
      return reply({
        name: "Muse",
        expiresAt: Date.now() + 3600000,
        roots: [{ name: "Project", path: "/Project", index: 0 }],
        terminals: [{ id: "reach:one", name: "Logs" }],
        screen: "off",
      });
    if (route === "/api/files" || route.includes("/terminals/"))
      return new Promise((resolve, reject) => {
        reads.push({ route, signal: init.signal });
        init.signal.addEventListener(
          "abort",
          () => reject(new DOMException("Aborted", "AbortError")),
          { once: true },
        );
      });
    return reply({ error: "Unexpected request" }, 404);
  };
  const view = await render(
    React.createElement(BrowserWorkspace, { peer, onEnd() {} }),
  );
  const c = view.container;
  await dom.waitFor(() => tab(c, "Files"));
  await click(tab(c, "Files"));
  await dom.waitFor(() => reads.length === 1);
  assert.equal(reads[0].route, "/api/files");
  await click(tab(c, "Terminal"));
  await dom.waitFor(() => reads.length === 2);
  assert.equal(reads[0].signal.aborted, true);
  assert.equal(reads[1].route, "/api/browser/terminals/reach%3Aone");
  await view.unmount();
  assert.equal(reads[1].signal.aborted, true);
});

test("browser surfaces render without React warnings", () => {
  assert.deepEqual(dom.errors, []);
});
