// An agent asks the owner for a Mac permission it's missing: browser tools
// in Chrome or Safari (macOS Automation and the browser's own "Allow
// JavaScript from Apple Events"), Screen Recording or Accessibility. The
// owner hears on the phone (a notification, a card in Needs you) and taps
// Allow or Not now. Allow does what Reach may do itself: the browser's
// switch flipped and macOS asked (tool-setup.mjs), or the right System
// Settings pane opened on the Mac. macOS's own consent stays the owner's.
// In memory only: a restart forgets the requests, never a permission.
import crypto from "node:crypto";
import os from "node:os";
import { spawn } from "node:child_process";
import { fail, hasReviewControls } from "./core.mjs";
import { desktopBinary } from "./desktop-native.mjs";
import { toolBrowsersFor, toolBrowserWords } from "./tool-protocol.mjs";

export const PERMISSION_NEEDS = ["browser-tools", "screen-recording", "accessibility"];
// Chrome or Safari on a Mac; Chrome or Edge on Windows (Reach's extension).
export const PERMISSION_BROWSERS = ["Chrome", "Safari", "Edge"];
const PANES = {
  "screen-recording": "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
  accessibility: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
};
const PENDING_MS = 30 * 60_000;
const QUIET_MS = 10 * 60_000; // an answer stands this long: no new ping for the same thing
const words = (need, browser) =>
  need === "browser-tools" ? `browser tools in ${browser}` : need === "screen-recording" ? "Screen Recording" : "Accessibility";
// What the owner's Allow will do, said on the card before they tap.
const allowDoes = (need, browser, platform) =>
  need === "browser-tools" && platform === "win32"
    ? `Allow lets Reach's extension in ${browser} connect, or opens its store page in ${browser} on the PC if it isn't added yet: click Add to ${browser} there.`
    : need === "browser-tools"
    ? `Allow turns on ${browser}'s "Allow JavaScript from Apple Events" and asks macOS to let Reach control ${browser}: answer that prompt on the Mac or here.`
    : `Allow opens ${words(need)} in System Settings on the Mac: switch on Terminal (the app Reach runs in) there${need === "screen-recording" ? ", then restart Reach" : ""}.`;
const told = {
  pending: "The owner was asked on their phone. Do something else meanwhile and call this again in a minute for the answer.",
  allowed: "The owner allowed it. macOS may still be asking them on the Mac; retry what needed it, and call this again if it still fails.",
  denied: "The owner said not now. Carry on without it and don't ask again for this task.",
  expired: "The owner didn't answer in time. Ask again only if you still need it.",
};

// Screen Recording and Accessibility as macOS sees them for the app Reach
// runs in: the agent screen helper's own first answer ({accessibility, screen}).
export function macAccess(config) {
  return async () => {
    const binary = await desktopBinary(config, "agent-desktop");
    return new Promise((resolve) => {
      const child = spawn(binary, [], { stdio: ["pipe", "pipe", "ignore"], env: { PATH: "/usr/bin:/bin", LANG: "en_US.UTF-8", HOME: os.homedir() } });
      let out = "", settled = false;
      const done = (value) => { if (!settled) { settled = true; clearTimeout(timer); child.kill(); resolve(value); } };
      const timer = setTimeout(() => done({}), 5000);
      child.stdout.on("data", (chunk) => {
        out += chunk;
        if (out.includes("\n")) { try { done(JSON.parse(out.split("\n")[0])); } catch { done({}); } }
      });
      child.on("error", () => done({}));
      child.on("close", () => done({}));
      child.stdin.end(`${JSON.stringify({ op: "rules", mode: "view" })}\n`);
    });
  };
}
const openSettings = (url) => new Promise((resolve) => {
  const child = spawn("/usr/bin/open", [url], { stdio: "ignore" });
  child.on("error", () => resolve(false));
  child.on("close", (code) => resolve(code === 0));
});

