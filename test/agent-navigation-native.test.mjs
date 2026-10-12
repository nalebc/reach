import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

// Compile the production reference resolver against inert accessibility
// objects. This never inspects or controls the owner's desktop.
test("native control references reject recycled rows, focus changes, detached elements and expired grants", { skip: process.platform !== "darwin" || !process.env.REACH_TEST_APP_NATIVE, timeout: 180000 }, async () => {
  const source = await fs.readFile(new URL("../scripts/native/agent-desktop.swift", import.meta.url), "utf8");
  const section = (start, end) => {
    const at = source.indexOf(start), stop = source.indexOf(end, at + start.length);
    assert.ok(at >= 0 && stop > at);
    return source.slice(at, stop);
  };
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "reach-navigation-native-"));
  const stubs = String.raw`
import Foundation
import CoreGraphics
typealias AXUIElement = Int
typealias CGDirectDisplayID = UInt32
struct Rules {}
struct Refusal: Error {}
func refuse(_ message: String, _ kind: String = "blocked") throws -> Never { throw Refusal() }
let kAXRoleAttribute = "role", kAXSubroleAttribute = "subrole", kAXTitleAttribute = "title", kAXDescriptionAttribute = "description", kAXValueAttribute = "value", kAXParentAttribute = "parent", kAXChildrenAttribute = "children", kAXEnabledAttribute = "enabled", kAXFocusedWindowAttribute = "window"
var props: [Int: [String: Any]] = [1: ["role": "AXButton", "parent": 2, "title": "Open"], 2: ["role": "AXRow", "parent": 3, "title": "Invoice A"], 3: ["role": "AXWindow", "title": "Invoices"]]
func attr(_ element: Int, _ key: String) -> Any? { props[element]?[key] }
func string(_ element: Int, _ key: String) -> String { attr(element, key) as? String ?? "" }
var focusedWindow = 3, currentDisplay: UInt32 = 2
func elementAttr(_ element: Int, _ key: String) -> Int? { key == "window" ? focusedWindow : attr(element, key) as? Int }
func AXUIElementCreateApplication(_ pid: pid_t) -> Int { 42 }
func CFEqual(_ a: Int, _ b: Int) -> Bool { a == b }
func pidOf(_ element: Int) -> pid_t { 42 }
func displayID() -> UInt32 { currentDisplay }
func displayBounds() -> CGRect { CGRect(x: 0, y: 0, width: 100, height: 100) }
func frameOf(_ element: Int) -> CGRect? { CGRect(x: 1, y: 1, width: 20, height: 20) }
func labelName(_ element: Int, _ role: String, secure: Bool) -> String { string(element, "title") }
func maskAccountNumbers(_ text: String, _ rules: Rules) -> String { text }
func hideSecrets(_ text: String, _ secrets: [String]) -> String { text }
var policyAllowed = true, checks = 0
func seen(_ element: Int) -> Int { element }
func check(_ seen: Int, _ rules: Rules) throws { checks += 1; if !policyAllowed { try refuse("revoked") } }
struct App { var processIdentifier: pid_t = 42; var localizedName: String? = "Fixture"; var bundleIdentifier: String? = "fixture" }
final class NSWorkspace { static let shared = NSWorkspace(); var frontmostApplication: App? = App() }
`;
  const harness = String.raw`
let rules = Rules()
let ref = rememberElement(1, prefix: "e", window: 3, name: "Open", context: "Invoice A")
assert(ref == rememberElement(1, prefix: "e", window: 3, name: "Open", context: "Invoice A"))
let resolved = try referencedControl(ref, rules)
assert(resolved.0.element == 1)
assert(checks == 1)
func rejected(_ label: String, _ setup: () -> Void, _ reset: () -> Void) {
  setup()
  do { _ = try referencedControl(ref, rules); fatalError(label + " was allowed") } catch {}
  reset()
}
rejected("recycled row", { props[2]?["title"] = "Invoice B" }, { props[2]?["title"] = "Invoice A" })
rejected("renamed", { props[1]?["title"] = "Delete" }, { props[1]?["title"] = "Open" })
rejected("disabled", { props[1]?["enabled"] = false }, { props[1]?["enabled"] = true })
rejected("detached", { props[1]?["parent"] = nil }, { props[1]?["parent"] = 2 })
rejected("window", { focusedWindow = 9 }, { focusedWindow = 3 })
rejected("moved to another window", { props[2]?["parent"] = 4; props[4] = ["role": "AXWindow"] }, { props[2]?["parent"] = 3 })
rejected("app", { NSWorkspace.shared.frontmostApplication?.processIdentifier = 99 }, { NSWorkspace.shared.frontmostApplication?.processIdentifier = 42 })
rejected("policy", { policyAllowed = false }, { policyAllowed = true })
rejected("expired", { elementReferences[ref]?.at = Date(timeIntervalSinceNow: -301) }, { elementReferences[ref]?.at = Date() })
assert(ref != rememberElement(1, prefix: "e", window: 3, name: "Open", context: "Invoice B"))
currentDisplay = 7
assert(ref != rememberElement(1, prefix: "e", window: 3, name: "Open", context: "Invoice A"))
assert(elementReferences[ref]?.display == 2)
print("OK references")
`;
  try {
    const program = stubs + section("struct Control {", "func frameOf(") + section("struct ElementReference {", "func labelName(") + harness;
    await fs.writeFile(path.join(dir, "main.swift"), program);
    const compiled = spawnSync("xcrun", ["swiftc", "-module-cache-path", path.join(dir, "modules"), "main.swift", "-o", "navigation"], { cwd: dir, encoding: "utf8", timeout: 160000 });
    assert.equal(compiled.status, 0, compiled.stderr);
    const run = spawnSync(path.join(dir, "navigation"), [], { encoding: "utf8", timeout: 10000 });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /OK references/);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
