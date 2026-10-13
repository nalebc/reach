import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { inputAction } from "../server/desktop-protocol.mjs";

test("finger tolerance travels only with left clicks and is bounded", () => {
  const click = { type: "click", x: 0.25, y: 0.5, touch: { x: 0.02, y: 0.04, owner: true } };
  assert.deepEqual(inputAction(click), {
    type: "click", x: 0.25, y: 0.5, button: "left", count: 1, touch: { x: 0.02, y: 0.04 },
  });
  for (const touch of [null, {}, { x: 0, y: 0.01 }, { x: -1, y: 0.01 },
    { x: 0.101, y: 0.01 }, { x: 0.01, y: NaN }, { x: Infinity, y: 0.01 }])
    assert.throws(() => inputAction({ ...click, touch }), /touch tolerance/);
  for (const type of ["move", "down", "up"])
    assert.throws(() => inputAction({ ...click, type }), /touch tolerance/);
  assert.throws(() => inputAction({ ...click, button: "right" }), /touch tolerance/);
  assert.equal(inputAction({ type: "click", x: 0, y: 1 }).touch, undefined);
});

// Execute native targeting and the full click path with inert AX fixtures.
// Every emitted Quartz event is intercepted; no app or screen is read and
// no mouse event is posted to the desktop.
test("native finger targeting and click events preserve exact coordinates and recover only clear near misses", {
  skip: process.platform !== "darwin",
}, async (t) => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), "reach-touch-geometry-"));
  t.after(() => fs.rm(folder, { recursive: true, force: true }));
  const source = await fs.readFile(new URL("../scripts/native/desktop-input.swift", import.meta.url), "utf8");
  const geometry = source.split("// BEGIN TOUCH GEOMETRY")[1].split("// END TOUCH GEOMETRY")[0];
  const mouse = source.split("// BEGIN DESKTOP MOUSE")[1].split("// END DESKTOP MOUSE")[0];
  const inputSource = "final class Input:" + source.split("final class Input:")[1].split("@main struct DesktopInput")[0];
  // Substitute just the local cursor read, so the real Input.action runs
  // without observing the user's mouse. Mouse emission is injected below.
  assert.match(inputSource, /CGEvent\(source: nil\)\?\.location/);
  const input = inputSource.replaceAll("CGEvent(source: nil)?.location", "Optional(fixtureCursor)");
  const file = path.join(folder, "main.swift"), binary = path.join(folder, "geometry");
  const resolver = "func touchPoint" + source.split("func touchPoint")[1].split("  func windowOf")[0];
  await fs.writeFile(file, `import AppKit\nimport ApplicationServices\n${geometry}\n` + String.raw`
func control(_ x: Double, _ y: Double, _ w: Double = 20, _ h: Double = 20, _ enabled: Bool = true) -> TouchCandidate {
  TouchCandidate(frame: CGRect(x: x, y: y, width: w, height: h), enabled: enabled)
}
let at = CGPoint(x: 100, y: 100), radius = CGSize(width: 10, height: 10)
let recovered = touchChoice(at, radius, [control(104, 90)])!
precondition(recovered.0 == 0 && recovered.1 == CGPoint(x: 106, y: 100))
precondition(touchChoice(at, radius, [control(90, 90)]) == nil, "exact hits stay exact")
precondition(touchChoice(at, radius, [control(90, 90, 20, 20, false), control(104, 90)]) == nil)
precondition(touchChoice(at, radius, [control(104, 90), control(76, 90)]) == nil, "equidistant controls")
precondition(touchChoice(at, radius, [control(104, 90), control(75, 90)]) == nil, "nearly equal controls")
precondition(touchChoice(at, radius, [control(103, 90), control(72, 90)])?.0 == 0, "clear nearest control")
precondition(touchChoice(at, radius, [control(103, 90, 20, 20, false), control(72, 90)]) == nil)
precondition(touchChoice(at, radius, [control(111, 90)]) == nil, "beyond tolerance")
precondition(touchChoice(at, radius, [control(108, 108)]) == nil, "ellipse excludes far diagonal")
precondition(touchChoice(at, CGSize(width: 5, height: 5), [control(106, 90)]) == nil, "zoom shrinks tolerance")
precondition(touchChoice(at, CGSize(width: 0, height: 10), [control(104, 90)]) == nil)
precondition(touchChoice(at, radius, [control(104, 90, 0, 20)]) == nil)
// Multi-display origins and Retina never change the ranking.
let translated = touchChoice(CGPoint(x: -1340, y: 100), radius, [control(-1336, 90)])!
precondition(translated.1 == CGPoint(x: -1334, y: 100))
print("touch geometry passed")
// AX objects here refer to nonexistent processes. All AX reads and display
// queries are intercepted below; only CoreFoundation identities are used.
var objects: [AXUIElement] = []
var attributes: [[String: AnyObject]] = []
var displayBounds = CGRect(x: 0, y: 0, width: 1000, height: 500)
var fixtureCursor = CGPoint(x: 800, y: 400)
var root: AXUIElement!, button: AXUIElement!, overlay: AXUIElement!
var cover = false, incomplete = false, slow = false
func node(_ role: String, _ frame: CGRect, _ enabled: Bool = true) -> AXUIElement {
  let element = AXUIElementCreateApplication(pid_t(700000 + objects.count))
  var origin = frame.origin, size = frame.size
  objects.append(element)
  attributes.append([
    kAXRoleAttribute: role as NSString,
    kAXPositionAttribute: AXValueCreate(.cgPoint, &origin)!,
    kAXSizeAttribute: AXValueCreate(.cgSize, &size)!,
    kAXEnabledAttribute: NSNumber(value: enabled),
    kAXChildrenAttribute: [] as NSArray,
  ])
  return element
}
func number(_ element: AXUIElement) -> Int { objects.firstIndex { CFEqual($0, element) }! }
func CGDisplayBounds(_ display: CGDirectDisplayID) -> CGRect { displayBounds }
func CGDisplayIsActive(_ display: CGDirectDisplayID) -> Int32 { 1 }
func AXIsProcessTrusted() -> Bool { true }
func AXUIElementCreateSystemWide() -> AXUIElement { root }
@discardableResult func AXUIElementSetMessagingTimeout(_ element: AXUIElement, _ seconds: Float) -> AXError { .success }
func AXUIElementCopyAttributeValue(_ element: AXUIElement, _ name: CFString, _ out: inout CFTypeRef?) -> AXError {
  out = attributes[number(element)][name as String]
  return out == nil ? .noValue : .success
}
func AXUIElementCopyMultipleAttributeValues(_ element: AXUIElement, _ names: CFArray,
  _ options: AXCopyMultipleAttributeOptions, _ out: inout CFArray?) -> AXError {
  if slow { usleep(130000) }
  if incomplete { return .cannotComplete }
  let values = attributes[number(element)]
  out = (names as! [String]).map { values[$0] ?? NSNull() } as CFArray
  return .success
}
func AXUIElementCopyElementAtPosition(_ system: AXUIElement, _ x: Float, _ y: Float, _ out: inout AXUIElement?) -> AXError {
  if x >= 104 && x <= 124 && y >= 90 && y <= 110 { out = cover ? overlay : button }
  else { out = root }
  return .success
}
root = node("AXWindow", displayBounds)
button = node("AXButton", CGRect(x: 104, y: 90, width: 20, height: 20))
overlay = node("AXGroup", displayBounds)
attributes[number(root)][kAXChildrenAttribute] = [button!] as NSArray
attributes[number(button)][kAXWindowAttribute] = root
attributes[number(button)][kAXParentAttribute] = root
` + `${mouse}\n${input}\nfinal class TouchFixture { let display: CGDirectDisplayID = 1\n${resolver}\n}\n` + String.raw`
let fixture = TouchFixture(), tolerance: [String: Any] = ["x": 10.0 / 999, "y": 10.0 / 499]
precondition(fixture.touchPoint(at, tolerance) == CGPoint(x: 106, y: 100), "live tree recovers a nearby button")
precondition(fixture.touchPoint(CGPoint(x: 110, y: 100), tolerance) == CGPoint(x: 110, y: 100), "direct hit preserved")
cover = true
precondition(fixture.touchPoint(at, tolerance) == at, "covered button is not a target")
cover = false; incomplete = true
precondition(fixture.touchPoint(at, tolerance) == at, "incomplete scan falls back to exact tap")
incomplete = false; slow = true
precondition(fixture.touchPoint(at, tolerance) == at, "scan timeout falls back to exact tap")
slow = false
attributes[number(button)][kAXEnabledAttribute] = NSNumber(value: false)
precondition(fixture.touchPoint(at, tolerance) == at, "disabled button cannot attract a miss")
print("live target fixtures passed")
// Exercise the production normalized click -> targeting -> native down/up
// path, including the pointer positioning recently added for Mac dragging.
attributes[number(button)][kAXEnabledAttribute] = NSNumber(value: true)
var events: [CGEvent] = []
let input = Input(1)
input.mouse = DesktopMouse(source: input.source, point: fixtureCursor, emit: { events.append($0) })
func field(_ event: CGEvent, _ key: CGEventField) -> Int64 { event.getIntegerValueField(key) }
func click(_ point: CGPoint, touch: Bool = false, button: String = "left", count: Int = 1) -> [String: Any] {
  events = []
  var action: [String: Any] = ["type": "click", "x": Double(point.x), "y": Double(point.y), "button": button, "count": count]
  if touch { action["touch"] = tolerance }
  return try! input.action(action)
}
func checkClick(_ result: [String: Any], _ expected: CGPoint, right: Bool = false, count: Int = 1) {
  let clicks = events.filter { $0.type != .mouseMoved }
  let pair: [CGEventType] = right ? [.rightMouseDown, .rightMouseUp] : [.leftMouseDown, .leftMouseUp]
  precondition(clicks.map { $0.type } == (1...count).flatMap { _ in pair })
  precondition(events.first!.type == .mouseMoved && events.first!.location == expected)
  precondition(events.allSatisfy { $0.location == expected }, "the pre-move cannot shift a click")
  for (index, event) in clicks.enumerated() {
    precondition(field(event, .mouseEventClickState) == Int64(index / 2 + 1))
    precondition(field(event, .mouseEventButtonNumber) == (right ? 1 : 0))
    precondition(field(event, .mouseEventDeltaX) == 0 && field(event, .mouseEventDeltaY) == 0)
    precondition(field(event, .mouseEventNumber) == field(clicks[index / 2 * 2], .mouseEventNumber))
  }
  let encoded = try! JSONSerialization.data(withJSONObject: result)
  let decoded = try! JSONSerialization.jsonObject(with: encoded) as! [String: Any]
  let acknowledged = decoded["point"] as! [String: Double]
  precondition(abs(acknowledged["x"]! - (expected.x - displayBounds.minX) / (displayBounds.width - 1)) < 1e-10)
  precondition(abs(acknowledged["y"]! - (expected.y - displayBounds.minY) / (displayBounds.height - 1)) < 1e-10)
  precondition(input.mouse.held == nil, "a tap leaves no held button")
}
let miss = CGPoint(x: 100.0 / 999, y: 100.0 / 499)
checkClick(click(miss, touch: true), CGPoint(x: 106, y: 100))
checkClick(click(miss, touch: true, count: 2), CGPoint(x: 106, y: 100), count: 2)
checkClick(click(CGPoint(x: 110.0 / 999, y: 100.0 / 499), touch: true), CGPoint(x: 110, y: 100))
checkClick(click(miss), at) // Assistance off stays exact.
checkClick(click(miss, button: "right"), at, right: true)
cover = true
checkClick(click(miss, touch: true), at)
cover = false; incomplete = true
checkClick(click(miss, touch: true), at)
incomplete = false
attributes[number(button)][kAXEnabledAttribute] = NSNumber(value: false)
checkClick(click(miss, touch: true), at)
// A click after a drag gets its own point and a fresh press count.
_ = try! input.action(["type": "down", "x": 0.3, "y": 0.4])
_ = try! input.action(["type": "move", "x": 0.6, "y": 0.2])
_ = try! input.action(["type": "up", "x": 0.6, "y": 0.2])
checkClick(click(miss), at)
// Frame pixel density does not enter this calculation: Quartz receives
// display points, including exact corners and fractional coordinates.
displayBounds = CGRect(x: -1440, y: 120, width: 1440, height: 900)
for (point, expected) in [
  (CGPoint(x: 0, y: 0), CGPoint(x: -1440, y: 120)),
  (CGPoint(x: 1, y: 1), CGPoint(x: -1, y: 1019)),
  (CGPoint(x: 0.5, y: 0.5), CGPoint(x: -720.5, y: 569.5)),
  (CGPoint(x: 0.25, y: 0.25), CGPoint(x: -1080.25, y: 344.75)),
] { checkClick(click(point), expected) }
print("native click coordinates passed")
`);
  const built = spawnSync("xcrun", ["swiftc", "-module-cache-path", path.join(folder, "cache"), file, "-o", binary], { encoding: "utf8", timeout: 45000 });
  assert.equal(built.status, 0, built.stderr);
  const checked = spawnSync(binary, [], { encoding: "utf8", timeout: 5000 });
  assert.equal(checked.status, 0, checked.stderr);
  assert.match(checked.stdout, /touch geometry passed/);
  assert.match(checked.stdout, /live target fixtures passed/);
  assert.match(checked.stdout, /native click coordinates passed/);
});
