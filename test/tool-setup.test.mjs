import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createToolSetup } from "../server/tool-setup.mjs";
import { createReach } from "../server/index.mjs";
import { ALL_SCOPES } from "../server/core.mjs";
import { startDom, settle } from "./dom/harness.mjs";

// Muse's feedback, Oct 10: saved tools run on the Mac with no round trips,
// once macOS lets Reach control the browser and the browser allows
// JavaScript from Apple Events. Reach reads where each stands (both
// switches, as the Mac has them), asks macOS on request and opens the
// settings; it never grants either itself.
const fake = (answers, { chromeSwitch, safariSwitch } = {}) => {
  const runs = [], opened = [], launched = [];
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "reach-tool-home-"));
  if (chromeSwitch !== undefined) {
    const dir = path.join(home, "Library", "Application Support", "Google", "Chrome");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "Local State"), JSON.stringify({ browser: { allow_javascript_apple_events: chromeSwitch } }));
  }
  const f = {
    runs, opened, launched, home,
    // The Mac's answer, changeable mid-test (what the owner did there).
    answer: null,
    options: {
      platform: "darwin", home,
      exists: (file) => file.includes("Google Chrome") || file.includes("Safari") || fs.existsSync(file),
      run: async (mode, bundle) => { runs.push([mode, bundle]); return f.answer?.(mode, bundle) ?? answers[`${mode}:${bundle}`] ?? { status: null }; },
      open: async () => { opened.push(true); return true; },
      launch: async (app) => { launched.push(app); return true; },
      defaults: async (domain, key) => {
        assert.deepEqual([domain, key], ["com.apple.Safari", "AllowJavaScriptFromAppleEvents"]);
        if (safariSwitch instanceof Error) throw safariSwitch;
        return safariSwitch ?? null;
      },
    },
  };
  return f;
};

test("both switches as the Mac has them; macOS's prompt on request; a closed browser is launched first", async () => {
  const f = fake({ "check:com.google.Chrome": { status: 0 }, "check:com.apple.Safari": { status: -600 },
    "ask:com.apple.Safari": { status: -600 }, "ask:com.google.Chrome": { status: -1743 } }, { chromeSwitch: true });
  let clock = Date.now();
  const setup = createToolSetup({ ...f.options, now: () => clock });
  const status = await setup.status();
  assert.equal(status.available, true);
  assert.deepEqual(status.browsers.map(({ id, automation, javascript, ready }) => [id, automation, javascript, ready]),
    [["Chrome", "allowed", "on", true], ["Safari", "closed", "off", false]]);
  // Shown to the owner only for a browser an agent's tool needed, this week.
  assert.deepEqual(status.browsers.map((b) => b.needed), [false, false]);
  setup.needed("Safari");
  setup.needed("Firefox");
  assert.deepEqual((await setup.status()).browsers.map((b) => b.needed), [false, true]);
  clock += 8 * 86400_000;
  assert.deepEqual((await setup.status()).browsers.map((b) => b.needed), [false, false]);
  assert.match(status.browsers[1].where, /Develop → Allow JavaScript from Apple Events/);
  assert.ok(f.runs.length && f.runs.every(([mode]) => mode === "check"), "checking never prompts");
  // Safari isn't running: launched hidden, then asked; macOS says it hasn't asked yet.
  f.answer = () => (f.launched.length ? { status: -1744 } : { status: -600 });
  assert.deepEqual(await setup.ask("Safari"), { id: "Safari", automation: "ask" });
  assert.deepEqual(f.launched, ["/Applications/Safari.app"]);
  assert.deepEqual(f.opened, []);
  // Turned off before: its settings open on the Mac.
  f.answer = () => ({ status: -1743 });
  assert.deepEqual(await setup.ask("Chrome"), { id: "Chrome", automation: "off", settings: true });
  await assert.rejects(setup.ask("Firefox"), { status: 404 });
  assert.deepEqual(await createToolSetup({ ...f.options, platform: "linux" }).status(), { available: false, browsers: [] });
  assert.deepEqual((await createToolSetup({ ...f.options, exists: () => false }).status()).browsers, []);
});

test("the browser's own switch: Chrome's Local State and Safari's defaults, never claimed on when unreadable", async () => {
  const answers = { "check:com.google.Chrome": { status: 0 }, "check:com.apple.Safari": { status: 0 } };
  const js = async (extra) => (await createToolSetup(fake(answers, extra).options).status()).browsers.map((b) => [b.javascript, b.ready]);
  assert.deepEqual(await js({ chromeSwitch: true, safariSwitch: "1" }), [["on", true], ["on", true]]);
  assert.deepEqual(await js({ chromeSwitch: false, safariSwitch: "0" }), [["off", false], ["off", false]]);
  assert.deepEqual(await js({}), [["off", false], ["off", false]], "never turned on: nothing stored, so off");
  assert.deepEqual(await js({ chromeSwitch: true, safariSwitch: new Error("refused") }), [["on", true], ["unknown", false]]);
  // The check itself can't run (no Command Line Tools): still listed, with why.
  const broken = fake(answers, { chromeSwitch: true, safariSwitch: "1" });
  broken.answer = () => { throw Object.assign(Error("Could not prepare the automation-check helper."), { status: 503 }); };
  const status = await createToolSetup(broken.options).status();
  assert.match(status.problem, /Could not prepare/);
  assert.deepEqual(status.browsers.map((b) => [b.automation, b.javascript, b.ready]), [["unknown", "on", false], ["unknown", "on", false]]);
});

