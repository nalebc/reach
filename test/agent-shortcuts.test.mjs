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
  const recordWebsite = async (url = "https://mail.google.com/mail/u/0/") => {
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
    "https://mail.google.com/mail/u/0/",
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
    assert.match(listedAccess.body.savedToolHint, /Before starting a laptop task/);
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
