import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createAppIconCache } from "../server/app-icons.mjs";
import { createAppShortcuts } from "../server/app-shortcuts.mjs";
import { createLogos } from "../server/agent-sessions/logos.mjs";
import { createReach } from "../server/index.mjs";
import { ALL_SCOPES } from "../server/core.mjs";

const installed = [
  { id: "/Applications/Codex.app", name: "Codex" },
  { id: "/Applications/Google Chrome.app", name: "Google Chrome" },
  { id: "/System/Applications/Notes.app", name: "Notes" },
];

const turn = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

for (const fails of [false, true]) test(`closing the icon cache joins its current ${fails ? "failed" : "successful"} reader and retires queued and late work`, async (t) => {
  const entered = deferred(), held = deferred(), batches = [];
  const cache = createAppIconCache(async (ids) => {
    batches.push(ids);
    entered.resolve();
    await held.promise;
    if (fails) throw Error("native lookup failed after shutdown");
    return ids.map((id) => `icon:${id}`);
  });
  t.after(() => held.resolve());
  const active = cache("active");
  await entered.promise;
  const queued = cache("queued");
  assert.equal(typeof cache.close, "function");
  const stopped = cache.close();
  assert.equal(cache.close(), stopped, "close has one owned completion barrier");
  let ended = false;
  void stopped.then(() => { ended = true; });
  assert.equal(await queued, null);
  assert.equal(await cache("late"), null);
  await turn();
  assert.equal(ended, false, "a live native reader still belongs to the cache");
  held.resolve();
  await stopped;
  assert.equal(await active, fails ? null : "icon:active");
  assert.deepEqual(batches, [["active"]], "queued and later IDs never start another helper");
});

test("closing before the scheduled icon pump prevents its first native dispatch", async () => {
  let reads = 0;
  const cache = createAppIconCache(async () => { reads++; return ["unexpected"]; });
  const queued = cache("not-started");
  assert.equal(typeof cache.close, "function");
  await cache.close();
  assert.equal(await queued, null);
  await turn();
  assert.equal(reads, 0);
  assert.equal(await cache("after-close"), null);
});

for (const method of ["icon", "icons", "list", "customList"]) test(`shortcut shutdown joins a held ${method} catalog without admitting later native reads`, async (t) => {
  const entered = deferred(), held = deferred();
  let catalogs = 0, icons = 0, bundles = 0, commands = 0;
  const shortcuts = createAppShortcuts({
    listApps: async () => { catalogs++; entered.resolve(); await held.promise; return installed; },
    loadIcons: async () => { icons++; return ["unexpected"]; },
    bundleId: async () => { bundles++; return null; },
    locateCli: async () => { commands++; return null; },
    macTerminal: async () => {}, windowsTerminal: async () => {},
  });
  t.after(() => held.resolve());
  const active = shortcuts[method](method === "icon" ? installed[0].id : [installed[0].id]);
  // Attach the handler before close can retire the request.
  const retired = assert.rejects(active, (error) => error.status === 503);
  void retired.catch(() => {});
  await entered.promise;
  assert.equal(typeof shortcuts.close, "function");
  const stopped = shortcuts.close();
  let ended = false;
  void stopped.then(() => { ended = true; });
  await assert.rejects(shortcuts.icons([installed[1].id]), (error) => error.status === 503);
  await turn();
  assert.equal(ended, false);
  held.resolve();
  await Promise.all([stopped, retired]);
  assert.deepEqual({ catalogs, icons, bundles, commands }, { catalogs: 1, icons: 0, bundles: 0, commands: 0 });
});

test("shortcut shutdown retires a one-at-a-time icon batch after its current lookup", async (t) => {
  const entered = deferred(), held = deferred(), seen = [];
  const shortcuts = createAppShortcuts({
    listApps: async () => installed,
    loadIcon: async (id) => { seen.push(id); entered.resolve(); await held.promise; return `icon:${id}`; },
  });
  t.after(() => held.resolve());
  const active = shortcuts.icons(installed.map((app) => app.id));
  const retired = assert.rejects(active, (error) => error.status === 503);
  void retired.catch(() => {});
  await entered.promise;
  assert.equal(typeof shortcuts.close, "function");
  const stopped = shortcuts.close();
  held.resolve();
  await Promise.all([stopped, retired]);
  assert.deepEqual(seen, [installed[0].id], "remaining sequential lookups cannot launch after close");
});

