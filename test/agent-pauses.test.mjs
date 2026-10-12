import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAgentDesktop } from "../server/agent-desktop.mjs";
import { createAgentPauses } from "../server/agent-pauses.mjs";
import { presetScopes } from "../server/agent-presets.mjs";
import { createReach } from "../server/index.mjs";
import { presetFixture, privateIngressTest } from "./helpers/preset-fixture.mjs";

// The owner's pause of one agent outlives a restart (reliability audit, Oct
// 10: it lived only in memory, so a crash or restart resumed the agent).
const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), "reach-pauses-"));
const agent = (id) => {
  const policy = { invite: true, browser: true, preset: "full", roots: ["/Users/me"] };
  return { id, kind: "agent", name: id, expiresAt: Date.now() + 600000, policy, scopes: presetScopes(policy) };
};
const desktop = (file, clients) =>
  createAgentDesktop({ screen: true }, {
    available: () => true, home: "/Users/me", verifyClient: (id) => clients.get(id), pausesFile: file,
    spawnHelper: async () => ({ async send() { return { ok: true, app: "Google Chrome", bundle: "com.google.Chrome" }; }, stop() {} }),
  });

test("a paused agent is still paused after Reach starts again", async () => {
  const file = path.join(dir(), "agent-pauses.json");
  const clients = new Map([["muse", agent("muse")], ["grok", agent("grok")]]);
  const first = desktop(file, clients);
  assert.equal(first.setPaused("muse", true), true);
  first.close();
  const second = desktop(file, clients);
  assert.equal(second.isPaused("muse"), true);
  assert.equal(second.isPaused("grok"), false);
  await assert.rejects(() => second.act(clients.get("muse"), { type: "click", x: 0.5, y: 0.5 }, () => clients.get("muse")), (e) => e.status === 409 && e.kind === "paused");
  assert.equal(second.setPaused("muse", false), false);
  assert.equal(desktop(file, clients).isPaused("muse"), false);
});

test("ending a session's work (Reopen, an access change) never resumes it", () => {
  const file = path.join(dir(), "agent-pauses.json");
  const clients = new Map([["muse", agent("muse")]]);
  const d = desktop(file, clients);
  d.setPaused("muse", true);
  d.cancelClient("muse");
  assert.equal(d.isPaused("muse"), true);
  assert.equal(desktop(file, clients).isPaused("muse"), true);
});

test("pauses of agents whose access ended are forgotten", () => {
  const file = path.join(dir(), "agent-pauses.json");
  const clients = new Map([["muse", agent("muse")], ["grok", agent("grok")]]);
  const d = desktop(file, clients);
  d.setPaused("muse", true);
  d.setPaused("grok", true);
  assert.deepEqual(d.forgetPauses((id) => id === "grok"), ["muse"]);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).paused, ["grok"]);
});

test("saved pauses that can't be read say so: never read as nobody paused", () => {
  const folder = dir();
  const file = path.join(folder, "agent-pauses.json");
  fs.writeFileSync(file, "{ torn");
  const pauses = createAgentPauses({ file });
  assert.equal(pauses.unreadable, true);
  assert.equal(pauses.has("muse"), false);
  // Pausing everyone (what Reach does then) writes a readable file again.
  assert.deepEqual(pauses.add(["muse", "grok"]), ["muse", "grok"]);
  assert.equal(pauses.unreadable, false);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).paused, ["muse", "grok"]);
  // No file yet is a first run, not unreadable.
  assert.equal(createAgentPauses({ file: path.join(folder, "none.json") }).unreadable, false);
});

test("a pause that can't be saved still holds now, and says a restart would end it", () => {
  const folder = dir();
  const file = path.join(folder, "agent-pauses.json");
  fs.mkdirSync(file); // a folder where the file goes: every write fails
  const pauses = createAgentPauses({ file });
  assert.throws(() => pauses.set("muse", true), (e) => e.status === 507 && /restart would end it/.test(e.message));
  assert.equal(pauses.has("muse"), true);
  // Resuming can't be saved either: it holds, and a restart would pause again.
  assert.equal(pauses.set("muse", false), false);
});

