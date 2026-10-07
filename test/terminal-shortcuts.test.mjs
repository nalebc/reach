import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createAppShortcuts } from "../server/app-shortcuts.mjs";
import { DesktopTerminals } from "../server/desktop-terminals.mjs";

const setup = async ({ clis = { codex: "codex" }, folder = "/Users/me/Documents" } = {}) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "reach-shortcuts-"));
  const opened = [];
  const shortcuts = createAppShortcuts({
    dataDir,
    listApps: async () => [],
    loadIcon: async () => null,
    macTerminal: async (command) => {
      opened.push(command);
      return { ok: true };
    },
    resolveFolder: (root, relative) => {
      if (relative === "missing") throw Object.assign(Error("Gone"), { status: 404 });
      return relative ? `${folder}/${relative}` : folder;
    },
    locateCli: async (name) => clis[name] ?? null,
  });
  return { shortcuts, opened, dataDir };
};

test(
  "agent recipes appear when the CLI exists and open a terminal running it",
  { skip: process.platform !== "darwin" && "Mac terminal integration" },
  async () => {
    const { shortcuts, opened } = await setup();
    const list = await shortcuts.list();
    const codex = list.find((s) => s.id === "recipe:codex-terminal");
    assert.ok(codex, "Codex in Terminal is offered");
    assert.equal(codex.kind, "terminal");
    assert.ok(!list.some((s) => s.id === "recipe:claude-terminal"), "no Claude CLI, no recipe");
    assert.equal((await shortcuts.run(codex.id)).name, "Codex in Terminal");
    assert.deepEqual(opened, ["cd '/Users/me/Documents' && codex"]);
  },
);

test(
  "custom terminal shortcuts validate, persist, quote folders and run",
  { skip: process.platform !== "darwin" && "Mac terminal integration" },
  async () => {
    const { shortcuts, opened, dataDir } = await setup({ folder: "/tmp/it's here" });
    await assert.rejects(
      shortcuts.save({ name: "Bad", type: "terminal", command: "rm -rf /\nreboot" }),
      /one-line command/,
    );
    await assert.rejects(
      shortcuts.save({ name: "Gone", type: "terminal", command: "ls", path: "missing" }),
      /Gone/,
    );
    const saved = await shortcuts.save({
      name: "Dev server",
      type: "terminal",
      command: "  npm run dev ",
      path: "app",
    });
    assert.deepEqual(
      { type: saved.type, root: saved.root, path: saved.path, command: saved.command },
      { type: "terminal", root: 0, path: "app", command: "npm run dev" },
    );
    const stored = JSON.parse(await fs.readFile(path.join(dataDir, "shortcuts.json"), "utf8"));
    assert.equal(stored[0].command, "npm run dev");
    const listed = (await shortcuts.list()).find((s) => s.id === saved.id);
    assert.deepEqual(
      { detail: listed.detail, kind: listed.kind, custom: listed.custom },
      { detail: "npm run dev", kind: "terminal", custom: true },
    );
    await shortcuts.run(saved.id);
    // The folder's quote cannot break out of the cd argument.
    assert.deepEqual(opened, [`cd '/tmp/it'\\''s here/app' && npm run dev`]);
    // A saved app shortcut may point at a recipe.
    const alias = await shortcuts.save({
      name: "Codex",
      type: "app",
      actionId: "recipe:codex-terminal",
    });
    await shortcuts.run(alias.id);
    assert.equal(opened.at(-1), "cd '/tmp/it'\\''s here' && codex");
  },
);

test("without a terminal integration, no terminal shortcuts are offered", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "reach-shortcuts-"));
  const shortcuts = createAppShortcuts({
    dataDir,
    listApps: async () => [],
    locateCli: async () => "codex",
    resolveFolder: () => "/tmp",
  });
  if (process.platform === "darwin") {
    assert.ok(!(await shortcuts.list()).some((s) => s.kind === "terminal"));
    await assert.rejects(
      shortcuts.save({ name: "X", type: "terminal", command: "ls" }),
      /not available/,
    );
  }
});

test("Mac terminal windows can start with one command", async () => {
  const payloads = [];
  const terminals = new DesktopTerminals({
    platform: "darwin",
    run: async (payload) => {
      payloads.push(payload);
      return { ok: true };
    },
  });
  await terminals.create("terminal", () => {}, "cd '/tmp' && codex");
  assert.deepEqual(payloads[0], {
    provider: "terminal",
    action: "create",
    command: "cd '/tmp' && codex",
  });
  await terminals.create("iterm2", () => {});
  assert.deepEqual(payloads[1], { provider: "iterm2", action: "create" });
  await assert.rejects(terminals.create("terminal", () => {}, "ls\u0007"), /control/);
});
