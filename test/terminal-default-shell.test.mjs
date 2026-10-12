import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Terminals } from "../server/terminal.mjs";

test("a Linux terminal starts with no SHELL environment or zsh dependency", {
  skip: process.platform !== "linux", timeout: 15000,
}, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "reach-default-shell-"));
  const terminals = new Terminals();
  t.after(async () => { await terminals.dispose(); await fs.rm(directory, { recursive: true, force: true }); });
  const previous = process.env.SHELL;
  let session;
  try {
    delete process.env.SHELL;
    const created = terminals.create({ cwd: directory, clientId: "linux-fixture",
      command: "printf 'REACH_DEFAULT_SHELL_OK:%s\\n' \"$0\"; exit 0" });
    session = terminals.get(created.id);
  } finally {
    if (previous === undefined) delete process.env.SHELL;
    else process.env.SHELL = previous;
  }
  let timer;
  try {
    await Promise.race([session.ended, new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error("The default terminal did not exit.")), 10000);
    })]);
  } finally { clearTimeout(timer); }
  assert.equal(session.exitCode, 0, session.buffer);
  assert.match(session.buffer, /REACH_DEFAULT_SHELL_OK:\/bin\/sh/);
});
