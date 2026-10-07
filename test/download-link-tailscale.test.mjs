import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { createReach } from "../server/index.mjs";
import { approvalStore } from "../server/device-approval.mjs";

const owner = { userId: "42", login: "owner@example.test" };
const whois = (node, user = 42) => ({
  Node: {
    StableID: node,
    User: user,
    Name: `${node}.test.ts.net.`,
    KeyExpiry: "0001-01-01T00:00:00Z",
  },
  UserProfile: {
    ID: user,
    LoginName: user === 42 ? owner.login : "other@example.test",
  },
});

test(
  "a download link works only from the Tailscale device that asked for it",
  { skip: process.platform === "win32", timeout: 20000 },
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "reach-link-ts-"));
    const socketDir = await fs.mkdtemp("/tmp/reach-link-socket-");
    const socketPath = path.join(socketDir, "s");
    const dataDir = path.join(root, "private");
    await fs.writeFile(path.join(root, "report.pdf"), "pdf bytes");
    const devices = new Map([
      ["100.64.0.1", whois("nPhone")],
      ["100.64.0.2", whois("nOther")],
      ["100.64.0.3", whois("nStranger", 99)],
    ]);
    const reach = await createReach({
      roots: [root],
      dataDir,
      port: 0,
      tailscaleOwner: owner,
      tailscaleIdentity: {
        lookup: async (ip) => {
          if (!devices.has(ip)) throw Error("disconnected");
          return devices.get(ip);
        },
      },
    });
    await new Promise((r) => reach.server.listen(0, "127.0.0.1", r));
    await reach.listenPrivate(socketPath);
    // Requests through Tailscale Serve (the private socket) from a device.
    const call = (
      route,
      { from = "100.64.0.1", body, headers = {}, tcp } = {},
    ) =>
      new Promise((resolve, reject) => {
        const req = http.request(
          {
            ...(tcp
              ? { hostname: "127.0.0.1", port: reach.server.address().port }
              : { socketPath }),
            path: route,
            method: body ? "POST" : "GET",
            headers: {
              Host: "localhost",
              "X-Forwarded-For": from,
              "Tailscale-User-Login": owner.login,
              ...(body ? { "Content-Type": "application/json" } : {}),
              ...headers,
            },
          },
          (res) => {
            const chunks = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () =>
              resolve({ status: res.statusCode, body: Buffer.concat(chunks) }),
            );
          },
        );
        req.once("error", reject);
        req.end(body ? JSON.stringify(body) : undefined);
      });
    try {
      // The phone pairs and is approved on the Mac: bound to nPhone.
      const created = await call("/api/auth/requests", {
        body: { name: "Phone" },
      });
      assert.equal(created.status, 202, created.body.toString());
      const request = JSON.parse(created.body);
      approvalStore(dataDir).decide(request.id, "approve");
      const { token } = JSON.parse(
        (
          await call(`/api/auth/requests/${request.id}`, {
            body: { secret: request.secret },
          })
        ).body,
      );
      const link = JSON.parse(
        (
          await call("/api/files/download-link?root=0&path=report.pdf", {
            headers: { Authorization: `Bearer ${token}` },
          })
        ).body,
      );
      // The phone itself: the file.
      const mine = await call(link.url);
      assert.equal(mine.status, 200);
      assert.equal(mine.body.toString(), "pdf bytes");
      // Same owner, another device; a stranger; and no Tailscale at all.
      assert.equal((await call(link.url, { from: "100.64.0.2" })).status, 403);
      assert.equal((await call(link.url, { from: "100.64.0.3" })).status, 403);
      assert.equal((await call(link.url, { tcp: true })).status, 403);
    } finally {
      await reach.close();
      await fs.rm(root, { recursive: true, force: true });
      await fs.rm(socketDir, { recursive: true, force: true });
    }
  },
);
