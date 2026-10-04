import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocket } from "ws";
import { createReach } from "../server/index.mjs";
import { ALL_SCOPES, atomicJson, createAuth } from "../server/core.mjs";

test(
  "temporary guest grants: single use, permissions, restart, expiry and revocation",
  { timeout: 20000 },
  async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "reach-guest-"));
    const shared = path.join(root, "shared"),
      other = path.join(root, "other");
    fs.mkdirSync(shared);
    fs.mkdirSync(other);
    fs.writeFileSync(path.join(shared, "hello.txt"), "hello");
    const reach = await createReach({
      roots: [shared, other],
      dataDir: path.join(root, "private"),
      screen: true,
      screenStreamFactory: async () => () => ({
        next: async () => Buffer.from("fixture-frame"),
        stop() {},
      }),
    });
    await new Promise((r) => reach.server.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${reach.server.address().port}`;
    const owner = reach.auth.issue("Owner", ALL_SCOPES);
    const call = (route, token = owner.token, body, method) =>
      fetch(url + route, {
        method: method || (body ? "POST" : "GET"),
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    const grant = async (options = {}) => {
      const response = await call("/api/guests", owner.token, {
        name: "Alex",
        ttlSeconds: 900,
        roots: [0],
        write: true,
        ...options,
      });
      assert.equal(response.status, 201);
      return response.json();
    };
    const redeem = async (invite) => {
      const response = await call("/api/guest/redeem", "", {
        invitation: invite.invitation,
      });
      assert.equal(response.status, 200);
      return response.json();
    };
    const shorten = (id, expiresAt) => {
      const file = path.join(reach.config.dataDir, "clients.json");
      const clients = JSON.parse(fs.readFileSync(file));
      clients.find((c) => c.id === id).expiresAt = expiresAt;
      atomicJson(file, clients);
    };
    try {
      await t.test(
        "owner-selected scope and fixed deadline survive redemption and restart",
        async () => {
          const invite = await grant();
          assert.equal(reach.auth.verify(invite.invitation), null);
          const guest = await redeem(invite);
          assert.equal(guest.expiresAt, invite.expiresAt);
          assert.equal(
            (
              await call("/api/guest/redeem", "", {
                invitation: invite.invitation,
              })
            ).status,
            401,
          );
          const restarted = createAuth(reach.config, { rotatePairing: false });
          assert.equal(
            restarted.verify(guest.token).expiresAt,
            invite.expiresAt,
          );
          const device = await (await call("/api/device", guest.token)).json();
          assert.deepEqual(
            device.roots.map((r) => r.path),
            [fs.realpathSync(shared)],
          );
          assert.deepEqual(device.network.peers, []);
          assert.equal(device.capabilities.terminal, false);
          for (const route of [
            "/api/clients",
            "/api/guests",
            "/api/jobs",
            "/api/terminals",
            "/api/settings",
            "/api/agents/requests",
            "/api/screen",
          ]) {
            assert.equal((await call(route, guest.token)).status, 403, route);
          }
          assert.equal(
            (
              await call("/api/guests", guest.token, {
                name: "Nested",
                roots: [0],
                ttlSeconds: 60,
              })
            ).status,
            403,
          );
          assert.equal(
            (await call("/api/files?root=1", guest.token)).status,
            400,
          );
          assert.equal(
            (await call("/api/files?root=0&path=../other", guest.token)).status,
            403,
          );
          assert.equal(
            (
              await call("/api/files/folder", guest.token, {
                root: 0,
                name: "from-guest",
              })
            ).status,
            200,
          );
          assert.ok(fs.existsSync(path.join(shared, "from-guest")));
          const listed = await (await call("/api/clients")).json();
          assert.ok(listed.clients.every((c) => !c.hash && !c.inviteHash));
          assert.equal(
            listed.clients.find((c) => c.id === guest.clientId).status,
            "accepted",
          );
        },
      );
      await t.test(
        "owner cancellation ends an accepted guest session and survives restart",
        async () => {
          const invite = await grant({ write: false });
          const guest = await redeem(invite);
          assert.equal(
            (await call("/api/files?root=0", guest.token)).status,
            200,
          );
          assert.equal(
            (
              await call(
                `/api/clients/${invite.clientId}`,
                owner.token,
                undefined,
                "DELETE",
              )
            ).status,
            200,
          );
          for (const route of [
            "/api/device",
            "/api/files?root=0",
            "/api/files/download?root=0&path=hello.txt",
          ])
            assert.equal((await call(route, guest.token)).status, 401, route);
          assert.equal(
            (
              await call("/api/guest/redeem", "", {
                invitation: invite.invitation,
              })
            ).status,
            401,
          );
          const restarted = createAuth(reach.config, { rotatePairing: false });
          assert.equal(restarted.verify(guest.token), null);
          assert.equal(
            (await call("/api/device")).status,
            200,
            "owner remains connected",
          );
        },
      );
      await t.test(
        "read-only, invalid durations, expired and revoked invitations fail closed",
        async () => {
          for (const ttlSeconds of [0, 59, 86401, "60", 60.1])
            assert.equal(
              (
                await call("/api/guests", owner.token, {
                  name: "Invalid",
                  ttlSeconds,
                  roots: [0],
                })
              ).status,
              400,
            );
          assert.equal(
            (
              await call("/api/guests", owner.token, {
                name: "Invalid",
                ttlSeconds: 60,
                roots: [99],
              })
            ).status,
            400,
          );
          const invite = await grant({ write: false });
          const guest = await redeem(invite);
          assert.equal(
            (await call("/api/files/text?root=0&path=hello.txt", guest.token))
              .status,
            200,
          );
          assert.equal(
            (
              await call("/api/files/folder", guest.token, {
                root: 0,
                name: "denied",
              })
            ).status,
            403,
          );
          shorten(guest.clientId, Date.now() - 1);
          assert.equal((await call("/api/device", guest.token)).status, 401);
          const expired = await grant();
          shorten(expired.clientId, Date.now() - 1);
          assert.equal(
            (
              await call("/api/guest/redeem", "", {
                invitation: expired.invitation,
              })
            ).status,
            401,
          );
          const revoked = await grant();
          await call(
            `/api/clients/${revoked.clientId}`,
            owner.token,
            undefined,
            "DELETE",
          );
          assert.equal(
            (
              await call("/api/guest/redeem", "", {
                invitation: revoked.invitation,
              })
            ).status,
            401,
          );
          const left = await redeem(await grant());
          assert.equal(
            (await call("/api/device/access", left.token, undefined, "DELETE"))
              .status,
            200,
          );
          assert.equal((await call("/api/device", left.token)).status, 401);
        },
      );
      await t.test("simultaneous redemption has one winner", async () => {
        const invite = await grant();
        const results = await Promise.all(
          [1, 2].map(() =>
            call("/api/guest/redeem", "", { invitation: invite.invitation }),
          ),
        );
        assert.deepEqual(results.map((r) => r.status).sort(), [200, 401]);
      });
      await t.test(
        "screen stream closes on deadline and early revocation; control stays denied",
        async () => {
          for (const revoke of [false, true]) {
            const guest = await redeem(
              await grant({ roots: [], screen: true }),
            );
            assert.equal(
              (
                await call("/api/screen/control", guest.token, {
                  enabled: true,
                })
              ).status,
              403,
            );
            if (!revoke) shorten(guest.clientId, Date.now() + 600);
            const ws = new WebSocket(
              url.replace("http:", "ws:") + "/ws/screen",
            );
            await once(ws, "open");
            const closed = once(ws, "close");
            const ready = once(ws, "message");
            ws.send(JSON.stringify({ type: "auth", token: guest.token }));
            await ready;
            if (revoke)
              await call(
                `/api/clients/${guest.clientId}`,
                owner.token,
                undefined,
                "DELETE",
              );
            assert.equal((await closed)[0], 4001);
            assert.equal((await call("/api/device", guest.token)).status, 401);
          }
        },
      );
      await t.test(
        "expiry aborts an in-flight download before completion",
        async () => {
          const file = path.join(shared, "large.bin");
          const fd = fs.openSync(file, "w");
          fs.ftruncateSync(fd, 64 * 1024 * 1024);
          fs.closeSync(fd);
          const guest = await redeem(await grant());
          shorten(guest.clientId, Date.now() + 600);
          let finish;
          const closed = new Promise((r) => {
            finish = r;
          });
          const observe = (req, res) => {
            if (req.url.includes("large.bin"))
              res.once("close", () => finish(res.writableFinished));
          };
          reach.server.on("request", observe);
          const req = http.get(
            url + "/api/files/content?root=0&path=large.bin",
            { headers: { Authorization: `Bearer ${guest.token}` } },
          );
          req.on("error", () => {});
          const [response] = await once(req, "response");
          response.pause();
          response.on("error", () => {});
          assert.equal(await closed, false);
          response.destroy();
          req.destroy();
          reach.server.off("request", observe);
        },
      );
      await t.test(
        "expiry aborts a slow upload without publishing a file",
        async () => {
          const guest = await redeem(await grant());
          shorten(guest.clientId, Date.now() + 600);
          const req = http.request(url + "/api/files/upload?root=0", {
            method: "POST",
            headers: {
              Authorization: `Bearer ${guest.token}`,
              "Content-Type": "multipart/form-data; boundary=guest-boundary",
              "Transfer-Encoding": "chunked",
            },
          });
          req.on("error", () => {});
          const closed = new Promise((r) => req.once("close", r));
          req.write(
            '--guest-boundary\r\nContent-Disposition: form-data; name="file"; filename="unfinished.txt"\r\nContent-Type: text/plain\r\n\r\nincomplete',
          );
          await closed;
          await delay(100);
          assert.equal(
            fs.existsSync(path.join(shared, "unfinished.txt")),
            false,
          );
          assert.deepEqual(
            fs.readdirSync(path.join(reach.config.dataDir, "uploads")),
            [],
          );
        },
      );
    } finally {
      await reach.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);
