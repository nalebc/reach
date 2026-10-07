import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
const script = fileURLToPath(new URL("../scripts/agent-hook.mjs", import.meta.url));
for (const agent of ["claude", "codex"]) {
  test(`a cached ${agent} Reach hook exits without creating or answering a request`, async () => {
    const child = spawn(process.execPath, [script, agent, "/not-a-real-socket"], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => output += chunk);
    child.stderr.on("data", (chunk) => output += chunk);
    const code = await new Promise((resolve) => child.on("exit", resolve));
    assert.equal(code, 0);
    assert.equal(output, "");
  });
}
