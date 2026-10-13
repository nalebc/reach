import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { codexHolder } from "../server/agent-sessions/codex.mjs";
import { fileHolders } from "../server/windows-owners.mjs";

// Who holds a Codex chat on Windows (audit #46, Oct 12): a Mac asks pgrep,
// lsof and ps, which Windows hasn't got. There Restart Manager names the
// processes holding the chat's lock file, and their programs tell which:
// Codex's daemon, the Codex app, a terminal, else "other". A lookup that
// fails answers as a Mac's does (nobody), so delivery goes as it would there.
const T = "019a0000-1111-7222-8333-444455556666";
const locked = (t) => {
  const locks = fs.mkdtempSync(path.join(os.tmpdir(), "reach-locks-"));
  t.after(() => fs.rmSync(locks, { recursive: true, force: true }));
  fs.writeFileSync(path.join(locks, `${T}.lock`), "");
  return locks;
};
const holding = (...holders) => async () => ({ holders });

test("on Windows a Codex chat's holder is told by its program, never pgrep, lsof or ps", async (t) => {
  const locks = locked(t);
  const run = async () => assert.fail("no pgrep, lsof or ps on Windows");
  const asked = [];
  const ask = (answer) => async (file) => (asked.push(file), answer());
  const win = (holders) => codexHolder(T, { locks, run, platform: "win32", holders });
  assert.equal(
    await win(ask(holding({ pid: 9, image: "C:\\Users\\me\\.codex\\packages\\app-server-daemon\\bin\\codex.exe", command: "codex.exe", parents: ["explorer.exe"] }))),
    "daemon",
  );
  assert.deepEqual(asked, [path.join(locks, `${T}.lock`)], "the chat's own lock file");
  assert.equal(await win(holding({ pid: 9, image: "C:\\x\\codex.exe", command: "\"C:\\x\\codex.exe\" app-server-daemon run", parents: [] })), "daemon");
  assert.equal(await win(holding({ pid: 9, image: "C:\\Program Files\\WindowsApps\\OpenAI.ChatGPT\\app\\codex.exe", command: "codex.exe app-server", parents: ["ChatGPT.exe", "explorer.exe"] })), "codex-app");
  assert.equal(await win(holding({ pid: 9, image: "C:\\x\\codex.exe", command: "codex resume", parents: ["node.exe", "pwsh.exe", "WindowsTerminal.exe"] })), "terminal");
  assert.equal(await win(holding({ pid: 9, image: "C:\\x\\codex.exe", command: "codex", parents: ["cmd.exe"] })), "terminal");
  // Held by something Reach can't tell apart: "other", as on a Mac.
  assert.equal(await win(holding({ pid: 9, image: null, command: null, parents: [] })), "other");
  assert.equal(await win(holding({ pid: 9, image: "C:\\x\\codex.exe", command: "codex", parents: ["services.exe"] })), "other");
  // Nothing holds it, or it's gone: Codex let go, as lsof says on a Mac.
  assert.equal(await win(holding()), null);
  assert.equal(await win(async () => ({ error: "missing", code: 2 })), null);
});

// Owner, Oct 12: chats stay in sync across the agent's app, its CLI and
// Reach, so Windows never holds back a message a Mac would deliver. A Mac's
// failed lookup reads as nobody holding the chat; Windows' does too.
test("on Windows a lookup that fails answers as a Mac's does: nobody holds the chat", async (t) => {
  const locks = locked(t);
  for (const [what, holders] of [
    ["the helper can't run", async () => { throw new Error("csc.exe refused"); }],
    ["Windows wouldn't say", async () => ({ error: "unchecked", code: 5 })],
    ["an answer that isn't one", async () => ({ holders: "codex" })],
    ["a holder that isn't one", async () => ({ holders: [null] })],
    ["no answer at all", async () => null],
  ])
    assert.equal(await codexHolder(T, { locks, platform: "win32", holders }), null, what);
  // As a Mac when lsof fails.
  assert.equal(await codexHolder(T, { locks, platform: "darwin", run: async () => { throw Object.assign(new Error("lsof failed"), { code: 1 }); } }), null);
  // No lock file: nobody holds it, and nobody is asked.
  assert.equal(await codexHolder("019a0000-1111-7222-8333-000000000000", { locks, platform: "win32", holders: async () => assert.fail("not asked") }), null);
});

test("on real Windows, Restart Manager names the process holding a file, and none once it's let go", { skip: process.platform !== "win32", timeout: 240000 }, async (t) => {
  const locks = locked(t);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "reach owners-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const file = path.join(locks, `${T}.lock`);
  const handle = fs.openSync(file, "r+");
  let closed = false;
  t.after(() => closed || fs.closeSync(handle));
  const found = await fileHolders(file, { dataDir });
  fs.mkdirSync("reports", { recursive: true });
  fs.writeFileSync("reports/windows-file-holders.json", JSON.stringify(found, null, 2));
  const me = found.holders.find((h) => h.pid === process.pid);
  assert.ok(me, `this process holds it: ${JSON.stringify(found)}`);
  assert.match(me.image, /node(\.exe)?$/i);
  assert.ok(Array.isArray(me.parents) && me.parents.length > 0, "its parents are named");
  // Not Codex's daemon or app: a terminal (the runner's shell) or other, held either way.
  assert.ok(["terminal", "other"].includes(await codexHolder(T, { locks, platform: "win32", holders: (f) => fileHolders(f, { dataDir }) })));
  fs.closeSync(handle);
  closed = true;
  assert.deepEqual(await fileHolders(file, { dataDir }), { holders: [] });
  assert.equal(await codexHolder(T, { locks, platform: "win32", holders: (f) => fileHolders(f, { dataDir }) }), null);
});