test("shortcut shutdown joins failed catalog discovery without starting an icon reader", async (t) => {
  const entered = deferred(), held = deferred(), failure = Error("native catalog failed");
  let icons = 0;
  const shortcuts = createAppShortcuts({ listApps: async () => { entered.resolve(); await held.promise; throw failure; },
    loadIcons: async () => { icons++; return []; } });
  t.after(() => held.resolve());
  const request = shortcuts.icons([installed[0].id]);
  const refused = assert.rejects(request, (error) => error === failure);
  await entered.promise;
  const stopped = shortcuts.close();
  held.resolve();
  await Promise.all([stopped, refused]);
  assert.equal(icons, 0);
});

test("shortcut shutdown joins a held bundle lookup and starts no later command discovery", async (t) => {
  const entered = deferred(), held = deferred();
  let commands = 0;
  const shortcuts = createAppShortcuts({ listApps: async () => [installed[0]],
    bundleId: async () => { entered.resolve(); await held.promise; return "com.openai.codex"; },
    locateCli: async () => { commands++; return "fixture"; },
    macTerminal: async () => {}, windowsTerminal: async () => {},
  });
  t.after(() => held.resolve());
  const refused = assert.rejects(shortcuts.list(), (error) => error.status === 503);
  await entered.promise;
  let ended = false;
  const stopped = shortcuts.close().then(() => { ended = true; });
  await turn();
  assert.equal(ended, false);
  held.resolve();
  await Promise.all([stopped, refused]);
  assert.equal(commands, 0);
});

test("shortcut shutdown stops command discovery after the already-started command", { skip: !["darwin", "win32"].includes(process.platform) }, async (t) => {
  const entered = deferred(), held = deferred(), commands = [];
  const shortcuts = createAppShortcuts({ listApps: async () => [],
    locateCli: async (name) => { commands.push(name); entered.resolve(); await held.promise; return "fixture"; },
    macTerminal: async () => {}, windowsTerminal: async () => {},
  });
  t.after(() => held.resolve());
  const refused = assert.rejects(shortcuts.list(), (error) => error.status === 503);
  await entered.promise;
  const stopped = shortcuts.close();
  held.resolve();
  await Promise.all([stopped, refused]);
  assert.deepEqual(commands, ["codex"]);
});

test("Windows logo shutdown joins held catalog work without starting its later icon reader", async (t) => {
  const entered = deferred(), held = deferred();
  let catalogs = 0, icons = 0;
  const logos = createLogos({ platform: "win32", dataDir: "controlled Windows fixture",
    listApps: async () => { catalogs++; entered.resolve(); await held.promise; return [{ id: "fixture!App", name: "Claude" }]; },
    readIcons: async () => { icons++; return ["unexpected"]; },
  });
  t.after(() => held.resolve());
  const active = logos();
  await entered.promise;
  let ended = false;
  const stopped = logos.close().then(() => { ended = true; });
  assert.deepEqual(await logos(), { version: "", logos: {} });
  await turn();
  assert.equal(ended, false);
  held.resolve();
  await Promise.all([stopped, active]);
  assert.deepEqual({ catalogs, icons }, { catalogs: 1, icons: 0 });
});

for (const fails of [false, true]) test(`Windows logo shutdown joins the current ${fails ? "failed" : "successful"} icon read and fences late calls`, async (t) => {
  const entered = deferred(), held = deferred();
  let reads = 0;
  const logos = createLogos({ platform: "win32", dataDir: "controlled Windows fixture",
    listApps: async () => [{ id: "fixture!App", name: "Claude" }],
    readIcons: async () => { reads++; entered.resolve(); await held.promise; if (fails) throw Error("native failure"); return ["icon"]; },
  });
  t.after(() => held.resolve());
  const active = logos();
  await entered.promise;
  let ended = false;
  const stopped = logos.close().then(() => { ended = true; });
  await turn();
  assert.equal(ended, false);
  held.resolve();
  await Promise.all([active, stopped]);
  assert.deepEqual(await logos(), { version: "", logos: {} });
  assert.equal(reads, 1);
});

