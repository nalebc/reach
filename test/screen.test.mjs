import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { ScreenControl } from "../server/screen.mjs";
import { screenInput } from "../server/platform.mjs";
import { createReach } from "../server/index.mjs";
import { ALL_SCOPES } from "../server/core.mjs";

test("screen control belongs to one paired person, expires, and can be revoked", () => {
  let now = 100;
  const control = new ScreenControl(() => now);
  const owner = { id: "owner", scopes: ALL_SCOPES };
  const other = { id: "other", scopes: ALL_SCOPES };
  const agent = { id: "agent", scopes: ["screen"] };
  assert.throws(() => control.check(owner), /off or expired/);
  assert.throws(() => control.acquire(agent, true), /paired person/);
  assert.throws(() => control.acquire(owner, "true"), /true or false/);
  control.acquire(owner, true);
  control.check(owner);
  assert.throws(() => control.check(other), /off or expired/);
  assert.throws(() => control.acquire(other, true), /Another paired device/);
  control.acquire(other, false); // Cannot release someone else's control.
  control.check(owner);
  now += 30001;
  assert.throws(() => control.check(owner), /off or expired/);
  control.acquire(other, true);
  control.revoke(other.id);
  assert.throws(() => control.check(other), /off or expired/);
  control.acquire(owner, true);
  control.clear();
  assert.throws(() => control.check(owner), /off or expired/);
});

test("invalid pointer, scroll and keyboard payloads never reach native input", async () => {
  for (const payload of [
    null,
    {},
    { type: "drag" },
    { type: "click", x: -1, y: 0 },
    { type: "click", x: 0, y: Infinity },
    { type: "click", x: 0, y: 0, count: 100 },
    { type: "click", x: 0, y: 0, button: "other" },
    { type: "scroll", delta: Infinity },
    { type: "scroll", delta: 11 },
    { type: "scroll", delta: 0 },
    { type: "text", text: "x".repeat(2001) },
    { type: "key", key: "arbitrary" },
  ]) {
    await assert.rejects(
      screenInput({ screen: true }, payload),
      (e) => e.status === 400,
    );
  }
});

test("screen HTTP endpoints require viewing plus a separate per-client control grant", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "reach-screen-test-"));
  const reach = await createReach({
    roots: [root],
    dataDir: path.join(root, ".reach"),
    port: 0,
  });
  await new Promise((r) => reach.server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${reach.server.address().port}`;
  const owner = reach.auth.issue("owner", ALL_SCOPES);
  const other = reach.auth.issue("other", ALL_SCOPES);
  const agent = reach.auth.issue("viewer", ["screen"], "agent");
  const call = (route, who, body) =>
    fetch(url + route, {
      method: body ? "POST" : "GET",
      headers: {
        ...(who ? { Authorization: `Bearer ${who.token}` } : {}),
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  try {
    assert.equal((await call("/api/screen", null)).status, 401);
    assert.equal((await call("/api/screen", owner)).status, 403);
    assert.equal(
      (await call("/api/screen/control", owner, { enabled: true })).status,
      403,
    );
    assert.equal(
      (await call("/api/settings", owner, { screen: true })).status,
      200,
    );
    assert.equal(
      (await call("/api/screen/input", owner, { type: "key", key: "invalid" }))
        .status,
      403,
    );
    assert.equal(
      (await call("/api/screen/control", agent, { enabled: true })).status,
      403,
    );
    assert.equal(
      (await call("/api/screen/control", owner, { enabled: true })).status,
      200,
    );
    assert.equal(
      (await call("/api/screen/control", other, { enabled: true })).status,
      409,
    );
    assert.equal(
      (await call("/api/screen/input", other, { type: "key", key: "invalid" }))
        .status,
      403,
    );
    // A granted owner's invalid action reaches validation, never OS execution.
    assert.equal(
      (await call("/api/screen/input", owner, { type: "key", key: "invalid" }))
        .status,
      400,
    );
    assert.equal(
      (await call("/api/settings", owner, { screen: false })).status,
      200,
    );
    assert.equal(
      (await call("/api/settings", owner, { screen: true })).status,
      200,
    );
    assert.equal(
      (await call("/api/screen/input", owner, { type: "key", key: "invalid" }))
        .status,
      403,
    );
    assert.equal(
      (await call("/api/screen/control", other, { enabled: true })).status,
      200,
    );
    const revoked = await fetch(url + "/api/clients/" + other.clientId, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${owner.token}` },
    });
    assert.equal(revoked.status, 200);
    assert.equal(
      (await call("/api/screen/control", owner, { enabled: true })).status,
      200,
    );
    assert.equal(
      (await call("/api/screen/control", owner, { enabled: false })).status,
      200,
    );
    assert.equal(
      (await call("/api/screen/input", owner, { type: "key", key: "invalid" }))
        .status,
      403,
    );
  } finally {
    await reach.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test(
  "native input rechecks permission before dispatch and forwards only validated actions",
  { skip: process.platform !== "darwin" },
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "reach-input-test-"));
    const helper = path.join(root, "input");
    const record = path.join(root, "received.json");
    await fs.writeFile(
      helper,
      '#!/bin/sh\ncat > "$REACH_TEST_INPUT_RECORD"\n',
      { mode: 0o700 },
    );
    const previous = process.env.REACH_INPUT_HELPER;
    const previousRecord = process.env.REACH_TEST_INPUT_RECORD;
    process.env.REACH_INPUT_HELPER = helper;
    process.env.REACH_TEST_INPUT_RECORD = record;
    try {
      const action = {
        type: "click",
        x: 0.25,
        y: 0.75,
        button: "right",
        count: 1,
      };
      await assert.rejects(
        screenInput({ screen: true }, action, () => {
          throw Error("control released");
        }),
        /control released/,
      );
      await assert.rejects(fs.access(record));
      for (const action of [
        { type: "click", x: 0.25, y: 0.75, button: "right", count: 1 },
        { type: "scroll", delta: -3 },
        { type: "text", text: "hello" },
        { type: "key", key: "tab" },
      ]) {
        await screenInput({ screen: true }, action);
        assert.deepEqual(JSON.parse(await fs.readFile(record, "utf8")), action);
      }
    } finally {
      if (previous === undefined) delete process.env.REACH_INPUT_HELPER;
      else process.env.REACH_INPUT_HELPER = previous;
      if (previousRecord === undefined)
        delete process.env.REACH_TEST_INPUT_RECORD;
      else process.env.REACH_TEST_INPUT_RECORD = previousRecord;
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);
