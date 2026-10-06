import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { safePath } from "../server/core.mjs";
import { parseBrowserMutation, validateBrowserMutation, runBrowserMutation } from "../server/browser-mutations.mjs";

async function fixture(t) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "reach-mutations-"));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  await fs.mkdir(path.join(temp, "Desktop"));
  await fs.writeFile(path.join(temp, "outside.txt"), "private outside");
  const root = await fs.realpath(path.join(temp, "Desktop"));
  const client = { kind: "agent", agentRoots: [root], policy: { browser: true, terminalApproval: true } };
  const authorize = () => client;
  const resolve = (index, relative, current, options = {}) => {
    let result;
    try { result = safePath(current.agentRoots, index, relative); }
    catch (error) { if (!options.allowMissing) throw error; result = path.join(safePath(current.agentRoots, index, path.posix.dirname(relative)), path.posix.basename(relative)); }
    if (result === path.join(root, "private") || result.startsWith(path.join(root, "private") + path.sep)) throw Error("private data blocked");
    return result;
  };
  const run = (command, extra = {}, check = authorize) => runBrowserMutation({ type: "terminal-change", command, root: 0, ...extra }, check, { resolve });
  return { root, temp, client, authorize, resolve, run };
}

test("mutation grammar is an exact finite file-operation language", () => {
  assert.deepEqual(parseBrowserMutation('cp "notes one.txt" "notes two.txt"'), { name: "cp", paths: ["notes one.txt", "notes two.txt"] });
  for (const command of ["sudo rm notes.txt", "sh -c pwd", "python code.py", "./script", "mkdir -p a/b", "rm -rf a", "mv a b", "ln -s a b", "cp a b c", "rm a b", "touch /tmp/x", "touch ../x", "touch a/../x", "touch ~/x", "touch C:/x", "touch $HOME/x", "touch `pwd`", "touch x; rm y", "touch x\nrm y", "touch x | cat", "touch x > y", "touch x\\ y", 'touch "unterminated', "touch .", "touch x*", "touch a\u202eb"]) assert.throws(() => parseBrowserMutation(command), /Supported file changes/, command);
});

test("approved changes create/copy/remove only bounded regular files within the selected folder", async (t) => {
  const { root, run } = await fixture(t);
  assert.match(await run("mkdir notes"), /Created folder notes/);
  assert.match(await run('touch "first note.txt"', { cwd: "notes" }), /Touched file/);
  const file = path.join(root, "notes", "first note.txt");
  await fs.writeFile(file, "hello");
  assert.match(await run('cp "first note.txt" "second note.txt"', { cwd: "notes" }), /Copied/);
  assert.equal(await fs.readFile(path.join(root, "notes", "second note.txt"), "utf8"), "hello");
  assert.equal((await fs.stat(path.join(root, "notes", "second note.txt"))).mode & 0o777, 0o600);
  await assert.rejects(run('cp "first note.txt" "second note.txt"', { cwd: "notes" }), /already exists/);
  await run('rm "second note.txt"', { cwd: "notes" });
  await assert.rejects(fs.stat(path.join(root, "notes", "second note.txt")), { code: "ENOENT" });
  await assert.rejects(run("rm notes"), /regular file/);
  await fs.writeFile(path.join(root, "large"), Buffer.alloc(1024 * 1024 + 1));
  for (const command of ["touch large", "rm large", "cp large copy"]) await assert.rejects(run(command), /1 MiB/);
});

test("approval cannot escape roots through symlinks, hard links, cwd, or special directory targets", async (t) => {
  const { root, temp, run, client } = await fixture(t);
  await fs.mkdir(path.join(root, "folder"));
  await fs.writeFile(path.join(root, "safe"), "safe");
  await fs.symlink(path.join(temp, "outside.txt"), path.join(root, "outside-link"));
  await fs.symlink(path.join(root, "folder"), path.join(root, "inside-link"));
  await fs.link(path.join(temp, "outside.txt"), path.join(root, "hard-link"));
  for (const command of ["cp outside-link copy", "touch outside-link", "rm outside-link", "touch inside-link/child", "mkdir inside-link/child", "cp safe outside-link", "cp hard-link copy", "touch hard-link", "rm hard-link"]) await assert.rejects(run(command), /links|regular file/, command);
  await assert.rejects(run("touch child", { cwd: "inside-link" }), /Symbolic links/);
  await assert.rejects(run("touch child", { cwd: "../" }), /Supported file changes/);
  await assert.rejects(run("touch child", { root: 1 }), /does not allow/);
  client.policy.terminalApproval = false;
  await assert.rejects(run("touch forbidden"), /does not allow/);
  assert.equal(await fs.readFile(path.join(temp, "outside.txt"), "utf8"), "private outside");
});

test("authorization and current filesystem paths are checked immediately before each change", async (t) => {
  const { root, run, client, authorize, resolve } = await fixture(t);
  await fs.writeFile(path.join(root, "source"), "source");
  validateBrowserMutation({ type: "terminal-change", command: "cp source copy", root: 0 }, authorize, { resolve });
  let checks = 0;
  await assert.rejects(run("touch blocked", {}, () => { if (++checks > 1) throw Error("revoked"); return client; }), /revoked/);
  await assert.rejects(fs.stat(path.join(root, "blocked")), { code: "ENOENT" });
  await assert.rejects(run("touch private"), /private data/, "a private leaf remains blocked before it exists");
  await fs.mkdir(path.join(root, "private"));
  await assert.rejects(run("touch private/secret"), /private data/);
  assert.equal((await fs.readdir(root)).includes("copy"), false, "validation alone never mutates files");
});
