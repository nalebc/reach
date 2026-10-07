import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import { WebSocket } from "ws";
import { createReach } from "../server/index.mjs";
import { ALL_SCOPES, atomicJson, loadJson } from "../server/core.mjs";

test(
  "security boundaries: routes, origins, ownership, expiry, and private state",
  { timeout: 20000 },
  async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "reach-security-"));
    const privateDir = path.join(root, ".reach");
    const reach = await createReach({
      roots: [root],
      dataDir: path.join(privateDir, "quick"),
      privatePaths: [privateDir],
      publicOrigin: "https://my-computer.example.ts.net:8444",
    });
    await new Promise((r) => reach.server.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${reach.server.address().port}`;
    const admin = reach.auth.issue("owner", ALL_SCOPES);
    const files = reach.auth.issue("files agent", ["files"], "agent");
    const agent = reach.auth.issue("agent", ["terminal", "codex"], "agent");
    const other = reach.auth.issue("other", ["terminal", "codex"], "agent");
    const call = (route, identity = admin, body, headers = {}, method) =>
      fetch(url + route, {
        method: method || (body ? "POST" : "GET"),
        headers: {
          Authorization: `Bearer ${identity.token}`,
          ...(body ? { "Content-Type": "application/json" } : {}),
          ...headers,
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    const host = (value) =>
      new Promise((resolve, reject) => {
        const req = http.get(
          url + "/api/health",
          { headers: { Host: value } },
          (res) => {
            res.resume();
            res.on("end", () => resolve(res.statusCode));
          },
        );
        req.on("error", reject);
      });
    const socket = async (identity, sessionId) => {
      const ws = new WebSocket(url.replace("http:", "ws:") + "/ws/terminal");
      const messages = [];
      ws.on("message", (b) => messages.push(JSON.parse(b)));
      await once(ws, "open");
      ws.send(
        JSON.stringify({ type: "auth", token: identity.token, sessionId }),
      );
      return { ws, messages };
    };
    try {
      await t.test("document preview does not permit external frames, plugins, or embedding Reach", async () => {
        const response = await call("/api/health");
        const policy = response.headers.get("content-security-policy");
        const directives = new Map(policy.split(";").map((part) => {
          const [name, ...sources] = part.trim().split(/\s+/);
          return [name, sources];
        }));
        assert.deepEqual(directives.get("frame-src") || directives.get("default-src"), ["'self'"]);
        assert.deepEqual(directives.get("frame-ancestors"), ["'none'"]);
        assert.deepEqual(directives.get("object-src"), ["'none'"]);
        assert.equal(response.headers.get("x-frame-options"), "DENY");
      });
      await t.test(
        "mixed-case routes cannot bypass scopes, including agent approvals",
        async () => {
          for (const route of [
            "/api/CLIENTS",
            "/API/ClIeNtS",
            "/api/SETTINGS",
            "/api/Terminals",
            "/api/ChAtS",
          ]) {
            assert.equal((await call(route, files)).status, 403, route);
          }
          assert.equal(
            (await call("/api/JoBs", files, { command: "echo never" })).status,
            403,
          );
          assert.equal(
            (
              await call("/api/AgEnTs/ReQuEsTs/nonexistent", files, {
                decision: "approve",
              })
            ).status,
            403,
          );
          assert.equal((await call("/api/unknown", files)).status, 403);
        },
      );
      await t.test(
        "only explicit browser origins and exact hostnames are accepted",
        async () => {
          for (const origin of [
            "https://attacker.example",
            "https://other.example.ts.net",
            "null",
            "http://localhost:9999",
          ]) {
            assert.equal(
              (await call("/api/health", admin, undefined, { Origin: origin }))
                .status,
              403,
            );
          }
          for (const origin of [
            url,
            "https://my-computer.example.ts.net:8444",
            "capacitor://localhost",
          ]) {
            assert.equal(
              (await call("/api/health", admin, undefined, { Origin: origin }))
                .status,
              200,
            );
          }
          for (const value of [
            "attacker.example.ts.net",
            "[evil]:123",
            "127.0.0.1@evil.example",
          ])
            assert.equal(await host(value), 403);
          assert.equal(await host("my-computer.example.ts.net:8444"), 200);
          assert.equal(
            (
              await call("/api/health", admin, undefined, {
                "Tailscale-Funnel-Request": "?1",
              })
            ).status,
            403,
          );
        },
      );
      await t.test(
        "agents cannot list, delete or attach to another client terminal",
        async () => {
          const terminal = await (
            await call("/api/terminals", agent, { name: "private terminal" })
          ).json();
          assert.equal(
            (await (await call("/api/terminals", other)).json()).length,
            0,
          );
          assert.equal(
            (
              await call(
                "/api/terminals/" + terminal.id,
                other,
                undefined,
                {},
                "DELETE",
              )
            ).status,
            403,
          );
          const denied = await socket(other, terminal.id);
          await once(denied.ws, "close");
          assert.ok(denied.messages.some((m) => m.type === "error"));
          assert.ok(!denied.messages.some((m) => m.type === "snapshot"));
          const permitted = await socket(agent, terminal.id);
          await new Promise((r) => setTimeout(r, 50));
          assert.ok(permitted.messages.some((m) => m.type === "snapshot"));
          const closed = once(permitted.ws, "close");
          reach.auth.revoke(agent.clientId);
          await closed;
          assert.equal((await call("/api/terminals", agent)).status, 401);
        },
      );
      await t.test(
        "agents cannot access other chats or grant their own Codex approvals",
        async () => {
          const chat = {
            id: "owned-chat",
            clientId: other.clientId,
            status: "waiting",
            items: [],
            approvals: [
              {
                id: 42,
                method: "item/commandExecution/requestApproval",
                params: {},
              },
            ],
          };
          reach.codex.chats.push(chat);
          const outsider = reach.auth.issue("outsider", ["codex"], "agent");
          assert.equal(
            (await (await call("/api/chats", outsider)).json()).length,
            0,
          );
          for (const suffix of ["", "/messages", "/stop"]) {
            assert.equal(
              (
                await call(
                  "/api/chats/owned-chat" + suffix,
                  outsider,
                  suffix ? { text: "blocked" } : undefined,
                )
              ).status,
              403,
            );
          }
          let approved = false;
          reach.codex.send = (_, callback) => {
            approved = true;
            callback?.();
          };
          assert.equal(
            (
              await call("/api/chats/owned-chat/approvals/42", other, {
                decision: "accept",
              })
            ).status,
            403,
          );
          assert.equal(approved, false);
          const guestInvitation = reach.auth.inviteGuest({ name: "Full guest", ttlSeconds: 600, full: true });
          const guest = reach.auth.redeemGuest(guestInvitation.invitation);
          const service = reach.auth.issue("Service credential", ALL_SCOPES, "service");
          for (const credential of [guest, service]) {
            assert.equal(
              (await call("/api/chats/owned-chat/approvals/42", credential, { decision: "accept" })).status,
              403,
              "admin scope alone cannot answer the owner's Codex approvals",
            );
            assert.equal(approved, false);
          }
          assert.equal(
            (
              await call("/api/chats/owned-chat/approvals/42", admin, {
                decision: "decline",
              })
            ).status,
            200,
          );
        },
      );
      await t.test(
        "credentials expire and private launcher files cannot be downloaded",
        async () => {
          const file = path.join(reach.config.dataDir, "clients.json");
          const clients = loadJson(file, []);
          clients.find((c) => c.id === files.clientId).expiresAt =
            Date.now() - 1;
          atomicJson(file, clients);
          assert.equal((await call("/api/files", files)).status, 401);
          await fs.writeFile(path.join(privateDir, "setup.log"), "not shared");
          for (const name of [
            ".reach/setup.log",
            ".reach/quick/clients.json",
            ".reach/quick/pairing.json",
          ]) {
            assert.equal(
              (
                await call(
                  "/api/files/content?path=" + encodeURIComponent(name),
                )
              ).status,
              403,
            );
          }
          if (process.platform !== "win32") {
            await fs.symlink(privateDir, path.join(root, "alias"));
            assert.equal(
              (await call("/api/files/text?path=alias/setup.log")).status,
              403,
            );
          }
        },
      );
      await t.test(
        "unsafe upload and folder names are rejected across platforms",
        async () => {
          for (const name of [
            "CON",
            "NUL.txt",
            "LPT1",
            "COM1.log",
            "trailing.",
            "trailing ",
            ".hidden",
            "../escape",
          ]) {
            assert.equal(
              (await call("/api/files/folder", admin, { name })).status,
              400,
              name,
            );
          }
          const form = new FormData();
          form.append("file", new Blob(["blocked"]), "CON.txt");
          assert.equal(
            (
              await fetch(url + "/api/files/upload", {
                method: "POST",
                headers: { Authorization: `Bearer ${admin.token}` },
                body: form,
              })
            ).status,
            400,
          );
          assert.deepEqual(
            await fs.readdir(path.join(reach.config.dataDir, "uploads")),
            [],
          );
        },
      );
      await t.test(
        "pairing is one-use, expiring, and rate-limited",
        async () => {
          atomicJson(path.join(reach.config.dataDir, "pairing.json"), {
            code: "12345678",
            expiresAt: Date.now() - 1,
          });
          assert.equal(
            (await call("/api/pair", admin, { code: "12345678" })).status,
            401,
          );
          for (let i = 0; i < 4; i++)
            assert.equal(
              (await call("/api/pair", admin, { code: "00000000" })).status,
              401,
            );
          assert.equal(
            (await call("/api/pair", admin, { code: "00000000" })).status,
            429,
          );
        },
      );
    } finally {
      await reach.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);
