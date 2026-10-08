import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAgentShortcuts } from "../server/agent-shortcuts.mjs";
import {
  browserToolsFor,
  browserToolRequest,
} from "../server/browser-tools.mjs";
import { toolsFor } from "../scripts/mcp-server.mjs";
import {
  presetFixture,
  privateIngressTest,
  apps,
} from "./helpers/preset-fixture.mjs";

const chrome = apps.chrome;
const access = {
  preset: "apps",
  screen: true,
  control: true,
  open: true,
  apps: [chrome],
  roots: [],
  terminals: [],
};
function fixture(t, overrides = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-shortcut-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  let client = {
    id: "agent1",
    name: "Muse",
    kind: "agent",
    status: "accepted",
    expiresAt: Date.now() + 60000,
    policy: { browser: true, preset: "apps", apps: [chrome] },
    scopes: [
      "browser:control",
      "browser:open",
      "browser:screen",
      "browser:read",
    ],
  };
  let front = {
    bundle: chrome.bundleId,
    app: chrome.name,
    path: chrome.id,
    title: "Gmail",
    layout: "100,60|0,0,100,60|address",
    secure: false,
    blocked: "",
  };
  const log = [];
  const desktop = {
    front: async (_, authorize) => {
      authorize();
      return { ...front };
    },
    act: async (_, action, authorize, options) => {
      authorize();
      log.push({ action, options });
      return { ok: true, app: chrome.name, bundle: chrome.bundleId };
    },
    open: async (_, app, authorize) => {
      authorize();
      log.push({ app });
      return { ok: true, app: chrome.name, bundle: chrome.bundleId };
    },
    ...overrides.desktop,
  };
  const shortcuts = createAgentShortcuts({
    dataDir,
    desktop,
    wait: async () => {},
    ...overrides,
  });
  const authorize = () => client;
  const act = (action) => shortcuts.act(client, action, authorize);
  const recordWebsite = async (url = "https://mail.google.com/") => {
    shortcuts.start(authorize, "Open Gmail");
    await shortcuts.open(client, chrome.id, authorize);
    await act({ type: "key", key: "l", modifiers: ["cmd"] });
    await act({ type: "type", text: url });
    await act({ type: "key", key: "enter" });
    return shortcuts.save(authorize);
  };
  return {
    shortcuts,
    desktop,
    dataDir,
    authorize,
    act,
    log,
    recordWebsite,
    client: () => client,
    setClient: (value) => {
      client = value;
    },
    setFront: (value) => {
      front = { ...front, ...value };
    },
  };
}

test("records successful actions, compacts website navigation, persists and replays with current access", async (t) => {
  const f = fixture(t);
  const saved = await f.recordWebsite();
  assert.deepEqual(
    saved.steps.map((step) => step.type),
    ["open", "website"],
  );
  assert.equal(saved.enabled, true);
  assert.equal(f.shortcuts.list(f.authorize).shortcuts[0].id, saved.id);
  assert.ok(
    !f.shortcuts.list(f.authorize).shortcuts[0].steps,
    "catalog stays compact",
  );
  assert.equal(
    f.shortcuts.list(f.authorize, "Gmail").shortcuts[0].steps[1].type,
    "website",
  );
  const restored = createAgentShortcuts({
    dataDir: f.dataDir,
    desktop: f.desktop,
    wait: async () => {},
  });
  assert.equal(restored.list(f.authorize).shortcuts[0].id, saved.id);
  f.setFront({ title: "Different previous tab", layout: "different" });
  f.log.length = 0;
  const result = await restored.run(f.authorize, saved.id);
  assert.equal(result.status, "completed");
  assert.deepEqual(
    f.log.filter((entry) => entry.action).map((entry) => entry.action.type),
    ["key", "type", "key"],
  );
  assert.equal(
    f.log.find((entry) => entry.action?.type === "type").action.text,
    "https://mail.google.com/",
  );
  assert.deepEqual(f.log.find((entry) => entry.action).options.expected, {
    bundle: chrome.bundleId,
  });
  assert.equal(
    fs.statSync(path.join(f.dataDir, "agent-shortcuts.json")).mode & 0o777,
    0o600,
  );
});

