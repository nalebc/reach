import fs from "node:fs";
import path from "node:path";
import { atomicJson, isPlainRecord } from "./core.mjs";

// Tabs agents opened with reach_open_url (and reach_open_bank), closed once
// they're done with them, so the owner's browser doesn't fill up. Only a tab
// Reach saw appear for that open is the agent's: its tab list before and after
// show one new tab at the exact address asked for. Tabs that were there before, and
// tabs an agent opened some other way (a link, a keyboard shortcut), are
// never touched. Chrome on a Mac (Apple Events, its tabs have stable ids);
// Chrome and Edge on Windows (Reach's extension).
export const AGENT_TAB_IDLE_MS = 5 * 60 * 1000;
// An agent's own tabs open at once: opening one more closes its oldest one
// behind (never the tab in front).
export const AGENT_TABS_EACH = 5;
const AGENT_TABS = 40;
const SWEEP_MS = 30_000;
const tabKey = (tab) => `${tab.window}:${tab.tab}`;
const ownedKey = (tab) => `${tab.browser}:${tabKey(tab)}`;
const pageOf = (url) => {
  try { const value = new URL(url); return ["http:", "https:"].includes(value.protocol) ? value.href : ""; }
  catch { return ""; }
};
const readSavedTabs = (file) => {
  const limit = 256 * 1024;
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
  try {
    const opened = fs.fstatSync(fd, { bigint: true });
    if (!opened.isFile() || opened.size > limit) return [];
    // The descriptor is the read authority. On platforms without O_NOFOLLOW,
    // also reject a symlink or a pathname no longer naming this regular file.
    const linked = fs.lstatSync(file, { bigint: true });
    if (!linked.isFile() || linked.isSymbolicLink() || linked.size > limit || opened.dev !== linked.dev || opened.ino !== linked.ino) return [];
    // A concurrently growing file cannot turn the size check into an
    // unbounded read. Read only this descriptor, never the pathname again.
    const bytes = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = fs.readSync(fd, bytes, length, bytes.length - length, length);
      if (!count) break;
      length += count;
    }
    return length > limit ? [] : JSON.parse(bytes.subarray(0, length).toString("utf8"));
  } finally { fs.closeSync(fd); }
};

// The site an address is on: its host without www., by its last two labels
// (three for names like example.co.uk). Rough on purpose: this only filters
// an explicit close request among tabs whose exact page is still owned.
export const siteOf = (url) => {
  let host;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
  if (!host || /^[\d.]+$/.test(host) || host.includes(":")) return host;
  const labels = host.replace(/^www\./, "").split(".");
  const keep = labels.length > 2 && labels.at(-1).length === 2 && labels.at(-2).length <= 3 ? 3 : 2;
  return labels.slice(-keep).join(".");
};
// The browser whose tabs Reach can list and close, from what opened the page.
export const tabBrowserOf = (bundle, platform = process.platform) => {
  const id = String(bundle || "");
  if (platform === "win32") return /(^|[\\/:])msedge\.exe$/i.test(id) ? "Edge" : /(^|[\\/:])chrome\.exe$/i.test(id) ? "Chrome" : null;
  return id === "com.google.Chrome" || /\/Google Chrome\.app$/.test(id) ? "Chrome" : null;
};
// Said to the agent when a page it opened isn't one Reach can close for it.
export const tabsUnavailable = (platform = process.platform) => platform === "win32"
  ? "Reach closes the tabs you open in Chrome or Edge once Reach's browser extension is on (Agents → Browser tools). Close other tabs yourself when you're done: Ctrl+W with reach_act."
  : "Reach closes the tabs you open in Chrome once Reach may control Chrome (Agents → Browser tools). Close other tabs yourself when you're done: Command+W with reach_act.";

