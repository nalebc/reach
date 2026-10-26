import test from "node:test";
import assert from "node:assert/strict";
import { startDom, settle } from "./dom/harness.mjs";

// "<computer> is within reach" is news only. Oct 25: it appeared at the
// bottom on every open (and seemingly on page changes), over Settings' rows
// and Home's list, while nothing had happened. It is said when a computer is
// new to this phone, or when the computer comes back after the phone showed
// it lost (src/back-within-reach.ts); never on a plain open, a reload or a
// re-join of a computer this phone already has. These run the real
// workspace (src/App.tsx) in jsdom: the live connection and HTTP are
// stand-ins, so this checks when the message is shown, not the network.

const mac = { id: "mac", computerId: "mac-1", name: "Mac", url: "https://reach.test", token: "fixture", platform: "darwin" };
const device = () => ({
  id: "mac", computerId: "mac-1", name: "Mac", platform: "darwin", roots: [], memory: { total: 1, free: 1 },
  network: { connected: true, peers: [] },
  capabilities: { files: true, terminal: true, apps: true, screen: true },
});
const offline = () => new Response(JSON.stringify({ error: "Could not reach your computer." }), {
  status: 503, headers: { "Content-Type": "application/json" },
});

async function workspace({ peers = [mac], routes: extra = {}, reachable = true } = {}) {
  // `openDelay`: how long a new live connection takes to open (a phone's
  // network still waking).
  const net = { up: reachable, openDelay: 5, sockets: new Set(), hits: {} };
  const count = (route, answer) => (...args) => {
    net.hits[route] = (net.hits[route] || 0) + 1;
    return answer(...args);
  };
  const routes = {
    // Every computer's requests come to this one table: each answers as itself.
    "/api/device": count("/api/device", (_init, href) => (!net.up ? offline()
      : href.hostname.startsWith("pc.") ? { ...device(), id: "pc", computerId: "pc-1", name: "PC", platform: "win32" }
        : device())),
    "/api/terminals": () => [],
    "/api/terminals/desktop": () => ({ sessions: [] }),
    "/api/terminals/agents": () => ({ agents: [] }),
    "/api/handoffs": () => [],
    "/api/chats": () => [],
    "/api/codex": () => ({ sessions: [] }),
    "/api/activity": () => ({ activities: [] }),
    "/api/sessions": () => ({ sessions: [], errors: {} }),
    "/api/sessions/health": () => ({ agents: [] }),
    "/api/sessions/logos": () => ({ version: "1", logos: {} }),
    "/api/clients": () => ({ current: "me", clients: [] }),
    "/api/browser/agents": () => ({ agents: [], at: Date.now() }),
    "/api/agents/shortcuts": () => ({ shortcuts: [], running: null }),
    "/api/agents/services": () => ({ access: [] }),
    "/api/fleet/computers": count("/api/fleet/computers", () => ({ computers: [] })),
    ...Object.fromEntries(Object.entries(extra).map(([route, answer]) => [route, count(route, answer)])),
  };
  const dom = await startDom({ mobile: true, routes });
  // The computer's live connection (src/useFleetConnections.ts): it answers
  // with presence while the network is up, and drops when it goes down.
  const socket = globalThis.WebSocket;
  globalThis.WebSocket = class FakeSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    constructor(url) {
      this.url = String(url);
      this.readyState = 0;
      net.sockets.add(this);
      setTimeout(() => {
        if (this.readyState !== 0) return;
        if (!net.up) return this.drop();
        this.readyState = 1;
        this.onopen?.();
      }, net.openDelay);
    }
    send(raw) {
      let message;
      try { message = JSON.parse(raw); } catch { return; }
      if (message?.type === "auth" && this.url.includes("/ws/presence"))
        setTimeout(() => this.readyState === 1 && this.onmessage?.({ data: JSON.stringify({ type: "presence", devices: [] }) }), 5);
    }
    close() { this.drop(); }
    drop() {
      if (this.readyState === 3) return;
      this.readyState = 3;
      net.sockets.delete(this);
      this.onclose?.({ code: 1006 });
    }
  };
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  localStorage.setItem("reach.devices", JSON.stringify(peers));
  localStorage.setItem("reach.active", peers[0].id);
  const { default: App } = await dom.load("/src/App.tsx");
  const view = await dom.render(dom.React.createElement(App));
  let inFront = Date.now();
  // Past the moments after opening (or coming back in front), when a drop is
  // part of opening (src/back-within-reach.ts, OPENING_MS).
  const settled = () => settle(Math.max(0, inFront + 4300 - Date.now()));
  // The phone locks, or Reach goes to the background, then comes back.
  const hidden = (value) => {
    Object.defineProperty(dom.document, "hidden", { configurable: true, get: () => value });
    Object.defineProperty(dom.document, "visibilityState", { configurable: true, get: () => (value ? "hidden" : "visible") });
    if (!value) inFront = Date.now();
    dom.document.dispatchEvent(new dom.window.Event("visibilitychange"));
  };
  const $ = (selector) => dom.document.querySelector(selector);
  const toast = () => $(".toast")?.textContent || "";
  // Home's own word for the computer's live connection.
  // Home says it in its connection line: "Connected" (older Homes: "Online").
  const online = () => /^Connected\b/.test($(".home-connection summary")?.textContent?.trim() || "") ||
    /Online/.test($(".home-live, .main-content")?.textContent || "");
  const goOffline = () => {
    net.up = false;
    for (const s of [...net.sockets]) s.drop();
  };
  const goOnline = () => {
    net.up = true;
    // The phone's network is back: Reach wakes its connections at once.
    dom.window.dispatchEvent(new dom.window.Event("online"));
  };
  const close = async () => {
    await view.unmount();
    globalThis.WebSocket = socket;
    await dom.close();
  };
  return { dom, net, $, toast, online, goOffline, goOnline, settled, hidden, close };
}

