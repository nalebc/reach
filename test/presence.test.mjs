import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { WebSocket } from "ws";
import { DevicePresence } from "../server/presence.mjs";
import { createReach } from "../server/index.mjs";
import { ALL_SCOPES } from "../server/core.mjs";

test("presence counts tailnet devices, not tabs or credentials; restricted clients see only themselves", () => {
  const presence = new DevicePresence();
  const owner = {
    id: "one",
    name: "Phone",
    expiresAt: Date.now() + 10000,
    scopes: ["admin"],
    tailscale: { userId: "1", nodeId: "same-phone" },
  };
  const secondCredential = { ...owner, id: "two" };
  const guest = {
    id: "guest",
    kind: "guest",
    name: "Guest",
    expiresAt: Date.now() + 10000,
    scopes: ["files:read"],
  };
  const tab1 = {},
    tab2 = {},
    tab3 = {},
    guestTab = {};
  presence.add(tab1, owner, "phone");
  presence.add(tab2, owner, "phone");
  presence.add(tab3, secondCredential, "phone");
  presence.add(guestTab, guest, "tablet");
  const snapshot = presence.snapshot(owner, (id) =>
    id === "two" ? "controlling" : "connected",
  );
  assert.equal(snapshot.devices.length, 2);
  assert.equal(snapshot.devices.filter((d) => d.self).length, 1);
  assert.equal(snapshot.devices[0].activity, "controlling");
  assert.deepEqual(snapshot.devices[0].access, [
    { kind: "paired", expiresAt: owner.expiresAt },
  ]);
  assert.deepEqual(snapshot.devices[1].access, [
    { kind: "invited", expiresAt: guest.expiresAt },
  ]);
  // The same physical phone can have both a pairing and a temporary grant;
  // grouping must retain both roles, without counting the phone twice.
  const mixed = {};
  presence.add(mixed, { ...guest, tailscale: owner.tailscale }, "phone");
  assert.deepEqual(
    presence.snapshot(owner).devices[0].access.map((a) => a.kind),
    ["paired", "invited"],
  );
  presence.remove(mixed);
  assert(!JSON.stringify(snapshot).includes("same-phone"));
  assert.equal(presence.snapshot(guest).devices.length, 1);
  presence.remove(tab1);
  assert.equal(presence.snapshot(owner).devices.length, 2);
  presence.removeClient("one");
  presence.removeClient("two");
  assert.equal(presence.snapshot(owner).devices.length, 1);
  presence.add({}, { ...owner, id: "expired", expiresAt: 0 }, "phone");
  assert.equal(presence.snapshot(owner).devices.length, 1);
});

test(
  "live presence authenticates, disconnects revoked devices, and reconnects without duplicate counts",
  { timeout: 15000 },
  async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "reach-presence-"));
    const reach = await createReach({
      roots: [dir],
      dataDir: path.join(dir, ".reach"),
    });
    const sockets = [];
    try {
      await new Promise((r) => reach.server.listen(0, "127.0.0.1", r));
      const origin = `http://127.0.0.1:${reach.server.address().port}`;
      const owner = reach.auth.issue("My phone", ALL_SCOPES);
      const limited = reach.auth.issue("Read-only device", ["files:read"]);
      for (const headers of [
        { Origin: "https://untrusted.example" },
        { "Tailscale-Funnel-Request": "1" },
      ]) {
        const blocked = new WebSocket(
          origin.replace("http:", "ws:") + "/ws/presence",
          { headers },
        );
        sockets.push(blocked);
        await once(blocked, "error");
        assert.notEqual(blocked.readyState, WebSocket.OPEN);
      }
      const open = async (token) => {
        const socket = new WebSocket(
          origin.replace("http:", "ws:") + "/ws/presence",
        );
        sockets.push(socket);
        await once(socket, "open");
        const reply = once(socket, token === "invalid" ? "close" : "message");
        socket.send(
          JSON.stringify({
            type: "auth",
            token,
            kind: "phone",
            access: [{ kind: "invited" }],
          }),
        );
        const [value] = await reply;
        return {
          socket,
          reply: token === "invalid" ? value : JSON.parse(value.toString()),
        };
      };
      assert.equal((await open("invalid")).reply, 4001);
      const first = await open(owner.token);
      assert.equal(first.reply.devices.length, 1);
      assert.equal(
        first.reply.devices[0].access[0].kind,
        "paired",
        "auth messages cannot forge access labels",
      );
      const duplicate = await open(owner.token);
      assert.equal(duplicate.reply.devices.length, 1);
      const guest = await open(limited.token);
      assert.equal(guest.reply.devices.length, 1);
      assert.equal(guest.reply.devices[0].name, "Read-only device");
      const updated = JSON.parse(
        (await once(first.socket, "message"))[0].toString(),
      );
      assert.equal(updated.devices.length, 2);
      const closed = once(guest.socket, "close");
      const revoke = await fetch(`${origin}/api/clients/${limited.clientId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${owner.token}` },
      });
      assert.equal(revoke.status, 200);
      assert.equal((await closed)[0], 4001);
      const next = JSON.parse(
        (await once(first.socket, "message"))[0].toString(),
      );
      assert.equal(next.devices.length, 1);
      duplicate.socket.close();
      first.socket.close();
      await Promise.all([
        once(duplicate.socket, "close"),
        once(first.socket, "close"),
      ]);
      const reconnected = await open(owner.token);
      assert.equal(reconnected.reply.devices.length, 1);
      assert.equal(reconnected.reply.devices[0].self, true);
    } finally {
      sockets.forEach((s) => s.terminate());
      await reach.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  },
);
