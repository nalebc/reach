// Agents' saved tools drive Chrome or Safari with Apple Events
// (tool-browser-driver.mjs), which needs two things turned on once: macOS
// Automation (Reach's Terminal may control the browser) and the browser's
// own "Allow JavaScript from Apple Events". From the owner's one tap
// (enable), Reach flips the browser's switch for them and asks macOS, whose
// own prompt they answer, on the Mac or from the phone (mac-prompts.mjs).
// macOS's consent is never pressed by Reach itself.
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fail } from "./core.mjs";
import { desktopBinary } from "./desktop-native.mjs";
import { TOOL_BROWSERS } from "./tool-protocol.mjs";

const APPS = { Chrome: "/Applications/Google Chrome.app", Safari: "/Applications/Safari.app" };
// The browser's own switch, in its menus (reached through Accessibility).
const MENUS = { Chrome: ["View", "Developer", "Allow JavaScript from Apple Events"], Safari: ["Develop", "Allow JavaScript from Apple Events"] };
const STATES = new Map([[0, "allowed"], [-1743, "off"], [-1744, "ask"], [-600, "closed"]]);
// Where each browser's own switch is. Never flipped by Reach: on, anything
// macOS lets control the browser can run scripts in its tabs.
export const JAVASCRIPT_SETTING = {
  Chrome: "In Chrome: View → Developer → Allow JavaScript from Apple Events.",
  Safari: "In Safari: Settings → Advanced → Show features for web developers, then Develop → Allow JavaScript from Apple Events.",
};
const AUTOMATION_PANE = "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation";

// One run of the helper. "ask" may wait on the owner at the Mac: after a
// moment it answers "asking" and the prompt stays up until they choose.
function helperRun(config) {
  return async (mode, bundle, ...path) => {
    const binary = await desktopBinary(config, "automation-check");
    return new Promise((resolve) => {
      const child = spawn(binary, [bundle, mode, ...path], { stdio: ["ignore", "pipe", "ignore"] });
      let out = "", settled = false;
      const done = (value) => { if (!settled) { settled = true; resolve(value); } };
      const hard = setTimeout(() => child.kill(), 120000);
      hard.unref();
      const soft = setTimeout(() => done({ asking: true }), mode === "ask" ? 2500 : 8000);
      child.stdout.on("data", (chunk) => { out += chunk; });
      child.on("error", () => done({ status: null }));
      child.on("close", () => {
        clearTimeout(soft);
        clearTimeout(hard);
        try { done(JSON.parse(out)); } catch { done({ status: null }); }
      });
    });
  };
}
const openPane = () => new Promise((resolve) => {
  const child = spawn("/usr/bin/open", [AUTOMATION_PANE], { stdio: "ignore" });
  child.on("error", () => resolve(false));
  child.on("close", (code) => resolve(code === 0));
});
// A closed browser, launched hidden and in the background: macOS can only
// say whether Reach may control a browser that runs.
const launchHidden = (app) => new Promise((resolve) => {
  const child = spawn("/usr/bin/open", ["-g", "-j", "-a", app], { stdio: "ignore" });
  child.on("error", () => resolve(false));
  child.on("close", (code) => setTimeout(() => resolve(code === 0), 1500));
});
// A browser's own setting, read through the system: null when unset, the
// text when set, an error when it can't be read.
const readDefault = (domain, key) => new Promise((resolve, reject) => {
  execFile("/usr/bin/defaults", ["read", domain, key], { timeout: 5000 }, (error, stdout, stderr) => {
    if (!error) return resolve(String(stdout).trim());
    if (/does not exist/.test(String(stderr))) return resolve(null);
    reject(error);
  });
});
// Safari's switch turned on while Safari is closed (it reads its settings
// when it opens); only ever these two fixed keys.
const writeDefault = (domain, key) => new Promise((resolve) => {
  execFile("/usr/bin/defaults", ["write", domain, key, "-bool", "true"], { timeout: 5000 }, (error) => resolve(!error));
});

