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
  const owner = { id: "owner", name: "Owner's iPhone", scopes: ALL_SCOPES };
  const other = { id: "other", name: "iPad", scopes: ALL_SCOPES };
  const agent = { id: "agent", scopes: ["screen"] };
  assert.throws(() => control.check(owner), /off or expired/);
  assert.throws(() => control.acquire(agent, true), /paired person/);
  assert.throws(() => control.acquire(owner, "true"), /true or false/);
  control.acquire(owner, true);
  control.check(owner);
  assert.deepEqual(control.holder(), { clientId: "owner", name: "Owner's iPhone", guest: false });
  // The other device watches and is told who controls.
  assert.throws(() => control.check(other), /Owner's iPhone is controlling/);
  assert.throws(() => control.acquire(other, true), /Owner's iPhone is controlling the screen/);
  control.acquire(other, false); // Cannot release someone else's control.
  control.check(owner);
  now += 30001;
  assert.throws(() => control.check(owner), /off or expired/);
  assert.equal(control.holder(), null);
  control.acquire(other, true);
  control.revoke(other.id);
  assert.throws(() => control.check(other), /off or expired/);
  control.acquire(owner, true);
  control.clear();
  assert.throws(() => control.check(owner), /off or expired/);
});

test("control never moves silently: only an explicit Take over moves it", () => {
  let now = 100;
  const control = new ScreenControl(() => now);
  const phone = { id: "phone", name: "iPhone", scopes: ALL_SCOPES };
  const ipad = { id: "ipad", name: "iPad", scopes: ALL_SCOPES };
  const ali = { id: "ali", name: "Ali", kind: "guest", scopes: ["screen", "screen:control"] };
  const sam = { id: "sam", name: "Sam", kind: "guest", scopes: ["screen", "screen:control"] };
  control.acquire(ali, true);
  // Your own renewals (each action renews) no longer take it from your guest:
  // the two phones used to take it from each other on every tap.
  const asked = (() => {
    try {
      control.acquire(phone, true);
    } catch (e) {
      return e;
    }
  })();
  assert.equal(asked.status, 409);
  assert.deepEqual(asked.holder, { name: "Ali", guest: true });
  assert.equal(asked.canTakeOver, true, "you can take it from a guest");
  control.check(ali);
  // An explicit Take over moves it, and says from whom.
  assert.deepEqual(control.acquire(phone, true, { takeover: true }), { enabled: true, expiresAt: 30100, taken: "ali" });
  assert.throws(() => control.check(ali), /iPhone is controlling/);
  // A guest never takes it from you, even asking.
  const refused = (() => {
    try {
      control.acquire(ali, true, { takeover: true });
    } catch (e) {
      return e;
    }
  })();
  assert.equal(refused.status, 409);
  assert.equal(refused.canTakeOver, false);
  // Your other device takes over only when asked.
  assert.throws(() => control.acquire(ipad, true), /iPhone is controlling/);
  assert.equal(control.acquire(ipad, true, { takeover: true }).taken, "phone");
  // Between guests, Take over works both ways.
  now += 30001;
  control.acquire(sam, true);
  assert.equal(control.acquire(ali, true, { takeover: true }).taken, "sam");
});

test("while the Mac shows one of its own dialogs, only the owner's own devices click or type", () => {
  const now = 1000;
  const control = new ScreenControl(() => now);
  let dialog = false;
  control.dialogUp = () => dialog;
  const me = { id: "me", name: "Me", kind: "device", scopes: ["admin", "screen"] };
  const ali = { id: "ali", name: "Ali", kind: "guest", scopes: ["screen", "screen:control"] };
  const other = { id: "x", name: "X", kind: "linked-mac", scopes: ["admin", "screen"] };
  control.acquire(ali, true);
  control.check(ali);
  dialog = true;
  // Every check before a click or key, and the live connection's own.
  assert.throws(() => control.check(ali), (e) => e.status === 423 && /only its owner can answer/.test(e.message));
  assert.throws(() => control.acquire(ali, true), (e) => e.status === 423);
  assert.throws(() => control.acquire(other, true, { takeover: true }), (e) => e.status === 423);
  assert.deepEqual(control.acquire(ali, false), { enabled: false });
  // Yours: unchanged.
  assert.equal(control.acquire(me, true).enabled, true);
  control.check(me);
  dialog = false;
  control.acquire(me, false);
  assert.equal(control.acquire(ali, true).enabled, true);
  // A person with full access answers the Mac's dialogs like you (Oct 11),
  // and takes control from a limited guest; a limited guest can't take it back.
  const aya = { id: "aya", name: "Aya", kind: "guest", scopes: ["admin", "screen"] };
  dialog = true;
  assert.equal(control.acquire(aya, true, { takeover: true }).enabled, true);
  control.check(aya);
  assert.deepEqual(control.holder(), { clientId: "aya", name: "Aya", guest: false, person: true });
  dialog = false;
  assert.throws(() => control.acquire(ali, true, { takeover: true }), (e) => e.status === 409 && e.canTakeOver === false);
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
    // The first phone in turned viewing on; switched off here, as you can.
    assert.equal(reach.config.screen, true);
    assert.equal((await call("/api/settings", owner, { screen: false })).status, 200);
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
    // The whole, unfiltered picture is yours (and full-access people's):
    // someone invited to watch gets the live screen without private windows.
    const watch = reach.auth.inviteGuest({ name: "Watcher", ttlSeconds: 600, screen: "view", apps: "all" });
    const watcher = reach.auth.redeemGuest(watch.invitation);
    const refused = await call("/api/screen", watcher);
    assert.equal(refused.status, 403);
    assert.match((await refused.json()).error, /live screen/);
    assert.equal(
      (await call("/api/screen/control", owner, { enabled: true })).status,
      200,
    );
    assert.equal(
      (await call("/api/screen/control", other, { enabled: true })).status,
      409,
    );
    // Someone else controls: the answer says so (not "expired").
    assert.equal(
      (await call("/api/screen/input", other, { type: "key", key: "invalid" }))
        .status,
      409,
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
