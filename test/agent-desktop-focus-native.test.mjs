import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { nativeRules } from "../server/agent-guard.mjs";

// Compile production focus(), check() and perform() with inert AppKit/AX/CG
// adapters. The event sink only counts objects: no real apps or input are used.
test("native keyboard dispatch refuses missing or conflicting focus identity before any event", {
  skip: process.platform !== "darwin" || process.env.REACH_TEST_APP_NATIVE !== "1",
}, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "reach-focus-policy-"));
  try {
    const source = await fs.readFile(new URL("../scripts/native/agent-desktop.swift", import.meta.url), "utf8");
    const extract = (start, end) => {
      const at = source.indexOf(start);
      assert.notEqual(at, -1, start);
      const stop = source.indexOf(end, at + start.length);
      assert.notEqual(stop, -1, end);
      return source.slice(at, stop);
    };
    const section = (start, end) => extract(start, end).split("\n").slice(1).join("\n");
    const policy = section("// BEGIN PURE DESKTOP POLICY", "// END PURE DESKTOP POLICY");
    const text = section("// BEGIN PURE DESKTOP TEXT", "// END PURE DESKTOP TEXT");
    const seen = source.split("\n").find((line) => line.startsWith("struct Seen "));
    assert.ok(seen);
    const rules = nativeRules({ preset: "full" }, { hosts: ["localhost:8443"], titles: ["reach"], home: "/Users/me", protectedPaths: [] });
    const literal = (value) => JSON.stringify(value).replace(/\\u([0-9a-f]{4})/gi, "\\u{$1}");
    const list = (values) => `[${values.map(literal).join(",")}]`;
    const config = `
var full = Rules()
full.mode = "full"
full.hosts = ${list(rules.hosts)}
full.titles = ${list(rules.titles)}
full.protectedAppIds = ${list(rules.protectedAppIds)}
full.protectedAppNames = ${list(rules.protectedAppNames)}
full.reachWords = ${list(rules.reachWords)}
full.privatePanes = ${list(rules.privatePanes)}
full.protectedTitleWords = ${list(rules.protectedTitleWords)}
full.patterns = compile(${list(rules.protectedPagePatterns)})
full.terminalLike = ${list(rules.terminalLike)}
`;
    const stubs = String.raw`
final class NSRunningApplication {
  let processIdentifier: pid_t
  let bundleIdentifier: String?, localizedName: String?
  let bundleURL: URL?
  init(_ pid: pid_t, _ bundle: String = "com.apple.Safari", _ name: String = "Safari") {
    processIdentifier = pid; bundleIdentifier = bundle; localizedName = name
    bundleURL = URL(fileURLWithPath: "/Applications/" + name + ".app")
  }
  // Another running app (the one holding focus when it isn't the front one).
  convenience init?(processIdentifier pid: pid_t) {
    guard let other = otherApp, other.processIdentifier == pid else { return nil }
    self.init(pid, other.bundleIdentifier ?? "", other.localizedName ?? "")
  }
}
var otherApp: NSRunningApplication? = nil
final class NSWorkspace { static let shared = NSWorkspace(); var frontmostApplication: NSRunningApplication? = nil }
typealias AXUIElement = Int
// Numbered labels (perform "element"): none in these keyboard cases.
var snapshots: [(id: String, elements: [AXUIElement])] = []
func frameOf(_ element: AXUIElement) -> CGRect? { nil }
let kAXFocusedWindowAttribute = "window", kAXFocusedUIElementAttribute = "focus", kAXTitleAttribute = "title"
var focusedPid: pid_t? = 42, observedPid: pid_t = 42
var pidLookupSucceeded = true
enum AXStatus { case success, failure }
func AXUIElementGetPid(_ element: AXUIElement, _ pid: inout pid_t) -> AXStatus { pid = focusedPid ?? 0; return pidLookupSucceeded ? .success : .failure }
var focusedTitle = "Interaction Lab", focusedURL = "", focusedSecure = false
var appWindowTitle = "Interaction Lab"
func AXUIElementCreateSystemWide() -> AXUIElement { -1 }
func AXUIElementCreateApplication(_ pid: pid_t) -> AXUIElement { Int(pid) }
func elementAttr(_ element: AXUIElement, _ name: String) -> AXUIElement? {
  if name == kAXFocusedUIElementAttribute { return focusedPid == nil ? nil : 1001 }
  if name == kAXFocusedWindowAttribute { return 1002 }
  return nil
}
func string(_ element: AXUIElement, _ name: String) -> String { appWindowTitle }
func canonical(_ url: URL) -> String { url.path }
func pidOf(_ element: AXUIElement) -> pid_t { focusedPid ?? 0 }
func seen(_ element: AXUIElement) -> Seen {
  let front = NSWorkspace.shared.frontmostApplication!
  let app = observedPid != front.processIdentifier && otherApp?.processIdentifier == observedPid ? otherApp! : front
  return Seen(bundle: app.bundleIdentifier ?? "", name: app.localizedName ?? "", path: app.bundleURL!.path,
    title: focusedTitle, url: focusedURL, secure: focusedSecure, role: focusedSecure ? "AXSecureTextField" : "AXTextField", pid: observedPid)
}
func windowTitleReason(_ title: String, _ bundle: String, _ path: String, _ pid: pid_t, _ rules: Rules) -> String? { titleReason(title, bundle, rules) }
func hostsReach(_ app: NSRunningApplication, _ rules: Rules) -> Bool { false }
func front(_ rules: Rules) -> [String: Any] { [:] }
func checkPoint(_ point: CGPoint, _ rules: Rules, _ expected: [String:String]? = nil) throws -> Seen { fatalError("Keyboard fixtures must never use pointer input") }
typealias CGKeyCode = UInt16
struct CGEventFlags: OptionSet {
  let rawValue: Int
  static let maskCommand = Self(rawValue:1), maskShift = Self(rawValue:2), maskAlternate = Self(rawValue:4), maskControl = Self(rawValue:8)
}
enum CGEventType { case mouseMoved, leftMouseDown, leftMouseUp, rightMouseDown, rightMouseUp, leftMouseDragged }
enum CGMouseButton { case left, right }
enum CGEventField { case mouseEventClickState }
enum CGScrollEventUnit { case pixel }
let source = 0
var events = 0
final class CGEvent {
  var flags: CGEventFlags = []
  init?(mouseEventSource: Int, mouseType: CGEventType, mouseCursorPosition: CGPoint, mouseButton: CGMouseButton) {}
  init?(keyboardEventSource: Int, virtualKey: CGKeyCode, keyDown: Bool) {}
  init?(scrollWheelEvent2Source: Int, units: CGScrollEventUnit, wheelCount: UInt32, wheel1: Int32, wheel2: Int32, wheel3: Int32) {}
  func setIntegerValueField(_ field: CGEventField, value: Int64) {}
  func keyboardSetUnicodeString(stringLength: Int, unicodeString: [UInt16]) {}
}
func post(_ event: CGEvent?, pause: UInt32 = 0) { if event != nil { events += 1 } }
`;
    const harness = String.raw`
var failures = [String]()
func reset() {
  NSWorkspace.shared.frontmostApplication = NSRunningApplication(42)
  otherApp = NSRunningApplication(99)
  focusedPid = 42; observedPid = 42; pidLookupSucceeded = true; focusedTitle = "Interaction Lab"; focusedURL = ""; focusedSecure = false; appWindowTitle = "Interaction Lab"; events = 0
}
func expect(_ label: String, _ action: [String:Any], _ status: String, _ rules: Rules = full) {
  do {
    let result = try perform(action, CGRect(x:0,y:0,width:100,height:100), rules)
    if status != "allowed" || events == 0 || result["ok"] as? Bool != true { failures.append(label + ": unexpectedly allowed, events=" + String(events)) }
  } catch let refusal as Refusal {
    if refusal.kind != status || events != 0 { failures.append(label + ": " + refusal.kind + ", events=" + String(events)) }
  } catch { failures.append(label + ": unexpected error") }
}
let typing: [String:Any] = ["type":"type", "text":"Zoë"]
let key: [String:Any] = ["type":"key", "key":"a"]
var apps = full; apps.mode = "apps"; apps.allowedApps = [["id":"/Applications/Safari.app","bundleId":"com.apple.Safari"]]
// Full control is light: a focus Accessibility can't confirm goes to the app
// in front (still checked). The Apps preset keeps refusing it.
func unverified(_ label: String, _ action: [String:Any], _ setup: () -> Void) {
  reset(); setup(); expect(label + " (Full)", action, "allowed")
  reset(); setup(); expect(label + " (Apps)", action, "retry", apps)
}
for action in [typing,key] {
  let name = action["type"] as! String
  unverified(name + " mismatched PID", action) { focusedPid = 99; observedPid = 99 }
  unverified(name + " no AX focus", action) { focusedPid = nil }
  unverified(name + " unavailable AX PID", action) { focusedPid = 0; observedPid = 0 }
  reset(); NSWorkspace.shared.frontmostApplication = NSRunningApplication(0); focusedPid = 0; observedPid = 0
  expect(name + " unavailable app PID", action, "retry")
  unverified(name + " AX PID lookup failed with stale value", action) { pidLookupSucceeded = false }
  // A focus that changed while it was checked is looked at again, everywhere.
  reset(); observedPid = 0; expect(name + " failed PID lookup during inspection", action, "retry")
  reset(); observedPid = 99; expect(name + " PID changed during inspection", action, "retry")
  // Keys go where focus is, even when that app isn't in front: it is judged.
  reset(); focusedPid = 99; observedPid = 99; otherApp = NSRunningApplication(99, "com.1password.1password", "1Password")
  expect(name + " focus in a protected app that isn't in front (Full)", action, "blocked")
  reset(); focusedPid = 99; observedPid = 99; focusedSecure = true
  expect(name + " a password field in an app that isn't in front (Full)", action, "blocked")
  reset(); focusedPid = 99; observedPid = 99; focusedTitle = "Reach"
  expect(name + " Reach holding focus without being in front (Full)", action, "blocked")
  reset(); focusedTitle = "Reach"
  expect(name + " same-PID protected title", action, "blocked")
  reset(); focusedURL = "http://localhost:8443/"
  expect(name + " same-PID protected URL", action, "blocked")
  reset(); NSWorkspace.shared.frontmostApplication = NSRunningApplication(42,"com.apple.Passwords","Passwords")
  expect(name + " protected app", action, "blocked")
  reset(); focusedSecure = true
  expect(name + " secure field", action, "blocked")
  reset(); expect(name + " ordinary focus", action, "allowed")
}
reset(); focusedSecure = true
expect("secure navigation remains allowed", ["type":"key","key":"tab"], "allowed")
reset(); NSWorkspace.shared.frontmostApplication = NSRunningApplication(42,"com.apple.Terminal","Terminal")
expect("terminal transition keeps prior command guard", typing, "retry")
reset(); NSWorkspace.shared.frontmostApplication = NSRunningApplication(42,"com.apple.Terminal","Terminal")
expect("checked terminal text remains allowed", ["type":"type","text":"pwd","terminalLikeChecked":true], "allowed")
reset()
expect("selected app ordinary focus", key, "allowed", apps)
reset(); NSWorkspace.shared.frontmostApplication = NSRunningApplication(42,"com.apple.Notes","Notes")
expect("selected app policy still enforced", key, "blocked", apps)
if !failures.isEmpty { print(failures.joined(separator:"\n")); exit(1) }
print("OK focus and keyboard dispatch cases")
`;
    const program = "import Foundation\nimport CoreGraphics\nimport Darwin\nstruct Refusal: Error { let message:String; let kind:String }\nfunc refuse(_ message:String, _ kind:String = \"blocked\") throws -> Never { throw Refusal(message:message,kind:kind) }\n"
      + policy + "\n" + text + "\n" + seen + "\n" + stubs
      + extract("func check(_ s:", "// The window server")
      + extract("struct Focus ", "// No longer called: guessing the owner")
      + extract("let keyCodes:", "let source = CGEventSource")
      + extract("func flags(", "@available(macOS 14.0, *)\nfunc shot(")
      + config + harness;
    assert.doesNotMatch(program, /import (?:AppKit|ApplicationServices)|cghidEventTap/);
    await fs.writeFile(path.join(directory, "focus.swift"), program);
    const compiled = spawnSync("xcrun", ["swiftc", "-module-cache-path", path.join(directory, "modules"), "focus.swift", "-o", "focus"], { cwd: directory, encoding: "utf8", timeout: 180000 });
    assert.equal(compiled.status, 0, compiled.stderr);
    const run = spawnSync(path.join(directory, "focus"), [], { encoding: "utf8", timeout: 30000 });
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
    assert.equal(run.stdout.trim(), "OK focus and keyboard dispatch cases");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