const NEEDED_MS = 7 * 86400_000;
export function createToolSetup({
  config, run = helperRun(config), open = openPane, launch = launchHidden, defaults = readDefault, setDefault = writeDefault,
  exists = fs.existsSync, home = os.homedir(), platform = process.platform, now = Date.now,
} = {}) {
  // Which browsers an agent's tool needed and couldn't have, lately: the
  // owner is shown those, not a setup chore for every browser installed.
  const needs = new Map();
  const told = new Map();
  const browsers = () => Object.entries(TOOL_BROWSERS).filter(([id]) => exists(APPS[id]));
  const state = (answer) => (answer?.asking ? "asking" : STATES.get(answer?.status) || "unknown");
  const browser = (id) => {
    const found = browsers().find(([name]) => name === id);
    if (!found) throw fail(404, "Choose Chrome or Safari, installed on this Mac.");
    return found;
  };
  // The browser's own switch: its menu item while it runs (what the browser
  // holds right now), else where it keeps it: Chrome's Local State
  // (browser.allow_javascript_apple_events, absent until first turned on),
  // Safari's defaults (AllowJavaScriptFromAppleEvents). A browser never run
  // has nothing on: off. Unreadable: unknown, never claimed on.
  const javascript = async (id) => {
    try {
      const live = await run("script-status", TOOL_BROWSERS[id], ...MENUS[id]);
      if (live?.javascript === "on" || live?.javascript === "off") return live.javascript;
      if (id === "Chrome") {
        const file = path.join(home, "Library", "Application Support", "Google", "Chrome", "Local State");
        if (!exists(file)) return "off";
        return JSON.parse(fs.readFileSync(file, "utf8"))?.browser?.allow_javascript_apple_events === true ? "on" : "off";
      }
      if (id === "Safari") {
        const value = await defaults("com.apple.Safari", "AllowJavaScriptFromAppleEvents");
        return value === null ? "off" : ["1", "true", "yes"].includes(value.toLowerCase()) ? "on" : "off";
      }
    } catch { /* said as unknown */ }
    return "unknown";
  };
  const entry = (id, automation, js) => ({ id, automation, javascript: js, ready: automation === "allowed" && js === "on",
    needed: now() - (needs.get(id) || 0) < NEEDED_MS, where: JAVASCRIPT_SETTING[id] });
  return {
    // A tool needed this browser: remembered; true when the owner should
    // hear of it (once an hour at most).
    needed(id) {
      if (!Object.hasOwn(APPS, id)) return false;
      needs.set(id, now());
      if (now() - (told.get(id) || 0) < 3600_000) return false;
      told.set(id, now());
      return true;
    },
    async status() {
      if (platform !== "darwin") return { available: false, browsers: [] };
      const list = [];
      try {
        for (const [id, bundle] of browsers())
          list.push(entry(id, state(await run("check", bundle)), await javascript(id)));
      } catch (error) {
        // The check itself can't run yet (no Command Line Tools): the
        // browsers are still listed, with what's missing, not hidden.
        if (error.status !== 503) throw error;
        const listed = [];
        for (const [id] of browsers()) listed.push(entry(id, "unknown", await javascript(id)));
        return { available: true, browsers: listed, problem: error.message };
      }
      return { available: true, browsers: list };
    },
    // macOS's own prompt on the Mac, if it hasn't asked yet (a closed browser
    // is launched hidden first); turned off before, the Automation settings
    // open there instead.
    async ask(id) {
      if (platform !== "darwin") throw fail(404, "Saved tools need macOS.");
      const [name, bundle] = browser(id);
      let automation = state(await run("ask", bundle));
      if (automation === "closed" && (await launch(APPS[name]))) automation = state(await run("ask", bundle));
      if (automation === "off") return { id: name, automation, settings: await open() };
      return { id: name, automation };
    },
    async settings(id) {
      if (platform !== "darwin") throw fail(404, "Saved tools need macOS.");
      const [name] = browser(id);
      return { id: name, settings: await open() };
    },
    // The owner's one tap: the browser's own switch flipped for them (its
    // menu item while it runs, launched hidden first if not; Safari closed:
    // its settings written), then macOS asked, whose prompt they answer.
    async enable(id) {
      if (platform !== "darwin") throw fail(404, "Saved tools need macOS.");
      const [name, bundle] = browser(id);
      let js = await run("script-on", bundle, ...MENUS[name]);
      if (js?.status === -600) {
        if (name === "Safari" && (await setDefault("com.apple.Safari", "IncludeDevelopMenu")) && (await setDefault("com.apple.Safari", "AllowJavaScriptFromAppleEvents")))
          js = { javascript: await javascript(name) };
        else if (await launch(APPS[name])) js = await run("script-on", bundle, ...MENUS[name]);
      }
      const script = js?.javascript === "on" || js?.javascript === "off" ? js.javascript : "unknown";
      const asked = await this.ask(name);
      return { id: name, javascript: script, automation: asked.automation, ...(asked.settings !== undefined ? { settings: asked.settings } : {}) };
    },
  };
}
