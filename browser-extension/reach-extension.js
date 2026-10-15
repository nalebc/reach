// Reach's browser extension (docs/parity/G-browser-tools.md): the Windows
// transport for agents' saved tools, as Apple Events are on a Mac. It talks
// only to Reach's own server on this computer, through Reach's native host,
// and only after both sides proved the secret the owner approved in Reach.
// The only code it ever runs in a page is toolPageOperation (page-runtime.js,
// generated from Reach's server/tool-page-runtime.mjs); requests carry data.
/* global globalThis */
(function () {
  "use strict";
  const HOST = "com.reach.browser_tools";
  const LABEL = "reach.browser.v1";
  const CHUNK_LIMIT = 16 * 1024 * 1024;
  // The same fixed words the Mac's JXA transport uses (tool-browser-driver.mjs
  // FIXED_DETAILS), so Reach maps them identically.
  const WINDOW_GONE = "The target browser window is gone.";
  const TAB_GONE = "The target tab is gone.";
  const TAB_CHANGED = "The target tab changed. No action was taken.";
  const DOCUMENT_CHANGED = "The target document changed. No action was taken.";
  const UNEXPECTED = "The browser returned an unexpected result.";

  function refusal(message, code, uncertain) {
    return { publicMessage: message, code: code || "browser_changed", uncertain: uncertain === true };
  }
  const hex = (bytes) => Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
  function same(a, b) {
    if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
  }

  function create(chrome, { crypto = globalThis.crypto, navigator = globalThis.navigator, runtime = globalThis.toolPageOperation, version } = {}) {
    let port = null,
      // This connection asked to pair: only then may Reach hand it a secret.
      asked = false,
      // Reach proved itself on this connection: only then are requests run.
      trusted = false,
      reachNonce = null,
      ownNonce = null,
      secret = null,
      installId = null;
    const chunks = new Map();
    const cancelled = new Set();
    const browserName = () => {
      const brands = (navigator && navigator.userAgentData && navigator.userAgentData.brands) || [];
      const names = brands.map((brand) => String(brand.brand || ""));
      if (names.some((name) => /Edge/i.test(name))) return "Edge";
      if (names.some((name) => /Chrome/i.test(name))) return "Chrome";
      const agent = String((navigator && navigator.userAgent) || "");
      if (/\bEdg\//.test(agent)) return "Edge";
      if (/\bChrome\//.test(agent)) return "Chrome";
      return "Chromium";
    };
    const nonce = () => {
      const bytes = new Uint8Array(32);
      crypto.getRandomValues(bytes);
      return hex(bytes);
    };
    async function hmac(key, text) {
      const raw = new Uint8Array(key.match(/../g).map((pair) => parseInt(pair, 16)));
      const imported = await crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
      return hex(await crypto.subtle.sign("HMAC", imported, new TextEncoder().encode(text)));
    }
    async function load() {
      const stored = await chrome.storage.local.get(["installId", "secret"]);
      installId = typeof stored.installId === "string" && /^[0-9a-f-]{36}$/.test(stored.installId) ? stored.installId : null;
      if (!installId) {
        installId = crypto.randomUUID();
        await chrome.storage.local.set({ installId });
      }
      secret = typeof stored.secret === "string" && /^[0-9a-f]{64}$/.test(stored.secret) ? stored.secret : null;
    }
    const send = (message) => {
      try {
        if (port) port.postMessage(message);
      } catch (error) {
        // A closed port: Reach is gone; the next connect starts over.
      }
    };
    async function hello() {
      ownNonce = nonce();
      const base = { type: "hello", installId, browser: browserName(), version, nonce: ownNonce };
      asked = !secret;
      if (!secret) return send(Object.assign(base, { pair: true }));
      send(Object.assign(base, { proof: await hmac(secret, `${LABEL}|extension|${reachNonce}|${ownNonce}|${installId}`) }));
    }

    // --- The browser operations (the JXA worker's, by the same names) -----
    const record = (tab) => ({ window: tab.windowId, tab: tab.id, index: tab.index + 1, url: tab.url || "", title: tab.title || "" });
    const normal = async () => (await chrome.windows.getAll({ windowTypes: ["normal"] })).filter((window) => !window.incognito);
    async function target(request) {
      const wanted = request.target || {};
      if (!Number.isInteger(wanted.window) || !Number.isInteger(wanted.tab)) throw refusal(TAB_GONE);
      const windows = await normal();
      if (!windows.some((window) => window.id === wanted.window)) throw refusal(WINDOW_GONE);
      let tab;
      try {
        tab = await chrome.tabs.get(wanted.tab);
      } catch (error) {
        throw refusal(TAB_GONE);
      }
      if (!tab || tab.windowId !== wanted.window) throw refusal(TAB_GONE);
      return tab;
    }
    async function inPage(tab, func, args) {
      const results = await chrome.scripting.executeScript({ target: { tabId: tab.id, frameIds: [0] }, world: "ISOLATED", func, args });
      const value = results && results[0] && results[0].result;
      if (typeof value !== "string") throw refusal(UNEXPECTED, "browser_changed", true);
      return value;
    }
    // A fixed reader of the interpreter's own state: which document it bound.
    function boundDocument() {
      const state = globalThis.__reach_tool_protocol_v1__;
      return JSON.stringify(state ? state.document : null);
    }
    async function checked(request) {
      const tab = await target(request);
      if (request.expectedURL !== undefined && tab.url !== request.expectedURL) throw refusal(TAB_CHANGED);
      if (request.expectedDocument !== undefined) {
        let bound = null;
        try {
          bound = JSON.parse(await inPage(tab, boundDocument, []));
        } catch (error) {
          throw refusal(DOCUMENT_CHANGED);
        }
        if (bound !== request.expectedDocument) throw refusal(DOCUMENT_CHANGED);
      }
      return tab;
    }
    const operations = {
      async preflight(request) {
        if (!/^[0-9a-f-]{36}$/i.test(request.probeId || "")) throw refusal("The browser setup check is invalid.", "invalid");
        const windows = await normal();
        if (request.window !== undefined) {
          if (!windows.some((window) => window.id === request.window)) throw refusal(WINDOW_GONE);
          return { ok: true };
        }
        if (!windows.length)
          throw refusal(`The owner needs to open a ${browserName()} window and select a profile before using browser tools.`, "browser_window_required");
        return { ok: true };
      },
      async tabs() {
        const windows = new Set((await normal()).map((window) => window.id));
        return (await chrome.tabs.query({})).filter((tab) => windows.has(tab.windowId)).map(record);
      },
      async create(request) {
        const windows = await normal();
        const background = request.background === true;
        if (!windows.length) {
          const window = await chrome.windows.create({ url: request.url, focused: !background, type: "normal" });
          const first = window && window.tabs && window.tabs[0];
          if (!first) throw refusal("The new browser window has not acknowledged creation. Inspect it before continuing.", "browser_changed", true);
          return record(first);
        }
        let front;
        try {
          front = await chrome.windows.getLastFocused({ windowTypes: ["normal"] });
        } catch (error) {
          front = null;
        }
        const window = front && windows.some((candidate) => candidate.id === front.id) ? front : windows[0];
        return record(await chrome.tabs.create({ windowId: window.id, url: request.url, active: !background }));
      },
      async info(request) {
        return record(await target(request));
      },
      async navigate(request) {
        const tab = await checked(request);
        return record(await chrome.tabs.update(tab.id, { url: request.url }));
      },
      async focus(request) {
        const tab = await checked(request);
        const shown = await chrome.tabs.update(tab.id, { active: true });
        await chrome.windows.update(tab.windowId, { focused: true });
        return record(shown);
      },
      async page(request) {
        const tab = await checked(request);
        if (typeof runtime !== "function") throw refusal(UNEXPECTED, "browser_changed", true);
        // The raw answer is the interpreter's own JSON, as on a Mac.
        return { raw: await inPage(tab, runtime, [request.request]) };
      },
      async document(request) {
        const tab = await target(request);
        return { raw: await inPage(tab, boundDocument, []) };
      },
      async close(request) {
        const tab = await checked(request);
        // A batch tab the owner brought forward is theirs now: it stays open.
        if (request.behind === true && tab.active) throw refusal("The owner is looking at this tab.", "owner_tab");
        await chrome.tabs.remove(tab.id);
        return {};
      },
    };
    async function run(request) {
      if (!request || typeof request !== "object" || !Object.prototype.hasOwnProperty.call(operations, request.op))
        return JSON.stringify({ error: "Unknown browser transport operation.", code: "invalid", uncertain: false });
      try {
        const result = await operations[request.op](request);
        return result && typeof result.raw === "string" ? result.raw : JSON.stringify(result);
      } catch (error) {
        if (error && error.publicMessage)
          return JSON.stringify({ error: error.publicMessage, code: error.code, uncertain: error.uncertain === true });
        // Never the browser's own exception text: it can hold addresses.
        const check = ["preflight", "tabs", "info", "document"].includes(request.op);
        return JSON.stringify({
          error: "The browser command could not be verified. Inspect the browser before continuing.",
          code: "browser_changed",
          uncertain: !check,
        });
      }
    }

    // --- Reach's messages ----------------------------------------------------
    // One message at a time, in order: a request right behind Reach's proof
    // waits for the proof to be checked. Requests themselves run alongside.
    let queue = Promise.resolve();
    const receive = (message) => (queue = queue.then(() => handle(message)).catch(() => {}));
    async function handle(message) {
      if (!message || typeof message !== "object") return;
      if (message.type === "chunk") {
        // A message too big for one native message (an 8 MB attachment).
        const { id, index, count, data } = message;
        if (typeof id !== "string" || !Number.isInteger(index) || !Number.isInteger(count) || count < 1 || count > 64 || index < 0 || index >= count || typeof data !== "string") return;
        let entry = chunks.get(id);
        if (!entry) {
          if (chunks.size >= 4) chunks.clear();
          entry = { count, parts: new Array(count), size: 0, have: 0 };
          chunks.set(id, entry);
        }
        if (entry.count !== count || entry.parts[index] !== undefined) return chunks.delete(id);
        entry.parts[index] = data;
        entry.have++;
        entry.size += data.length;
        if (entry.size > CHUNK_LIMIT * 1.4) return chunks.delete(id);
        if (entry.have < count) return;
        chunks.delete(id);
        let whole;
        try {
          const binary = atob(entry.parts.join(""));
          const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
          whole = JSON.parse(new TextDecoder().decode(bytes));
        } catch (error) {
          return;
        }
        if (whole && whole.type !== "chunk") return handle(whole);
        return;
      }
      if (message.type === "waiting") {
        // The host lost Reach (restarting): nothing runs until it proves itself again.
        trusted = false;
        return;
      }
      if (message.type === "challenge" && typeof message.nonce === "string" && /^[0-9a-f]{64}$/.test(message.nonce)) {
        trusted = false;
        reachNonce = message.nonce;
        return hello();
      }
      if (message.type === "paired" && asked && typeof message.secret === "string" && /^[0-9a-f]{64}$/.test(message.secret) && /^[0-9a-f]{64}$/.test(message.nonce || "")) {
        // The owner allowed this browser in Reach: kept for every later connection.
        secret = message.secret;
        await chrome.storage.local.set({ secret });
        trusted = false;
        reachNonce = message.nonce;
        return hello();
      }
      if (message.type === "unknown" && /^[0-9a-f]{64}$/.test(message.nonce || "")) {
        // Reach no longer knows this browser's secret: the owner allows it again.
        secret = null;
        await chrome.storage.local.remove("secret");
        trusted = false;
        reachNonce = message.nonce;
        return hello();
      }
      if (message.type === "ready") {
        if (!secret || !reachNonce || !ownNonce) return;
        const expected = await hmac(secret, `${LABEL}|reach|${ownNonce}|${reachNonce}|${installId}`);
        trusted = same(expected, message.proof);
        if (!trusted) disconnect();
        return;
      }
      if (message.type === "cancel" && typeof message.id === "string") {
        cancelled.add(message.id);
        if (cancelled.size > 256) cancelled.clear();
        return;
      }
      if (message.type === "request" && typeof message.id === "string") {
        if (!trusted)
          return send({ type: "response", id: message.id, raw: JSON.stringify({ error: "Reach has not proven itself to this browser.", code: "setup_required", uncertain: false }) });
        respond(message.id, message.request);
        return;
      }
    }
    async function respond(id, request) {
      const raw = await run(request);
      // Reach gave up on it (timed out, cancelled): its answer isn't sent.
      if (cancelled.delete(id)) return;
      send({ type: "response", id, raw });
    }
    function disconnect() {
      trusted = false;
      const old = port;
      port = null;
      try {
        if (old) old.disconnect();
      } catch (error) {
        /* already closed */
      }
    }
    // One port at a time, however many events ask for it at once.
    let connecting = null;
    function connect() {
      if (port) return Promise.resolve();
      if (!connecting) connecting = open().finally(() => { connecting = null; });
      return connecting;
    }
    async function open() {
      await load();
      try {
        port = chrome.runtime.connectNative(HOST);
      } catch (error) {
        port = null;
        return;
      }
      const mine = port;
      mine.onMessage.addListener((message) => {
        if (port === mine) receive(message).catch(() => {});
      });
      mine.onDisconnect.addListener(() => {
        // Reading lastError keeps Chrome from logging it as unchecked.
        void chrome.runtime.lastError;
        if (port === mine) {
          port = null;
          trusted = false;
        }
      });
    }
    function start() {
      chrome.alarms.create("reach-connect", { periodInMinutes: 1 });
      chrome.alarms.onAlarm.addListener((alarm) => {
        if (alarm.name === "reach-connect") connect();
      });
      chrome.runtime.onStartup.addListener(() => connect());
      chrome.runtime.onInstalled.addListener(() => connect());
      chrome.windows.onFocusChanged.addListener((id) => {
        if (trusted && id !== chrome.windows.WINDOW_ID_NONE) send({ type: "focus" });
      });
      return connect();
    }
    return { start, connect, receive, run, state: () => ({ trusted, connected: !!port, paired: !!secret, installId }) };
  }
  globalThis.reachExtension = { create, HOST };
})();
