import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createAppShortcuts } from "../server/app-shortcuts.mjs";
import { createReach } from "../server/index.mjs";
import { ALL_SCOPES } from "../server/core.mjs";
const installed = [
  { id: "/Applications/Codex.app", name: "Codex" },
  { id: "/Applications/Google Chrome.app", name: "Google Chrome" },
];
test("shortcuts discover installed apps and open a fresh Codex session with a fixed action", async () => {
  const calls = [];
  const shortcuts = createAppShortcuts({
    listApps: async () => installed,
    launch: async (id) => calls.push(id),
    openCodex: async () => calls.push("new-codex"),
  });
  assert.deepEqual(
    (await shortcuts.list()).map((s) => s.name),
    ["New Codex session", "Open Codex", "Open Chrome"],
  );
  await shortcuts.run("codex-new");
  await shortcuts.run("app:/Applications/Google Chrome.app");
  for (const id of [
    "shell:rm -rf /",
    "app:/tmp/unknown.app",
    "codex://new?prompt=unexpected",
    null,
  ])
    await assert.rejects(shortcuts.run(id));
  assert.deepEqual(calls, ["new-codex", "/Applications/Google Chrome.app"]);
});
test("shortcuts recheck permission after async discovery before launch", async () => {
  let executed = false;
  const shortcuts = createAppShortcuts({
    listApps: async () => installed,
    openCodex: async () => {
      executed = true;
    },
  });
  await assert.rejects(
    shortcuts.run("codex-new", () => {
      throw Error("revoked");
    }),
    /revoked/,
  );
  assert.equal(executed, false);
});
test("shortcut API rejects guests and scoped agents and dispatches owner actions", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "reach-shortcuts-"));
  const calls = [];
  const reach = await createReach({
    roots: [dir],
    dataDir: path.join(dir, "private"),
    appShortcuts: {
      listApps: async () => installed,
      loadIcon: async () => "data:image/png;base64,aWNvbg==",
      launch: async (id) => calls.push(id),
      openCodex: async () => calls.push("new-codex"),
    },
  });
  await new Promise((r) => reach.server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${reach.server.address().port}/api/apps/shortcuts`;
  const owner = reach.auth.issue("owner", ALL_SCOPES),
    agent = reach.auth.issue("apps agent", ["apps"], "agent");
  const invite = reach.auth.inviteGuest({
    name: "guest",
    roots: [0],
    ttlSeconds: 60,
  });
  const guest = reach.auth.redeemGuest(invite.invitation);
  const call = (token, body) =>
    fetch(url, {
      method: body ? "POST" : "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  try {
    for (const token of [agent.token, guest.token]) {
      assert.equal(
        (
          await fetch(
            url + "/icon?appId=" + encodeURIComponent(installed[0].id),
            {
              headers: { Authorization: `Bearer ${token}` },
            },
          )
        ).status,
        403,
      );
      assert.equal((await call(token)).status, 403);
      assert.equal((await call(token, { id: "codex-new" })).status, 403);
      for (const method of ["GET", "POST", "DELETE"]) {
        const result = await fetch(
          url + "/custom" + (method === "DELETE" ? "/custom:missing" : ""),
          {
            method,
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
            },
            body:
              method === "POST"
                ? JSON.stringify({
                    name: "Denied",
                    type: "website",
                    url: "https://example.com",
                  })
                : undefined,
          },
        );
        assert.equal(result.status, 403);
      }
    }
    assert.equal((await call(owner.token)).status, 200);
    const icon = await fetch(
      url + "/icon?appId=" + encodeURIComponent(installed[0].id),
      {
        headers: { Authorization: `Bearer ${owner.token}` },
      },
    );
    assert.equal(icon.status, 200);
    assert.equal(icon.headers.get("cache-control"), "no-store");
    assert.equal((await icon.json()).icon, "data:image/png;base64,aWNvbg==");
    assert.equal((await call(owner.token, { id: "codex-new" })).status, 200);
    assert.equal(
      (await call(owner.token, { id: "app:/unlisted" })).status,
      404,
    );
    assert.deepEqual(calls, ["new-codex"]);
    const saved = await fetch(url + "/custom", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${owner.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "My Chrome",
        type: "app",
        actionId: "app:/Applications/Google Chrome.app",
      }),
    });
    assert.equal(saved.status, 200);
    const custom = await saved.json();
    assert.equal((await call(owner.token, { id: custom.id })).status, 200);
    assert.equal(calls.at(-1), "/Applications/Google Chrome.app");
  } finally {
    await reach.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("ChatGPT alone never advertises Codex and removed apps disappear", async () => {
  let installed = [
    { id: "chatgpt", name: "ChatGPT" },
    { id: "chrome", name: "Google Chrome" },
  ];
  const shortcuts = createAppShortcuts({
    listApps: async () => installed,
    launch: async () => {
      throw Error("Must not launch");
    },
  });
  assert(!(await shortcuts.list()).some((a) => a.kind === "codex"));
  const saved = await shortcuts.save({
    name: "My browser",
    type: "app",
    actionId: "app:chrome",
  });
  installed = [{ id: "chatgpt", name: "ChatGPT" }];
  assert(!(await shortcuts.list()).some((a) => a.id === saved.id));
  assert.equal((await shortcuts.customList())[0].available, false);
  await assert.rejects(shortcuts.run(saved.id), /no longer available/);
});
test("custom shortcuts persist, rename, run and delete without accepting executable URLs or unknown apps", async () => {
  const dir = await fs.mkdtemp(
    path.join(os.tmpdir(), "reach-custom-shortcuts-"),
  );
  const calls = [];
  const options = {
    dataDir: dir,
    listApps: async () => installed,
    launch: async (id) => calls.push(id),
    openWebsite: async (url) => calls.push(url),
  };
  try {
    let shortcuts = createAppShortcuts(options);
    const app = await shortcuts.save({
      name: "My browser",
      type: "app",
      actionId: "app:/Applications/Google Chrome.app",
    });
    const web = await shortcuts.save({
      name: "Project docs",
      type: "website",
      url: "https://example.com/docs?q=hello&lang=en",
    });
    shortcuts = createAppShortcuts(options);
    assert.equal((await shortcuts.customList()).length, 2);
    await shortcuts.save({ ...web, name: "Team docs" });
    assert.equal(
      (await shortcuts.list()).find((a) => a.id === web.id).name,
      "Team docs",
    );
    await shortcuts.run(app.id);
    await shortcuts.run(web.id);
    assert.deepEqual(calls, [
      "/Applications/Google Chrome.app",
      "https://example.com/docs?q=hello&lang=en",
    ]);
    for (const url of [
      "javascript:alert(1)",
      "file:///etc/passwd",
      "codex://threads/new",
      "https://user:secret@example.com",
      "https://example.com\n--args",
      "--args",
    ])
      await assert.rejects(
        shortcuts.save({ name: "Bad", type: "website", url }),
      );
    await assert.rejects(
      shortcuts.save({
        name: "Bad",
        type: "app",
        actionId: "app:/tmp/not-installed.app",
      }),
    );
    await assert.rejects(
      shortcuts.save({
        name: "Bad",
        type: "shell",
        command: "open -a anything",
      }),
    );
    await assert.rejects(
      shortcuts.save({
        name: "x".repeat(61),
        type: "website",
        url: "https://example.com",
      }),
    );
    await assert.rejects(shortcuts.save({ ...web, id: "custom:unknown" }));
    const before = (await shortcuts.customList()).length;
    await assert.rejects(
      shortcuts.save(
        {
          name: "Revoked",
          type: "app",
          actionId: "app:/Applications/Google Chrome.app",
        },
        () => {
          throw Error("revoked");
        },
      ),
      /revoked/,
    );
    assert.equal((await shortcuts.customList()).length, before);
    shortcuts.remove(web.id);
    assert(
      !(await createAppShortcuts(options).list()).some((a) => a.id === web.id),
    );
    await assert.rejects(shortcuts.run(web.id));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
test("custom shortcut creation is bounded", async () => {
  const shortcuts = createAppShortcuts({ listApps: async () => installed });
  for (let i = 0; i < 50; i++)
    await shortcuts.save({
      name: `Link ${i}`,
      type: "website",
      url: "https://example.com",
    });
  await assert.rejects(
    shortcuts.save({
      name: "One too many",
      type: "website",
      url: "https://example.com",
    }),
    /up to 50/,
  );
});

test("app logos inherit the target app, never a custom label, and only installed IDs reach the native reader", async () => {
  let catalog = installed;
  const calls = [];
  const shortcuts = createAppShortcuts({
    listApps: async () => catalog,
    loadIcon: async (id) => {
      calls.push(id);
      return "png";
    },
  });
  const app = await shortcuts.save({
    name: "My work",
    type: "app",
    actionId: "codex-new",
  });
  const website = await shortcuts.save({
    name: "Codex",
    type: "website",
    url: "https://example.com",
  });
  const list = await shortcuts.list();
  assert.equal(list.find((a) => a.id === app.id).appId, installed[0].id);
  assert.equal(list.find((a) => a.id === website.id).appId, undefined);
  await Promise.all([
    shortcuts.icon(installed[0].id),
    shortcuts.icon(installed[0].id),
  ]);
  assert.deepEqual(calls, [installed[0].id]);
  for (const id of ["/etc/passwd", "../../secret", null, [installed[0].id]])
    await assert.rejects(shortcuts.icon(id), /installed app/);
  catalog = [];
  await assert.rejects(shortcuts.icon(installed[0].id), /installed app/);
  assert.equal(calls.length, 1);
});

test("an unavailable native icon falls back without breaking shortcuts", async () => {
  const shortcuts = createAppShortcuts({
    listApps: async () => installed,
    loadIcon: async () => {
      throw Error("Icon unavailable");
    },
  });
  assert.deepEqual(await shortcuts.icon(installed[0].id), { icon: null });
  assert.equal((await shortcuts.list()).length, 3);
});


test("a renamed Codex app is identified by bundle id while a same-name unrelated app is not", async () => {
  const launches = [];
  const shortcuts = createAppShortcuts({
    listApps: async () => [
      { id: "/fixture/Renamed.app", name: "Renamed", bundleId: "com.openai.codex" },
      { id: "/fixture/Codex.app", name: "Codex", bundleId: "example.unrelated" },
    ],
    launch: async id => launches.push(id), openCodex: async () => launches.push("new"),
  });
  const listed = await shortcuts.list();
  assert.ok(listed.some(item => item.id === "codex-new"));
  await shortcuts.run("codex-new");
  await shortcuts.run("app:/fixture/Renamed.app");
  assert.deepEqual(launches, ["new", "/fixture/Renamed.app"]);
  const unrelated = createAppShortcuts({ listApps: async () => [{ id: "/fixture/Codex.app", name: "Codex", bundleId: "example.unrelated" }] });
  assert.equal((await unrelated.list()).some(item => item.id === "codex-new"), false);
});