test("Mac logo shutdown joins current conversion and never starts the next source", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "reach-logo-close-"));
  const source = path.join(dir, "source.png");
  await fs.writeFile(source, "owned fixture");
  const entered = deferred(), held = deferred(), conversions = [];
  const logos = createLogos({ platform: "darwin", dataDir: dir, resolve: (value) => value.file,
    sources: { first: { file: source, size: 64 }, second: { file: source, size: 128 } },
    run: async (_file, args) => { conversions.push(args); entered.resolve(); await held.promise; throw Error("owned conversion failed"); },
  });
  t.after(async () => { held.resolve(); await logos.close(); await fs.rm(dir, { recursive: true, force: true }); });
  const active = logos();
  await entered.promise;
  let ended = false;
  const stopped = logos.close().then(() => { ended = true; });
  await turn();
  assert.equal(ended, false);
  held.resolve();
  await Promise.all([active, stopped]);
  assert.equal(conversions.length, 1, "modeled Mac path starts no later sips conversion");
});

test("Reach shutdown joins file icons, shortcut icons and the direct app catalog before returning", { timeout: 15000 }, async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "reach-icon-close-"));
  const entered = { files: deferred(), icons: deferred(), apps: deferred() }, held = deferred();
  const seen = [];
  const reach = await createReach({
    roots: [dir], dataDir: path.join(dir, "private"),
    desktopTerminals: { platform: "linux" }, terminalWatch: () => null,
    fileIcons: async (types) => { seen.push("files"); entered.files.resolve(); await held.promise; return types.map(() => null); },
    appList: async () => { seen.push("apps"); entered.apps.resolve(); await held.promise; return installed; },
    appShortcuts: { listApps: async () => installed,
      loadIcons: async (ids) => { seen.push("icons"); entered.icons.resolve(); await held.promise; return ids.map(() => null); } },
  });
  let closing;
  t.after(async () => { held.resolve(); await (closing || reach.close()); await fs.rm(dir, { recursive: true, force: true }); });
  await new Promise((resolve) => reach.server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${reach.server.address().port}`;
  const owner = reach.auth.issue("owner", ALL_SCOPES);
  const headers = { Authorization: `Bearer ${owner.token}`, "Content-Type": "application/json" };
  const requests = [
    fetch(`${origin}/api/files/icons?types=txt`, { headers }),
    fetch(`${origin}/api/apps/icons`, { method: "POST", headers, body: JSON.stringify({ ids: [installed[0].id] }) }),
    fetch(`${origin}/api/apps`, { headers }),
  ].map((request) => request.catch(() => null));
  await Promise.all(Object.values(entered).map((entry) => entry.promise));
  const serverClosed = new Promise((resolve) => reach.server.once("close", resolve));
  let ended = false;
  closing = reach.close().then(() => { ended = true; });
  await serverClosed;
  await turn();
  assert.equal(ended, false, "closing HTTP connections is not native-reader retirement");
  held.resolve();
  await closing;
  await Promise.all(requests);
  assert.deepEqual(seen.sort(), ["apps", "files", "icons"]);
});

test("readApps retires a held catalog before the hidden-app consumer can create work after close", { timeout: 15000 }, async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "reach-app-catalog-close-"));
  const entered = deferred(), held = deferred();
  let helperStarts = 0, closing;
  const dataDir = path.join(dir, "private");
  const reach = await createReach({ roots: [dir], dataDir, screen: true, appPlatform: "darwin",
    desktopTerminals: { platform: "linux" }, terminalWatch: () => null,
    appList: async () => { entered.resolve(); await held.promise; return installed; },
    appDisplays: async () => { helperStarts++; throw Error("a retired catalog must not reach the native display helper"); },
  });
  t.after(async () => { held.resolve(); await (closing || reach.close()); await fs.rm(dir, { recursive: true, force: true }); });
  await new Promise((resolve) => reach.server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${reach.server.address().port}`;
  const owner = reach.auth.issue("owner", ALL_SCOPES);
  const request = fetch(`${origin}/api/screen/apps`, { method: "POST",
    headers: { Authorization: `Bearer ${owner.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ appId: installed[0].id, width: 393, height: 852 }),
  }).then(async (response) => { await response.arrayBuffer(); }).catch(() => {});
  await entered.promise;
  const serverClosed = new Promise((resolve) => reach.server.once("close", resolve));
  closing = reach.close();
  await serverClosed;
  held.resolve();
  await Promise.all([closing, request]);
  await turn();
  assert.equal(helperStarts, 0);
  await assert.rejects(fs.stat(path.join(dataDir, "app-threads.json")), (error) => error.code === "ENOENT", "retired catalog must not create a late paused app record");
});

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
    await reach.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
