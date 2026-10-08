import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

test("Mac mouse fallback only posts to the unchanged, enabled, unobscured dialog button", {
  skip: process.platform !== "darwin", timeout: 120000,
}, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "reach-mac-button-"));
  try {
    const source = await fs.readFile(new URL("../scripts/native/mac-answer.swift", import.meta.url), "utf8");
    const click = source.slice(source.indexOf("func clickButton("), source.indexOf("// Where the keyboard is,"));
    const stub = `
import Foundation
import CoreGraphics
typealias CGWindowID = UInt32
class AXUIElement {}
class AXValue { var point = CGPoint(x: 10, y: 10); var size = CGSize(width: 20, height: 20) }
let kAXEnabledAttribute = "enabled", kAXPositionAttribute = "position", kAXSizeAttribute = "size"
struct Dialog { let owner: String; let pid: Int; let frame: CGRect }
let original = Dialog(owner: "UserNotificationCenter", pid: 123, frame: CGRect(x: 0, y: 0, width: 100, height: 100))
var current: Dialog? = original
let button = AXUIElement(), other = AXUIElement(), position = AXValue(), size = AXValue()
var fresh: AXUIElement? = button, hitTarget: AXUIElement? = button, enabled = true
var context = ["Allow access to Documents?"]
func dialog(_ id: CGWindowID) -> Dialog? { current }
func buttons(of d: Dialog) -> [String: AXUIElement] { fresh.map { ["Allow": $0] } ?? [:] }
func buttonContext(_ e: AXUIElement) -> [String]? { context }
func CFEqual(_ a: AXUIElement, _ b: AXUIElement) -> Bool { a === b }
func CFGetTypeID(_ value: AnyObject) -> Int { value is AXValue ? 1 : 0 }
func AXValueGetTypeID() -> Int { 1 }
func attr(_ e: AXUIElement, _ key: String) -> AnyObject? {
  if key == "enabled" { return NSNumber(value: enabled) }
  return key == "position" ? position : size
}
enum ValueKind { case cgPoint, cgSize }
func AXValueGetValue(_ v: AXValue, _ kind: ValueKind, _ p: inout CGPoint) -> Bool { p = v.point; return true }
func AXValueGetValue(_ v: AXValue, _ kind: ValueKind, _ s: inout CGSize) -> Bool { s = v.size; return true }
enum Result { case success }
func AXUIElementCreateSystemWide() -> AXUIElement { other }
func AXUIElementCopyElementAtPosition(_ root: AXUIElement, _ x: Float, _ y: Float, _ hit: inout AXUIElement?) -> Result { hit = hitTarget; return .success }
enum State { case hidSystemState }
class CGEventSource { init?(stateID: State) {} }
enum MouseType { case leftMouseDown, leftMouseUp }
enum MouseButton { case left }
enum Tap { case cghidEventTap }
class CGEvent {
  static var posts = 0
  var flags: [Int] = []
  init?(mouseEventSource: CGEventSource, mouseType: MouseType, mouseCursorPosition: CGPoint, mouseButton: MouseButton) {}
  func post(tap: Tap) { CGEvent.posts += 1 }
}
func check(_ ok: Bool, _ why: String) { if !ok { fatalError(why) } }
`;
    const cases = `
func attempt() -> Bool { clickButton(button, title: "Allow", context: ["Allow access to Documents?"], dialog: original, id: 1) }
current = nil
check(!attempt(), "gone")
current = Dialog(owner: "UserNotificationCenter", pid: 456, frame: original.frame)
check(!attempt(), "reused window owned by another process")
current = original
fresh = other
check(!attempt(), "replaced button")
fresh = button
context = ["Allow access to Photos?"]
check(!attempt(), "next prompt in reused window")
context = ["Allow access to Documents?"]
enabled = false
check(!attempt(), "disabled")
enabled = true
hitTarget = other
check(!attempt(), "covered by another element")
hitTarget = button
position.point = CGPoint(x: 200, y: 200)
check(!attempt(), "button outside dialog")
position.point = CGPoint(x: 10, y: 10)
check(CGEvent.posts == 0, "refusals never click")
check(attempt(), "verified button")
check(CGEvent.posts == 2, "exactly one mouse down/up pair")
print("guards passed")
`;
    const main = path.join(dir, "main.swift"), binary = path.join(dir, "check");
    await fs.writeFile(main, stub + click + cases);
    execFileSync("/usr/bin/xcrun", ["swiftc", "-module-cache-path", path.join(dir, "cache"), main, "-o", binary], { timeout: 90000, stdio: "pipe" });
    assert.match(execFileSync(binary, { encoding: "utf8" }), /guards passed/);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
