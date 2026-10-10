import test from "node:test";
import assert from "node:assert/strict";
import { atRest, sweepAtRest } from "../server/agent-sessions/at-rest.mjs";

// A chat's state is dropped only when everything about it is as it started
// and nobody asked about it for 30 minutes (reliability audit, Oct 10).
const fresh = () => ({ status: "idle", proc: null, prompts: new Map(), waiters: new Set(), settings: {}, error: null, turns: 0, version: 0 });
const free = ["version", "touchedAt", "id"];

test("only an entry back where it started is at rest; an unknown field keeps it", () => {
  assert.equal(atRest({ ...fresh(), version: 7, touchedAt: 1, id: "a" }, fresh(), free), true);
  assert.equal(atRest({ ...fresh(), status: "running" }, fresh(), free), false);
  assert.equal(atRest({ ...fresh(), prompts: new Map([["p", {}]]) }, fresh(), free), false);
  assert.equal(atRest({ ...fresh(), waiters: new Set([() => {}]) }, fresh(), free), false);
  assert.equal(atRest({ ...fresh(), settings: { model: "opus" } }, fresh(), free), false, "a model picked on the phone waits for the next send");
  assert.equal(atRest({ ...fresh(), error: "Lost the connection" }, fresh(), free), false);
  assert.equal(atRest({ ...fresh(), unread: true }, fresh(), free), false, "a field it doesn't know keeps it");
});

test("the sweep drops entries at rest and untouched for 30 minutes, never one asked to keep", () => {
  const now = 10 * 60 * 60 * 1000;
  const old = now - 31 * 60 * 1000;
  const map = new Map([
    ["quiet", { ...fresh(), touchedAt: old }],
    ["recent", { ...fresh(), touchedAt: now - 60 * 1000 }],
    ["working", { ...fresh(), status: "running", touchedAt: old }],
    ["kept", { ...fresh(), touchedAt: old }],
  ]);
  assert.deepEqual(sweepAtRest(map, { fresh, free, now, keep: (id) => id === "kept" }), ["quiet"]);
  assert.deepEqual([...map.keys()], ["recent", "working", "kept"]);
});
