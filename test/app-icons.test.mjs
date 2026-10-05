import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createAppIconCache } from "../server/app-icons.mjs";
import { createAppShortcuts } from "../server/app-shortcuts.mjs";
import { createReach } from "../server/index.mjs";
import { ALL_SCOPES } from "../server/core.mjs";

const installed = [
  { id: "/Applications/Codex.app", name: "Codex" },
  { id: "/Applications/Google Chrome.app", name: "Google Chrome" },
  { id: "/System/Applications/Notes.app", name: "Notes" },
];

test("a burst of icon requests shares one native lookup, and later ones queue behind it", async () => {
  const batches = [];
  let release;
  const gate = new Promise((r) => (release = r));
  const cache = createAppIconCache(async (ids) => {
    batches.push(ids);
    if (batches.length === 1) await gate;
    return ids.map((id) => `icon:${id}`);
  });
  const first = ["a", "b", "a", "c"].map(cache);
  await new Promise((r) => setImmediate(r));
  const second = ["d", "e", "b"].map(cache);
  release();
  assert.deepEqual(await Promise.all(first), [
    "icon:a",
    "icon:b",
    "icon:a",
    "icon:c",
  ]);
  assert.deepEqual(await Promise.all(second), ["icon:d", "icon:e", "icon:b"]);
  assert.deepEqual(batches, [
    ["a", "b", "c"],
    ["d", "e"],
  ]);
});

test("a failed native lookup resolves every waiting icon to null", async () => {
  const cache = createAppIconCache(async () => {
    throw Error("osascript unavailable");
  });
  assert.deepEqual(await Promise.all(["a", "b"].map(cache)), [null, null]);
});

test("batched icons only read installed apps and validate the request", async () => {
  const reads = [];
  const shortcuts = createAppShortcuts({
    listApps: async () => installed,
    loadIcons: async (ids) => {
      reads.push(...ids);
      return ids.map((id) => `png:${id}`);
    },
  });
  assert.deepEqual(
    await shortcuts.icons([
      installed[0].id,
      "/etc/passwd",
      installed[2].id,
      installed[0].id,
    ]),
    {
      icons: {
        [installed[0].id]: `png:${installed[0].id}`,
        [installed[2].id]: `png:${installed[2].id}`,
      },
    },
  );
  assert.deepEqual(reads, [installed[0].id, installed[2].id]);
  for (const ids of [
    undefined,
    [],
    "/Applications/Codex.app",
    [42],
    Array(65).fill(installed[0].id),
  ])
    await assert.rejects(shortcuts.icons(ids), /up to 64/);
});

test("the icons route is owner-only and returns logos keyed by app", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "reach-icons-"));
  const reach = await createReach({
    roots: [dir],
    dataDir: path.join(dir, "private"),
    appShortcuts: {
      listApps: async () => installed,
      loadIcons: async (ids) => ids.map(() => "data:image/png;base64,aWNvbg=="),
    },
  });
  await new Promise((r) => reach.server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${reach.server.address().port}/api/apps/icons`;
  const owner = reach.auth.issue("owner", ALL_SCOPES),
    agent = reach.auth.issue("apps agent", ["apps"], "agent");
  const guest = reach.auth.redeemGuest(
    reach.auth.inviteGuest({ name: "guest", roots: [0], ttlSeconds: 60 })
      .invitation,
  );
  const call = (token, ids) =>
    fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ids }),
    });
  try {
    for (const token of [guest.token, agent.token])
      assert.equal((await call(token, [installed[1].id])).status, 403);
    const response = await call(owner.token, [installed[1].id, "/tmp/x.app"]);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), {
      icons: { [installed[1].id]: "data:image/png;base64,aWNvbg==" },
    });
    assert.equal((await call(owner.token, [])).status, 400);
  } finally {
    reach.server.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
