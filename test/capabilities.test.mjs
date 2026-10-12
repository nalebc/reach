import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import ts from "typescript";
import {
  findCodexExecutable,
  bundledCodexPaths,
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
      "invite",
      "settings",
    ])
      assert.equal(pageAccessible(page, caps), true, `${platform}: ${page}`);
  }
  assert.equal(pageAccessible("agents", workspaceCapabilities(host("darwin"), ready)), false);
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
  const chatPage = "sessions";
  assert.equal(pageAccessible(chatPage, workspaceCapabilities(host("darwin"), ready)), true, "the chat page tested below must be a real owner page");
  for (const page of [
    "terminal",
    "apps",
    "screen",
    chatPage,
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
test("Chat stays in an owner's navigation without any agent; a disabled screen stays out", () => {
  // Chat is the page "sessions". With no agent yet (or Codex missing,
  // signed out, unavailable), it's where an owner adds one (first-run
  // matrix A2), so it never leaves navigation; nobody else ever sees it.
  const device = host("darwin");
  for (const state of ["checking", "missing", "signin", "unavailable", "ready"])
    assert.equal(
      pageAccessible("sessions", workspaceCapabilities(device, { state })),
      true,
      state,
    );
  device.capabilities.codex = false;
  assert.equal(
    pageAccessible("sessions", workspaceCapabilities(device, { state: "missing" })),
    true,
  );
  assert.equal(
    pageAccessible(
      "sessions",
      workspaceCapabilities({ ...device, access: { kind: "guest", scopes } }, { state: "ready" }),
    ),
    false,
    "a guest with full access doesn't see every chat",
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
  // On Windows an extensionless codex is npm's sh shim, never taken
  // (windows-agent-cli.test.mjs): the CLI there is codex.exe.
  const executable = path.join(tmp, process.platform === "win32" ? "codex.exe" : "codex");
  await fs.writeFile(executable, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  const options = { platform: process.platform === "win32" ? "win32" : "linux", env: { PATH: tmp }, home: tmp, extraPaths: [], run: async () => ({ stdout: "" }) };
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

test("More lists the pages outside the bottom bar, nothing waits on Codex", () => {
  const pages = ["overview", "sessions", "files", "apps", "terminal", "screen"];
  const bar = ["overview", "sessions", "screen", "terminal"];
  for (const state of ["checking", "ready", "missing"]) {
    const codex = { state };
    assert.deepEqual(
      morePlaces(pages, bar, workspaceCapabilities(host("darwin"), codex), codex),
      { places: ["files", "apps"], pending: [] },
    );
  }
});


test("Codex discovery follows a relocated bundled entry point while rejecting manifest paths outside the app", async () => {
  const allowed = path.posix.resolve("/Applications/ChatGPT.app/Contents/Resources/codex-cli", "new-layout/codex");
  const paths = await bundledCodexPaths({ readFile: async file => JSON.stringify({ entrypoint: file.includes("ChatGPT.app") ? "new-layout/codex" : "../../outside" }) });
  assert.equal(paths[0], allowed);
  assert.equal(paths.some(file => file.includes("outside")), false);
  const candidates = [];
  const options = { platform: "darwin", env: { PATH: "/old-bin" }, bundled: async () => paths, access: async file => { candidates.push(file); }, stat: async () => ({ isFile: () => true }) };
  assert.equal(await findCodexExecutable(options), allowed);
  assert.deepEqual(candidates, [allowed], "the matching app CLI takes precedence over an older PATH CLI");
  candidates.length = 0;
  assert.equal(await findCodexExecutable({ ...options, env: { REACH_CODEX: "/explicit/codex" } }), "/explicit/codex");
  assert.deepEqual(candidates, ["/explicit/codex"], "the explicit owner override remains authoritative");
  const malformed = await bundledCodexPaths({ readFile: async () => '{"entrypoint":"/arbitrary/binary"}' });
  assert.ok(!malformed.includes("/arbitrary/binary"));
});

test("Codex is found in the user's Applications folder, including the nested app binary", async () => {
  const home = "/Users/fixture";
  const file = `${home}/Applications/Codex.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex`;
  const bundled = await bundledCodexPaths({ home, readFile: async () => { throw Error("no manifest"); } });
  assert.ok(bundled.includes(file));
  const found = await findCodexExecutable({
    platform: "darwin", env: { PATH: "" }, home, bundled: async () => bundled,
    access: async candidate => { if (candidate !== file) throw Error("missing"); },
    stat: async () => ({ isFile: () => true }),
  });
  assert.equal(found, file);
});

test("Codex discovery recovers a shortened PATH and validates login-shell results without starting Codex", async () => {
  const file = "/custom/node/bin/codex";
  const calls = [];
  const options = {
    platform: "darwin", env: { PATH: "/usr/bin:/bin", SHELL: "/bin/zsh" }, home: "/Users/fixture",
    bundled: async () => [],
    access: async candidate => { if (candidate !== file) throw Error("missing"); },
    stat: async () => ({ isFile: () => true }),
    run: async (...args) => { calls.push(args); return { stdout: `${file}\n` }; },
  };
  assert.equal(await findCodexExecutable(options), file);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].slice(0, 2), ["/bin/zsh", ["-lc", "command -v codex"]]);
  assert.equal(await findCodexExecutable({ ...options, run: async () => ({ stdout: "/missing/codex\n" }) }), null);
  assert.equal(await findCodexExecutable({ ...options, run: async () => ({ stdout: "codex: aliased to something\n" }) }), null);
  calls.length = 0;
  assert.equal(await findCodexExecutable({ ...options, env: { ...options.env, REACH_CODEX: "/missing/explicit" } }), null);
  assert.equal(calls.length, 0, "an explicit override is never replaced by a different Codex");
});

// Windows refuses invited people its screen until it can leave password
// managers out of their picture (parity audit #12): their phone shows no
// Screen, and the owner's invite sheet offers no screen roles there.
test("on Windows an invited person gets no Screen; you and full-access people keep it; a Mac is unchanged", () => {
  const watch = ["device", "screen", "screen:control"];
  const caps = (platform, owner) => deviceCapabilities({ platform, scopes: watch, screen: true, codexInstalled: false, owner });
  assert.deepEqual([caps("win32", false).screen, caps("win32", false).screenSupported], [false, false]);
  assert.deepEqual([caps("win32", true).screen, caps("win32", true).screenSupported], [true, true]);
  assert.deepEqual([caps("darwin", false).screen, caps("darwin", false).screenSupported], [true, true]);
  assert.equal(caps("win32", true).guestScreen, false);
  assert.equal(caps("darwin", true).guestScreen, true);
});
