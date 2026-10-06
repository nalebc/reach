import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import { createReach } from "../server/index.mjs";
import { ALL_SCOPES } from "../server/core.mjs";

// "Don't pull" (2026-10-06): the chat list's revision rides on each device's
// live connection, so the owner's phones read the list when it changes
// instead of every 4 s. Guests never see it (the list is the owner's).
function listen(port, token) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/presence`);
  const snapshots = [];
  let wake = () => {};
  ws.on("open", () => ws.send(JSON.stringify({ type: "auth", token, kind: "phone" })));
  ws.on("message", (data) => {
    snapshots.push(JSON.parse(data));
    wake();
  });
  let consumed = 0;
  const next = (matches = () => true, timeout = 10000) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error("no matching snapshot")), timeout);
      wake = () => {
        while (consumed < snapshots.length) {
          const snapshot = snapshots[consumed++];
          if (matches(snapshot)) {
            clearTimeout(timer);
            wake = () => {};
            resolve(snapshot);
            return;
          }
        }
      };
      wake();
    });
  return { ws, next };
}

test("a new chat list reaches the owner's phones on their live connection; guests never see it", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-sessions-live-"));
  let revision = 0;
  const listeners = new Set();
  const reach = await createReach({
    roots: [dir],
    dataDir: path.join(dir, "private"),
    screen: true,
    agentSessions: {
      list: async () => ({ sessions: [], errors: {}, projects: { codex: [] }, macPrompts: [] }),
      listRevision: () => revision,
      onListChange(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
  });
  await new Promise((r) => reach.server.listen(0, "127.0.0.1", r));
  const { port } = reach.server.address();
  const owner = reach.auth.issue("owner", ALL_SCOPES);
  const guest = reach.auth.redeemGuest(reach.auth.inviteGuest({ name: "guest", roots: [0], ttlSeconds: 60 }).invitation);
  const ownerSocket = listen(port, owner.token);
  const guestSocket = listen(port, guest.token);
  try {
    const first = await ownerSocket.next();
    assert.equal(first.changes.sessions, "0");
    assert.equal((await guestSocket.next()).changes.sessions, undefined);
    // The Mac rebuilt the list and it changed: told at once.
    revision = 1;
    for (const listener of listeners) listener(revision);
    const told = await ownerSocket.next((s) => s.changes?.sessions === "1", 3000);
    assert.equal(told.changes.sessions, "1");
  } finally {
    ownerSocket.ws.close();
    guestSocket.ws.close();
    await reach.close?.();
    reach.server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
