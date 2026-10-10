// Agents' saved tools drive Chrome or Safari with Apple Events
// (tool-browser-driver.mjs), which needs two things the owner turns on once:
// macOS Automation (Reach's Terminal may control the browser) and the
// browser's "Allow JavaScript from Apple Events". Reach can't grant either:
// it reads where each stands, shows macOS's own prompt on the Mac when asked
// to, and opens the right System Settings page. The owner clicks there.
import { spawn } from "node:child_process";
import fs from "node:fs";
import { fail } from "./core.mjs";
import { desktopBinary } from "./desktop-native.mjs";
import { TOOL_BROWSERS } from "./tool-protocol.mjs";

const APPS = { Chrome: "/Applications/Google Chrome.app", Safari: "/Applications/Safari.app" };
const STATES = new Map([[0, "allowed"], [-1743, "off"], [-1744, "ask"], [-600, "closed"]]);
// The browser's own switch: never flipped by Reach (it lets anything allowed
// to automate the browser run scripts in every open tab).
export const JAVASCRIPT_SETTING = {
  Chrome: "In Chrome: View → Developer → Allow JavaScript from Apple Events.",
  Safari: "In Safari: Settings → Advanced → Show features for web developers, then Develop → Allow JavaScript from Apple Events.",
};
const AUTOMATION_PANE = "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation";

// One run of the helper. "ask" may wait on the owner at the Mac: after a
// moment it answers "asking" and the prompt stays up until they choose.
function helperRun(config) {
  return async (mode, bundle) => {
    const binary = await desktopBinary(config, "automation-check");
    return new Promise((resolve) => {
      const child = spawn(binary, [bundle, mode], { stdio: ["ignore", "pipe", "ignore"] });
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

export function createToolSetup({ config, run = helperRun(config), open = openPane, exists = fs.existsSync, platform = process.platform } = {}) {
  const browsers = () => Object.entries(TOOL_BROWSERS).filter(([id]) => exists(APPS[id]));
  const state = (answer) => (answer?.asking ? "asking" : STATES.get(answer?.status) || "unknown");
  const browser = (id) => {
    const found = browsers().find(([name]) => name === id);
    if (!found) throw fail(404, "Choose Chrome or Safari, installed on this Mac.");
    return found;
  };
  return {
    async status() {
      if (platform !== "darwin") return { available: false, browsers: [] };
      const list = [];
      for (const [id, bundle] of browsers())
        list.push({ id, automation: state(await run("check", bundle)), javascript: JAVASCRIPT_SETTING[id] });
      return { available: true, browsers: list };
    },
    // macOS's own prompt on the Mac, if it hasn't asked yet; turned off
    // before, the Automation settings open there instead.
    async ask(id) {
      if (platform !== "darwin") throw fail(404, "Saved tools need macOS.");
      const [name, bundle] = browser(id);
      const automation = state(await run("ask", bundle));
      if (automation === "off") return { id: name, automation, settings: await open() };
      return { id: name, automation };
    },
    async settings(id) {
      if (platform !== "darwin") throw fail(404, "Saved tools need macOS.");
      const [name] = browser(id);
      return { id: name, settings: await open() };
    },
  };
}
