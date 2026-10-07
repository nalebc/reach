import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import { createReach } from "../server/index.mjs";
import { ALL_SCOPES } from "../server/core.mjs";

// Each snapshot the presence socket sends, as parsed JSON.
function listen(port, token) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/presence`);
  const snapshots = [];
  let wake = () => {};
  ws.on("open", () =>
    ws.send(JSON.stringify({ type: "auth", token, kind: "phone" })),
  );
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
      wake(); // The snapshot may have arrived while the HTTP request finished.
    });
  return { ws, snapshots, next };
}

test("devices learn that their lists changed without polling, and only lists they can read", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-live-"));
  const reach = await createReach({
    roots: [dir],
    dataDir: path.join(dir, "private"),
    screen: true,
  });
  await new Promise((r) => reach.server.listen(0, "127.0.0.1", r));
  const { port } = reach.server.address();
  const owner = reach.auth.issue("owner", ALL_SCOPES);
  const guest = reach.auth.redeemGuest(
    reach.auth.inviteGuest({ name: "guest", roots: [0], ttlSeconds: 60 })
      .invitation,
  );
  const ownerSocket = listen(port, owner.token);
  const guestSocket = listen(port, guest.token);
  try {
    const first = await ownerSocket.next();
    // Which phone interface the Mac serves rides along for everyone (it's no secret).
    const { build, ...lists } = first.changes;
    assert.deepEqual(Object.keys(lists).sort(), [
      "activity",
      "apps",
      "chats",
      "control",
      "handoffs",
      "requests",
      "terminals",
    ]);
    const guestFirst = await guestSocket.next();
    // A files-only guest learns nothing about the owner's terminals or chats.
    // Guests receive their own access revision so permission changes refresh
    // their phone, but no fingerprints for the owner's private lists.
    const { build: guestBuild, access: guestAccess, ...guestLists } = guestFirst.changes;
    assert.equal(typeof guestAccess, "string");
    assert.ok(guestAccess.length > 0);
    assert.deepEqual(guestLists, {});
    assert.equal(guestBuild, build);
    // Something happens on the computer: a folder is created.
    const created = await fetch(`http://127.0.0.1:${port}/api/files/folder`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${owner.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ root: 0, path: "", name: "Receipts" }),
    });
    assert.equal(created.status, 200);
    const after = await ownerSocket.next((s) => s.changes.activity !== first.changes.activity);
    assert.notEqual(after.changes.activity, first.changes.activity);
    assert.equal(after.changes.terminals, first.changes.terminals);
    // Screen control changes hands: a watching phone hears it at once.
    const took = await fetch(`http://127.0.0.1:${port}/api/screen/control`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${owner.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ enabled: true }),
    });
    assert.equal(took.status, 200);
    const controlled = await ownerSocket.next((s) => s.changes.control !== after.changes.control);
    assert.notEqual(controlled.changes.control, after.changes.control);
  } finally {
    ownerSocket.ws.close();
    guestSocket.ws.close();
    await reach.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