test("form values and authentication URLs are inputs, never persisted or returned", async (t) => {
  const f = fixture(t);
  const secret =
    "https://example.com/callback?token=secret-session&code=secret-code";
  const saved = await f.recordWebsite(secret);
  assert.ok(saved.steps.some((step) => step.type === "input"));
  const onDisk = fs.readFileSync(
    path.join(f.dataDir, "agent-shortcuts.json"),
    "utf8",
  );
  for (const value of ["secret-session", "secret-code", "token="]) {
    assert.ok(!onDisk.includes(value));
    assert.ok(!JSON.stringify(f.shortcuts.ownerList()).includes(value));
  }
  f.shortcuts.update(saved.id, true);
  await assert.rejects(f.shortcuts.run(f.authorize, saved.id), /text inputs/);
  assert.equal(
    (await f.shortcuts.run(f.authorize, saved.id, { text1: "one-time input" }))
      .status,
    "completed",
  );
  assert.ok(
    !fs
      .readFileSync(path.join(f.dataDir, "agent-shortcuts.json"), "utf8")
      .includes("one-time input"),
  );
});

test("changed app, window, focus geometry, secure field or access stops replay before input", async (t) => {
  const f = fixture(t);
  f.shortcuts.start(f.authorize, "Click Gmail");
  await f.act({ type: "click", x: 0.5, y: 0.5 });
  const saved = f.shortcuts.save(f.authorize);
  f.shortcuts.update(saved.id, true);
  for (const mismatch of [
    { title: "Other page" },
    { layout: "moved window" },
    { secure: true },
    { blocked: "hidden" },
    { bundle: "com.apple.Notes" },
  ]) {
    f.setFront({
      title: "Gmail",
      layout: "100,60|0,0,100,60|address",
      secure: false,
      blocked: "",
      bundle: chrome.bundleId,
      ...mismatch,
    });
    f.log.length = 0;
    const result = await f.shortcuts.run(f.authorize, saved.id);
    assert.equal(result.status, "stopped");
    assert.equal(result.completedSteps, 0);
    assert.equal(f.log.length, 0);
  }
  f.setClient({
    ...f.client(),
    policy: { ...f.client().policy, apps: [apps.notes] },
  });
  assert.deepEqual(f.shortcuts.list(f.authorize).shortcuts, []);
  await assert.rejects(f.shortcuts.run(f.authorize, saved.id), /app access/);
  f.setClient({
    ...f.client(),
    policy: { ...f.client().policy, preset: "readonly" },
  });
  assert.throws(() => f.shortcuts.list(f.authorize), /app control/);
});

test("partial runs stop on disable, cancel and revoked grants, without retries", async (t) => {
  for (const change of ["disable", "cancel", "revoke"]) {
    const f = fixture(t);
    const saved = await f.recordWebsite();
    f.shortcuts.update(saved.id, true);
    f.log.length = 0;
    const original = f.desktop.open;
    f.desktop.open = async (...args) => {
      const result = await original(...args);
      if (change === "disable") f.shortcuts.update(saved.id, false);
      if (change === "cancel") f.shortcuts.cancel();
      if (change === "revoke")
        f.setClient({ ...f.client(), status: "revoked" });
      return result;
    };
    const result = await f.shortcuts.run(f.authorize, saved.id);
    assert.equal(result.status, "stopped");
    assert.equal(f.log.length, 1);
    assert.equal(result.completedSteps, 0);
    assert.equal(f.shortcuts.ownerList().running, null);
  }
});

