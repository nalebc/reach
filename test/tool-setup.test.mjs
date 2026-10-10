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
// JavaScript from Apple Events. Reach reads where each stands, asks macOS on
// request and opens the settings; it never grants either itself.
const fake = (answers) => {
  const runs = [], opened = [];
  return {
    runs, opened,
    options: {
      platform: "darwin",
      exists: (app) => app.includes("Google Chrome") || app.includes("Safari"),
      run: async (mode, bundle) => { runs.push([mode, bundle]); return answers[`${mode}:${bundle}`] ?? { status: null }; },
      open: async () => { opened.push(true); return true; },
    },
  };
};

test("where each browser stands, macOS's prompt on request, settings when it was turned off", async () => {
  const f = fake({ "check:com.google.Chrome": { status: 0 }, "check:com.apple.Safari": { status: -1744 },
    "ask:com.apple.Safari": { asking: true }, "ask:com.google.Chrome": { status: -1743 } });
  const setup = createToolSetup(f.options);
  const status = await setup.status();
  assert.equal(status.available, true);
  assert.deepEqual(status.browsers.map(({ id, automation }) => [id, automation]), [["Chrome", "allowed"], ["Safari", "ask"]]);
  assert.match(status.browsers[0].javascript, /View → Developer → Allow JavaScript from Apple Events/);
  assert.deepEqual(f.runs, [["check", "com.google.Chrome"], ["check", "com.apple.Safari"]], "checking never prompts");
  assert.deepEqual(await setup.ask("Safari"), { id: "Safari", automation: "asking" });
  assert.deepEqual(f.opened, []);
  assert.deepEqual(await setup.ask("Chrome"), { id: "Chrome", automation: "off", settings: true }, "turned off before: its settings open");
  await assert.rejects(setup.ask("Firefox"), { status: 404 });
  assert.deepEqual(await createToolSetup({ ...f.options, platform: "linux" }).status(), { available: false, browsers: [] });
  const none = createToolSetup({ ...f.options, exists: () => false });
  assert.deepEqual((await none.status()).browsers, []);
});

test("only your own devices see or change it", { timeout: 20000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-tool-setup-"));
  const f = fake({ "check:com.google.Chrome": { status: -1744 }, "ask:com.google.Chrome": { status: 0 } });
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
  assert.equal((await call(owner.token)).json.browsers[0].automation, "ask");
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
  ({ default: ToolBrowserSetup } = await dom.load("/src/ToolBrowserSetup.tsx"));
});
after(async () => dom?.close());

test("the panel: each browser's state, the one button it needs, the warning", async () => {
  const posts = [];
  let chrome = "ask";
  globalThis.fetch = dom.window.fetch = async (url, init = {}) => {
    const reply = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    if (init.method === "POST") { posts.push(JSON.parse(init.body)); chrome = "allowed"; return reply({ id: "Chrome", automation: "allowed" }); }
    return reply({ available: true, browsers: [
      { id: "Chrome", automation: chrome, javascript: "In Chrome: View → Developer → Allow JavaScript from Apple Events." },
      { id: "Safari", automation: "off", javascript: "In Safari: Settings → Advanced…" },
    ] });
  };
  const peer = { id: "mac", name: "My Mac", url: "https://mac.tail.ts.net:8443", token: "owner", platform: "darwin" };
  const view = await dom.render(React.createElement(ToolBrowserSetup, { peer }));
  const c = view.container;
  await dom.waitFor(() => c.textContent.includes("Saved tools on this Mac"));
  assert.match(c.textContent, /Chrome · Not asked yet/);
  assert.match(c.textContent, /Safari · Turned off for Reach/);
  assert.match(c.textContent, /run scripts in its tabs, including signed-in ones/);
  const button = (label) => [...c.querySelectorAll("button")].find((b) => b.textContent.trim() === label);
  assert.ok(button("Open settings on the Mac"));
  button("Ask on the Mac").dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  await dom.waitFor(() => c.textContent.includes("Chrome · Reach may control it"));
  assert.deepEqual(posts, [{ browser: "Chrome", action: "ask" }]);
  await settle(20);
  await view.unmount();
});
