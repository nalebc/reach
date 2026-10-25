import assert from "node:assert/strict";
import fs from "node:fs";
import { windowsAcl, othersAllowed, WRITES } from "./windows-acl.mjs";

// Only this user can open it, checked the way each system enforces that:
// its mode on a Mac or Linux; on Windows, where every file's mode reads
// 0666, its access list (nobody but this user, SYSTEM and Administrators).
// A named pipe (\\.\pipe\…) keeps Windows' own rule for new pipes: others
// may be let in to read but never write, so they can ask it nothing
// (proven with a real second user in windows-agent-pipe.test.mjs).
export async function assertPrivate(target) {
  if (process.platform === "win32") {
    const pipe = target.startsWith("\\\\.\\pipe\\");
    const acl = await windowsAcl(pipe ? "pipe" : "file", pipe ? target.slice("\\\\.\\pipe\\".length) : target);
    assert.deepEqual(othersAllowed(acl, pipe ? WRITES : -1), [], `${target} is open to others`);
  } else assert.equal((fs.statSync(target).mode & 0o777).toString(8), "600", `${target} is open to others`);
}