test("recording records only successful native input, has bounded steps, and blocks concurrent replay", async (t) => {
  const f = fixture(t);
  f.shortcuts.start(f.authorize, "Recorded task");
  f.desktop.act = async () => {
    throw Error("blocked");
  };
  await assert.rejects(f.act({ type: "click", x: 0.1, y: 0.1 }), /blocked/);
  assert.equal(f.shortcuts.ownerList().recordings[0].stepCount, 0);
  f.desktop.act = async () => ({ ok: true, bundle: chrome.bundleId });
  for (let index = 0; index < 61; index++)
    await f.act({ type: "key", key: "tab" });
  assert.equal(f.shortcuts.ownerList().recordings[0].stepCount, 60);
  assert.throws(() => f.shortcuts.save(f.authorize), /60 steps/);
  f.shortcuts.discard(f.client().id);
  const saved = await f.recordWebsite();
  f.shortcuts.update(saved.id, true);
  let release;
  f.desktop.open = () =>
    new Promise((resolve) => {
      release = () => resolve({ ok: true, bundle: chrome.bundleId });
    });
  const run = f.shortcuts.run(f.authorize, saved.id);
  await assert.rejects(
    f.shortcuts.run(f.authorize, saved.id),
    /already running/,
  );
  await assert.rejects(f.act({ type: "key", key: "tab" }), /already running/);
  f.shortcuts.cancel();
  release();
  assert.equal((await run).status, "stopped");
});

test("shortcut tools are scoped, validate inputs and reach the same APIs through MCP", () => {
  const names = browserToolsFor(access).map((tool) => tool.name);
  for (const name of [
    "reach_shortcuts",
    "reach_record_shortcut",
    "reach_save_shortcut",
    "reach_discard_shortcut",
    "reach_run_shortcut",
  ])
    assert.ok(names.includes(name));
  assert.ok(
    !browserToolsFor({ ...access, control: false }).some((tool) =>
      tool.name.includes("shortcut"),
    ),
  );
  const plan = browserToolRequest(
    "reach_run_shortcut",
    { id: "recipe", values: { text1: "hello" } },
    access,
  );
  assert.equal(plan.route, "/api/browser/shortcuts/run");
  for (const values of [
    { random: "bad" },
    { text1: 42 },
    { text1: "" },
    JSON.parse('{"__proto__":"bad"}'),
  ])
    assert.throws(
      () =>
        browserToolRequest(
          "reach_run_shortcut",
          { id: "recipe", values },
          access,
        ),
      /Invalid tool/,
    );
  const tools = toolsFor(
    ["browser:read", "browser:control", "browser:open", "browser:screen"],
    access,
  );
  assert.equal(
    tools.find((tool) => tool.name === "reach_run_shortcut").annotations
      .readOnlyHint,
    false,
  );
  assert.ok(
    !toolsFor(["browser:read"], access).some((tool) =>
      tool.name.includes("shortcut"),
    ),
  );
});

