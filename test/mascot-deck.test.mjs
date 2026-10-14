import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAuth } from "../server/core.mjs";
import { MASCOT_COUNT, createMascotDeck } from "../server/mascots.mjs";

// Oct 13, the owner: "if one is picked it should not be picked again".
// Each agent or person you invite draws a mascot from a shuffled deck.

const later = () => Date.now() + 3600_000;
const memoryDeck = (random = (n) => n - 1) => {
  const files = {};
  return createMascotDeck({
    file: "deck",
    load: (file, fallback) => files[file] ?? fallback,
    save: (file, value) => (files[file] = structuredClone(value)),
    random,
  });
};
const person = (id, extra = {}) => ({ id, kind: "guest", expiresAt: later(), ...extra });

test("twenty invites in a row get twenty different mascots", () => {
  const deck = memoryDeck((n) => Math.floor(Math.random() * n));
  const clients = [];
  for (let i = 0; i < MASCOT_COUNT; i++) {
    clients.push(person(`p${i}`));
    assert.equal(deck.dress(clients), true);
  }
  assert.equal(new Set(clients.map((c) => c.mascot)).size, MASCOT_COUNT);
  for (const c of clients) assert.ok(Number.isInteger(c.mascot) && c.mascot >= 0 && c.mascot < MASCOT_COUNT);
  // Nothing new: nothing drawn, nothing to save.
  assert.equal(deck.dress(clients), false);
});

test("a face once drawn isn't drawn again until all twenty have been, even after its invite ends", () => {
  const deck = memoryDeck();
  const first = [person("a")];
  deck.dress(first);
  const used = first[0].mascot;
  // Its invite ended: gone from the list. The next nineteen still skip it.
  const next = [];
  for (let i = 0; i < MASCOT_COUNT - 1; i++) {
    next.push(person(`n${i}`));
    deck.dress(next);
    assert.notEqual(next.at(-1).mascot, used);
  }
  assert.equal(new Set(next.map((c) => c.mascot)).size, MASCOT_COUNT - 1);
});

test("a new round never hands out a face someone listed still wears", () => {
  const deck = memoryDeck();
  const clients = [];
  for (let i = 0; i < MASCOT_COUNT; i++) {
    clients.push(person(`p${i}`));
    deck.dress(clients);
  }
  // Two leave; the round is over, and only their two faces are free.
  const freed = [clients[3].mascot, clients[11].mascot];
  const staying = clients.filter((_, i) => i !== 3 && i !== 11);
  staying.push(person("x"), person("y"));
  deck.dress(staying);
  assert.deepEqual(staying.slice(-2).map((c) => c.mascot).sort(), [...freed].sort());
  assert.equal(new Set(staying.map((c) => c.mascot)).size, MASCOT_COUNT);
});

test("with more than twenty listed, the extra one shares a face, and ended or other records are left alone", () => {
  const deck = memoryDeck();
  const clients = [];
  for (let i = 0; i <= MASCOT_COUNT; i++) {
    clients.push(person(`p${i}`));
    deck.dress(clients);
  }
  const times = new Map();
  for (const c of clients) times.set(c.mascot, (times.get(c.mascot) || 0) + 1);
  assert.equal(times.size, MASCOT_COUNT);
  assert.equal(Math.max(...times.values()), 2);
  // Your own devices, ended and revoked access: no mascot drawn.
  const others = [
    { id: "phone", kind: "device", expiresAt: later() },
    person("old", { expiresAt: Date.now() - 1 }),
    person("gone", { status: "revoked" }),
  ];
  assert.equal(deck.dress(others), false);
  assert.ok(others.every((c) => c.mascot === undefined));
});

test("invites carry their mascot from the store to the owner's lists, all different", (t) => {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "reach-mascots-")));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const shared = path.join(dir, "shared");
  fs.mkdirSync(shared);
  const config = { dataDir: path.join(dir, "private"), roots: [shared], agentPolicyFile: path.join(dir, "policy.json") };
  const auth = createAuth(config);
  const grants = [
    auth.inviteGuest({ name: "Sam", ttlSeconds: 3600, roots: [0] }),
    auth.inviteAgent({ name: "CLI", ttlSeconds: 3600, folders: [{ root: 0, path: "" }] }),
    auth.inviteBrowser({ name: "Muse", ttlSeconds: 3600, screen: "ask", commandRequests: true }),
  ];
  for (const g of grants) assert.ok(Number.isInteger(g.mascot), JSON.stringify(g));
  assert.equal(new Set(grants.map((g) => g.mascot)).size, grants.length);
  const listed = auth.list();
  for (const g of grants) assert.equal(listed.find((c) => c.id === g.clientId).mascot, g.mascot);
  // The deck lives beside the access records.
  const deck = JSON.parse(fs.readFileSync(path.join(config.dataDir, "mascots.json"), "utf8"));
  assert.deepEqual(deck.drawn, grants.map((g) => g.mascot));

  // Invited before mascots: each draws one when Reach starts.
  const file = path.join(config.dataDir, "clients.json");
  const stored = JSON.parse(fs.readFileSync(file, "utf8"));
  for (const c of stored) delete c.mascot;
  fs.writeFileSync(file, JSON.stringify(stored));
  fs.rmSync(path.join(config.dataDir, "mascots.json"));
  const restarted = createAuth(config, { rotatePairing: false });
  restarted.dressMascots();
  const dressed = restarted.list();
  assert.ok(dressed.every((c) => Number.isInteger(c.mascot)));
  assert.equal(new Set(dressed.map((c) => c.mascot)).size, dressed.length);
});

test("the server draws from exactly the faces the app can draw", () => {
  const art = fs.readFileSync(new URL("../src/mascots.ts", import.meta.url), "utf8");
  assert.equal(art.match(/^ {4}name: "/gm).length, MASCOT_COUNT);
});

test("a deck that can't be saved never holds up an invite or ending one", (t) => {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "reach-mascots-")));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const shared = path.join(dir, "shared");
  fs.mkdirSync(shared);
  const config = { dataDir: path.join(dir, "private"), roots: [shared], agentPolicyFile: path.join(dir, "policy.json") };
  // A folder where the deck would be saved: every save fails.
  fs.mkdirSync(path.join(config.dataDir, "mascots.json", "in-the-way"), { recursive: true });
  const auth = createAuth(config);
  const grant = auth.inviteGuest({ name: "Sam", ttlSeconds: 3600, roots: [0] });
  const agent = auth.inviteAgent({ name: "CLI", ttlSeconds: 3600, folders: [{ root: 0, path: "" }] });
  // Both stored, each still with its own face on its record.
  const listed = auth.list().filter((c) => [grant.clientId, agent.clientId].includes(c.id));
  assert.equal(listed.length, 2);
  assert.notEqual(listed[0].mascot, listed[1].mascot);
  assert.doesNotThrow(() => auth.dressMascots());
  auth.revoke(grant.clientId);
  assert.ok(!auth.list().some((c) => c.id === grant.clientId && c.status !== "revoked"));
});