test("only your own devices see or change it", { timeout: 20000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-tool-setup-"));
  const f = fake({ "check:com.google.Chrome": { status: -1744 }, "ask:com.google.Chrome": { status: 0 } }, { chromeSwitch: true });
  const reach = await createReach({ roots: [dir], dataDir: path.join(dir, "private"), port: 0, agentPolicyFile: path.join(dir, "none.json"), toolSetup: f.options });
  await new Promise((r) => reach.server.listen(0, "127.0.0.1", r));
  t.after(async () => { await reach.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const call = (token, method = "GET", body) => new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: reach.server.address().port, path: "/api/agents/tool-setup", method,
      headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) } },
    (res) => { let text = ""; res.on("data", (c) => (text += c)); res.on("end", () => resolve({ status: res.statusCode, json: JSON.parse(text || "null") })); });
    req.once("error", reject);
    req.end(body ? JSON.stringify(body) : undefined);
  });
  const owner = reach.auth.issue("My iPhone", ALL_SCOPES, "device");
  const agent = reach.auth.issue("Builder", ["device", "files:read"], "agent");
  const seen = (await call(owner.token)).json.browsers[0];
  assert.deepEqual([seen.automation, seen.javascript, seen.ready], ["ask", "on", false]);
  assert.equal((await call(agent.token)).status, 403);
  assert.equal((await call(agent.token, "POST", { browser: "Chrome", action: "ask" })).status, 403);
  assert.equal((await call(owner.token, "POST", { browser: "Chrome", action: "grant" })).status, 400);
  const asked = await call(owner.token, "POST", { browser: "Chrome", action: "ask" });
  assert.equal(asked.status, 200, JSON.stringify(asked.json));
  assert.equal(asked.json.automation, "allowed");
});

let dom, React, ToolBrowserSetup;
before(async () => {
  dom = await startDom();
  React = dom.React;
  // jsdom has no modal dialogs; the sheet opens as a plain open dialog.
  dom.window.HTMLDialogElement.prototype.showModal ??= function () { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close ??= function () { this.open = false; };
  ({ default: ToolBrowserSetup } = await dom.load("/src/ToolBrowserSetup.tsx"));
});
after(async () => dom?.close());

test("one row while a browser needs you, a sheet with both switches, nothing once they're ready", async () => {
  const posts = [], toasts = [];
  let chrome = { automation: "ask", javascript: "off" };
  const where = "In Chrome: View → Developer → Allow JavaScript from Apple Events.";
  let needed = false;
  globalThis.fetch = dom.window.fetch = async (url, init = {}) => {
    const reply = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    if (init.method === "POST") { posts.push(JSON.parse(init.body)); chrome = { automation: "allowed", javascript: "off" }; return reply({ id: "Chrome", automation: "allowed" }); }
    return reply({ available: true, browsers: [
      { id: "Chrome", ...chrome, ready: chrome.automation === "allowed" && chrome.javascript === "on", needed, where },
      { id: "Safari", automation: "allowed", javascript: "on", ready: true, needed: false, where: "In Safari: …" },
    ] });
  };
  const peer = { id: "mac", name: "My Mac", url: "https://mac.tail.ts.net:8443", token: "owner", platform: "darwin" };
  // Nothing asked for Chrome yet: no row, however unready it is.
  const quiet = await dom.render(React.createElement(ToolBrowserSetup, { peer }));
  await settle(60);
  assert.equal(quiet.container.textContent, "");
  await quiet.unmount();
  needed = true;
  const view = await dom.render(React.createElement(ToolBrowserSetup, { peer, toast: (message) => toasts.push(message) }));
  const c = view.container;
  await dom.waitFor(() => c.textContent.includes("Browser tools"));
  const row = c.querySelector(".ts-row");
  assert.match(row.textContent, /Browser tools/);
  assert.match(row.textContent, /An agent's tool needs Chrome/);
  assert.match(row.textContent, /Set up/);
  assert.ok(!c.textContent.includes("Ask on the Mac"), "the steps wait in the sheet");
  row.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  await dom.waitFor(() => c.ownerDocument.body.textContent.includes("macOS lets Reach control Chrome"));
  const body = c.ownerDocument.body;
  const button = (label) => [...body.querySelectorAll("button")].find((b) => b.textContent.trim() === label);
  assert.match(body.textContent, /Not asked yet/);
  assert.match(body.textContent, /Allow JavaScript from Apple Events/);
  assert.match(body.textContent, new RegExp(where.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(body.textContent, /SafariReady/);
  assert.ok(button("Ask on the Mac"));
  assert.ok(button("Check"));
  button("Ask on the Mac").dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  await dom.waitFor(() => !button("Ask on the Mac"));
  assert.deepEqual(posts, [{ browser: "Chrome", action: "ask" }]);
  assert.match(body.textContent, /On/);
  // The owner flips the browser's switch at the Mac: Check sees it, and with
  // nothing left to do the sheet closes, the row goes, a toast says so.
  chrome = { automation: "allowed", javascript: "on" };
  button("Check").dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  await dom.waitFor(() => !c.querySelector(".ts-row"));
  assert.deepEqual(toasts, ["Browser tools are ready."]);
  assert.ok(!body.textContent.includes("macOS lets Reach control"), "the sheet closed");
  await settle(20);
  await view.unmount();
});
