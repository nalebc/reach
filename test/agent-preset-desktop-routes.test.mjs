import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { atomicJson } from "../server/core.mjs";
import { presetFixture, privateIngressTest, apps } from "./helpers/preset-fixture.mjs";

test("agent invitations reject Full control while bounded Apps invitations still join", privateIngressTest, async (t) => {
  const f = await presetFixture(t);
  const denied = await f.invite({ name: "Muse", preset: "full", ttlSeconds: 600 });
  assert.equal(denied.status, 403, JSON.stringify(denied.body));
  assert.equal(f.reach.auth.list().filter((client) => client.kind === "agent").length, 0);

  const agent = await f.join({ preset: "apps", apps: [{ id: apps.chrome.id }] });
  assert.equal((await agent.as("/api/browser")).status, 200);
  assert.deepEqual(agent.joined.scopes, ["device", "browser:read", "browser:screen", "browser:control", "browser:open"]);
});

test("a saved legacy Full grant cannot authenticate shell, desktop or file routes", privateIngressTest, async (t) => {
  const calls = [], f = await presetFixture(t, {
    agentShellRun: async (input) => { calls.push(input); return { output: "ran", exitCode: 0, timedOut: false }; },
  });
  const agent = await f.join({ preset: "apps", apps: [{ id: apps.chrome.id }] });
  const store = path.join(f.reach.config.dataDir, "clients.json");
  const clients = JSON.parse(fs.readFileSync(store, "utf8"));
  const legacy = clients.find((client) => client.id === agent.joined.clientId);
  legacy.policy = { invite: true, browser: true, preset: "full", fullControlVersion: 1, roots: [f.home] };
  atomicJson(store, clients);

  for (const [route, method, body] of [
    ["/api/browser", "GET"],
    ["/api/browser/desktop/screen", "GET"],
    ["/api/browser/shell", "POST", { command: "echo fixture", root: 0, cwd: "" }],
    ["/api/browser/files/change", "POST", { op: "write", root: 0, path: "Desktop/Project/changed.txt", content: "no" }],
  ]) {
    const response = await agent.as(route, { method, body });
    assert.ok([401, 403].includes(response.status), `${route} -> ${response.status}`);
  }
  assert.deepEqual(calls, [], "a stale Full token cannot start a shell");
  assert.equal(fs.existsSync(path.join(f.home, "Desktop", "Project", "changed.txt")), false);
});

test("Files with editing changes files only through its sandboxed shared folder", { skip: process.platform !== "darwin" }, async (t) => {
  const f = await presetFixture(t);
  const editor = await f.join({ name: "Editor", preset: "files", folders: [{ root: 0, path: "Desktop/Project" }], write: true });
  const change = (body) => editor.as("/api/browser/files/change", { method: "POST", body });
  let result = await change({ op: "write", root: 0, path: "draft.md", content: "# Draft\n" });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(fs.readFileSync(path.join(f.home, "Desktop", "Project", "draft.md"), "utf8"), "# Draft\n");
  result = await change({ op: "write", root: 0, path: "draft.md", content: "# Draft 2\n" });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(fs.readFileSync(path.join(f.home, "Desktop", "Project", "draft.md"), "utf8"), "# Draft 2\n");
  assert.equal((await change({ op: "mkdir", root: 0, path: "notes" })).status, 200);
  assert.equal((await change({ op: "cp", root: 0, path: "draft.md", to: "notes/draft.md" })).status, 200);
  assert.equal((await change({ op: "rm", root: 0, path: "draft.md" })).status, 200);
  assert.equal((await change({ op: "write", root: 0, path: "../outside.txt", content: "x" })).status, 403);
});
