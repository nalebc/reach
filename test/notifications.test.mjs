import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createNotifications,
  readAttention,
} from "../server/notifications.mjs";

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const sources = (extra = {}) => ({
  agentSessions: { list: async () => ({ sessions: [], errors: {} }) },
  openClaw: { overview: async () => ({ connected: false }) },
  handoffs: () => [],
  browserRequests: () => [],
  admissions: () => [],
  accessRequests: () => [],
  ...extra,
});
test("the bell collects actual pending requests across providers and drops resolved work", async () => {
  const result = await readAttention(
    sources({
      agentSessions: {
        list: async () => ({
          sessions: [
            {
              agent: "codex",
              id: "c",
              status: "waiting",
              title: "Code",
              prompts: [{ id: "request-c", command: "secret" }],
            },
            { agent: "claude", id: "a", status: "waiting", title: "Writing" },
            {
              agent: "gemini",
              id: "g",
              status: "running",
              title: "Approval mentioned in old text",
            },
            { agent: "codex", id: "old", status: "waiting", archived: true },
          ],
          macPrompts: [{ id: "dialog", kind: "password", lines: ["Private"] }],
        }),
      },
      openClaw: {
        overview: async () => ({
          connected: true,
          sessions: [{ key: "claw", title: "Research" }],
          approvals: [{ id: "p", sessionKey: "claw", command: "secret" }],
        }),
      },
      handoffs: () => [
        { id: "h", agent: "Claude", app: "Notes", threadId: "app1" },
      ],
      browserRequests: () => [{ id: "b", name: "Browser" }],
      admissions: () => [{ requestId: "a", name: "Helper" }],
      accessRequests: () => [
        { id: "r", name: "Assistant", status: "pending" },
        { id: "done", status: "approved" },
      ],
    }),
  );
  assert.deepEqual(
    result.items.map((i) => i.id),
    [
      "chat:codex:c",
      "chat:claude:a",
      "mac:dialog",
      "openclaw:p",
      "handoff:h",
      "browser:b",
      "admission:a",
      "access:r",
    ],
  );
  assert.equal(
    result.items.find((i) => i.source === "openclaw").target.id,
    "claw",
  );
  assert.doesNotMatch(JSON.stringify(result.items), /secret|Private/);
  assert.equal(result.items.find((i) => i.source === "handoff").push, false);
});

const item = (signature = "p1") => ({
  id: "chat:claude:private-id",
  source: "claude",
  signature,
  title: "Claude Code needs your answer",
  detail: "Private conversation",
  target: { page: "sessions", id: "private-id" },
});
test("deduplicates waits across polls and restarts, but sends a new request; disk stores no conversation", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-notifications-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "seen.json");
  let snapshot = { items: [item("waiting")], unavailable: [] };
  const sent = [];
  const options = {
    read: async () => snapshot,
    notify: async (m) => (sent.push(m), { sent: 1 }),
    enabled: () => true,
    file,
  };
  const a = createNotifications(options);
  await Promise.all([a.refresh(), a.refresh()]);
  assert.equal(sent.length, 1);
  snapshot = { items: [item("p1")], unavailable: [] };
  await a.refresh({ fresh: true });
  assert.equal(sent.length, 1, "learning the request id doesn't notify twice");
  a.close();
  const b = createNotifications(options);
  await b.refresh();
  assert.equal(sent.length, 1, "restart doesn't repeat a waiting question");
  snapshot = { items: [], unavailable: ["claude"] };
  await b.refresh({ fresh: true });
  snapshot = { items: [item()], unavailable: [] };
  await b.refresh({ fresh: true });
  assert.equal(sent.length, 1, "outages don't reset the wait");
  snapshot.items = [item("p2")];
  await b.refresh({ fresh: true });
  assert.equal(sent.length, 2);
  snapshot.items = [];
  assert.deepEqual((await b.refresh({ fresh: true })).items, []);
  snapshot.items = [item("p2")];
  await b.refresh({ fresh: true });
  assert.equal(
    sent.length,
    3,
    "a new wait after a resolved one notifies again",
  );
  assert.doesNotMatch(
    fs.readFileSync(file, "utf8"),
    /private-id|Private conversation|p2/,
  );
  assert.doesNotMatch(
    JSON.stringify(sent),
    /private-id|Private conversation|p2/,
  );
  b.close();
});

test("background checks start only for subscribed devices, retry failed push, and stop on close", async () => {
  let enabled = false,
    reads = 0,
    sends = 0;
  const feed = createNotifications({
    intervalMs: 10,
    enabled: () => enabled,
    read: async () => (reads++, { items: [item()], unavailable: [] }),
    notify: async () => ({ sent: ++sends > 1 ? 1 : 0 }),
  });
  feed.start();
  await wait(35);
  assert.equal(reads, 0);
  enabled = true;
  await wait(70);
  assert.ok(reads >= 2);
  assert.equal(sends, 2);
  feed.close();
  const stoppedAt = reads;
  await wait(35);
  assert.equal(reads, stoppedAt);
});

test("an unavailable provider never manufactures a pending request", async () => {
  const result = await readAttention(
    sources({
      agentSessions: {
        list() {
          throw Error("offline");
        },
      },
    }),
  );
  assert.deepEqual(result.items, []);
  assert.ok(result.unavailable.includes("codex"));
});

test("muted requests stay in the bell and do not burst into push when resumed", async () => {
  let paused = true;
  const messages = [];
  const feed = createNotifications({
    enabled: () => true,
    read: async () => ({
      items: [item(), { ...item(), id: "mac:p", source: "mac" }],
      unavailable: [],
    }),
    notify: async (message) => (
      messages.push(message),
      paused ? { sent: 0, suppressed: 1 } : { sent: 1 }
    ),
  });
  const result = await feed.refresh({ fresh: true });
  assert.equal(result.items.length, 2);
  assert.deepEqual(
    messages.map((m) => m.category),
    ["chat", "computer"],
  );
  paused = false;
  await feed.refresh({ fresh: true });
  assert.equal(messages.length, 2);
  feed.close();
});
