import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

test("native keyboard events carry one whole character each, preserving Unicode", {
  skip: process.platform !== "darwin" || process.env.REACH_TEST_APP_NATIVE !== "1",
}, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "agent-keyboard-text-"));
  try {
    const source = await fs.readFile(new URL("../scripts/native/agent-desktop.swift", import.meta.url), "utf8");
    const pure = source.split("// BEGIN PURE DESKTOP TEXT")[1]?.split("// END PURE DESKTOP TEXT")[0];
    assert.ok(pure);
    const checks = `
func check(_ value: Bool, _ label: String) { if !value { print("FAILED: " + label); exit(1) } }
let samples = ["", "plain text", "café — mañana", "日本語 العربية", "🙂", "👨‍👩‍👧‍👦", "e\\u{301}"]
for padding in 0...33 {
  for sample in samples {
    let text = String(repeating: "a", count: padding) + sample + String(repeating: "🚀", count: 20)
    let chunks = keyboardChunks(text)
    check(chunks.allSatisfy { !$0.isEmpty && $0.count <= 16 }, "event length")
    check(chunks.flatMap { $0 } == Array(text.utf16), "code units preserved")
    check(chunks.map { String(decoding: $0, as: UTF16.self) }.joined() == text, "complete scalars in each event")
  }
}
check(keyboardChunks("").isEmpty, "empty text emits no events")
check(keyboardChunks("7*3") == [[55], [42], [51]], "one character per event")
check(keyboardChunks("e\u{301}x").count == 2, "a combined character stays one event")
print("Unicode keyboard chunks passed")
`;
    const main = path.join(directory, "main.swift"), binary = path.join(directory, "keyboard-text");
    await fs.writeFile(main, "import Foundation\n" + pure + checks);
    const build = spawnSync("/usr/bin/xcrun", ["swiftc", "-module-cache-path", path.join(directory, "cache"), main, "-o", binary], { encoding: "utf8", timeout: 120000 });
    assert.equal(build.status, 0, build.stderr);
    const result = spawnSync(binary, [], { encoding: "utf8", timeout: 10000 });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /Unicode keyboard chunks passed/);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
