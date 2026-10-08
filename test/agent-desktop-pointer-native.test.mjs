import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { nativeRules } from "../server/agent-guard.mjs";

const sourceUrl = new URL("../scripts/native/agent-desktop.swift", import.meta.url);

test("pointer actions use the checked target and clicks report that identity", async () => {
  const source = await fs.readFile(sourceUrl, "utf8");
  const click = source.split('case "click":')[1]?.split('case "drag":')[0];
  assert.ok(click);
  assert.match(click, /let target = try checkPoint\(p, rules, expected\)/);
  assert.match(click, /"app": target\.name, "bundle": target\.bundle/);
  assert.doesNotMatch(click, /windowAt\(/, "a compositor queried after dispatch is not the checked app");
  const actions = source.split('case "drag":')[1]?.split('case "scroll":')[0];
  assert.match(actions, /try checkPoint\(from, rules, expected\)[\s\S]*try checkPoint\(to, rules, expected\)/, "drag checks both endpoints");
});

// Compile the actual window/point policy with inert CG and AX fixtures. This
// never reads a screen, queries a real app, or posts native input events.
test("native pointer targets fail closed when only a compositor or no app is identified", {
  skip: process.platform !== "darwin" || process.env.REACH_TEST_APP_NATIVE !== "1",
}, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "reach-pointer-policy-"));
  try {
    const source = await fs.readFile(sourceUrl, "utf8");
    const extract = (start, end) => {
      const after = source.split(start)[1];
      assert.ok(after, start);
      assert.ok(after.includes(end), end);
      return after.split(end)[0];
    };
    const policy = extract("// BEGIN PURE DESKTOP POLICY", "// END PURE DESKTOP POLICY").split("\n").slice(1).join("\n");
    const seen = source.split("\n").find((line) => line.startsWith("struct Seen "));
    const surfaces = source.split("\n").find((line) => line.startsWith("let systemSurfaces ="));
    assert.ok(seen && surfaces);
    const full = nativeRules({ preset: "full", hidden: [{ id: "/System/Applications/Messages.app", bundleId: "com.apple.MobileSMS", name: "Messages" }] }, { hosts: ["localhost:8443"], titles: ["reach"], protectedPaths: [], home: "/Users/me" });
    const swift = (value) => JSON.stringify(value).replace(/\\u([0-9a-f]{4})/gi, "\\u{$1}");
    const list = (values) => `[${values.map(swift).join(",")}]`;
    const rules = `
var full = Rules()
full.mode = "full"
full.hosts = ${list(full.hosts)}
full.titles = ${list(full.titles)}
full.hiddenApps = [["id": "/System/Applications/Messages.app", "bundleId": "com.apple.MobileSMS", "name": "Messages"]]
full.protectedAppIds = ${list(full.protectedAppIds)}
full.protectedAppNames = ${list(full.protectedAppNames)}
full.reachWords = ${list(full.reachWords)}
full.privatePanes = ${list(full.privatePanes)}
full.protectedTitleWords = ${list(full.protectedTitleWords)}
full.patterns = compile(${list(full.protectedPagePatterns)})
var apps = full
apps.mode = "apps"
apps.allowedApps = [["id": "/Applications/Safari.app", "bundleId": "com.apple.Safari"]]
`;
    const stubs = String.raw`
let kCGNullWindowID: UInt32 = 0
let kCGWindowBounds = "bounds", kCGWindowAlpha = "alpha", kCGWindowOwnerPID = "pid", kCGWindowOwnerName = "name", kCGWindowName = "title"
let kAXTitleAttribute = "title"
enum WindowOptions { case optionOnScreenOnly }
var windows = [[String: Any]]()
func CGWindowListCopyWindowInfo(_ options: [WindowOptions], _ id: UInt32) -> Any? { windows }
typealias AXUIElement = Int
func AXUIElementCreateSystemWide() -> AXUIElement { 0 }
enum AXStatus { case success, failure }
var ax: AXUIElement? = nil
var axURL = ""
var axTitle = "Interaction Lab"
var appHostsReach = false
func AXUIElementCopyElementAtPosition(_ sys: AXUIElement, _ x: Float, _ y: Float, _ result: inout AXUIElement?) -> AXStatus { result = ax; return ax == nil ? .failure : .success }
func appInfo(_ pid: pid_t) -> (String, String, String) {
  switch pid {
  case 2: return ("com.reach.app", "Reach", "/Applications/Reach.app")
  case 3: return ("com.apple.Safari", "Safari", "/Applications/Safari.app")
  case 4: return ("com.apple.MobileSMS", "Messages", "/System/Applications/Messages.app")
  case 5: return ("com.google.Chrome", "Chrome", "/Applications/Google Chrome.app")
  default: return ("", "Window Server", "")
  }
}
func seen(_ element: AXUIElement) -> Seen { let (bundle,name,path) = appInfo(pid_t(element)); return Seen(bundle:bundle,name:name,path:path,title:axTitle,url:axURL,pid:pid_t(element)) }
func string(_ element: AXUIElement, _ name: String) -> String { "" }
func pidOf(_ element: AXUIElement) -> pid_t { pid_t(element) }
final class NSRunningApplication { let processIdentifier: pid_t; let localizedName: String? = nil; init?(processIdentifier: pid_t) { self.processIdentifier = processIdentifier } }
final class NSWorkspace { static let shared = NSWorkspace(); let runningApplications = [NSRunningApplication]() }
func hostsReach(_ app: NSRunningApplication, _ rules: Rules) -> Bool { appHostsReach }
func windowTitleReason(_ title: String, _ bundle: String, _ path: String, _ pid: pid_t, _ rules: Rules) -> String? { titleReason(title,bundle,rules) }
`;
    const harness = String.raw`
func window(_ pid: pid_t, _ title: String = "") -> [String: Any] { [kCGWindowBounds: ["X":CGFloat(0),"Y":CGFloat(0),"Width":CGFloat(500),"Height":CGFloat(500)], kCGWindowAlpha:Double(1), kCGWindowOwnerPID:pid, kCGWindowName:title, kCGWindowOwnerName:appInfo(pid).1] }
func expect(_ label: String, _ entries: [[String:Any]], _ element: Int?, _ rules: Rules, _ status: String, _ app: String = "", _ expected: [String:String]? = nil) {
  windows = entries; ax = element
  do {
    let target = try checkPoint(CGPoint(x:100,y:100),rules,expected)
    if status != "allowed" || target.name != app { print("FAILED: " + label + " allowed " + target.name); exit(1) }
  } catch let error as Refusal {
    if error.kind != status { print("FAILED: " + label + " " + error.kind); exit(1) }
  } catch { print("FAILED: " + label + " unexpected error"); exit(1) }
}
expect("compositor with verified Safari AX", [window(1),window(3)], 3, full, "allowed", "Safari")
expect("protected CG remains authoritative", [window(2)], 3, full, "blocked")
expect("Reach title on CG remains protected", [window(3,"Reach")], 3, full, "blocked")
expect("protected AX behind compositor", [window(1),window(2)], 2, full, "blocked")
expect("hidden CG", [window(4)], 3, full, "blocked")
expect("hidden AX", [window(1)], 4, full, "blocked")
axURL = "http://localhost:8443/"
expect("protected AX URL", [window(1),window(3)], 3, full, "blocked")
axURL = ""
axTitle = ""
appHostsReach = true
expect("missing title still checks app Reach windows", [window(1),window(3)], 3, full, "blocked")
appHostsReach = false
axTitle = "Interaction Lab"
expect("compositor with failed AX", [window(1),window(2)], nil, full, "retry")
expect("compositor with unknown AX", [window(1),window(2)], 1, full, "retry")
expect("no target", [], nil, full, "retry")
expect("known checked CG fallback", [window(3)], nil, full, "allowed", "Safari")
expect("AX without CG", [], 3, full, "allowed", "Safari")
expect("selected app", [window(3)], 3, apps, "allowed", "Safari")
expect("selected apps retain unknown compositor refusal", [window(1),window(3)], 3, apps, "blocked")
let recorded = ["bundle":"com.apple.Safari", "title":"Interaction Lab"]
expect("recorded Full target through compositor", [window(1),window(3)], 3, full, "allowed", "Safari", recorded)
expect("recorded Apps retains compositor refusal", [window(1),window(3)], 3, apps, "blocked", "", recorded)
expect("recorded matching known CG target", [window(3,"Interaction Lab")], nil, full, "allowed", "Safari", recorded)
expect("recorded target missing all identity", [window(1)], nil, full, "retry", "", recorded)
expect("recorded changed CG app before correct AX", [window(5)], 3, full, "retry", "", recorded)
expect("recorded changed AX app through compositor", [window(1)], 5, full, "retry", "", recorded)
expect("recorded changed CG title", [window(3,"Different window")], 3, full, "retry", "", recorded)
axTitle = "Different window"
expect("recorded changed AX title", [window(1)], 3, full, "retry", "", recorded)
axTitle = "Interaction Lab"
expect("recorded protected CG never bypassed", [window(2)], 3, full, "blocked", "", recorded)
expect("recorded protected AX never bypassed", [window(1)], 2, full, "blocked", "", recorded)
if pointerIdentityKnown("com.apple.WindowServer", "Other", "/System/Library/WindowServer", 1) || pointerIdentityKnown("", "Window Server", "/System/Library/WindowServer", 1) || pointerIdentityKnown("com.apple.Safari", "Safari", "/Applications/Safari.app", 0) { print("FAILED: unknown identity"); exit(1) }
print("OK")
`;
    const program = "import Foundation\nimport CoreGraphics\nimport Darwin\nstruct Refusal: Error { let message: String; let kind: String }\nfunc refuse(_ message:String,_ kind:String = \"blocked\") throws -> Never { throw Refusal(message:message,kind:kind) }\n"
      + policy + "\n" + seen + "\n" + stubs
      + "\nfunc check(_ s:" + extract("func check(_ s:", "// The window server")
      + "\nfunc windowAt(" + extract("func windowAt(", "// The system")
      + "\n" + surfaces
      + "\nfunc checkPoint(" + extract("func checkPoint(", "// Any of this app")
      + "\n" + rules + harness;
    await fs.writeFile(path.join(directory, "pointer.swift"), program);
    const compiled = spawnSync("xcrun", ["swiftc", "pointer.swift", "-o", "pointer"], { cwd: directory, encoding: "utf8", timeout: 180000 });
    assert.equal(compiled.status, 0, compiled.stderr);
    const run = spawnSync(path.join(directory, "pointer"), [], { encoding: "utf8", timeout: 30000 });
    assert.equal(run.stdout.trim(), "OK", `${run.stdout}\n${run.stderr}`);
    assert.equal(run.status, 0);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
