import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createReach } from "../server/index.mjs";
import { ALL_SCOPES } from "../server/core.mjs";
import { askRestart, restartRequestFile } from "../server/restart-requests.mjs";
import { watchInterface } from "../server/live-interface.mjs";
import { startInTerminal } from "../scripts/stop.mjs";

// Oct 6: agents restarted Reach again and again, each time ending its
// terminals and live screens (and once landing inside ChatGPT with no screen
// permission). In a checkout an agent's restart now waits for the owner's OK
// on the phone, and interface edits reach phones without any restart.

test("an agent's restart is a Needs you request; only the owner's Restart restarts Reach", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-agent-restart-"));
  const dataDir = path.join(dir, "private");
  let restarted = 0;
  let working = [];
  const reach = await createReach({
    dataDir,
    roots: [dir],
    restartReach: () => restarted++,
    agentSessions: { list: async () => ({ sessions: [] }), working: () => working, close() {} },
    openClaw: { overview: async () => ({ connected: false }), close() {} },
  });
  t.after(async () => {
    await reach.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await new Promise((resolve) => reach.server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${reach.server.address().port}`;
  const owner = reach.auth.issue("Owner", ALL_SCOPES).token;
  const guest = reach.auth.redeemGuest(reach.auth.inviteGuest({ name: "Guest", ttlSeconds: 3600, full: true }).invitation).token;
  const call = async (route, token = owner, body) => {
    const r = await fetch(url + route, {
      method: body ? "POST" : "GET",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: r.status, body: await r.json() };
  };
  assert.equal(askRestart(dataDir, { app: "ChatGPT" }).again, false);
  // Asking again (an impatient agent) keeps the one request.
  assert.equal(askRestart(dataDir, { app: "ChatGPT" }).again, true);
  const items = (await call("/api/notifications")).body.items.filter((i) => i.source === "restart");
  assert.equal(items.length, 1);
  const [item] = items;
  assert.equal(item.title, "Restart Reach?");
  // The card names who asked (its sender line) and what it is.
  assert.equal(item.sender, "ChatGPT");
  assert.equal(item.detail, "Computer restart");
  assert.deepEqual(item.actions.map((a) => a.id), ["restart", "deny"]);
  const route = `/api/notifications/${encodeURIComponent(item.id)}/actions`;
  assert.equal((await call(route, guest, { revision: item.revision, action: "restart" })).status, 403);
  assert.equal(restarted, 0);
  assert.equal((await call(route, owner, { revision: item.revision, action: "restart" })).status, 200);
  assert.equal(restarted, 1);
  assert.equal(fs.existsSync(restartRequestFile(dataDir)), false);
  // Exercise the phone's actual notification/action endpoints as well as
  // the standalone restart controller.
  working = [{ id: "chat-a", title: "Claw UI rebuild" }];
  askRestart(dataDir, { app: "Claude" });
  await new Promise((r) => setTimeout(r, 400));
  const busy = (await call("/api/notifications")).body.items.find((i) => i.source === "restart");
  assert.match(busy.summary, /Claw UI rebuild/);
  const busyRoute = `/api/notifications/${encodeURIComponent(busy.id)}/actions`;
  const deferred = await call(busyRoute, owner, { revision: busy.revision, action: "after" });
  assert.equal(deferred.status, 200);
  assert.equal(restarted, 1);
  working = [];
  for (let n = 0; n < 40 && restarted === 1; n++) await new Promise((r) => setTimeout(r, 100));
  assert.equal(restarted, 2);
  await new Promise((r) => setTimeout(r, 400)); // answered: the list refreshes
  assert.equal((await call("/api/notifications")).body.items.some((i) => i.source === "restart"), false);
  // Not now: dropped, nothing restarts.
  askRestart(dataDir, { app: "Claude" });
  await new Promise((r) => setTimeout(r, 400)); // the new request wakes the list
  const next = (await call("/api/notifications")).body.items.find((i) => i.source === "restart");
  assert.equal((await call(`/api/notifications/${encodeURIComponent(next.id)}/actions`, owner, { revision: next.revision, action: "deny" })).status, 200);
  assert.equal(restarted, 2);
  assert.equal(fs.existsSync(restartRequestFile(dataDir)), false);
});

test("an allowed restart opens Terminal running ./reach restart --yes", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-restart-term-"));
  let opened = "";
  const file = startInTerminal("/Users/me/reach", { state: dir, args: "restart --yes", nodeDir: "/n", open: (f) => (opened = f) });
  assert.equal(opened, file);
  assert.match(fs.readFileSync(file, "utf8"), /\n\.\/reach restart --yes\n/);
  startInTerminal("/Users/me/reach", { state: dir, nodeDir: "/n", open: () => {} });
  assert.match(fs.readFileSync(file, "utf8"), /\n\.\/reach\n/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("restart run by an agent in a checkout asks instead of stopping Reach", () => {
  const source = fs.readFileSync(new URL("../scripts/bootstrap.mjs", import.meta.url), "utf8");
  const body = source.slice(source.indexOf("async function restart("));
  const ask = body.indexOf("askRestart(");
  assert.ok(ask > 0 && ask < body.indexOf("stopReach(root"), "asks before stopping anything");
  assert.match(body, /const asker = !packaged && \(foreignApp\(\) \|\|/);
});

test("interface edits rebuild once per burst of saves and refresh what phones load", async () => {
  const listeners = [];
  const watch = (target, options, listener) => {
    listeners.push(listener);
    return { close() {} };
  };
  let builds = 0,
    built = 0;
  const stop = watchInterface({
    root: "/r",
    watch,
    delay: 10,
    build: async () => {
      builds++;
    },
    onBuilt: () => built++,
    log: { warn() {} },
  });
  assert.equal(listeners.length, 3);
  for (let i = 0; i < 5; i++) listeners[0]();
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(builds, 1);
  assert.equal(built, 1);
  // A broken edit keeps the last good interface.
  const warnings = [];
  const stop2 = watchInterface({ root: "/r", watch, delay: 5, build: async () => { throw Error("Syntax error\nmore"); }, onBuilt: () => built++, log: { warn: (w) => warnings.push(w) } });
  listeners.at(-1)();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(built, 1);
  assert.match(warnings[0], /didn't rebuild \(Syntax error\)/);
  stop();
  stop2();
});

test("only a checkout watches its interface", () => {
  const launch = fs.readFileSync(new URL("../scripts/launch.mjs", import.meta.url), "utf8");
  assert.match(launch, /liveInterface: !packaged,/);
});

test("a fresh Reach drops the restart that was asked for, and its watch never holds the process open", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-restart-fresh-"));
  askRestart(dir, { app: "Claude" });
  let unrefd = false;
  const watch = () => ({ unref: () => (unrefd = true), close() {} });
  return import("../server/restart-requests.mjs").then(({ restartRequests }) => {
    const r = restartRequests({ dataDir: dir, restart() {}, watch });
    assert.deepEqual(r.list(), []);
    assert.equal(unrefd, true);
    r.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

test("a restart names the Claude chats it would cut off and can wait for them to finish", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-restart-wait-"));
  const { restartRequests } = await import("../server/restart-requests.mjs");
  const { restartNotification } = await import("../server/notification-items.mjs");
  let working = [{ id: "a", title: "Claw UI rebuild" }];
  let restarted = 0;
  const restarts = restartRequests({ dataDir: dir, restart: () => restarted++, working: () => working, watch: () => ({ close() {} }), everyMs: 10 });
  askRestart(dir, { app: "Claude" });
  let [request] = restarts.list();
  let card = restartNotification(request);
  assert.match(card.summary, /^Claw UI rebuild is still working\./);
  assert.deepEqual(card.actions.map((a) => a.id), ["after", "restart", "deny"]);
  // Other chats starting or finishing a turn don't outdate a card on the phone.
  working = [{ id: "b", title: "Home ideas" }, { id: "c", title: "Bug hunt" }];
  assert.equal(restartNotification(restarts.list()[0]).revision, card.revision);
  working = [{ id: "a", title: "Claw UI rebuild" }];
  assert.deepEqual(restarts.decide(request.id, "after"), { status: "waiting" });
  [request] = restarts.list();
  const asked = card;
  card = restartNotification(request);
  assert.equal(card.title, "Reach restarts when chats finish");
  // Answered: the card it was is outdated.
  assert.notEqual(card.revision, asked.revision);
  assert.deepEqual(card.actions.map((a) => a.id), ["restart", "deny"]);
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(restarted, 0);
  working = [];
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(restarted, 1);
  assert.equal(fs.existsSync(restartRequestFile(dir)), false);
  // Asked from a chat: the card names it and opens it.
  const { askingChat } = await import("../server/restart-requests.mjs");
  assert.deepEqual(askingChat({ CLAUDE_CODE_SESSION_ID: "8ec9aa10-513d-46d2-82ab-e51b3ac7a965" }), { agent: "claude", id: "8ec9aa10-513d-46d2-82ab-e51b3ac7a965" });
  assert.deepEqual(askingChat({ CODEX_THREAD_ID: "01a11cff-9d8d-76d2-b114-c412e165f663" }), { agent: "codex", id: "01a11cff-9d8d-76d2-b114-c412e165f663" });
  assert.equal(askingChat({ CLAUDE_CODE_SESSION_ID: "../x y" }), null);
  assert.equal(askingChat({}), null);
  working = [{ id: "s1", title: "Home ideas" }];
  askRestart(dir, { app: "Claude", chat: { agent: "claude", id: "s1" } });
  card = restartNotification(restarts.list()[0]);
  assert.deepEqual(card.target, { page: "sessions", agent: "claude", id: "s1" });
  assert.equal(card.detail, "Asked in Home ideas");
  restarts.decide(restarts.list()[0].id, "deny");
  // A chat Reach can't name or open: Home's card, as before.
  askRestart(dir, { app: "Claude", chat: { agent: "other", id: "s1" } });
  card = restartNotification(restarts.list()[0]);
  assert.equal(card.target.page, "overview");
  assert.equal(card.detail, "Computer restart");
  restarts.decide(restarts.list()[0].id, "deny");
  working = [];
  // Nothing working: the card is as before.
  askRestart(dir, { app: "Claude" });
  assert.deepEqual(restartNotification(restarts.list()[0]).actions.map((a) => a.id), ["restart", "deny"]);
  restarts.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
