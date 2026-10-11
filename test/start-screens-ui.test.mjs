import test from "node:test";
import assert from "node:assert/strict";
import { startDom, settle } from "./dom/harness.mjs";

// First-run matrix P9: a new phone whose browser blocks site storage (Safari
// with "Block All Cookies", some private modes: even reading localStorage
// throws). Reach can't remember it, but it opens and offers to connect; it
// never shows "This screen couldn't open".
test("storage blocked: a new phone still gets Connect, not a crash screen", async () => {
  const dom = await startDom({
    mobile: true,
    routes: {
      "/api/auth/method": () => ({ eligible: true, method: "tailscale", login: "owner@example.test", name: "Studio" }),
      "/api/health": () => ({ product: "Reach", instance: "i1", name: "Studio" }),
    },
  });
  const blocked = () => {
    throw new dom.window.DOMException("The operation is insecure.", "SecurityError");
  };
  const saved = {};
  for (const name of ["localStorage", "sessionStorage"]) {
    saved[name] = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, get: blocked });
  }
  let view;
  try {
    const { default: App } = await dom.load("/src/App.tsx");
    view = await dom.render(dom.React.createElement(App));
    await settle(300);
    const text = dom.document.body.textContent;
    assert.doesNotMatch(text, /couldn't open/i, text.slice(0, 400));
    assert.deepEqual(dom.errors.filter((e) => !/act\(/.test(e)).map((e) => e.split("\n")[0]), [], "rendered without errors");
    assert.match(text, /Connect/, text.slice(0, 400));
    assert.match(text, /This browser blocks website data, so Reach can't remember it/);
  } finally {
    await view?.unmount().catch(() => {});
    for (const [name, descriptor] of Object.entries(saved))
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    await dom.close();
  }
});

// First-run matrix P6: every screen of the start page a phone without the
// Tailscale app can meet, through the real src/start.ts. The browser's own
// Tailscale (WebAssembly) is a stand-in the test moves from state to state.
const CONFIG = {
  product: "Reach",
  origin: "https://mac.t.ts.net:8443",
  home: "https://mac.t.ts.net",
  name: "Mac A",
  instance: "i1",
  tailnet: { wasm: "client.wasm", exec: "exec.js" },
};
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 Version/26.0 Mobile/15E148 Safari/604.1";
async function startPage({ config = CONFIG, path = "/", wasmFails = false } = {}) {
  const dom = await startDom({
    mobile: true,
    routes: {
      "/reach-start.json": () =>
        config ? new Response(JSON.stringify(config), { status: 200 }) : new Response("Unavailable.", { status: 503 }),
      "/tailnet/client.wasm": () => new Response("wasm"),
      "/api/health": () => new Response("Not found.", { status: 404 }),
    },
  });
  Object.defineProperty(dom.window.navigator, "userAgent", { configurable: true, value: IPHONE });
  // The browser's Tailscale: its loader script "loads", the runtime runs
  // until told to stop, and the node reports what the test says.
  const append = dom.document.head.append.bind(dom.document.head);
  dom.document.head.append = (...nodes) => {
    append(...nodes);
    for (const n of nodes) if (n.tagName === "SCRIPT") queueMicrotask(() => n.onload?.());
  };
  let stop;
  const stopped = new Promise((r) => (stop = r));
  globalThis.Go = class {
    importObject = {};
    run() {
      return stopped;
    }
  };
  const instantiate = WebAssembly.instantiateStreaming;
  WebAssembly.instantiateStreaming = async () => {
    if (wasmFails) throw new Error("no WebAssembly here");
    return { instance: {} };
  };
  const node = {
    status: { self: { state: "NoState", login: "" }, peers: [] },
    calls: [],
    start(cb) {
      this.cb = cb;
    },
    login() {
      this.calls.push("login");
    },
    logout() {
      this.calls.push("logout");
    },
    wake() {},
  };
  globalThis.reachTailnet = () => ({ ...node, start: (cb) => (node.cb = cb), status: () => node.status, login: () => node.calls.push("login"), logout: () => node.calls.push("logout") });
  if (path !== "/") dom.window.history.replaceState(null, "", path);
  dom.document.body.insertAdjacentHTML("beforeend", '<main id="start"></main>');
  dom.window.fetch = globalThis.fetch;
  await dom.load("/src/start.ts");
  const view = dom.document.getElementById("start");
  return {
    dom,
    view,
    node,
    stop: () => stop(),
    text: () => view.textContent,
    action: () => view.querySelector(".start-action"),
    until: (pattern, ms = 5000) => dom.waitFor(() => pattern.test(view.textContent), ms),
    close: async () => {
      WebAssembly.instantiateStreaming = instantiate;
      delete globalThis.Go;
      delete globalThis.reachTailnet;
      await dom.close();
    },
  };
}

test("start page, computer not answering: Reach isn't available, Try again", async () => {
  const page = await startPage({ config: null });
  try {
    await page.until(/Reach isn’t available right now/);
    assert.match(page.text(), /Make sure Reach is running on your computer/);
    assert.equal(page.action().textContent, "Try again");
  } finally {
    await page.close();
  }
});

test("start page, an agent's link opened by a person: says it's for the agent", async () => {
  const page = await startPage({ path: "/agent" });
  try {
    await page.until(/This link is for an AI agent/);
    assert.equal(page.action(), null);
  } finally {
    await page.close();
  }
});

test("start page, no browser client built (no Go on the computer): get the Tailscale app for this phone", async () => {
  const page = await startPage({ config: { ...CONFIG, tailnet: undefined } });
  try {
    await page.until(/Connect to Mac A/);
    assert.match(page.text(), /Install the Tailscale app on this phone/);
    assert.equal(page.action().textContent, "Get Tailscale");
    assert.equal(page.action().getAttribute("href"), "https://apps.apple.com/app/tailscale/id1470499037");
  } finally {
    await page.close();
  }
});

test("start page, without the app: step 1, sign in, joining, waiting for approval, each said", async () => {
  const page = await startPage();
  try {
    await page.dom.waitFor(() => page.node.cb);
    assert.match(page.text(), /Connecting to Mac A…/);
    assert.match(page.text(), /Step 1 of 2 · Join your network/);
    assert.match(page.text(), /Get the Tailscale app/, "the faster way, from the first screen");
    page.node.cb.state("NeedsLogin");
    await page.until(/Sign in with Tailscale/);
    assert.match(page.text(), /Puts this browser on your private network\. Nothing to install\./);
    assert.equal(page.action().getAttribute("aria-busy"), "true", "Preparing sign-in…");
    assert.deepEqual(page.node.calls, ["login"]);
    page.node.cb.authURL("https://login.tailscale.com/a/abc123");
    await page.dom.waitFor(() => page.action()?.getAttribute("href") === "https://login.tailscale.com/a/abc123");
    page.node.cb.state("NeedsMachineAuth");
    await page.until(/Waiting for approval/);
    assert.match(page.text(), /Tailscale admin needs to approve this browser/);
    page.node.cb.state("Starting");
    await page.until(/Joining your network…/);
  } finally {
    await page.close();
  }
});

test("start page, signed in but the computer is off: it's offline, Try again", async () => {
  const page = await startPage();
  try {
    await page.dom.waitFor(() => page.node.cb);
    page.node.status = { self: { state: "Running", login: "owner@example.test" }, peers: [{ dnsName: "mac.t.ts.net.", online: false }] };
    page.node.cb.state("Running");
    await page.until(/Mac A is offline/);
    assert.equal(page.action().textContent, "Try again");
  } finally {
    await page.close();
  }
});

test("start page, signed in with another Tailscale account: says which, offers another account", async () => {
  const page = await startPage();
  try {
    await page.dom.waitFor(() => page.node.cb);
    page.node.status = { self: { state: "Running", login: "someone@else.test" }, peers: [] };
    page.node.cb.state("Running");
    await page.until(/This account can’t reach Mac A/, 8000);
    assert.match(page.text(), /Signed in as someone@else\.test/);
    page.action().click();
    assert.deepEqual(page.node.calls, ["logout"]);
  } finally {
    await page.close();
  }
});

test("start page, a browser that can't run WebAssembly (Lockdown Mode): says so, offers the app", async () => {
  const page = await startPage({ wasmFails: true });
  try {
    await page.until(/This browser couldn’t start the secure connection/);
    assert.match(page.text(), /Try again, or use the Tailscale app/);
    assert.match(page.text(), /Get the Tailscale app/);
  } finally {
    await page.close();
  }
});

test("start page, the browser's connection stops: Reconnect", async () => {
  const page = await startPage();
  try {
    await page.dom.waitFor(() => page.node.cb);
    page.stop();
    await page.until(/Connection stopped/);
    assert.equal(page.action().textContent, "Reconnect");
  } finally {
    await page.close();
  }
});