export function createAgentTabs({
  dataDir,
  driver,
  platform = process.platform,
  // Whether Reach may list and close this browser's tabs right now, asking nobody.
  allowed = async () => false,
  // When the agent last acted or looked on this computer (ms), or 0.
  lastSeen = () => 0,
  // Who holds the computer now: { clientId } or null.
  holder = () => null,
  // The owner (or someone they invited) is using the computer through Reach.
  ownerUsing = () => false,
  // Seconds since this computer's own keyboard or mouse was used, or null.
  idle = async () => null,
  track = async (_clientId, work) => work({}),
  now = Date.now,
  record = () => {},
  idleMs = AGENT_TAB_IDLE_MS,
  askMs = 300,
} = {}) {
  const file = path.join(dataDir, "agent-tabs.json");
  const tabs = new Map();
  const pending = new Map();
  const refreshes = new Map();
  const generations = new Map();
  const lifetime = new AbortController();
  let timer = null,
    closed = false,
    sweeping = null;
  try {
    const data = readSavedTabs(file);
    for (const entry of Array.isArray(data) ? data : [])
      if (isPlainRecord(entry) && typeof entry.clientId === "string" && ["Chrome", "Edge"].includes(entry.browser) &&
          Number.isInteger(entry.window) && Number.isInteger(entry.tab) && typeof entry.url === "string" && tabs.size < AGENT_TABS)
        // From before a restart: the browser may have restarted too and
        // handed the same id to another tab, so only the exact page closes.
        tabs.set(ownedKey(entry), { clientId: entry.clientId, browser: entry.browser, window: entry.window, tab: entry.tab,
          url: entry.url, seenAt: now(), restored: true, attempts: 0 });
  } catch {
    /* unreadable: nothing to close */
  }
  const save = () => {
    try {
      atomicJson(file, [...tabs.values()].map(({ clientId, browser, window, tab, url }) => ({ clientId, browser, window, tab, url })));
    } catch {
      /* they still close while Reach runs */
    }
  };
  const check = (options = {}, entry) => {
    if (closed || lifetime.signal.aborted || options.signal?.aborted || ownerUsing())
      throw Object.assign(Error("Tab cleanup is waiting for the person using this computer."), { code: "tab_cleanup_blocked", status: 409, uncertain: false });
    options.guard?.();
    if (entry && tabs.get(ownedKey(entry)) !== entry)
      throw Object.assign(Error("The tracked tab changed before cleanup."), { code: "tab_cleanup_blocked", status: 409, uncertain: false });
  };
  const transport = (browser, request, timeoutMs = 4000, options) => driver.transport(browser, request, {
    timeoutMs, signal: options?.signal ? AbortSignal.any([lifetime.signal, options.signal]) : lifetime.signal,
    ...(options?.retirement ? { retirement: options.retirement } : {}),
    ...(options ? { beforeSend() {
      try { check(options, options.entry); }
      catch (error) { error.uncertain = false; throw error; }
    } } : {}),
  });
  const list = async (browser, timeoutMs = 4000, options) => {
    try {
      const answer = await transport(browser, { op: "tabs" }, timeoutMs, options);
      return Array.isArray(answer) ? answer : null;
    } catch (error) {
      if (options && error?.code !== "browser_closed") throw error;
      return error?.code === "browser_closed" ? [] : null;
    }
  };
  // Asked of the system at most once a minute (a refusal, every 10 s), and
  // never waited on long: the website opens either way, and an answer still
  // coming is used next time.
  const permits = new Map(), asking = new Map();
  const permitted = async (browser) => {
    const known = permits.get(browser);
    if (known && known.until > now()) return known.value;
    if (!asking.has(browser))
      asking.set(browser, Promise.resolve().then(() => allowed(browser)).then((answer) => answer === true, () => false).then((value) => {
        permits.set(browser, { value, until: now() + (value ? 60_000 : 10_000) });
        asking.delete(browser);
        return value;
      }));
    let late;
    const quick = new Promise((resolve) => { late = setTimeout(resolve, askMs, false); });
    try {
      return await Promise.race([asking.get(browser), quick]);
    } finally {
      clearTimeout(late);
    }
  };
  const candidates = async (browserPath) => {
    const named = browserPath ? tabBrowserOf(browserPath, platform) : null;
    if (browserPath && !named) return [];
    const all = platform === "win32" ? ["Chrome", "Edge"] : ["Chrome"];
    const out = [];
    for (const browser of named ? [named] : all) if (await permitted(browser)) out.push(browser);
    return out;
  };
  const mine = (clientId) => [...tabs.values()].filter((entry) => entry.clientId === clientId);
  const ownerAway = async (clientId) => {
    const seconds = await idle().catch(() => null);
    return Number.isFinite(seconds) && seconds * 1000 + 1500 >= now() - lastSeen(clientId);
  };
  // Close one tab Reach opened for an agent. In front closes only when nobody
  // else has used the computer since that agent's last action. A changed
  // address cannot be attributed to the agent, even within the same site.
  const closeOne = async (entry, live, { front, keepShown, ...options }) => {
    check(options, entry);
    const tab = live.find((item) => tabKey(item) === tabKey(entry));
    if (!tab || tab.url !== entry.url) {
      tabs.delete(ownedKey(entry));
      return false;
    }
    try {
      const effect = ({ signal = options.signal, retirement = options.retirement, guard = options.guard } = {}) => transport(entry.browser, {
        op: "close", target: { window: tab.window, tab: tab.tab }, expectedURL: tab.url, ...(front ? {} : { behind: true }),
      }, 4000, {
        ...options, signal, retirement, entry, guard() {
          guard?.();
          const busy = holder()?.clientId;
          if (front && busy && busy !== entry.clientId)
            throw Object.assign(Error("Another agent is using this computer."), { code: "tab_cleanup_blocked", status: 409, uncertain: false });
        },
      });
      await (options.retirement ? effect() : track(entry.clientId, effect));
      tabs.delete(ownedKey(entry));
      return true;
    } catch (error) {
      // In front while someone else was at the computer: theirs now.
      if (error?.code === "owner_tab") {
        if (!keepShown) tabs.delete(ownedKey(entry));
        return false;
      }
      // A lost acknowledgement does not prove the close was unsent. Retire
      // this ownership record rather than replaying a potentially delivered
      // command. Explicit callers still receive the original broker error.
      if (error?.uncertain !== false) tabs.delete(ownedKey(entry));
      throw error;
    }
  };
  const closeAll = async (entries, front, { keepShown = false, ...options } = {}) => {
    let count = 0;
    try {
      for (const browser of new Set(entries.map((entry) => entry.browser))) {
        check(options);
        const live = await list(browser, 4000, options);
        check(options);
        if (!live) continue;
        for (const entry of entries.filter((item) => item.browser === browser))
          if (await closeOne(entry, live, { front: await front(entry), keepShown, ...options })) count++;
      }
    } finally { save(); }
    return count;
  };
  // Later agent activity does not prove who navigated any tracked tab.
  // Relinquish a changed address rather than adopting an owner's page,
  // including another path, query or fragment on the same origin.
  const refresh = async (clientId, browser, options) => {
    clearTimeout(refreshes.get(clientId));
    refreshes.delete(clientId);
    const live = await list(browser, 4000, options);
    if (closed) return;
    if (options) check(options);
    if (!live) return;
    const byKey = new Map(live.map((tab) => [tabKey(tab), tab]));
    for (const item of mine(clientId).filter((value) => value.browser === browser)) {
      const tab = byKey.get(tabKey(item));
      if (!tab || tab.url !== item.url) tabs.delete(ownedKey(item));
      else Object.assign(item, { seenAt: now(), restored: false });
    }
    save();
  };
  const schedule = () => {
    clearTimeout(timer);
    timer = null;
    if (closed || !tabs.size) return;
    timer = setTimeout(() => void sweep(), SWEEP_MS);
    timer.unref?.();
  };
  // Tabs of agents done with this computer close on their own, with nobody
  // using it through Reach; another agent at work keeps the tab in front.
  const sweepOnce = async () => {
    if (ownerUsing()) return;
    const due = [...tabs.values()].filter((entry) => entry.ended || now() - Math.max(lastSeen(entry.clientId), entry.seenAt) >= idleMs);
    if (!due.length) return;
    const busy = holder()?.clientId;
    const away = new Map();
    const front = async (entry) => {
      if (busy && busy !== entry.clientId) return false;
      if (!away.has(entry.clientId)) away.set(entry.clientId, await ownerAway(entry.clientId));
      return away.get(entry.clientId);
    };
    const count = await closeAll(due, front);
    if (count) record("agent", `Reach closed ${count === 1 ? "a tab" : `${count} tabs`} agents had finished with`);
  };
  const sweep = () => {
    if (closed) return Promise.resolve();
    sweeping ??= sweepOnce().catch(error => {
      if (!closed) record("agent", error?.uncertain ? "A tab close could not be confirmed; it will not be retried." : "Reach left agent tabs open because cleanup could not proceed.");
    }).finally(() => {
      sweeping = null;
      schedule();
    });
    return sweeping;
  };
  schedule();
  return {
    /** Before an agent opens a website: the tabs already there, or null when Reach can't tell. */
    async before(clientId, browserPath) {
      if (closed) return null;
      const seen = {};
      for (const browser of await candidates(browserPath)) {
        // Quick or not at all: the website opens either way.
        const live = await list(browser, 1500);
        if (live) seen[browser] = new Set(live.map(tabKey));
      }
      return Object.keys(seen).length ? { clientId, seen, generation: generations.get(clientId) || 0 } : null;
    },
    /** After the website opened: only a sole new tab at the requested address is attributed to it. */
    after(token, url, result) {
      const browser = tabBrowserOf(result?.bundle, platform);
      const expectedURL = pageOf(url);
      if (closed || !token || !browser || !token.seen[browser] || !expectedURL) return false;
      const work = (async () => {
        for (let attempt = 0; attempt < 3; attempt++) {
          if (attempt) await new Promise((resolve) => setTimeout(resolve, 400));
          const live = await list(browser);
          if (!live || closed || token.generation !== (generations.get(token.clientId) || 0)) return;
          const fresh = live.filter((tab) => !token.seen[browser].has(tabKey(tab)));
          if (fresh.length > 1) return;
          if (fresh.length === 1 && fresh[0].url === expectedURL) {
            const tab = fresh[0];
            const entry = { clientId: token.clientId, browser, window: tab.window, tab: tab.tab, url: tab.url, seenAt: now(), attempts: 0 };
            tabs.set(ownedKey(entry), entry);
            while (tabs.size > AGENT_TABS) tabs.delete(tabs.keys().next().value);
            // Over its own limit: the agent's oldest tab closes, behind only.
            const own = mine(token.clientId);
            if (own.length > AGENT_TABS_EACH && !ownerUsing()) await closeAll(own.slice(0, own.length - AGENT_TABS_EACH), async () => false, { keepShown: true });
            save();
            schedule();
            return;
          }
          // The browser may still be loading the requested address. A page
          // that redirects elsewhere is deliberately left unowned.
        }
      })().catch(() => {}).finally(() => { if (pending.get(token.clientId) === work) pending.delete(token.clientId); });
      pending.set(token.clientId, work);
      return true;
    },
    /** The agent acted in a browser: where its tabs are now, a moment later. */
    activity(clientId, entry) {
      const browser = tabBrowserOf(entry?.bundle, platform);
      if (closed || !browser || !mine(clientId).some((item) => item.browser === browser)) return;
      clearTimeout(refreshes.get(clientId));
      const t = setTimeout(() => void refresh(clientId, browser).catch(() => {}), 2000);
      t.unref?.();
      refreshes.set(clientId, t);
    },
    /** The agent's own ask (reach_close_tabs): its tabs, or those on one site, the one in front too. */
    async closeOwn(clientId, { url, guard, signal, retirement } = {}) {
      const options = { guard, signal, retirement };
      check(options);
      await pending.get(clientId);
      check(options);
      const site = url ? siteOf(url) : "";
      for (const browser of new Set(mine(clientId).map((entry) => entry.browser))) await refresh(clientId, browser, options);
      const own = mine(clientId);
      if (!own.length) return { closed: 0, open: 0, note: "Reach has no tabs it opened for you still open. Tabs opened another way: close them yourself (Command+W or Ctrl+W with reach_act)." };
      const chosen = own.filter((entry) => !site || siteOf(entry.url) === site);
      const count = await closeAll(chosen, async () => true, options);
      schedule();
      return { closed: count, open: mine(clientId).length };
    },
    /** The agent's access ended: its tabs close at the next sweep. */
    endClient(clientId) {
      generations.set(clientId, (generations.get(clientId) || 0) + 1);
      for (const entry of mine(clientId)) entry.ended = true;
      if (tabs.size) void sweep();
    },
    sweep,
    // For tests and Reach's own pages: what is kept, by agent.
    list: () => [...tabs.values()].map(({ clientId, browser, window, tab, url }) => ({ clientId, browser, window, tab, url })),
    stop() {
      closed = true;
      lifetime.abort();
      clearTimeout(timer);
      for (const t of refreshes.values()) clearTimeout(t);
      refreshes.clear();
      // Tabs still open stay saved: the next start closes them.
    },
  };
}
