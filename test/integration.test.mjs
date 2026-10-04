import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import { once } from "node:events";
import { createReach } from "../server/index.mjs";
import { atomicJson, hash, id, loadJson } from "../server/core.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
test("Reach companion: authenticated end-to-end flows", async (t) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "reach-test-")),
    root = path.join(temp, "shared"),
    dataDir = path.join(temp, "private");
  await fs.mkdir(root);
  await fs.writeFile(path.join(root, "hello.txt"), "hello from the computer");
  await fs.mkdir(path.join(root, "project"));
  await fs.writeFile(path.join(temp, "outside.txt"), "must not be served");
  if (process.platform !== "win32")
    await fs.symlink(
      path.join(temp, "outside.txt"),
      path.join(root, "escape.txt"),
    );
  const reach = await createReach({
    roots: [root],
    dataDir,
    port: 0,
    name: "Test computer",
  });
  await new Promise((r) => reach.server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${reach.server.address().port}`;
  let token, clientId;
  const call = async (route, body, opts = {}) => {
    const response = await fetch(url + route, {
      method: opts.method || (body ? "POST" : "GET"),
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...opts.headers,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const result = { status: response.status, body: await response.json() };
    return result;
  };
  try {
    await t.test(
      "unauthenticated and hostile-origin requests are rejected",
      async () => {
        assert.equal((await call("/api/device")).status, 401);
        assert.equal(
          (
            await call("/api/health", null, {
              headers: { Origin: "http://untrusted.example" },
            })
          ).status,
          403,
        );

        assert.equal(
          (await call("/api/pair", { code: "00000000" })).status,
          401,
        );
      },
    );
    await t.test(
      "pair once, then reject reuse of the pairing code",
      async () => {
        const paired = await call("/api/pair", {
          code: reach.auth.pairing.code,
          name: "Test browser",
        });
        assert.equal(paired.status, 200);
        token = paired.body.token;
        clientId = paired.body.clientId;
        assert.equal(paired.body.device.name, "Test computer");
        assert.equal(
          (await call("/api/pair", { code: reach.auth.pairing.code })).status,
          401,
        );
        assert.equal((await call("/api/device")).body.roots.length, 1);
      },
    );
    await t.test(
      "list files and prevent traversal and symlink escapes",
      async () => {
        const result = await call("/api/files");
        assert.equal(result.status, 200);
        assert.ok(result.body.items.some((f) => f.name === "hello.txt"));
        assert.ok(!result.body.items.some((f) => f.name === "escape.txt"));
        assert.equal(
          (await call("/api/files/text?path=..%2Foutside.txt")).status,
          403,
        );
        if (process.platform !== "win32")
          assert.equal(
            (await call("/api/files/text?path=escape.txt")).status,
            403,
          );
        assert.equal(
          (await call("/api/files/text?path=hello.txt")).body.text,
          "hello from the computer",
        );
      },
    );
    await t.test(
      "upload/download round trip; existing files are never overwritten",
      async () => {
        const upload = async () => {
          const form = new FormData();
          form.append("file", new Blob(["uploaded from phone"]), "phone.txt");
          return fetch(url + "/api/files/upload?path=project", {
            method: "POST",
            headers: { Authorization: `Bearer ${token}` },
            body: form,
          });
        };
        assert.equal((await upload()).status, 200);
        assert.equal((await upload()).status, 409);
        const response = await fetch(
          url + "/api/files/content?path=project%2Fphone.txt",
          { headers: { Authorization: `Bearer ${token}` } },
        );
        assert.equal(await response.text(), "uploaded from phone");
        assert.match(response.headers.get("content-disposition"), /attachment/);
        assert.equal(
          (
            await call("/api/files/folder", {
              name: "new folder",
              path: "project",
            })
          ).status,
          200,
        );
      },
    );
    await t.test(
      "real terminal runs a command and survives disconnect/reconnect",
      async () => {
        const result = await call("/api/terminals", {
          path: "project",
          name: "Integration terminal",
        });
        assert.equal(result.status, 200);
        const sessionId = result.body.id;
        const connect = () => {
          const ws = new WebSocket(
            url.replace("http:", "ws:") + "/ws/terminal",
          );
          const received = [];
          ws.on("message", (b) => received.push(JSON.parse(b)));
          ws.on("open", () =>
            ws.send(JSON.stringify({ type: "auth", token, sessionId })),
          );
          return { ws, received };
        };
        const first = connect();
        await once(first.ws, "open");
        await sleep(150);
        first.ws.send(
          JSON.stringify({
            type: "input",
            data:
              process.platform === "win32"
                ? "Write-Output 'reach-pty-ok'\r"
                : "printf 'reach-pty-ok\\n'\r",
          }),
        );
        for (
          let i = 0;
          i < 50 &&
          !first.received.some((m) => m.data?.includes("reach-pty-ok"));
          i++
        )
          await sleep(100);
        assert.ok(first.received.some((m) => m.data?.includes("reach-pty-ok")));
        first.ws.close();
        await once(first.ws, "close");
        const second = connect();
        await once(second.ws, "open");
        for (
          let i = 0;
          i < 30 && !second.received.some((m) => m.type === "snapshot");
          i++
        )
          await sleep(100);
        assert.ok(
          second.received
            .find((m) => m.type === "snapshot")
            .data.includes("reach-pty-ok"),
        );
        second.ws.close();
        await once(second.ws, "close");
        await call(`/api/terminals/${sessionId}`, null, { method: "DELETE" });
      },
    );
    await t.test("agent jobs return actual output and time out", async () => {
      let result = await call("/api/jobs", {
        command:
          process.platform === "win32"
            ? "Write-Output 'reach-job-ok'"
            : "printf 'reach-job-ok'",
        path: "project",
      });
      assert.equal(result.status, 202);
      const jobId = result.body.id;
      for (let i = 0; i < 50 && result.body.status === "running"; i++) {
        await sleep(100);
        result = await call("/api/jobs/" + jobId);
      }
      assert.equal(result.body.status, "completed");
      assert.match(result.body.output, /reach-job-ok/);
      const slow = await call("/api/jobs", {
        command:
          process.platform === "win32" ? "Start-Sleep -Seconds 10" : "sleep 10",
        timeoutMs: 1000,
      });
      await sleep(1400);
      assert.equal(
        (await call("/api/jobs/" + slow.body.id)).body.status,
        "timed_out",
      );
    });
    await t.test(
      "scoped agent key can access files but cannot launch apps, get admin data, or execute",
      async () => {
        const agentToken = "test-token-only-" + id();
        const file = path.join(dataDir, "clients.json");
        const clients = loadJson(file, []);
        clients.push({
          id: id(),
          name: "Files agent",
          scopes: ["files"],
          hash: hash(agentToken),
          createdAt: new Date().toISOString(),
        });
        atomicJson(file, clients);
        const adminToken = token;
        token = agentToken;
        assert.equal((await call("/api/files")).status, 200);
        assert.equal((await call("/api/apps")).status, 403);
        assert.equal((await call("/api/clients")).status, 403);
        assert.equal(
          (await call("/api/jobs", { command: "echo no" })).status,
          403,
        );
        token = adminToken;
      },
    );
    await t.test("screen access is off by default", async () => {
      assert.equal((await call("/api/screen")).status, 403);
      assert.equal(
        (await call("/api/screen/input", { type: "key", key: "enter" })).status,
        403,
      );
    });
    await t.test(
      "the iPhone app origin is accepted; others are not",
      async () => {
        const origin = (o) =>
          call("/api/health", null, { headers: { Origin: o } });
        assert.equal((await origin("capacitor://localhost")).status, 200);
        assert.equal((await origin("capacitor://evil")).status, 403);
      },
    );
    await t.test(
      "screen access can be turned on from a paired phone and persists",
      async () => {
        assert.equal(
          (await call("/api/settings", { screen: "yes" })).status,
          400,
        );
        assert.equal(
          (await call("/api/settings", { screen: true })).body.screen,
          true,
        );
        assert.equal(
          (await call("/api/device")).body.capabilities.screen,
          true,
        );
        assert.equal(
          loadJson(path.join(dataDir, "settings.json"), {}).screen,
          true,
        );
        await call("/api/screen/control", { enabled: true });
        assert.equal(
          (await call("/api/screen/input", { type: "key", key: "nope" }))
            .status,
          400,
        );
        await call("/api/settings", { screen: false });
      },
    );
    await t.test(
      "agent access requests need phone approval and deliver the token once",
      async () => {
        const ask = await call("/api/agents/requests", {
          name: "Build bot",
          scopes: ["files"],
        });
        assert.equal(ask.status, 202);
        const status = (secret) =>
          fetch(`${url}/api/agents/requests/${ask.body.id}/status`, {
            headers: { "X-Request-Secret": secret },
          });
        assert.equal(
          (await (await status(ask.body.secret)).json()).status,
          "pending",
        );
        assert.equal((await status("wrong")).status, 404);
        assert.equal(
          (
            await call("/api/agents/requests", {
              name: "Root",
              scopes: ["admin"],
            })
          ).status,
          400,
        );
        const pending = await call("/api/agents/requests");
        assert.ok(
          pending.body.some((r) => r.id === ask.body.id && !r.secretHash),
        );
        assert.equal(
          (
            await call(`/api/agents/requests/${ask.body.id}`, {
              decision: "approve",
            })
          ).status,
          200,
        );
        const approved = await (await status(ask.body.secret)).json();
        assert.equal(approved.status, "approved");
        assert.ok(approved.token);
        assert.equal((await status(ask.body.secret)).status, 404);
        const owner = token;
        token = approved.token;
        assert.equal((await call("/api/files")).status, 200);
        assert.equal(
          (await call("/api/jobs", { command: "echo no" })).status,
          403,
        );
        assert.equal((await call("/api/agents/requests")).status, 403);
        token = owner;
      },
    );
    await t.test(
      "revocation immediately removes API and terminal access",
      async () => {
        assert.equal(
          (await call("/api/clients/" + clientId, null, { method: "DELETE" }))
            .status,
          200,
        );
        assert.equal((await call("/api/files")).status, 401);
      },
    );
  } finally {
    await reach.close();
    await fs.rm(temp, { recursive: true, force: true });
  }
});
