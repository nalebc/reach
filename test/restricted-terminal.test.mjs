import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseTerminalCommand, runTerminalCommand } from "../server/restricted-terminal.mjs";
import { safePath } from "../server/core.mjs";

function fixture(t) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "reach-restricted-")));
  const root = path.join(dir, "shared");
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, "notes.txt"), "hello world\nsecond line\nlast line\n");
  fs.writeFileSync(path.join(root, "file with spaces.txt"), "quoted path\n");
  fs.writeFileSync(path.join(dir, "private.txt"), "not shared");
  if (process.platform !== "win32") fs.symlinkSync(path.join(dir, "private.txt"), path.join(root, "escape"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let permitted = true;
  const client = { policy: { restrictedTerminal: true }, agentRoots: [root] };
  const authorize = () => { if (!permitted) throw Object.assign(Error("Revoked"), { status: 403 }); return client; };
  const resolve = (index, p, c) => safePath(c.agentRoots, index, p);
  // Unsupported hosts exercise the JS parser/formatter with an explicit fake.
  // macOS still uses the real descriptor helper; sandbox/race tests are separate.
  const fileRun = async request => {
    const full = path.join(request.root, request.path), stat = fs.lstatSync(full);
    const reject = message => { throw Object.assign(Error(message), { status: 400 }); };
    if (stat.isSymbolicLink()) throw Object.assign(Error("Symbolic link"), { status: 403 });
    if (request.op === "stat") return { stat: { type: stat.isDirectory() ? "directory" : "file" } };
    if (request.op === "list") return { items: fs.readdirSync(full, { withFileTypes: true }).filter(entry => !entry.isSymbolicLink()).map(entry => ({ name: entry.name, type: entry.isDirectory() ? "directory" : "file" })), truncated: false };
    assert.equal(request.op, "read");
    if (!stat.isFile() || stat.size > request.maxBytes) reject("Choose a bounded regular file");
    return { data: fs.readFileSync(full).toString("base64"), stat: {} };
  };
  const run = (command, index = 0, cwd = "") => runTerminalCommand({ type: "terminal", command, root: index, cwd }, authorize, resolve, process.platform === "darwin" ? {} : { run: fileRun });
  return { dir, root, run, client, revoke: () => { permitted = false; } };
}

test("restricted commands read only the selected folder and return bounded text", async (t) => {
  const f = fixture(t);
  assert.equal(await f.run("pwd"), f.root);
  assert.match(await f.run("ls"), /notes.txt/);
  assert.equal(await f.run("cat notes.txt"), "hello world\nsecond line\nlast line\n");
  assert.equal(await f.run('cat "file with spaces.txt"'), "quoted path\n");
  assert.equal(await f.run("head -n 1 notes.txt"), "hello world");
  assert.equal(await f.run("tail -n 1 notes.txt"), "last line");
  assert.equal(await f.run("wc -l notes.txt"), "3 notes.txt");
  assert.equal(await f.run('grep "second" notes.txt'), "2:second line");
  assert.equal(await f.run('grep ".*" notes.txt'), "", "search is literal, never a regex or program");
  assert.equal(fs.readFileSync(path.join(f.root, "notes.txt"), "utf8"), "hello world\nsecond line\nlast line\n");
});

test("cd and following commands stay in their explicit working folder", async (t) => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.root, "nested"));
  fs.writeFileSync(path.join(f.root, "nested/notes.txt"), "nested content");
  if (process.platform !== "win32") fs.symlinkSync(f.dir, path.join(f.root, "outside"));
  assert.equal(await f.run("cd nested"), path.join(f.root, "nested"));
  assert.equal(await f.run("pwd", 0, "nested"), path.join(f.root, "nested"));
  assert.equal(await f.run("cat notes.txt", 0, "nested"), "nested content");
  assert.equal(await f.run("cd ..", 0, "nested"), f.root);
  await assert.rejects(f.run("cd .."), { status: 403 });
  await assert.rejects(f.run("cd ../..", 0, "nested"), { status: 403 });
  if (process.platform !== "win32") await assert.rejects(f.run("cd outside"), { status: 403 });
  await assert.rejects(f.run("cd notes.txt"), { status: 400 });
  for (const cwd of ["../", "/tmp", {}, null, "nested\u202e"])
    await assert.rejects(f.run("pwd", 0, cwd), { status: 400 });
  assert.equal(await f.run("pwd"), f.root, "cd never changes process-global working directory");
});

