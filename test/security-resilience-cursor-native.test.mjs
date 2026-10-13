import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
test(
  "cursor exclusion requires native Apple WindowServer identity and refuses this process or invalid PIDs",
  {
    skip:
      process.platform !== "darwin" ||
      process.env.REACH_TEST_APP_NATIVE !== "1",
  },
  async (t) => {
    const dir = await fs.mkdtemp(
      path.join(os.tmpdir(), "agent-cursor-identity-"),
    );
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const source = await fs.readFile(
      new URL("../scripts/native/agent-desktop.swift", import.meta.url),
      "utf8",
    );
    const identity = source
      .split("// BEGIN NATIVE CURSOR IDENTITY")[1]
      ?.split("\n")
      .slice(1)
      .join("\n")
      .split("// END NATIVE CURSOR IDENTITY")[0];
    assert.ok(identity);
    const program = `import Foundation\nimport Security\nimport Darwin\n${identity}\nfor pid: pid_t in [0, -1, getpid(), getppid(), 999999] { if trustedCursorIdentity(pid) { fatalError("untrusted process accepted") } }\nprint("OK")\n`;
    const input = path.join(dir, "identity.swift"),
      binary = path.join(dir, "identity");
    await fs.writeFile(input, program);
    await exec("/usr/bin/xcrun", ["swiftc", input, "-o", binary], {
      timeout: 180000,
      maxBuffer: 1024 * 1024,
    });
    const result = await exec(binary, [], { timeout: 10000, maxBuffer: 65536 });
    assert.equal(result.stdout.trim(), "OK");
  },
);
