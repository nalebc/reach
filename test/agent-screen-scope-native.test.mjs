import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";

// Production readers, compiled together with an archived baseline. Only AX
// and AppKit are replaced: this test never looks at or operates a real app.
test("native scoped reads preserve content while avoiding unrelated AX work", {
  skip: process.platform !== "darwin" || process.env.REACH_TEST_APP_NATIVE !== "1", timeout: 180000,
}, async t => {
  const source = await fs.readFile(new URL("../scripts/native/agent-desktop.swift", import.meta.url), "utf8");
  const baseline = await fs.readFile(new URL("fixtures/agent-screen-reader-before-scoping.swift", import.meta.url), "utf8");
  const section = (start, end) => {
    const at = source.indexOf(start), stop = source.indexOf(end, at + start.length);
    assert.ok(at >= 0 && stop > at, start);
    return source.slice(at, stop);
  };
  const renamed = baseline.replace(/\b(contextLabel|labelName|readScreen)\b/g, name => "baseline_" + name);
  const stubs = String.raw`
import Foundation
import CoreGraphics
typealias AXUIElement = Int
typealias CGDirectDisplayID = UInt32
typealias CFString = String
let kCFBooleanTrue = true
let kAXRoleAttribute = "role", kAXSubroleAttribute = "subrole", kAXTitleAttribute = "title", kAXDescriptionAttribute = "description", kAXValueAttribute = "value", kAXChildrenAttribute = "children", kAXEnabledAttribute = "enabled", kAXFocusedWindowAttribute = "window", kAXMainWindowAttribute = "mainWindow", kAXMenuBarAttribute = "menu", kAXPlaceholderValueAttribute = "placeholder", kAXHelpAttribute = "help"
struct Rules { var mode = "full"; var money: [String: NSRegularExpression] = [:] }
struct Refusal: Error {}
func refuse(_ message: String, _ kind: String = "blocked") throws -> Never { throw Refusal() }
struct Seen { let bundle: String, name: String, path: String; let pid: pid_t; var title = "" }
var policyAllowed = true, checks = 0, reads = 0
var attributes: [String: Int] = [:]
var props: [Int: [String: Any]] = [:]
func attr(_ element: Int, _ key: String) -> Any? {
  reads += 1; attributes[key, default: 0] += 1
  return props[element]?[key]
}
func string(_ element: Int, _ key: String) -> String { attr(element, key) as? String ?? "" }
func elementAttr(_ element: Int, _ key: String) -> Int? { attr(element, key) as? Int }
func AXUIElementCreateApplication(_ pid: pid_t) -> Int { Int(pid) }
func AXUIElementSetAttributeValue(_ element: Int, _ key: String, _ value: Bool) {}
func watchScreen() {}
func canonical(_ url: URL) -> String { url.path }
func lower(_ text: String) -> String { text.precomposedStringWithCompatibilityMapping.lowercased() }
func squeezed(_ text: String) -> String { lower(text).split(whereSeparator: \.isWhitespace).joined(separator: " ") }
func appReason(_ bundle: String, _ name: String, _ path: String, _ rules: Rules) -> String? { policyAllowed ? nil : "blocked" }
func check(_ seen: Seen, _ rules: Rules) throws { checks += 1; if !policyAllowed { try refuse("revoked") } }
func urlReason(_ url: String, _ rules: Rules) -> String? { rules.mode != "full" && url.contains("blocked.test") ? "blocked" : nil }
func moneySite(_ url: String, _ rules: Rules) -> Bool { url.contains("bank.test") }
func displayBounds() -> CGRect { CGRect(x: 0, y: 0, width: 2000, height: 2000) }
func frameOf(_ element: Int) -> CGRect? {
  guard let position = attr(element, "position") as? CGPoint, let size = attr(element, "size") as? CGSize else { return nil }
  return CGRect(origin: position, size: size)
}
struct App { var processIdentifier: pid_t = 42; var localizedName: String? = "Fixture"; var bundleIdentifier: String? = "fixture"; var bundleURL: URL? = URL(fileURLWithPath: "/Fixture.app") }
final class NSWorkspace { static let shared = NSWorkspace(); var frontmostApplication: App? = App() }
`;
  const harness = String.raw`
let rules = Rules()
func node(_ id: Int, _ role: String, _ title: String = "", children: [Int] = [], value: String = "", row: Int = 0) {
  props[id] = ["role": role, "title": title, "value": value, "children": children, "position": CGPoint(x: 20, y: 20 + row * 6), "size": CGSize(width: 200, height: 5)]
}
func fixture(_ controlRole: String = "AXTextField") {
  props = [:]
  props[42] = ["window": 1]
  node(1, "AXWindow", "Invoices", children: Array(100..<120) + [2])
  node(2, "AXButton", "Stop loading", row: 180)
  for group in 0..<20 {
    let first = 1000 + group * 20
    node(100 + group, "AXGroup", "Region " + String(group), children: Array(first..<(first + 16)))
    for item in 0..<8 {
      node(first + item, controlRole, "Field " + String(item), value: "Value " + String(group) + "-" + String(item), row: group * 8 + item)
      node(first + 8 + item, "AXStaticText", value: "Invoice " + String(group) + "-" + String(item), row: group * 8 + item)
    }
  }
}
func content(_ screen: Screen, within: String = "") -> Data {
  let words = { (text: String) in text.lowercased().split(whereSeparator: \.isWhitespace).joined(separator: " ") }
  let wanted = words(within)
  let contains = { (context: String) in wanted.isEmpty || (words(context) as NSString).range(of: wanted, options: .literal).location != NSNotFound }
  let items: [[String: Any]] = screen.controls.enumerated().filter { contains($0.element.context) }.map { index, item in
    ["id": item.element, "role": item.role, "name": item.name, "context": item.context, "secure": item.secure, "value": screen.values[index] ?? "", "frame": NSStringFromRect(item.frame)]
  }
  let texts: [[String: Any]] = screen.texts.filter { contains($0.2) }.map { ["text": $0.0, "context": $0.2, "frame": NSStringFromRect($0.1)] }
  return try! JSONSerialization.data(withJSONObject: ["app": screen.app, "title": screen.title, "items": items, "texts": texts, "truncated": screen.truncated], options: [.sortedKeys])
}
fixture()
let before = try baseline_readScreen(rules)
let after = try readScreen(rules)
precondition(!before.truncated && !after.truncated)
precondition(content(before) == content(after))
for within in ["Region 19", "  REGION   19  ", "Region 1", "Absent"] {
  let scoped = try readScreen(rules, within: within)
  precondition(content(before, within: within) == content(scoped, within: within), within)
  precondition(scoped.loading == true, "a Stop button outside the region must still signal loading")
}
props[2]?["enabled"] = false
let disabledStop = try readScreen(rules, within: "Region 19")
precondition(disabledStop.loading == false)
props[2]?["enabled"] = true
props[119]?["title"] = "Region e\u{301}"
let combiningBefore = try baseline_readScreen(rules)
let combiningAfter = try readScreen(rules, within: "Region e")
precondition(combiningAfter.controls.count == 8)
precondition(content(combiningBefore, within: "Region e") == content(combiningAfter, within: "Region e"))

// All label fallbacks and window-button precedence must remain equivalent.
for role in ["AXButton", "AXTextField", "AXSecureTextField", "AXGroup"] {
  for variant in 0..<7 {
    props[9000] = ["role": role, "title": variant == 0 ? "  Named   control  " : " \n", "description": variant == 1 ? "Description" : "", "placeholder": variant == 2 ? "Placeholder" : "", "value": variant == 3 ? "Value" : "", "help": variant == 4 ? "Help" : "", "subrole": variant == 5 ? "AXZoomButton" : ""]
    precondition(labelName(9000, role, secure: role == "AXSecureTextField") == baseline_labelName(9000, role, secure: role == "AXSecureTextField"))
  }
}
// Scoped reads still apply secret and bank masking, and skip protected web trees.
var restricted = Rules(); restricted.mode = "apps"; restricted.money["accountNumber"] = try! NSRegularExpression(pattern: "[0-9]{12}")
node(1, "AXWindow", "Accounts", children: [5, 6])
node(5, "AXWebArea", children: [7]); props[5]?["AXURL"] = "https://bank.test"
node(6, "AXWebArea", children: [8]); props[6]?["AXURL"] = "https://blocked.test"
node(7, "AXGroup", "Account 123456789012", children: [10, 11, 12])
node(8, "AXGroup", "Account 123456789012", children: [13])
node(10, "AXTextField", "Name", value: "vault-secret")
node(11, "AXSecureTextField", "Password", value: "never-read-this")
node(12, "AXStaticText", value: "Balance 123456789012")
node(13, "AXStaticText", value: "PRIVATE protected page")
typedSecrets = ["vault-secret"]
let bankBefore = try baseline_readScreen(restricted)
let bankAfter = try readScreen(restricted, within: "Account ••••9012")
let bankContent = content(bankAfter, within: "Account ••••9012")
precondition(content(bankBefore, within: "Account ••••9012") == bankContent)
let bankText = String(data: bankContent, encoding: .utf8)!
precondition(!bankText.contains("vault-secret") && !bankText.contains("never-read-this") && !bankText.contains("123456789012") && !bankText.contains("PRIVATE"))
for (index, control) in bankAfter.controls.enumerated() where control.secure { precondition(bankAfter.values[index] == nil) }
policyAllowed = false
do { _ = try readScreen(rules, within: "Region 19"); fatalError("App policy bypassed") } catch {}
policyAllowed = true; typedSecrets = []
fixture()

// Paired samples: same in-memory AX tree, same result, no injected delays.
// Measure optimized native CPU work, not actual interprocess AX or model time.
var target = "Region 19", expected = Data()
func run(_ mode: Int) throws -> (Double, Int) {
  reads = 0
  let start = DispatchTime.now().uptimeNanoseconds
  let screen = try mode == 0 ? baseline_readScreen(rules) : readScreen(rules, within: mode == 2 ? target : "")
  let output = content(screen, within: target)
  let elapsed = Double(DispatchTime.now().uptimeNanoseconds - start) / 1_000_000
  precondition(output == expected && !screen.truncated)
  return (elapsed, reads)
}
var scenarios: [[String: Any]] = []
for (name, role, within, narrow) in [("fields", "AXTextField", "Region 19", true), ("buttons", "AXButton", "Region 19", true), ("broad", "AXTextField", "Region", false), ("missing", "AXTextField", "Absent", true)] {
  fixture(role); target = within; expected = content(try baseline_readScreen(rules), within: target)
  for _ in 0..<5 { for mode in 0..<3 { _ = try run(mode) } }
  var times = [[Double]](repeating: [], count: 3), counts = [Int](repeating: 0, count: 3)
  for round in 0..<40 {
    for step in 0..<3 {
      let mode = (round + step) % 3, result = try run(mode)
      times[mode].append(result.0); counts[mode] = result.1
    }
  }
  precondition(counts[1] < counts[0])
  precondition(narrow ? counts[2] < counts[1] : counts[2] <= counts[1])
  var scenario: [String: Any] = ["name": name, "controlRole": role, "within": within]
  for (mode, label) in ["baselineFullReadThenFilter", "lazyLabelsFullReadThenFilter", "nativeWithinRead"].enumerated() {
    let sorted = times[mode].sorted()
    scenario[label] = ["attributeReads": counts[mode], "medianMs": sorted[sorted.count / 2], "p95Ms": sorted[Int(Double(sorted.count - 1) * 0.95)]]
  }
  scenarios.append(scenario)
}
let report: [String: Any] = ["samplesPerMode": 40, "controls": 161, "texts": 160, "pairedOutputsEqual": true, "injectedDelayMs": 0, "scenarios": scenarios]
let data = try JSONSerialization.data(withJSONObject: report, options: [.sortedKeys])
print(String(data: data, encoding: .utf8)!)
`;
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "reach-scoped-reader-"));
  try {
    const program = stubs + section("func hideSecrets(", "// Bank, card") + section("func maskAccountNumbers(", "// END PURE DESKTOP POLICY") +
      section("struct Control {", "func frameOf(") + section("func contextLabel(", "func controlContext(") + section("func labelName(", "func elements(") + renamed + harness;
    await fs.writeFile(path.join(directory, "main.swift"), program);
    const compiled = spawnSync("xcrun", ["swiftc", "-O", "-module-cache-path", path.join(directory, "modules"), "main.swift", "-o", "reader"], { cwd: directory, encoding: "utf8", timeout: 160000 });
    assert.equal(compiled.status, 0, compiled.stderr);
    const ran = spawnSync(path.join(directory, "reader"), [], { encoding: "utf8", timeout: 20000 });
    assert.equal(ran.status, 0, ran.stderr);
    const report = { schema: "reach.scoped-reader-benchmark.v1", date: "2026-10-13", ...JSON.parse(ran.stdout),
      sourceSha256: crypto.createHash("sha256").update(source).digest("hex"), baselineSha256: crypto.createHash("sha256").update(baseline).digest("hex"),
      limitations: ["Fake AX/AppKit; no real application, interprocess AX latency, model inference, transport or live input.", "Optimized production reader plus equivalent normalized JSON output. Rotating paired order, five warmups, no injected delays.", "Timing is diagnostic, not a pass threshold. Assertions require equivalent content, bounded reads and fewer attribute requests."] };
    t.diagnostic(JSON.stringify(report));
    if (process.env.REACH_SCREEN_BENCHMARK_OUTPUT) await fs.writeFile(process.env.REACH_SCREEN_BENCHMARK_OUTPUT, JSON.stringify(report, null, 2) + "\n");
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