test(
  "agents save and reuse tasks immediately; owner controls and app presets remain enforced",
  privateIngressTest,
  async (t) => {
    const seen = [];
    const f = await presetFixture(t, {
      desktopExtras: {
        front: async (_, authorize) => {
          authorize();
          return {
            app: chrome.name,
            bundle: chrome.bundleId,
            path: chrome.id,
            title: "Gmail",
            layout: "",
            secure: false,
            blocked: "",
          };
        },
        act: async (_, action, authorize) => {
          authorize();
          seen.push(action);
          return { ok: true, bundle: chrome.bundleId };
        },
        open: async (_, app, authorize) => {
          authorize();
          return { ok: true, bundle: chrome.bundleId };
        },
      },
    });
    const agent = await f.join({ preset: "apps", apps: [{ id: chrome.id }] });
    const started = await agent.as("/api/browser/shortcuts/record", {
      method: "POST",
      body: { name: "Open Gmail" },
    });
    assert.equal(started.status, 201, JSON.stringify(started.body));
    for (const action of [
      { type: "key", key: "l", modifiers: ["cmd"] },
      { type: "type", text: "https://mail.google.com/" },
      { type: "key", key: "enter" },
    ])
      assert.equal(
        (
          await agent.as("/api/browser/desktop/input", {
            method: "POST",
            body: { action },
          })
        ).status,
        200,
      );
    const saved = await agent.as("/api/browser/shortcuts/save", {
      method: "POST",
      body: {},
    });
    assert.equal(saved.status, 201, JSON.stringify(saved.body));
    assert.equal(saved.body.enabled, true);
    const id = saved.body.id;
    const listedAccess = await agent.as("/api/browser");
    const offered = browserToolsFor(listedAccess.body).find((tool) =>
      tool.name.startsWith("reach_saved_"),
    );
    assert.equal(offered.title, "Open Gmail");
    assert.match(
      listedAccess.body.savedToolHint,
      /Before starting a laptop task/,
    );
    assert.equal(listedAccess.body.savedTools[0].tool, offered.name);
    const direct = browserToolRequest(offered.name, {}, listedAccess.body);
    assert.equal(direct.body.id, id);
    assert.equal(
      (
        await agent.as(direct.route, {
          method: direct.method,
          body: direct.body,
        })
      ).body.status,
      "completed",
    );
    assert.equal(
      (
        await agent.as(`/api/agents/shortcuts/${id}`, {
          method: "PATCH",
          body: { enabled: true },
        })
      ).status,
      403,
    );
    assert.equal(
      (await agent.as("/api/browser/shortcuts")).body.shortcuts.length,
      1,
    );
    const run = await agent.as("/api/browser/shortcuts/run", {
      method: "POST",
      body: { id },
    });
    assert.equal(run.status, 200, JSON.stringify(run.body));
    assert.equal(run.body.status, "completed");
    const watcher = await f.join({ preset: "readonly" });
    assert.equal((await watcher.as("/api/browser/shortcuts")).status, 403);
    assert.equal(
      (
        await watcher.as("/api/browser/shortcuts/record", {
          method: "POST",
          body: { name: "No" },
        })
      ).status,
      403,
    );
    const another = await f.join({
      preset: "apps",
      apps: [{ id: apps.notes.id }],
    });
    assert.deepEqual(
      (await another.as("/api/browser/shortcuts")).body.shortcuts,
      [],
    );
    assert.equal(
      (
        await another.as("/api/browser/shortcuts/run", {
          method: "POST",
          body: { id },
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await f.call(`/api/agents/shortcuts/${id}`, {
          method: "PATCH",
          body: { enabled: false },
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await agent.as("/api/browser/shortcuts/run", {
          method: "POST",
          body: { id },
        })
      ).status,
      403,
    );
    const removed = await f.call(`/api/agents/shortcuts/${id}`, {
      method: "DELETE",
    });
    assert.equal(removed.status, 200, JSON.stringify(removed.body));
    assert.equal(
      (await f.call("/api/agents/shortcuts")).body.shortcuts.length,
      0,
    );
  },
);

test("token-bearing URL paths stay per-run inputs rather than reusable saved credentials", async (t) => {
  const f = fixture(t);
  const secret = "https://example.test/reset/one-time-secret-token";
  const saved = await f.recordWebsite(secret);
  assert.ok(saved.steps.some((step) => step.type === "input"));
  assert.ok(!JSON.stringify(saved).includes("one-time-secret-token"));
  assert.ok(
    !JSON.stringify(f.shortcuts.list(f.authorize, "Gmail")).includes(
      "one-time-secret-token",
    ),
  );
  assert.ok(
    !fs
      .readFileSync(path.join(f.dataDir, "agent-shortcuts.json"), "utf8")
      .includes("one-time-secret-token"),
  );
});

test("printable key recording refuses persistence and keeps normal navigation and shortcuts", async (t) => {
  for (const action of [
    { type: "key", key: "a" },
    { type: "key", key: "a", modifiers: ["shift"] },
    { type: "key", key: "space" },
    { type: "key", key: "a", modifiers: ["option"] },
  ]) {
    const f = fixture(t);
    f.shortcuts.start(f.authorize, "Private form task");
    await f.act(action);
    assert.equal(
      f.log.length,
      1,
      "the normal authorized key action still succeeds",
    );
    assert.equal(f.shortcuts.ownerList().recordings[0].stepCount, 0);
    assert.throws(
      () => f.shortcuts.save(f.authorize),
      /Type.*text|text.*Type/i,
    );
    assert.equal(
      fs.existsSync(path.join(f.dataDir, "agent-shortcuts.json")),
      false,
    );
  }
  const f = fixture(t);
  f.shortcuts.start(f.authorize, "Navigation");
  for (const action of [
    { type: "key", key: "tab" },
    { type: "key", key: "a", modifiers: ["cmd"] },
  ])
    await f.act(action);
  assert.equal(f.shortcuts.save(f.authorize).steps.length, 2);
});

test("owner stop targets a run instance, and disable remains stopped after quick re-enable", async (t) => {
  const f = fixture(t);
  const saved = await f.recordWebsite();
  let release, entered;
  const openEntered = () => new Promise((resolve) => { entered = resolve; });
  let opening = openEntered();
  f.desktop.open = () =>
    new Promise((resolve) => {
      release = () => resolve({ ok: true, bundle: chrome.bundleId });
      entered();
    });
  const first = f.shortcuts.run(f.authorize, saved.id);
  await opening;
  const firstId = f.shortcuts.ownerList().running.runId;
  assert.match(firstId, /^[a-f0-9-]{36}$/);
  f.shortcuts.cancel(firstId);
  release();
  assert.equal((await first).status, "stopped");
  opening = openEntered();
  const second = f.shortcuts.run(f.authorize, saved.id);
  await opening;
  const secondId = f.shortcuts.ownerList().running.runId;
  assert.notEqual(secondId, firstId);
  assert.throws(() => f.shortcuts.cancel(firstId), /changed|ended|current/i);
  assert.ok(!f.shortcuts.ownerList().running.cancelled);
  f.shortcuts.update(saved.id, false);
  f.shortcuts.update(saved.id, true);
  release();
  assert.equal((await second).status, "stopped");
  assert.equal(f.shortcuts.ownerList().running, null);
});

test("an owner disable is sticky even when re-enabled before the awaited action completes", async (t) => {
  const f = fixture(t);
  f.shortcuts.start(f.authorize, "Open app only");
  await f.shortcuts.open(f.client(), chrome.id, f.authorize);
  const saved = f.shortcuts.save(f.authorize);
  let release, entered;
  const openEntered = () => new Promise((resolve) => { entered = resolve; });
  let opening = openEntered();
  f.desktop.open = () =>
    new Promise((resolve) => {
      release = () => resolve({ ok: true, bundle: chrome.bundleId });
      entered();
    });
  const run = f.shortcuts.run(f.authorize, saved.id);
  await opening;
  f.shortcuts.update(saved.id, false);
  f.shortcuts.update(saved.id, true);
  release();
  assert.equal((await run).status, "stopped");
  assert.equal(
    f.shortcuts.list(f.authorize).shortcuts[0].id,
    saved.id,
    "future runs are enabled while this cancelled run stays stopped",
  );
});

test("recordings belong to exact agent identities and a stale recorder cannot save or replay", async (t) => {
  const f = fixture(t);
  const first = f.client();
  f.shortcuts.start(f.authorize, "Original recording");
  await f.act({ type: "key", key: "tab" });
  const second = { ...first, id: "agent2" };
  f.setClient(second);
  assert.equal(f.shortcuts.list(f.authorize).recording, null);
  assert.throws(() => f.shortcuts.save(f.authorize), /no recording/);
  f.shortcuts.start(f.authorize, "Independent recording");
  await f.act({ type: "key", key: "escape" });
  const secondSaved = f.shortcuts.save(f.authorize);
  f.setClient(first);
  assert.equal(
    f.shortcuts.list(f.authorize).recording.name,
    "Original recording",
  );
  f.shortcuts.discard(first.id);
  f.setClient({ ...first, expiresAt: Date.now() - 1 });
  assert.throws(
    () => f.shortcuts.start(f.authorize, "Expired"),
    /active agent/,
  );
  await assert.rejects(
    f.shortcuts.run(f.authorize, secondSaved.id),
    /active agent/,
  );
  f.setClient({ ...first, status: "revoked" });
  await assert.rejects(
    f.shortcuts.run(f.authorize, secondSaved.id),
    /active agent/,
  );
});

test(
  "private HTTP owner Stop is run-bound and inaccessible to the running agent",
  privateIngressTest,
  async (t) => {
    let block = false,
      release,
      started;
    let ready = new Promise((resolve) => {
      started = resolve;
    });
    const f = await presetFixture(t, {
      desktopExtras: {
        open: async (_, app, authorize) => {
          authorize();
          if (block)
            await new Promise((resolve) => {
              release = resolve;
              started();
            });
          authorize();
          return { ok: true, bundle: chrome.bundleId };
        },
      },
    });
    t.after(() => release?.());
    const agent = await f.join({ preset: "apps", apps: [{ id: chrome.id }] });
    assert.equal(
      (
        await agent.as("/api/browser/shortcuts/record", {
          method: "POST",
          body: { name: "Open app" },
        })
      ).status,
      201,
    );
    assert.equal(
      (
        await agent.as("/api/browser/desktop/open", {
          method: "POST",
          body: { app: chrome.id },
        })
      ).status,
      200,
    );
    const saved = await agent.as("/api/browser/shortcuts/save", {
      method: "POST",
      body: {},
    });
    assert.equal(saved.status, 201);
    block = true;
    const first = agent.as("/api/browser/shortcuts/run", {
      method: "POST",
      body: { id: saved.body.id },
    });
    await ready;
    const current = (await f.call("/api/agents/shortcuts")).body.running;
    assert.match(current.runId, /^[a-f0-9-]{36}$/);
    assert.equal(
      (
        await agent.as("/api/agents/shortcuts/cancel", {
          method: "POST",
          body: { runId: current.runId },
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await f.call("/api/agents/shortcuts/cancel", {
          method: "POST",
          body: {},
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await f.call("/api/agents/shortcuts/cancel", {
          method: "POST",
          body: { runId: "00000000-0000-0000-0000-000000000000" },
        })
      ).status,
      409,
    );
    assert.ok(!(await f.call("/api/agents/shortcuts")).body.running.cancelled);
    assert.equal(
      (
        await f.call("/api/agents/shortcuts/cancel", {
          method: "POST",
          body: { runId: current.runId },
        })
      ).status,
      200,
    );
    assert.equal(
      (await f.call("/api/agents/shortcuts")).body.running.cancelled,
      true,
    );
    release();
    assert.equal((await first).body.status, "stopped");
    ready = new Promise((resolve) => {
      started = resolve;
    });
    const second = agent.as("/api/browser/shortcuts/run", {
      method: "POST",
      body: { id: saved.body.id },
    });
    await ready;
    assert.equal(
      (
        await f.call("/api/agents/shortcuts/cancel", {
          method: "POST",
          body: { runId: current.runId },
        })
      ).status,
      409,
    );
    release();
    assert.equal(
      (await second).body.status,
      "completed",
      "a stale Stop must not cancel the replacement run",
    );
  },
);

test("typed values echoed in titles or focused-control metadata are never saved as literal context", async (t) => {
  const f = fixture(t);
  const secret = "synthetic-private-form-value";
  f.shortcuts.start(f.authorize, "Context matching");
  f.setFront({
    title: `Search ${secret}`,
    layout: `geometry|AXIdentifier:${secret}`,
  });
  await f.act({ type: "type", text: secret });
  await f.act({ type: "key", key: "enter" });
  const saved = f.shortcuts.save(f.authorize);
  for (const value of [
    JSON.stringify(saved),
    JSON.stringify(f.shortcuts.list(f.authorize, "Context")),
    JSON.stringify(f.shortcuts.ownerList()),
    fs.readFileSync(path.join(f.dataDir, "agent-shortcuts.json"), "utf8"),
  ])
    assert.ok(
      !value.includes(secret),
      "literal text must not leak through matching metadata",
    );
  assert.match(saved.steps[0].context.fingerprint, /^[a-f0-9]{64}$/);
  assert.deepEqual(Object.keys(saved.steps[0].context).sort(), [
    "bundle",
    "fingerprint",
  ]);
  f.log.length = 0;
  assert.equal(
    (await f.shortcuts.run(f.authorize, saved.id, { text1: "fresh run value" }))
      .status,
    "completed",
  );
  assert.deepEqual(
    f.log[0].options.expected,
    {
      bundle: chrome.bundleId,
      title: `Search ${secret}`,
      layout: `geometry|AXIdentifier:${secret}`,
    },
    "native dispatch still checks the matched actual window and focus",
  );
  f.setFront({ layout: "changed focus" });
  f.log.length = 0;
  assert.equal(
    (await f.shortcuts.run(f.authorize, saved.id, { text1: "fresh run value" }))
      .status,
    "stopped",
  );
  assert.equal(f.log.length, 0);
});

test("legacy saved tools migrate private context, path URLs and printable keys without losing IDs or owner state", async (t) => {
  const f = fixture(t);
  f.shortcuts.close();
  const secret = "legacy-private-form-value";
  const rawContext = {
    bundle: chrome.bundleId,
    title: secret,
    layout: `field:${secret}`,
  };
  const old = {
    id: "11111111-1111-4111-8111-111111111111",
    name: "Legacy task",
    enabled: true,
    createdAt: 123,
    steps: [
      {
        type: "website",
        app: chrome.id,
        bundle: chrome.bundleId,
        url: `https://example.test/reset/${secret}`,
        delayMs: 0,
      },
      { type: "input", input: "text1", context: rawContext, delayMs: 0 },
      {
        type: "action",
        action: { type: "key", key: "a" },
        context: rawContext,
        delayMs: 0,
      },
      {
        type: "action",
        action: { type: "key", key: "tab" },
        context: rawContext,
        delayMs: 0,
      },
    ],
  };
  fs.writeFileSync(
    path.join(f.dataDir, "agent-shortcuts.json"),
    JSON.stringify([
      old,
      {
        ...old,
        id: "22222222-2222-4222-8222-222222222222",
        name: "Disabled legacy task",
        enabled: false,
      },
    ]),
    { mode: 0o600 },
  );
  const restored = createAgentShortcuts({
    dataDir: f.dataDir,
    desktop: f.desktop,
    wait: async () => {},
  });
  const migrated = restored.ownerList().shortcuts;
  assert.equal(migrated.length, 2);
  for (const [index, value] of migrated.entries()) {
    assert.equal(
      value.id,
      index ? "22222222-2222-4222-8222-222222222222" : old.id,
    );
    assert.equal(value.enabled, !index);
    assert.equal(value.createdAt, old.createdAt);
    assert.equal(value.steps.length, old.steps.length);
    assert.equal(value.steps[0].type, "website");
    assert.equal(value.steps[0].url, undefined);
    assert.equal(value.steps[0].input, "text2");
    assert.equal(value.steps[1].input, "text1");
    assert.equal(value.steps[2].input, "text3");
    assert.equal(value.steps[3].action.key, "tab");
  }
  const stored = fs.readFileSync(
    path.join(f.dataDir, "agent-shortcuts.json"),
    "utf8",
  );
  assert.ok(!stored.includes(secret));
  assert.ok(!stored.includes('"title"'));
  assert.equal(
    fs.statSync(path.join(f.dataDir, "agent-shortcuts.json")).mode & 0o777,
    0o600,
  );
  assert.deepEqual(restored.list(f.authorize).shortcuts[0].inputs, [
    "text2",
    "text1",
    "text3",
  ]);
  await assert.rejects(restored.run(f.authorize, old.id), /text inputs/);
  f.setFront(rawContext);
  assert.equal(
    (
      await restored.run(f.authorize, old.id, {
        text1: "form value",
        text2: "https://example.test/new-path",
        text3: "letter",
      })
    ).status,
    "completed",
  );
  const again = createAgentShortcuts({
    dataDir: f.dataDir,
    desktop: f.desktop,
  });
  assert.deepEqual(
    again.ownerList().shortcuts,
    migrated,
    "migration is stable across restarts",
  );
});
