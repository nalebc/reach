// Reach's real browser extension (browser-extension/) in a VM, against a fake
// `chrome` whose tabs are the tool fixture's jsdom pages, connected to Reach's
// bridge (server/browser-extension.mjs) through a stand-in for the native host
// that relays frames as browser-host.cs does, with Chrome's 1 MB limit toward
// the extension. Everything but the browser and the C# relay is the real code.
import fs from "node:fs";
import net from "node:net";
import vm from "node:vm";
import { webcrypto } from "node:crypto";
import { frame, frameReader } from "../../server/browser-extension.mjs";
import { REPO_EXTENSION_ID, extensionOrigin } from "../../server/browser-extension-ids.mjs";
import { toolBrowserFixture } from "./tool-browser-fixture.mjs";

const source = (name) => fs.readFileSync(new URL(`../../browser-extension/${name}`, import.meta.url), "utf8");
const BROWSER_LIMIT = 1024 * 1024;
const listeners = () => {
  const list = [];
  return { addListener: (f) => list.push(f), fire: (...args) => list.forEach((f) => f(...args)), list };
};

export function fakeChrome(fixture = toolBrowserFixture(), { connectNative } = {}) {
  const store = new Map();
  const tabs = () => fixture.browsers.get("Chrome");
  let active = null, focused = 1, nextWindow = 100;
  const empty = new Set();
  const chromeTab = (tab) => ({
    id: tab.tab, windowId: tab.window, index: tab.index - 1,
    // Without the "tabs" permission Chrome gives addresses only where the
    // extension has host access: https pages.
    url: tab.pending ? "" : /^https:/.test(tab.url) ? tab.url : undefined,
    ...(tab.pending ? { pendingUrl: tab.url, status: "loading" } : {}),
    title: /^https:/.test(tab.url) ? tab.title : undefined,
    active: tab.tab === active,
  });
  const find = (id) => {
    const tab = tabs().find((item) => item.tab === id);
    if (!tab) throw Error(`No tab with id: ${id}.`);
    return tab;
  };
  const chrome = {
    calls: [],
    hang: null,
    fixture,
    runtime: {
      lastError: undefined,
      getManifest: () => ({ version: "0.2.0" }),
      connectNative: (name) => connectNative(name),
      onStartup: listeners(),
      onInstalled: listeners(),
    },
    alarms: { create() {}, onAlarm: listeners() },
    storage: {
      local: {
        async get(keys) { return Object.fromEntries(keys.filter((key) => store.has(key)).map((key) => [key, store.get(key)])); },
        async set(values) { for (const [key, value] of Object.entries(values)) store.set(key, value); },
        async remove(key) { store.delete(key); },
      },
      store,
    },
    windows: {
      WINDOW_ID_NONE: -1,
      onFocusChanged: listeners(),
      async getAll() {
        const ids = new Set([...tabs().map((tab) => tab.window), ...empty]);
        return [...ids].map((id) => ({ id, type: "normal", incognito: false }));
      },
      async getLastFocused() { return { id: focused }; },
      async create({ url }) {
        const tab = fixture.add("Chrome", url);
        tab.window = nextWindow++;
        active = tab.tab;
        return { id: tab.window, tabs: [chromeTab(tab)] };
      },
      async update(id) { focused = id; return { id }; },
    },
    tabs: {
      async query() {
        chrome.calls.push("tabs.query");
        if (chrome.hang) await chrome.hang;
        return tabs().map(chromeTab);
      },
      async get(id) { return chromeTab(find(id)); },
      async create({ windowId, url, active: show }) {
        const tab = fixture.add("Chrome", url);
        tab.window = windowId;
        if (show) active = tab.tab;
        return chromeTab(tab);
      },
      async update(id, { url, active: show }) {
        const tab = find(id);
        if (url) fixture.load(tab, url);
        if (show) active = id;
        return chromeTab(tab);
      },
      async remove(id) {
        const tab = find(id);
        fixture.browsers.set("Chrome", tabs().filter((item) => item !== tab));
      },
    },
    scripting: {
      async executeScript({ target, world, func, args }) {
        chrome.calls.push(`executeScript:${world}`);
        if (world !== "ISOLATED" || target.frameIds?.join() !== "0") throw Error("Only the top frame, isolated world");
        const tab = find(target.tabId);
        // As Chrome does: the function's own source, its arguments as data.
        const result = tab.dom.window.eval(`(${func.toString()})(...${JSON.stringify(args)})`);
        return [{ result }];
      },
    },
    show(id) { active = id; },
    openWindow(id) { empty.add(id); },
  };
  return chrome;
}

/** The extension's code, loaded as Chrome loads its service worker. */
export function loadExtension(chrome, { browser = "Edge" } = {}) {
  const brand = browser === "Edge" ? "Microsoft Edge" : "Google Chrome";
  const navigator = { userAgentData: { brands: [{ brand: "Chromium" }, { brand }] }, userAgent: "" };
  const context = vm.createContext({ crypto: webcrypto, navigator, TextEncoder, TextDecoder, atob, btoa, setTimeout, clearTimeout, console, URL });
  vm.runInContext(source("page-runtime.js"), context, { filename: "page-runtime.js" });
  vm.runInContext(source("reach-extension.js"), context, { filename: "reach-extension.js" });
  return context.reachExtension.create(chrome, { crypto: webcrypto, navigator, version: "0.2.0" });
}

/** A stand-in for browser-host.cs: frames relayed, 1 MB toward the browser. */
export function fakeHost(pipe, { origin = extensionOrigin(REPO_EXTENSION_ID), retry = true } = {}) {
  const host = { sockets: [], ports: [], tooBig: 0, closed: false };
  host.connectNative = () => {
    const onMessage = listeners(), onDisconnect = listeners();
    let open = true, socket = null;
    // As the real host: Reach's pipe dialled again while Reach restarts.
    const dial = () => {
      if (!open || host.closed) return;
      const current = net.connect(pipe);
      socket = current;
      host.sockets.push(current);
      let joined = false;
      current.on("connect", () => {
        joined = true;
        current.write(frame({ type: "host", origin, version: 1 }));
      });
      const read = frameReader((message) => onMessage.fire(message), { max: BROWSER_LIMIT });
      current.on("data", (chunk) => {
        if (!read(chunk)) {
          host.tooBig++;
          current.destroy();
        }
      });
      current.on("error", () => {});
      current.on("close", () => {
        if (!open || host.closed) return;
        if (joined) onMessage.fire({ type: "waiting" });
        if (retry) setTimeout(dial, 50);
      });
    };
    const port = {
      onMessage, onDisconnect,
      postMessage(message) { if (open && socket && !socket.destroyed) socket.write(frame(message)); },
      disconnect() { open = false; socket?.destroy(); },
    };
    host.ports.push(port);
    dial();
    return port;
  };
  host.close = () => {
    host.closed = true;
    for (const socket of host.sockets) socket.destroy();
  };
  return host;
}

export const until = async (check, what = "condition", ms = 5000) => {
  for (const end = Date.now() + ms; ; await new Promise((resolve) => setTimeout(resolve, 10))) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw Error(`timed out waiting: ${what}`);
  }
};