test("deny unlisted programs and shell bypasses, even if an owner would approve", () => {
  for (const command of [
    "sudo ls", "rm notes.txt", "rmdir folder", "del notes.txt", "unlink notes.txt", "mv notes.txt x", "cp a b",
    "chmod 777 notes.txt", "touch new", "truncate -s 0 notes.txt", "find . -delete", "find . -exec rm {} +",
    "python -c 'print(1)'", "node -e '1'", "sh -c ls", "bash", "npm run build", "git status", "curl example.com",
    "ls; rm notes.txt", "ls && rm notes.txt", "ls | sh", "ls > notes.txt", "cat < notes.txt", "ls\nrm notes.txt",
    "cat $(whoami)", "cat `whoami`", "cat ${HOME}", "ls\\n", "./ls", "/bin/ls", "env ls", "LS", "l's' /",
    "cat ../private.txt", "cat /etc/passwd", "cat ~/secret", "ls -R", "head -n 0 notes.txt", "head -n 9999 notes.txt",
    "grep -e notes.txt", "wc --files0-from=notes.txt", "cat '*.txt'", "cat \"unfinished", "cat \u202efile",
  ]) assert.throws(() => parseTerminalCommand(command), { status: 400 }, command);
});

test("deny folder escapes, missing grants, special files, oversized reads and revoked sessions", async (t) => {
  const f = fixture(t);
  if (process.platform !== "win32") await assert.rejects(f.run("cat escape"), { status: 403 });
  await assert.rejects(f.run("pwd", 9), { status: 403 });
  await assert.rejects(f.run("cat ."), { status: 400 });
  fs.writeFileSync(path.join(f.root, "large.txt"), "x".repeat(1024 * 1024 + 1));
  await assert.rejects(f.run("cat large.txt"), { status: 400 });
  fs.writeFileSync(path.join(f.root, "output.txt"), "x".repeat(100000));
  const out = await f.run("cat output.txt");
  assert.ok(out.length < 64100);
  assert.match(out, /Output truncated/);
  fs.writeFileSync(path.join(f.root, "control.txt"), "\x1b[2J\u202ehello");
  assert.equal(await f.run("cat control.txt"), "\\u001b[2J\\u202ehello");
  f.revoke();
  await assert.rejects(f.run("ls"), { status: 403 });
});

test("SQL, HTML and encoded shell syntax remain inert file data", async (t) => {
  const f = fixture(t);
  const contents = "Robert'); DROP TABLE clients;--\n<img src=x onerror=alert(1)>\n$(rm notes.txt)\n";
  fs.writeFileSync(path.join(f.root, "payload.txt"), contents);
  assert.equal(await f.run("cat payload.txt"), contents);
  assert.equal(await f.run('grep "DROP TABLE" payload.txt'), "1:Robert'); DROP TABLE clients;--");
  // No percent decoding or a second shell interpretation is allowed.
  for (const name of ["%2e%2e%2fprivate.txt", "%24%28whoami%29", "%3brm"])
    fs.writeFileSync(path.join(f.root, name), "literal filename");
  assert.equal(await f.run("cat %2e%2e%2fprivate.txt"), "literal filename");
  assert.equal(await f.run("cat %24%28whoami%29"), "literal filename");
  assert.equal(await f.run("cat %3brm"), "literal filename");
  assert.equal(fs.readFileSync(path.join(f.root, "notes.txt"), "utf8"), "hello world\nsecond line\nlast line\n");
  for (const bad of ["true", 1, {}, null]) {
    f.client.policy.restrictedTerminal = bad;
    await assert.rejects(f.run("pwd"), { status: 403 });
  }
});
