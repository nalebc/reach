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
  [...container.querySelectorAll('[role="tab"]')].find(
    (item) => item.textContent.trim() === label,
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

test("Muse invitation copies and shares its actual granted permissions with its scoped link and no-delegation instruction", async (t) => {
  const calls = [];
  let made;
  globalThis.fetch = dom.window.fetch = async (url, init = {}) => {
    const route = new URL(url).pathname;
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push([init.method || "GET", route, body]);
    if (route === "/api/agents/browser-options")
      return reply({
        terminals: [
          { id: "reach:one", name: "Build logs" },
          { id: "desktop:two", name: "Private terminal" },
        ],
        screenAvailable: true, appAccessAvailable: true, apps: [{ id: "safari", name: "Safari", protected: false }],
      });
    if (route === "/api/agents/browser-invitations")
      return reply({
        invitation: secret,
        url: `https://mac.tail.ts.net/agent-browser#invite=${secret}`,
        clientId: "muse",
        expiresAt: Date.now() + 3600000,
        joinBy: Date.now() + 900000,
      });
    return reply({ error: "Unexpected request" }, 404);
  };
  const view = await render(
    React.createElement(BrowserInvite, {
      peer,
      device,
      keyPeer: peer,
      onSetup() {},
      onCreated: (...args) => {
        made = args;
      },
    }),
  );
  const c = view.container;
  assert.equal(c.querySelector('[aria-label="AI browser name"]').value, "Assistant");
  assert.equal(button(c, "Create invite link").disabled, true);
  await click(c.querySelector('[aria-label="Share Project"]'));
  await click(
    [...c.querySelectorAll(".ivt-toggle")]
      .find((item) => item.textContent.startsWith("Build logs"))
      .querySelector("input"),
  );
  await value(c.querySelector('[aria-label="Screen permission"]'), "apps");
  await click(button(c, "Create invite link"));
  assert.deepEqual(
    calls.find(([, route]) => route === "/api/agents/browser-invitations")[2],
    {
      name: "Assistant",
      transport: "funnel",
      ttlSeconds: 900,
      folders: [{ root: 0, path: "" }],
      terminalIds: ["reach:one"],
      screen: "apps",
      appAccess: [],
    },
  );
  const preview = c.querySelector(
    'textarea[aria-label="AI browser invitation message"]',
  );
  const message = preview.value;
  const invite = message.split("\n").at(-1);
  assert.equal(preview.readOnly, true);
  assert.match(message, /^Open this temporary Reach link in your VM browser\./);
  assert.match(
    message,
    /Never invite anyone, delegate access, or share this link or credentials/,
  );
  assert.ok(message.split("\n\n")[0].split(/\s+/).length <= 190);
  assert.match(message, /Apps: none shared yet/);
  assert.match(message, /Files: read\/search\/download only in "\/Users\/me\/Project"/);
  assert.match(message, /Terminal output: 1 selected session, read-only/);
  assert.match(message, /Commands: not enabled/);
  assert.doesNotMatch(message, /full control|unrestricted|request clicks/);
  assert.equal(new URL(invite).pathname, "/agent-browser");
  assert.equal(
    new URLSearchParams(new URL(invite).hash.slice(1)).get("invite"),
    secret,
  );
  assert.equal(
    calls.some(([, route]) => route === "/api/guests/key"),
    false,
  );
  assert.match(
    c.textContent,
    /Match the connection code in Home → Needs you to approve/,
  );
  assert.equal(made[1], invite);
  assert.doesNotMatch(invite, /curl|agent\.mjs|\/agent#/);
  assert.match(c.textContent, /Share selected app windows for viewing/);
  // Unsubmitted edits must not misdescribe the already-issued credential.
  await value(c.querySelector('[aria-label="Screen permission"]'), "apps");
  await click(c.querySelector('[aria-label="Share Project"]'));
  await click([...c.querySelectorAll(".ivt-toggle")].find((item) => item.textContent.startsWith("Build logs")).querySelector("input"));
  assert.equal(preview.value, message, "prompt is frozen to the invitation's actual permissions");
  const nav = dom.window.navigator;
  const priorClipboard = nav.clipboard;
  const priorShare = nav.share;
  t.after(() => {
    nav.clipboard = priorClipboard;
    nav.share = priorShare;
  });
  let copied;
  let shared;
  nav.clipboard = {
    writeText: async (text) => {
      copied = text;
    },
  };
  nav.share = async (payload) => {
    shared = payload;
  };
  assert.equal(
    copied,
    undefined,
    "creating a link does not copy it automatically",
  );
  assert.equal(shared, undefined, "sharing requires a button press");
  await click(button(c, "Copy prompt + link"));
  assert.equal(copied, message);
  assert.ok(button(c, "Copied"));
  await click(button(c, "Share…"));
  assert.deepEqual(shared, { title: "Connect to Reach", text: message });
  nav.share = async () => {
    throw new dom.window.DOMException("User cancelled", "AbortError");
  };
  await click(button(c, "Share…"));
  assert.equal(
    c.querySelector('[role="status"]'),
    null,
    "cancelling sharing is not an error",
  );
  nav.share = async () => {
    throw Error("Share unavailable");
  };
  await click(button(c, "Share…"));
  assert.match(
    c.querySelector('[role="status"]').textContent,
    /Copy the prompt and link/,
  );
  nav.share = undefined;
  copied = undefined;
  await click(button(c, "Share…"));
  assert.equal(
    copied,
    message,
    "no share sheet falls back to copying the complete message",
  );
  nav.clipboard = {
    writeText: async () => {
      throw Error("Clipboard unavailable");
    },
  };
  await click(button(c, "Copied"));
  assert.match(
    c.querySelector('[role="status"]').textContent,
    /Select the message below/,
  );
  assert.equal(
    preview.value,
    message,
    "manual copy fallback keeps the full prompt and link",
  );
  assert.equal(
    calls.filter(([, route]) => route === "/api/agents/browser-invitations")
      .length,
    1,
  );
  await view.unmount();
});

for (const choice of [
  { screen: "off", folder: true, allowed: /Screen: not shared\./ },
  { screen: "apps", folder: false, allowed: /Apps: none shared yet/ },
]) test(`invitation prompt accurately describes ${choice.screen} screen access without inventing other permissions`, async () => {
  let issued;
  globalThis.fetch = dom.window.fetch = async (url, init = {}) => {
    const route = new URL(url).pathname;
    if (route === "/api/agents/browser-options") return reply({ terminals: [], screenAvailable: true, appAccessAvailable: true, apps: [{ id: "safari", name: "Safari", protected: false }] });
    if (route === "/api/agents/browser-invitations") {
      issued = JSON.parse(init.body);
      return reply({ invitation: secret, url: `https://mac.tail.ts.net/agent-browser#invite=${secret}`, clientId: "muse", expiresAt: Date.now() + 3600000, joinBy: Date.now() + 900000 });
    }
    return reply({ error: "Unexpected request" }, 404);
  };
  const view = await render(React.createElement(BrowserInvite, { peer, device, keyPeer: peer, onSetup() {}, onCreated() {} }));
  const c = view.container;
  await dom.waitFor(() => c.querySelector('[aria-label="Screen permission"]'));
  if (choice.folder) await click(c.querySelector('[aria-label="Share Project"]'));
  await value(c.querySelector('[aria-label="Screen permission"]'), choice.screen);
  await click(button(c, "Create invite link"));
  const message = c.querySelector('[aria-label="AI browser invitation message"]').value;
  assert.equal(issued.screen, choice.screen);
  assert.match(message, choice.allowed);
  assert.match(message, choice.folder ? /Files: read\/search\/download only in "\/Users\/me\/Project"/ : /Files: not shared\./);
  assert.match(message, /Terminal output: not shared\./);
  assert.match(message, /Commands: not enabled\./);
  assert.match(message, /Never invite anyone, delegate access, or share this link or credentials/);
  assert.doesNotMatch(message, /full control|unrestricted|run shell commands/i);
  assert.ok(message.split("\n\n")[0].split(/\s+/).length <= 190);
  assert.equal(new URL(message.split("\n").at(-1)).pathname, "/agent-browser");
  await view.unmount();
});

test("invitation prompt includes the restricted command grant separately from shared terminal output", async () => {
  let issued;
  globalThis.fetch = dom.window.fetch = async (url, init = {}) => {
    const route = new URL(url).pathname;
    if (route === "/api/agents/browser-options") return reply({ terminals: [{ id: "reach:one", name: "Build logs" }], screenAvailable: true, appAccessAvailable: true, apps: [{ id: "safari", name: "Safari", protected: false }] });
    if (route === "/api/agents/browser-invitations") {
      issued = JSON.parse(init.body);
      return reply({ invitation: secret, url: `https://mac.tail.ts.net/agent-browser#invite=${secret}`, clientId: "muse", expiresAt: Date.now() + 3600000, joinBy: Date.now() + 900000 });
    }
    return reply({ error: "Unexpected request" }, 404);
  };
  const view = await render(React.createElement(BrowserInvite, { peer, device, keyPeer: peer, onSetup() {}, onCreated() {} }));
  const c = view.container;
  await dom.waitFor(() => c.querySelector('[aria-label="Screen permission"]'));
  await click(c.querySelector('[aria-label="Share Project"]'));
  await click([...c.querySelectorAll(".ivt-toggle")].find((item) => item.textContent.startsWith("Build logs")).querySelector("input"));
  await value(c.querySelector('[aria-label="Screen permission"]'), "apps");
  await click([...c.querySelectorAll(".ivt-disclosure")].at(-1).querySelector('input[type="checkbox"]'));
  await click(button(c, "Create invite link"));
  const message = c.querySelector('[aria-label="AI browser invitation message"]').value;
  assert.equal(issued.restrictedTerminal, true);
  assert.equal(issued.screen, "apps");
  assert.match(message, /Apps: none shared yet/);
  assert.match(message, /Files: read\/search\/download only in "\/Users\/me\/Project"/);
  assert.match(message, /Terminal output: 1 selected session, read-only/);
  assert.match(message, /Commands: supported read-only commands run directly in shared folders; other commands are blocked/);
  assert.match(message, /Terminal commands cannot access outside these folders, even with approval/);
  assert.doesNotMatch(message, /Commands: not enabled|full control|unrestricted|run shell commands/i);
  assert.ok(message.split("\n\n")[0].split(/\s+/).length <= 190);
  await view.unmount();
});

test("invitation combines screen approval and approved file changes without widening folder access", async () => {
  let issued;
  globalThis.fetch = dom.window.fetch = async (url, init = {}) => {
    const route = new URL(url).pathname;
    if (route === "/api/agents/browser-options") return reply({ terminals: [], screenAvailable: true, appAccessAvailable: true, apps: [{ id: "safari", name: "Safari", protected: false }] });
    if (route === "/api/agents/browser-invitations") {
      issued = JSON.parse(init.body);
      return reply({ invitation: secret, url: `https://mac.tail.ts.net/agent-browser#invite=${secret}`, clientId: "muse", expiresAt: Date.now() + 3600000, joinBy: Date.now() + 900000 });
    }
    return reply({ error: "Unexpected request" }, 404);
  };
  const view = await render(React.createElement(BrowserInvite, { peer, device, keyPeer: peer, onSetup() {}, onCreated() {} }));
  const c = view.container;
  await dom.waitFor(() => c.querySelector('[aria-label="Screen permission"]'));
  await click(c.querySelector('[aria-label="Share Project"]'));
  await value(c.querySelector('[aria-label="Screen permission"]'), "apps");
  await click([...c.querySelectorAll(".ivt-toggle")].find((item) => item.textContent.startsWith("Commands with approval")).querySelector("input"));
  assert.equal(c.querySelector('[aria-label="Screen permission"]').value, "apps", "terminal access must not downgrade screen control");
  await click(button(c, "Create invite link"));
  assert.equal(issued.restrictedTerminal, true);
  assert.equal(issued.terminalApproval, true);
  assert.equal(issued.scriptApproval, true);
  assert.equal(issued.screen, "apps");
  const message = c.querySelector('[aria-label="AI browser invitation message"]').value;
  assert.match(message, /Other eligible apps are hidden; ask to view/);
  assert.match(message, /file changes and scripts ask for approval once/);
  assert.match(message, /Terminal commands cannot access outside these folders, even with approval/);
  assert.match(message, /Files: read\/search\/download only in "\/Users\/me\/Project"/);
  assert.doesNotMatch(message, /full control|unrestricted|other commands require owner approval/i);
  assert.ok(message.split("\n\n")[0].split(/\s+/).length <= 190);
  await click([...c.querySelectorAll(".ivt-toggle")].find((item) => item.textContent.startsWith("Run read-only commands")).querySelector("input"));
  assert.equal([...c.querySelectorAll(".ivt-toggle")].find((item) => item.textContent.startsWith("Commands with approval")).querySelector("input").checked, false, "turning command access off clears file-change approval scope");
  assert.equal(c.querySelector('[aria-label="AI browser invitation message"]').value, message);
  await view.unmount();
});

test("AI browser invite works without OAuth key setup and cancels malformed gateway links", async () => {
  let setup = 0;
  globalThis.fetch = dom.window.fetch = async () =>
    reply({ terminals: [], screenAvailable: false });
  let view = await render(
    React.createElement(BrowserInvite, {
      peer,
      device,
      keyPeer: null,
      onSetup: () => setup++,
      onCreated() {},
    }),
  );
  await click(view.container.querySelector('[aria-label="Share Project"]'));
  assert.equal(button(view.container, "Create invite link").disabled, false);
  assert.equal(button(view.container, "Set up invite links"), undefined);
  assert.equal(setup, 0);
  await view.unmount();
  const calls = [];
  globalThis.fetch = dom.window.fetch = async (url, init = {}) => {
    const route = new URL(url).pathname;
    calls.push([init.method || "GET", route]);
    if (route === "/api/agents/browser-options")
      return reply({ terminals: [], screenAvailable: false });
    if (route === "/api/agents/browser-invitations")
      return reply({
        invitation: secret,
        url: `https://mac.tail.ts.net/owner#invite=${secret}`,
        clientId: "muse",
        expiresAt: Date.now() + 3600000,
        joinBy: Date.now() + 900000,
      });
    return reply({ ok: true });
  };
  view = await render(
    React.createElement(BrowserInvite, {
      peer,
      device,
      keyPeer: peer,
      onSetup() {},
      onCreated() {
        assert.fail("Should not create link");
      },
    }),
  );
  await click(view.container.querySelector('[aria-label="Share Project"]'));
  await click(button(view.container, "Create invite link"));
  assert.ok(
    calls.some(
      ([method, route]) => method === "DELETE" && route === "/api/clients/muse",
    ),
  );
  assert.match(
    view.container.querySelector('[role="alert"]').textContent,
    /temporary connection link could not be prepared/,
  );
  await view.unmount();
});

test("shared files download as authenticated bytes without exposing a credential link", async (t) => {
  const calls = [], saved = [];
  const oldClick = dom.window.HTMLAnchorElement.prototype.click;
  const oldCreate = URL.createObjectURL;
  const oldTimeout = globalThis.setTimeout;
  let payload;
  URL.createObjectURL = (blob) => { payload = blob; return "blob:shared-download"; };
  dom.window.HTMLAnchorElement.prototype.click = function () { saved.push({ href: this.href, name: this.download }); };
  globalThis.setTimeout = (fn, ms, ...args) => oldTimeout(fn, ms === 60000 ? 0 : ms, ...args);
  t.after(() => {
    URL.createObjectURL = oldCreate;
    dom.window.HTMLAnchorElement.prototype.click = oldClick;
    globalThis.setTimeout = oldTimeout;
  });
  globalThis.fetch = dom.window.fetch = async (url, init = {}) => {
    const u = new URL(url);
    if (u.pathname === "/api/browser") return reply({ name: "Reader", expiresAt: Date.now() + 600000,
      roots: [{ name: "Shared", path: "/Shared", index: 0 }], terminals: [], screen: "off" });
    if (u.pathname === "/api/files") return reply({ items: [{ name: "report.pdf", path: "report.pdf", type: "file" }] });
    if (u.pathname === "/api/files/content") {
      calls.push({ path: u.searchParams.get("path"), root: u.searchParams.get("root"), auth: new Headers(init.headers).get("Authorization") });
      return new Response("pdf bytes", { headers: { "Content-Type": "application/pdf" } });
    }
    return reply({}, 404);
  };
  const view = await render(React.createElement(BrowserWorkspace, { peer, onEnd() {} }));
  await settle(60);
  await click(button(view.container, "Download file report.pdf"));
  assert.deepEqual(calls, [{ path: "report.pdf", root: "0", auth: "Bearer owner" }]);
  assert.deepEqual(saved, [{ href: "blob:shared-download", name: "report.pdf" }]);
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
  await settle(60);
  assert.equal(tab(c, "Screen").getAttribute("aria-selected"), "true");
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
    c.querySelector('[aria-label="Shared terminal"]').value,
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
  await settle(30);
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

test("available permissions choose the initial tab without fetching unshared resources", async () => {
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
    await dom.waitFor(() => calls.length >= 2);
    assert.deepEqual(
      [...c.querySelectorAll('[role="tab"]')].map((item) =>
        item.textContent.trim(),
      ),
      ["Screen", "Files", "Terminal"],
    );
    assert.equal(
      tab(c, permissions.selected).getAttribute("aria-selected"),
      "true",
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
      c.querySelector('[role="tabpanel"]').getAttribute("aria-labelledby"),
      selected.id,
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
