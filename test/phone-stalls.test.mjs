import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { cleanStall, createPhoneStalls } from "../server/phone-stalls.mjs";

// The computer's side of a phone page saying it stopped answering
// (src/stall-watch.ts): only the owner's own devices, only the known fields,
// each bounded, through a real Reach server and onto its disk.
const report = (extra = {}) => ({ kind: "stall", ms: 1834, at: Date.now(), page: "screen", route: "browser", visible: true,
  dialogs: 0, inert: 1, pinned: false, focused: "", build: "r2-index-C3TXZ8v1.js", ...extra });

test("a report keeps only its known fields, each bounded; anything else is dropped", () => {
  const at = Date.now();
  const kept = cleanStall(report({ target: "button.tool-open", under: "div[dialog].stuck-overlay", interactive: false,
    text: "a chat's words", label: "Secret plan.txt", cookie: "x" }), at);
  assert.deepEqual(Object.keys(kept).sort(), ["at", "build", "dialogs", "focused", "inert", "interactive", "kind", "ms", "page", "pinned", "receivedAt", "route", "target", "under", "visible"]);
  assert.equal(kept.under, "div[dialog].stuck-overlay");
  // A field holding words, not Reach's own names, is emptied.
  assert.equal(cleanStall(report({ target: 'button "Pay $5"' }), at).target, undefined);
  assert.equal(cleanStall(report({ page: "x".repeat(41) }), at).page, "");
  assert.equal(cleanStall(report({ page: "/Users/me/Notes" }), at).page, "");
  // A clock a day off is the computer's instead.
  assert.equal(cleanStall(report({ at: at - 3 * 24 * 3600_000 }), at).at, at);
  for (const bad of [null, [], "stall", report({ kind: "anything" }), report({ ms: -1 }), report({ ms: Infinity }), report({ ms: "9" })])
    assert.equal(cleanStall(bad, at), null, JSON.stringify(bad));
});

test("only the owner's own devices report, a few at a time, and the record stays bounded on disk", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-stalls-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "phone-stalls.jsonl");
  let now = 1_000_000;
  const stalls = createPhoneStalls({ file, now: () => now, max: 40 });
  const phone = { id: "phone", kind: "device" };
  assert.throws(() => stalls.add({ id: "agent", kind: "agent" }, { reports: [report()] }), /Only your own devices/);
  assert.throws(() => stalls.add({ id: "guest", kind: "guest" }, { reports: [report()] }), /Only your own devices/);
  assert.throws(() => stalls.add(phone, { reports: [] }), /between 1 and 10/);
  assert.throws(() => stalls.add(phone, { reports: Array(11).fill(report()) }), /between 1 and 10/);
  assert.deepEqual(stalls.add(phone, { reports: [report({ at: now }), report({ kind: "nope" })] }), { kept: 1 });
  for (let i = 0; i < 2; i++) stalls.add(phone, { reports: Array(10).fill(report({ at: now })) });
  assert.throws(() => stalls.add(phone, { reports: Array(10).fill(report({ at: now })) }), /Too many reports/);
  now += 61_000;
  for (let i = 0; i < 3; i++) stalls.add(phone, { reports: Array(10).fill(report({ at: now })) });
  await stalls.flushed();
  const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
  assert.ok(lines.length <= 40 && lines.length >= 20, `bounded: ${lines.length} lines`);
  const entry = JSON.parse(lines.at(-1));
  assert.equal(entry.clientId, "phone");
  assert.equal(entry.kind, "stall");
  assert.equal((fs.statSync(file).mode & 0o777).toString(8), process.platform === "win32" ? (fs.statSync(file).mode & 0o777).toString(8) : "600");
});

test("through a real Reach server: the owner's device is heard, an agent and a guest are not", { timeout: 30000 }, async (t) => {
  const { createReach } = await import("../server/index.mjs");
  const { ALL_SCOPES } = await import("../server/core.mjs");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-stalls-route-"));
  const dataDir = path.join(dir, "private");
  const reach = await createReach({ roots: [dir], dataDir, port: 0, agentPolicyFile: path.join(dir, "none.json") });
  await new Promise((resolve) => reach.server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { await reach.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const owner = reach.auth.issue("Phone", ALL_SCOPES);
  const agent = reach.auth.issue("Builder", ["terminal", "files"], "agent");
  const guest = reach.auth.issue("Sam", ALL_SCOPES, "guest");
  const call = (token, body) => new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: reach.server.address().port, path: "/api/reach/stalls", method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => (text += chunk));
      res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(text || "null") }));
    });
    req.once("error", reject);
    req.end(JSON.stringify(body));
  });
  assert.deepEqual(await call(owner.token, { reports: [report({ kind: "repeat-taps", under: "div.stuck-overlay", interactive: false })] }), { status: 200, body: { kept: 1 } });
  assert.equal((await call(agent.token, { reports: [report()] })).status, 403);
  assert.equal((await call(guest.token, { reports: [report()] })).status, 403);
  assert.equal((await call("not-a-token", { reports: [report()] })).status, 401);
  assert.equal((await call(owner.token, { reports: "lots" })).status, 400);
  await reach.close();
  const saved = fs.readFileSync(path.join(dataDir, "phone-stalls.jsonl"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  assert.equal(saved.length, 1);
  assert.equal(saved[0].under, "div.stuck-overlay");
  assert.equal(saved[0].clientId, reach.auth.list().find((client) => client.name === "Phone").id, "kept under the phone that sent it");
});
