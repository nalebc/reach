import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import ts from "typescript";
import {
  findCodexExecutable,
  createToolDetector,
  deviceCapabilities,
} from "../server/capabilities.mjs";
import { createReach } from "../server/index.mjs";
const { outputText } = ts.transpileModule(
  await fs.readFile(new URL("../src/capabilities.ts", import.meta.url), "utf8"),
  {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
    },
  },
);
const { workspaceCapabilities, pageAccessible, morePlaces } = await import(
  `data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`
);
const scopes = [
  "admin",
  "files",
  "terminal",
  "apps",
  "screen",
  "codex",
  "exec",
];
const host = (platform, overrides = {}) => ({
  platform,
  access: { scopes },
  capabilities: deviceCapabilities({
    platform,
    scopes,
    screen: true,
    codexInstalled: true,
  }),
  ...overrides,
});
test("platform, permissions and ready tools determine every workspace entry", () => {
  const ready = { state: "ready" };
  for (const platform of ["darwin", "win32"]) {
    const caps = workspaceCapabilities(host(platform), ready);
    for (const page of [
      "overview",
      "files",
      "terminal",
      "apps",
      "screen",
      "chat",
      "agents",
      "invite",
      "settings",
    ])
      assert.equal(pageAccessible(page, caps), true, `${platform}: ${page}`);
  }
  const linux = workspaceCapabilities(host("linux"), ready);
  assert.equal(linux.apps, false);
  assert.equal(linux.screen, false);
  assert.equal(linux.screenSetup, false);
  assert.equal(linux.codex, true);
  assert.equal(linux.terminal, true);
  // Even old or erroneous servers advertising everything cannot bypass OS/scopes.
  const reader = workspaceCapabilities(
    host("darwin", { access: { scopes: ["files:read"] } }),
    ready,
  );
  assert.equal(reader.files, true);
  for (const page of [
    "terminal",
    "apps",
    "screen",
    "chat",
    "agents",
    "invite",
    "settings",
  ])
    assert.equal(pageAccessible(page, reader), false, page);
  assert.equal(reader.writeFiles, false);
  const terminalUser = workspaceCapabilities(
    host("darwin", { access: { scopes: ["terminal", "apps"] } }),
    ready,
  );
  assert.equal(terminalUser.terminal, true);
  assert.equal(terminalUser.apps, true);
  assert.equal(terminalUser.shortcuts, false);
  assert.equal(terminalUser.desktopTerminals, false);
  assert.equal(reader.codexSetup, false);
  assert.equal(reader.screenSetup, false);
  assert.equal(pageAccessible("unknown", linux), false);
  const noDevice = workspaceCapabilities(null, ready);
  assert.equal(pageAccessible("overview", noDevice), true);
  assert.equal(pageAccessible("files", noDevice), false);
});
test("optional tools and disabled screen stay out of navigation until usable", () => {
  const device = host("darwin");
  for (const state of ["checking", "missing", "signin", "unavailable"])
    assert.equal(
      pageAccessible("chat", workspaceCapabilities(device, { state })),
      false,
      state,
    );
  device.capabilities.codex = false;
  assert.equal(
    pageAccessible("chat", workspaceCapabilities(device, { state: "ready" })),
    false,
  );
  device.capabilities.screen = false;
  const caps = workspaceCapabilities(device);
  assert.equal(caps.screen, false);
  assert.equal(caps.screenSetup, true);
  assert.equal(caps.codexSetup, true);
  assert.equal(
    caps.agents,
    true,
    "external agent access does not require Codex",
  );
});
test("Codex detection inspects executable permissions, honours overrides, and caches without spawning", async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "reach-tools-"));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const executable = path.join(tmp, "codex");
  await fs.writeFile(executable, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  const options = { platform: "linux", env: { PATH: tmp } };
  assert.equal(await findCodexExecutable(options), executable);
  assert.equal(
    await findCodexExecutable({
      ...options,
      env: { PATH: tmp, REACH_CODEX: path.join(tmp, "missing") },
    }),
    null,
  );
  await fs.chmod(executable, 0o600);
  if (process.platform !== "win32")
    assert.equal(await findCodexExecutable(options), null);
  let calls = 0,
    time = 0,
    installed = true;
  const detect = createToolDetector({
    now: () => time,
    find: async () => {
      calls++;
      return installed ? executable : null;
    },
  });
  await Promise.all([detect(), detect(), detect()]);
  assert.equal(calls, 1);
  installed = false;
  time = 29000;
  assert.equal((await detect()).codex.installed, true);
  time = 31000;
  assert.equal((await detect()).codex.installed, false);
  assert.equal(calls, 2);
});
test("device discovery hides inaccessible tools and backend still rejects forbidden routes", async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "reach-capabilities-"));
  let detections = 0;
  const reach = await createReach({
    roots: [tmp],
    dataDir: path.join(tmp, "private"),
    port: 0,
    screen: true,
    toolDetection: {
      find: async () => {
        detections++;
        return null;
      },
    },
  });
  await new Promise((r) => reach.server.listen(0, "127.0.0.1", r));
  t.after(async () => {
    await reach.close();
    await fs.rm(tmp, { recursive: true, force: true });
  });
  const url = `http://127.0.0.1:${reach.server.address().port}`;
  const reader = reach.auth.issue("Reader", ["files:read"]);
  const call = (route, token) =>
    fetch(url + route, { headers: { Authorization: `Bearer ${token}` } });
  const readerDevice = await (await call("/api/device", reader.token)).json();
  assert.equal(readerDevice.capabilities.files, true);
  assert.equal(readerDevice.capabilities.codex, false);
  assert.equal(readerDevice.capabilities.screen, false);
  assert.equal(readerDevice.tools, undefined);
  assert.equal(detections, 0);
  for (const route of [
    "/api/codex/status",
    "/api/agents/requests",
    "/api/settings",
  ])
    assert.equal((await call(route, reader.token)).status, 403);
  const owner = reach.auth.issue("Owner", scopes);
  const ownerDevice = await (await call("/api/device", owner.token)).json();
  assert.equal(ownerDevice.tools.codex.installed, false);
  assert.equal(ownerDevice.capabilities.codex, false);
  assert.equal(detections, 1);
});

test("More keeps Codex's row, waiting, while the computer checks it", () => {
  const pages = [
    "overview",
    "sessions",
    "files",
    "apps",
    "terminal",
    "chat",
    "screen",
  ];
  const bar = ["overview", "sessions", "screen", "terminal"];
  const checking = { state: "checking" };
  const caps = workspaceCapabilities(host("darwin"), checking);
  assert.deepEqual(morePlaces(pages, bar, caps, checking), {
    places: ["files", "apps", "chat"],
    pending: ["chat"],
  });
  const ready = { state: "ready" };
  assert.deepEqual(
    morePlaces(pages, bar, workspaceCapabilities(host("darwin"), ready), ready),
    { places: ["files", "apps", "chat"], pending: [] },
  );
  // Not there at all: no row.
  const missing = { state: "missing" };
  assert.deepEqual(
    morePlaces(
      pages,
      bar,
      workspaceCapabilities(host("darwin"), missing),
      missing,
    ),
    { places: ["files", "apps"], pending: [] },
  );
});
