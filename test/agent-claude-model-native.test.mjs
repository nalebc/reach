import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);

test("native Claude setting controls bind each action and acknowledgement to one exact session", {
  skip: process.platform !== "darwin" || process.env.REACH_TEST_APP_NATIVE !== "1",
}, async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), "reach-claude-chip-"));
  try {
    const source = await fs.readFile(new URL("../scripts/native/claude-compose.swift", import.meta.url), "utf8");
    // A failed model-menu lookup must not send cleanup input into a new chat.
    const modelCleanup = source.slice(source.indexOf("func closeModelMenu()"), source.indexOf("let itemRoles:", source.indexOf("func closeModelMenu()")));
    assert.match(modelCleanup, /guard elements\(app\)\.contains/);
    assert.match(modelCleanup, /guard showing\(look\(app\)\) else \{ return \}\s*for down/);
    assert.match(source, /let selected = current\.popups\.compactMap \{ modelOf\(\$0\.1\) \}\s*if selected == \[wanted\]/);
    // Check production paths cannot bypass the tested dispatch gate.
    const settings = source.slice(source.indexOf('if let wanted = option("--mode")'), source.indexOf('if args.contains("--stop") {'));
    assert.ok(settings.includes("settingsPress") && settings.includes("settingsKeys") && settings.includes("settingsWindow"));
    assert.doesNotMatch(settings, /AXUIElementPerformAction|postToPid/);
    // Exercise the real parser and action gate without opening or controlling an app.
    const checks = `
// Exercise the production JSON decoder, with JS's worst-case escaping,
// without entering ClaudeCompose.main or touching any Accessibility API.
let payloadData = try Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))
assert(payloadData.count > 524288)
let payload = decodeComposerPayload(payloadData)!
assert((payload["expected"] as? [String])?.count == 9)
assert((payload["text"] as? String)?.count == 50000)
let exactLimit = Data("{}".utf8) + Data(repeating: 32, count: composerPayloadLimit - 2)
assert(decodeComposerPayload(exactLimit) != nil)
assert(decodeComposerPayload(exactLimit + Data([32])) == nil)
assert(decodeComposerPayload(Data("[]".utf8)) == nil)
assert(decodeComposerPayload(Data("{".utf8)) == nil)
assert(modelOf("Model: Sonnet 5.5") == "Sonnet 5.5")
assert(modelOf("Opus 5.5 Medium") == "Opus 5.5")
assert(modelOf("Effort: High") == nil)
assert(modelOf("Effort: Extra") == nil)
assert(modelOf("Auto") == nil)
assert(effortOf("Effort: Extra") == "Extra high")
assert(effortOf("Effort: Low") == "Low")
assert(effortOf("Model: Sonnet 5.5") == nil)
// The account button ("<name> <plan>") is neither an effort nor a model chip.
assert(effortOf("Jordan Max") == nil)
assert(modelOf("Jordan Max") == nil)
assert(effortOf("Effort: High") == "High")
assert(effortOf("Claude Opus 5.5 Max") == "Max")
var gate = SettingsSessionGate(session: "local_expected")
var visible = ["local_expected"]
var actions = 0
assert(gate.perform(sessions: { visible }, action: { actions += 1; return true }))
visible = ["local_other"] // the person switches chats while the menu loads
assert(!gate.perform(sessions: { visible }, selection: true, action: { actions += 1; return true }))
assert(actions == 1 && !gate.selectionAttempted)
assert(!gate.perform(sessions: { visible }, action: { actions += 1; return true })) // no cleanup or shortcut in other chat
visible = ["local_expected"]
assert(gate.perform(sessions: { visible }, selection: true, action: { actions += 1; return true }))
assert(gate.selectionAttempted)
assert(!gate.confirms(["local_other"], matched: true)) // another chat's matching chip is not acknowledgement
assert(!gate.confirms(["local_expected", "local_other"], matched: true))
assert(!gate.confirms(["local_expected"], matched: false))
assert(gate.confirms(["local_expected"], matched: true))
assert(!SettingsSessionGate(session: nil).permits(["local_expected"]))
var failed = SettingsSessionGate(session: "local_expected")
assert(!failed.perform(sessions: { ["local_expected"] }, selection: true, action: { false }))
assert(failed.selectionAttempted) // attempted dispatch must remain uncertain even when AX returns failure
print("native-chip-contract-ok")
`;
    const file = path.join(folder, "chips.swift");
    const binary = path.join(folder, "chips");
    await fs.writeFile(file, source.split("@main\nstruct ClaudeCompose")[0] + checks);
    await exec("xcrun", ["swiftc", "-module-cache-path", path.join(folder, "cache"), file, "-o", binary], { timeout: 90_000, maxBuffer: 1024 * 1024 });
    const payloadFile = path.join(folder, "payload.json");
    await fs.writeFile(payloadFile, JSON.stringify({
      text: "\u0001".repeat(40000) + "x".repeat(10000),
      expected: Array.from({ length: 9 }, (_, i) => String.fromCharCode(i + 16).repeat(32000)),
      draft: false,
    }));
    const { stdout } = await exec(binary, [payloadFile], { timeout: 5000 });
    assert.equal(stdout.trim(), "native-chip-contract-ok");
  } finally {
    await fs.rm(folder, { recursive: true, force: true });
  }
});
