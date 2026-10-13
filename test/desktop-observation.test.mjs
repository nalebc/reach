import test from "node:test";
import assert from "node:assert/strict";
import { createObservations, observationOptions, screenMatches, waitForScreen, waitOptions } from "../server/desktop-observation.mjs";

const client = { id: "agent", expiresAt: 100, scopes: ["browser:control"], policy: { preset: "full" } };
const button = (ref, name, context = "Invoices") => ({ ref, n: Number(ref.slice(2)), role: "Button", name, context, x: 0, y: 0, w: 0.1, h: 0.1 });
const screen = (snapshot, items) => ({ snapshot, app: "Browser", title: "Invoices", displayId: 1, revision: 0, items, texts: [], truncated: false });

test("scoped observations preserve target numbers and stable references", () => {
  const observe = createObservations();
  const result = observe(client, screen("one", [button("e-1", "Open", "March"), button("e-2", "Open", "April")]), { within: "April", maxChars: 500 });
  assert.deepEqual(result.items.map(item => item.ref), ["e-2"]);
  assert.equal(result.items[0].n, 2);
  assert.match(result.text, /e-2/);
  assert.ok(result.text.length <= 500);
});

test("deltas include changed and removed controls, and reset across grants and displays", () => {
  const observe = createObservations();
  observe(client, screen("one", [button("e-1", "Open"), button("e-2", "Delete")]));
  const next = observe(client, screen("two", [button("e-1", "Opened")]), { sinceSnapshot: "one" });
  assert.equal(next.delta, true);
  assert.equal(next.items[0].name, "Opened");
  assert.deepEqual(next.removed.map(item => item.ref), ["e-2"]);
  assert.match(next.text, /Removed: e-2/);
  const other = observe({ ...client, id: "another" }, screen("three", []), { sinceSnapshot: "two" });
  assert.equal(other.reset, true);
  const changedGrant = observe({ ...client, policy: { preset: "apps" } }, screen("four", []), { sinceSnapshot: "two" });
  assert.equal(changedGrant.reset, true);
  assert.doesNotMatch(changedGrant.text, /Opened|Delete/);
  const otherDisplay = observe(client, { ...screen("five", []), displayId: 2 }, { sinceSnapshot: "four" });
  assert.equal(otherDisplay.reset, true);
});

test("ready screens return immediately; waits reauthorize and wake on changes", async () => {
  let reads = 0, wakes = 0, authorizations = 0, clock = 0;
  const read = async () => { reads++; return screen(String(reads), [button("e-1", reads === 1 ? "Loading" : "Ready")]); };
  const result = await waitForScreen({ read, authorize: () => { authorizations++; }, wanted: { name: "Ready" }, now: () => clock,
    changed: async () => { wakes++; clock += 10; } });
  assert.equal(result.found, true); assert.equal(result.waitedMs, 10); assert.equal(wakes, 1); assert.equal(reads, 2);
  assert.equal(authorizations, 4);
  const ready = await waitForScreen({ read, authorize() {}, wanted: { name: "Ready" }, changed: () => assert.fail("No delay after readiness"), now: () => 0 });
  assert.equal(ready.waitedMs, 0);
});

test("a delta reports disappearing text even when no control changed", () => {
  const observe = createObservations();
  observe(client, { ...screen("one", []), texts: [{ text: "Loading", x: 0, y: 0, context: "Invoices" }] });
  const next = observe(client, screen("two", []), { sinceSnapshot: "one" });
  assert.deepEqual(next.removed, [{ text: "Loading", context: "Invoices" }]);
  assert.match(next.text, /Removed: Loading/);
});

test("absence requires a complete read; predicates and options are bounded", () => {
  const incomplete = { ...screen("one", []), truncated: true };
  assert.equal(screenMatches(incomplete, { text: "Loading", state: "absent" }), false);
  assert.equal(screenMatches(screen("one", []), { text: "Loading", state: "absent" }), true);
  assert.throws(() => waitOptions({ text: "x", name: "y" }));
  assert.throws(() => observationOptions({ maxChars: 1000000 }));
  assert.throws(() => observationOptions({ displayId: -1 }));
});

test("large descriptions report truncation and never seed a delta from unseen controls", () => {
  const observe = createObservations();
  const items = Array.from({ length: 250 }, (_, index) => button(`e-${index + 1}`, `Action ${index + 1}`, "Context ".repeat(50)));
  const first = observe(client, screen("large-one", items));
  assert.equal(first.outputTruncated, true);
  assert.ok(first.text.length <= 30000);
  assert.match(first.text, /output limited/);
  assert.doesNotMatch(first.text, /Action 250/);
  const next = observe(client, screen("large-two", items), {}, { changes: true });
  assert.notEqual(next.diff, true, "an incomplete look cannot establish that nothing changed");
  assert.equal(next.outputTruncated, true);
  const scoped = observe(client, screen("large-three", items), { query: "Action 250", maxChars: 1000 });
  assert.equal(scoped.outputTruncated, false);
  assert.match(scoped.text, /Action 250/);
});