export function createPermissionRequests({
  toolSetup, access = async () => ({}), open = openSettings, notify = () => {}, record = () => {}, now = Date.now, platform = process.platform,
} = {}) {
  const browsersHere = Object.keys(toolBrowsersFor(platform));
  const entries = new Map();
  const agent = (authorize) => {
    const client = authorize();
    if (client?.kind !== "agent" || client.policy?.browser !== true || client.policy.preset === undefined || !client.scopes?.includes("browser:read"))
      throw fail(403, "Only an invited agent asks for permissions.");
    return client;
  };
  const owner = (authorize) => {
    const client = authorize();
    if (client?.kind !== "device" || !client.scopes?.includes("admin")) throw fail(403, "Only the owner answers permission requests.");
    return client;
  };
  const prune = () => {
    for (const [id, entry] of entries) {
      if (entry.status === "pending" && entry.expiresAt <= now()) entry.status = "expired";
      if (now() - entry.createdAt > 24 * 3600_000) entries.delete(id);
    }
  };
  // Whether macOS and the browser already allow it: unknown counts as no.
  const ready = async (need, browser) => {
    try {
      if (need === "browser-tools") {
        const status = await toolSetup.status();
        return status.browsers?.some((entry) => entry.id === browser && entry.ready === true) === true;
      }
      const state = await access();
      return need === "screen-recording" ? state.screen === true : state.accessibility === true;
    } catch { return false; }
  };
  const forAgent = (entry, status = entry.status) => ({
    id: entry.id, need: entry.need, ...(entry.browser ? { browser: entry.browser } : {}), status, message: told[status] || told.pending,
  });
  const forOwner = (entry) => ({
    id: entry.id, agentName: entry.agentName, need: entry.need, ...(entry.browser ? { browser: entry.browser } : {}),
    title: `${entry.agentName} asks for ${words(entry.need, entry.browser)}`, allowDoes: allowDoes(entry.need, entry.browser, platform),
    reason: entry.reason, status: entry.status, createdAt: entry.createdAt, expiresAt: entry.expiresAt,
    ...(entry.answeredAt ? { answeredAt: entry.answeredAt } : {}), ...(entry.next ? { next: entry.next } : {}),
  });
  const api = {
    async request(authorize, input) {
      const client = agent(authorize);
      if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some((key) => !["need", "browser", "reason"].includes(key)))
        throw fail(400, "Send need, reason and, for browser tools, browser.");
      const { need, browser, reason } = input;
      if (!PERMISSION_NEEDS.includes(need)) throw fail(400, `Ask for one of: ${PERMISSION_NEEDS.join(", ")}.`);
      if (need === "browser-tools" ? !browsersHere.includes(browser) : browser !== undefined)
        throw fail(400, need === "browser-tools" ? `Name the browser: ${toolBrowserWords(platform)}.` : "Only browser tools name a browser.");
      if (typeof reason !== "string" || !reason.trim() || reason.length > 300 || hasReviewControls(reason))
        throw fail(400, "Say in a sentence why you need it (up to 300 characters).");
      prune();
      const mine = [...entries.values()].filter((entry) => entry.clientId === client.id);
      const latest = mine.filter((entry) => entry.need === need && entry.browser === browser).at(-1);
      if (await ready(need, browser)) {
        if (latest?.status === "pending") latest.status = "allowed";
        return { need, ...(browser ? { browser } : {}), status: "ready", message: "This Mac already allows it. Retry what needed it." };
      }
      if (latest && (latest.status === "pending" || now() - (latest.answeredAt || latest.createdAt) < QUIET_MS)) return forAgent(latest);
      if (mine.filter((entry) => entry.createdAt > now() - QUIET_MS).length >= 5 || [...entries.values()].filter((entry) => entry.status === "pending").length >= 50)
        throw fail(429, "Too many permission requests. Wait for the owner's answers.");
      const entry = {
        id: crypto.randomUUID(), clientId: client.id, agentName: String(client.name || "An agent").slice(0, 80), need, browser,
        reason: reason.trim(), status: "pending", createdAt: now(), expiresAt: now() + PENDING_MS,
      };
      entries.set(entry.id, entry);
      record("agent", `${entry.agentName} asked for ${words(need, browser)}`);
      try {
        Promise.resolve(notify({
          category: "access", title: `${entry.agentName.slice(0, 48)} asks for ${words(need, browser)}`, body: entry.reason.slice(0, 160),
          icon: "agent", tag: `permission-${entry.id}`, url: `/?page=overview&needs=permission:${entry.id}`,
          actions: [{ action: "open", title: "Review" }],
        })).catch(() => {});
      } catch { /* the card is there without the notification */ }
      return forAgent(entry);
    },
    list(authorize) {
      owner(authorize);
      prune();
      return { permissions: [...entries.values()].map(forOwner).reverse() };
    },
    async decide(authorize, id, input) {
      owner(authorize);
      if (!input || typeof input !== "object" || Object.keys(input).some((key) => key !== "decision") || !["allow", "deny"].includes(input.decision))
        throw fail(400, "Choose allow or deny.");
      prune();
      const entry = entries.get(id);
      if (!entry) throw fail(404, "This request has ended.");
      if (entry.status !== "pending") throw fail(409, "This request was already answered.");
      entry.answeredAt = now();
      if (input.decision === "deny") {
        entry.status = "denied";
        record("agent", `Not now: ${entry.agentName}, ${words(entry.need, entry.browser)}`);
        return forOwner(entry);
      }
      entry.status = "allowed";
      const by_hand = platform === "win32" && entry.need === "browser-tools"
        ? `In Reach on the phone: Agents → Browser tools: add Reach's extension to ${entry.browser} and allow it.`
        : `Open System Settings → Privacy & Security → ${entry.need === "browser-tools" ? "Automation" : words(entry.need)} on the Mac and switch on Terminal${entry.need === "browser-tools" ? ` for ${entry.browser}` : ""}.`;
      try {
        if (entry.need === "browser-tools" && platform === "win32") {
          const result = await toolSetup.enable(entry.browser);
          entry.next = {
            connected: `${entry.browser} is ready for browser tools.`,
            asking: `${entry.browser} is connecting to Reach.`,
            added: `${entry.browser} is opening on the PC; its extension connects once it's open.`,
            missing: `Reach's extension's store page is open in ${entry.browser} on the PC: click Add to ${entry.browser} there.`,
            unpublished: `Reach's extension isn't in ${entry.browser}'s store yet.`,
          }[result.extension] || by_hand;
        } else if (entry.need === "browser-tools") {
          const result = await toolSetup.enable(entry.browser);
          entry.next = result.automation === "allowed" && result.javascript === "on"
            ? `${entry.browser} is ready for browser tools.`
            : result.settings
              ? `Automation settings are open on the Mac: switch on ${entry.browser} under Terminal.`
              : `macOS asks on the Mac whether Reach may control ${entry.browser}: answer it there or here.`;
        } else {
          entry.next = (await open(PANES[entry.need]))
            ? `${words(entry.need)} is open in System Settings on the Mac: switch on Terminal${entry.need === "screen-recording" ? ", then restart Reach" : ""}.`
            : by_hand;
        }
      } catch { entry.next = by_hand; }
      record("agent", `Allowed: ${entry.agentName}, ${words(entry.need, entry.browser)}`);
      return forOwner(entry);
    },
  };
  return api;
}

export function permissionRoutes(app, permissions) {
  app.post("/api/browser/permissions/request", async (req, res) => res.json(await permissions.request(req.reauthorize, req.body)));
  app.get("/api/agents/permissions", (req, res) => res.json(permissions.list(req.reauthorize)));
  app.post("/api/agents/permissions/:id", async (req, res) => res.json(await permissions.decide(req.reauthorize, req.params.id, req.body)));
}