test("a normal open says nothing: no toast once Home is up and the fleet pass is done", async () => {
  const { dom, net, toast, online, close } = await workspace();
  try {
    await dom.waitFor(() => dom.document.querySelector(".main-content.page-overview") && online());
    await dom.waitFor(() => net.hits["/api/fleet/computers"] >= 1);
    // Past the time a toast would take to appear after either.
    await settle(400);
    assert.equal(toast(), "", "no toast on a plain open");
    assert.deepEqual(dom.errors, []);
  } finally {
    await close();
  }
});

test("offline, then reconnected: one toast says the computer is back", async () => {
  const { dom, toast, online, goOffline, goOnline, settled, close } = await workspace();
  try {
    await dom.waitFor(() => online());
    await settled();
    goOffline();
    // Home shows it lost, long enough to have been seen.
    await dom.waitFor(() => /Connecting…|Reconnecting…|Connection lost/.test(dom.document.querySelector(".main-content").textContent));
    await settle(1800);
    assert.equal(toast(), "", "nothing said while it's down");
    goOnline();
    await dom.waitFor(() => /Mac is back within reach/.test(toast()));
    assert.deepEqual(dom.errors, []);
  } finally {
    await close();
  }
});

test("a blip too short to see says nothing", async () => {
  const { dom, toast, online, goOffline, goOnline, settled, close } = await workspace();
  try {
    await dom.waitFor(() => online());
    await settled();
    goOffline();
    await settle(30);
    goOnline();
    await dom.waitFor(() => online());
    await settle(1800);
    assert.equal(toast(), "");
    assert.deepEqual(dom.errors, []);
  } finally {
    await close();
  }
});

test("back in front after the background: a live connection that drops and takes a moment to return says nothing", async () => {
  const { dom, net, toast, online, hidden, close } = await workspace();
  try {
    await dom.waitFor(() => online());
    hidden(true);
    await settle(50);
    hidden(false);
    // The phone reports the suspended connection closed only now, and its
    // network takes a moment to wake: the retry opens slowly.
    net.openDelay = 1200;
    for (const s of [...net.sockets]) s.drop();
    await dom.waitFor(() => /Connecting…|Reconnecting…|Connection lost/.test(dom.document.querySelector(".main-content").textContent));
    await dom.waitFor(() => online());
    await settle(1800);
    assert.equal(toast(), "", "coming back in front is a normal open");
    assert.deepEqual(dom.errors, []);
  } finally {
    await close();
  }
});

test("out of reach on opening, then back: the recovery the owner waited for is said", async () => {
  const { dom, $, net, toast, close } = await workspace({ reachable: false });
  try {
    await dom.waitFor(() => /out of reach/.test($(".main-content")?.textContent || ""));
    await settle(1800);
    net.up = true;
    const retry = [...dom.document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Try again");
    retry.click();
    await dom.waitFor(() => /Mac is back within reach/.test(toast()));
    assert.deepEqual(dom.errors, []);
  } finally {
    await close();
  }
});

// A linked computer joins by itself (src/fleet-join.ts). Saved under another
// address, it is joined again on each open; that refresh isn't news.
const linkedPc = (computerId) => ({
  "/api/fleet/computers": () => ({ computers: [{ nodeId: "n-pc", name: "PC", origin: "https://pc.tail1.ts.net", short: "pc", linked: true }] }),
  "/api/fleet/tickets": () => ({ ticket: "ticket" }),
  "/api/auth/method": () => ({ method: "tailscale", eligible: true }),
  "/api/auth/requests": () => ({ id: "r1", secret: "s1", expiresAt: Date.now() + 60000, verification: "1234" }),
  "/api/auth/requests/r1": () => ({ status: "approved", token: "pc-token", device: { id: "pc", computerId, name: "PC", platform: "win32" } }),
});

test("a linked computer this phone already has, joined again: no toast", async () => {
  const savedPc = { id: "pc", computerId: "pc-1", name: "PC", url: "https://pc.tail1.ts.net:8443", token: "old", platform: "win32" };
  const { dom, net, toast, close } = await workspace({ peers: [mac, savedPc], routes: linkedPc("pc-1") });
  try {
    await dom.waitFor(() => net.hits["/api/auth/requests/r1"] >= 1);
    await dom.waitFor(() => JSON.parse(localStorage.getItem("reach.devices")).some((p) => p.token === "pc-token"));
    await settle(300);
    assert.equal(toast(), "");
    assert.equal(JSON.parse(localStorage.getItem("reach.devices")).length, 2, "the same PC, refreshed in place");
    assert.deepEqual(dom.errors, []);
  } finally {
    await close();
  }
});

test("a linked computer new to this phone: it says it's within reach", async () => {
  const { dom, toast, close } = await workspace({ routes: linkedPc("pc-1") });
  try {
    await dom.waitFor(() => /PC is within reach/.test(toast()));
    assert.deepEqual(dom.errors, []);
  } finally {
    await close();
  }
});