// Oct 12: the pause lived in the Mac-only desktop service, so off a Mac
// (Windows) pausing an agent did nothing. Reach now keeps one store on every
// computer; the desktop service, where there is one, acts on that same store.
test("the desktop service acts on the one store Reach gives it, never a second copy", () => {
  const folder = dir();
  const store = createAgentPauses({ file: path.join(folder, "agent-pauses.json") });
  const clients = new Map([["muse", agent("muse")], ["grok", agent("grok")]]);
  const d = createAgentDesktop({ screen: true }, {
    available: () => true, home: "/Users/me", verifyClient: (id) => clients.get(id), pauses: store, pausesFile: path.join(folder, "other.json"),
    spawnHelper: async () => ({ async send() { return { ok: true }; }, stop() {} }),
  });
  assert.equal(d.setPaused("muse", true), true);
  assert.equal(store.has("muse"), true);
  store.set("grok", true);
  assert.equal(d.isPaused("grok"), true);
  assert.deepEqual(d.activity().paused, ["muse", "grok"]);
  store.set("muse", false);
  assert.equal(d.isPaused("muse"), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(folder, "agent-pauses.json"), "utf8")).paused, ["grok"]);
  assert.equal(fs.existsSync(path.join(folder, "other.json")), false, "no second store");
});

test("without the desktop service (as on Windows), the owner's pause is kept, enforced and shown", privateIngressTest, async (t) => {
  const f = await presetFixture(t, { withDesktop: false });
  const writer = await f.join({ name: "Writer", preset: "files", write: true, folders: [{ root: 0, path: "Desktop/Project" }] });
  const id = writer.created.clientId;
  // Its one folder is its root 0.
  const change = (name) => writer.as("/api/browser/files/change", { method: "POST", body: { op: "write", root: 0, path: name, content: "x" } });
  const pausedNow = await f.call("/api/browser/agents/pause", { method: "POST", body: { clientId: id, paused: true } });
  assert.equal(pausedNow.status, 200, JSON.stringify(pausedNow.body));
  assert.deepEqual(pausedNow.body, { clientId: id, paused: true });
  const saved = path.join(path.dirname(f.home), "private", "agent-pauses.json");
  assert.deepEqual(JSON.parse(fs.readFileSync(saved, "utf8")).paused, [id], "kept across restarts");
  assert.equal((await f.call("/api/browser/agents")).body.agents.find((entry) => entry.id === id).paused, true);
  const refused = await change("paused.txt");
  assert.equal(refused.status, 409, JSON.stringify(refused.body));
  assert.equal(refused.body.kind, "paused");
  assert.ok(!fs.existsSync(path.join(f.home, "Desktop", "Project", "paused.txt")), "nothing was written");
  // Agents can't pause anyone; resuming gives the hands back.
  assert.equal((await writer.as("/api/browser/agents/pause", { method: "POST", body: { clientId: id, paused: false } })).status, 403);
  assert.equal((await f.call("/api/browser/agents/pause", { method: "POST", body: { clientId: id, paused: false } })).body.paused, false);
  assert.equal((await f.call("/api/browser/agents")).body.agents.find((entry) => entry.id === id).paused, undefined);
  const resumed = await change("resumed.txt");
  assert.equal(resumed.status, 200, JSON.stringify(resumed.body));
  assert.equal(fs.readFileSync(path.join(f.home, "Desktop", "Project", "resumed.txt"), "utf8"), "x");
});

test("without the desktop service, saved pauses that can't be read pause every agent that can use the computer", async () => {
  const root = dir();
  const dataDir = path.join(root, "data");
  fs.mkdirSync(dataDir, { mode: 0o700 });
  const entry = (id, policy) => ({ id, kind: "agent", name: id, scopes: ["screen"], createdAt: Date.now(), expiresAt: Date.now() + 864e5, hash: "x".repeat(64), policy });
  fs.writeFileSync(path.join(dataDir, "clients.json"), JSON.stringify([
    entry("muse", { invite: true, browser: true, preset: "full", roots: [] }),
    entry("files-only", { invite: true, roots: [] }),
  ]), { mode: 0o600 });
  const file = path.join(dataDir, "agent-pauses.json");
  fs.writeFileSync(file, "{ torn");
  const reach = await createReach({ roots: [root], dataDir, port: 0, publicOrigin: "", previousRun: null, agentDesktop: null });
  await reach.close();
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).paused, ["muse"]);
});
