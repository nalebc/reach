import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createReach } from "../server/index.mjs";
import { ALL_SCOPES } from "../server/core.mjs";
test("the notification action route accepts only owner decisions for the unchanged live prompt", async (t) => {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "reach-notification-actions-"),
  );
  const calls = [];
  let prompts = [
    {
      id: "p1",
      kind: "command",
      title: "Run tests",
      command: "npm test",
      decisions: ["accept", "decline"],
    },
  ];
  const reach = await createReach({
    dataDir: path.join(dir, "private"),
    roots: [dir],
    agentSessions: {
      list: async () => ({
        sessions: [
          {
            agent: "codex",
            id: "chat",
            title: "Project",
            status: "waiting",
            prompts,
          },
        ],
      }),
      respond: async (...args) => {
        calls.push(args);
        prompts = [];
        return { ok: true };
      },
      close() {},
    },
    openClaw: { overview: async () => ({ connected: false }), close() {} },
  });
  t.after(async () => {
    await reach.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await new Promise((resolve) => reach.server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${reach.server.address().port}`;
  const owner = reach.auth.issue("Owner", ALL_SCOPES).token;
  const invited = reach.auth.inviteGuest({
    name: "Guest",
    ttlSeconds: 3600,
    full: true,
  });
  const guest = reach.auth.redeemGuest(invited.invitation).token;
  const call = async (route, token = owner, body) => {
    const r = await fetch(url + route, {
      method: body ? "POST" : "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: r.status, body: await r.json() };
  };
  const item = (await call("/api/notifications")).body.items[0];
  assert.equal(item._binding, undefined);
  const route = `/api/notifications/${encodeURIComponent(item.id)}/actions`;
  const body = { revision: item.revision, action: "approve" };
  assert.equal((await call(route, guest, body)).status, 403);
  assert.equal(
    (await call(route, owner, { ...body, command: "rm -rf /" })).status,
    400,
  );
  assert.equal((await call(route, owner, body)).status, 200);
  assert.deepEqual(calls, [["codex", "chat", "p1", { decision: "accept" }]]);
  assert.equal((await call(route, owner, body)).status, 409);
});
