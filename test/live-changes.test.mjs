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
  const next = (timeout = 4000) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error("no snapshot")), timeout);
      wake = () => {
        clearTimeout(timer);
        resolve(snapshots.at(-1));
      };
    });
  return { ws, snapshots, next };
}

test("devices learn that their lists changed without polling, and only lists they can read", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-live-"));
  const reach = await createReach({
    roots: [dir],
    dataDir: path.join(dir, "private"),
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
      "requests",
      "terminals",
    ]);
    const guestFirst = await guestSocket.next();
    // A files-only guest learns nothing about the owner's terminals or chats.
    const { build: guestBuild, ...guestLists } = guestFirst.changes;
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
    const after = await ownerSocket.next();
    assert.notEqual(after.changes.activity, first.changes.activity);
    assert.equal(after.changes.terminals, first.changes.terminals);
  } finally {
    ownerSocket.ws.close();
    guestSocket.ws.close();
    reach.server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
