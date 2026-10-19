import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

// Construct real Quartz events and intercept every emission. No event is
// posted, no window is touched, and no screen or app is read by this test.
test("Mac drag events position before pressing, carry movement deltas and pair the press with its release", {
  skip: process.platform !== "darwin",
}, async (t) => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), "reach-mouse-sequence-"));
  t.after(() => fs.rm(folder, { recursive: true, force: true }));
  const source = await fs.readFile(new URL("../scripts/native/desktop-input.swift", import.meta.url), "utf8");
  const mouse = source.split("// BEGIN DESKTOP MOUSE")[1].split("// END DESKTOP MOUSE")[0];
  const file = path.join(folder, "main.swift"), binary = path.join(folder, "mouse");
  await fs.writeFile(file, "import CoreGraphics\nimport Foundation\n" + mouse + String.raw`
var events: [CGEvent] = []
let source = CGEventSource(stateID: .hidSystemState)
var times: [UInt64] = []
let mouse = DesktopMouse(source: source, point: CGPoint(x: 800, y: 700), emit: {
  events.append($0)
  times.append(DispatchTime.now().uptimeNanoseconds)
})
func field(_ e: CGEvent, _ key: CGEventField) -> Int64 { e.getIntegerValueField(key) }
mouse.down(at: CGPoint(x: 150, y: 200), button: .left)
precondition(events.map { $0.type } == [.mouseMoved, .leftMouseDown])
precondition(events[0].location == CGPoint(x: 150, y: 200))
precondition(field(events[0], .mouseEventDeltaX) == -650 && field(events[0], .mouseEventDeltaY) == -500)
precondition(mouse.held == .left)
mouse.move(to: CGPoint(x: 320, y: 40))
precondition(events.last!.type == .leftMouseDragged)
precondition(field(events.last!, .mouseEventDeltaX) == 170 && field(events.last!, .mouseEventDeltaY) == -160)
// A drop contains a final motion even if the phone had no last move sample.
mouse.up(at: CGPoint(x: 360, y: 10))
precondition(events.map { $0.type } == [.mouseMoved, .leftMouseDown, .leftMouseDragged, .leftMouseDragged, .leftMouseUp])
precondition(field(events[3], .mouseEventDeltaX) == 40 && field(events[3], .mouseEventDeltaY) == -30)
let number = field(events[1], .mouseEventNumber)
precondition(number > 0)
for event in events.dropFirst() {
  precondition(field(event, .mouseEventNumber) == number, "one press through drag and drop")
  precondition(field(event, .mouseEventClickState) == 1)
  precondition(field(event, .mouseEventButtonNumber) == 0)
}
precondition(events.last!.location == CGPoint(x: 360, y: 10))
precondition(mouse.held == nil)
let completed = events.count
mouse.release()
precondition(events.count == completed, "no extra release after a complete drag")
// Right drags and cancellation pair the same button and press identity.
events = []
mouse.down(at: CGPoint(x: 200, y: 180), button: .right)
mouse.move(to: CGPoint(x: 190, y: 160))
mouse.release()
precondition(events.map { $0.type } == [.mouseMoved, .rightMouseDown, .rightMouseDragged, .rightMouseUp])
precondition(field(events[2], .mouseEventDeltaX) == -10 && field(events[2], .mouseEventDeltaY) == -20)
for event in events.dropFirst() { precondition(field(event, .mouseEventButtonNumber) == 1) }
precondition(field(events[1], .mouseEventNumber) == field(events[3], .mouseEventNumber))
precondition(events.last!.location == CGPoint(x: 190, y: 160))
precondition(mouse.held == nil)
// Two clicks have separate press numbers but the correct click counts.
events = []
for count in 1...2 {
  mouse.down(at: CGPoint(x: 100, y: 100), button: .left, count: count)
  mouse.up(at: CGPoint(x: 100, y: 100))
}
let clicks = events.filter { $0.type != .mouseMoved }
precondition(clicks.map { field($0, .mouseEventClickState) } == [1, 1, 2, 2])
precondition(field(clicks[0], .mouseEventNumber) != field(clicks[2], .mouseEventNumber))
// A rapid pair preserves each actual point instead of snapping to the first.
events = []
let first = mouse.click(at: CGPoint(x: 101, y: 104), button: .left, id: 7)
let second = mouse.click(at: CGPoint(x: 103, y: 105), button: .left, id: 7, state: 2)
let pair = events.filter { $0.type != .mouseMoved }
precondition(pair.map { field($0, .mouseEventClickState) } == [1, 1, 2, 2], "exactly two physical clicks")
precondition(pair.prefix(2).allSatisfy { $0.location == CGPoint(x: 101, y: 104) })
precondition(pair.suffix(2).allSatisfy { $0.location == CGPoint(x: 103, y: 105) })
precondition(first.1 == 1 && second.1 == 2 && second.0 == CGPoint(x: 103, y: 105))
// An unrelated or already completed pair is a single click, never a replay.
events = []
let third = mouse.click(at: CGPoint(x: 180, y: 190), button: .left, id: 7, state: 2)
precondition(third.1 == 1 && third.0 == CGPoint(x: 180, y: 190))
precondition(events.filter { $0.type == .leftMouseDown }.count == 1)
_ = mouse.click(at: CGPoint(x: 100, y: 100), button: .left, id: 70)
let neighbor = mouse.click(at: CGPoint(x: 112, y: 100), button: .left, id: 70, state: 2)
precondition(neighbor.1 == 1 && neighbor.0 == CGPoint(x: 112, y: 100), "different host points stay independent")
_ = mouse.click(at: CGPoint(x: 30, y: 40), button: .left, id: 8)
mouse.forgetClick()
precondition(mouse.click(at: CGPoint(x: 50, y: 60), button: .left, id: 8, state: 2).1 == 1)
// With the phone's pair radius, the host compares where both taps asked
// for (touch assist moved the first from 100,100 to 110,100) and lands the
// second exactly where the first landed, never where the finger drifted.
let radius = CGSize(width: 8, height: 8)
events = []
_ = mouse.click(at: CGPoint(x: 110, y: 100), button: .left, id: 9, asked: CGPoint(x: 100, y: 100))
let drifted = mouse.click(at: CGPoint(x: 105, y: 106), button: .left, id: 9, state: 2,
  asked: CGPoint(x: 105, y: 106), pair: radius)
precondition(drifted == (CGPoint(x: 110, y: 100), 2), "a drifting second tap continues its pair")
let doubled = events.filter { $0.type != .mouseMoved }
precondition(doubled.map { field($0, .mouseEventClickState) } == [1, 1, 2, 2], "exactly two physical clicks")
precondition(events.allSatisfy { $0.location == CGPoint(x: 110, y: 100) }, "no motion toward the drift")
// The same drift without the radius keeps the old rule: compared with the
// first's landed point, 5 points away, it is a click of its own.
_ = mouse.click(at: CGPoint(x: 110, y: 100), button: .left, id: 15, asked: CGPoint(x: 100, y: 100))
precondition(mouse.click(at: CGPoint(x: 105, y: 106), button: .left, id: 15, state: 2) == (CGPoint(x: 105, y: 106), 1))
// Beyond the radius on either axis, another click id, or a forgotten first
// tap: a click of its own at its own point.
for (second, id) in [(CGPoint(x: 309, y: 300), 10), (CGPoint(x: 302, y: 309), 11)] {
  _ = mouse.click(at: CGPoint(x: 300, y: 300), button: .left, id: id)
  precondition(mouse.click(at: second, button: .left, id: id, state: 2, pair: radius) == (second, 1))
}
_ = mouse.click(at: CGPoint(x: 300, y: 300), button: .left, id: 12)
precondition(mouse.click(at: CGPoint(x: 301, y: 300), button: .left, id: 13, state: 2, pair: radius).1 == 1)
_ = mouse.click(at: CGPoint(x: 300, y: 300), button: .left, id: 16)
mouse.forgetClick()
precondition(mouse.click(at: CGPoint(x: 301, y: 300), button: .left, id: 16, state: 2, pair: radius).1 == 1)
// A radius under 4 points still pairs within 4, as without one.
_ = mouse.click(at: CGPoint(x: 300, y: 300), button: .left, id: 14)
precondition(mouse.click(at: CGPoint(x: 304, y: 296), button: .left, id: 14, state: 2,
  pair: CGSize(width: 1, height: 1)) == (CGPoint(x: 300, y: 300), 2))
// A first tap only starts a pair: a state 1 click with a radius is a click.
precondition(mouse.click(at: CGPoint(x: 301, y: 300), button: .left, id: 14, pair: radius) == (CGPoint(x: 301, y: 300), 1))
// Each press of a click is held a few milliseconds before its release,
// never as long as a slow tap.
precondition(DesktopMouse.pressHold >= 1_000 && DesktopMouse.pressHold <= 20_000)
for count in [1, 2] {
  events = []; times = []
  _ = mouse.click(at: CGPoint(x: 40, y: 50), button: .left, count: count)
  let downs = events.indices.filter { events[$0].type == .leftMouseDown }
  let ups = events.indices.filter { events[$0].type == .leftMouseUp }
  precondition(downs.count == count && ups.count == count)
  for (down, up) in zip(downs, ups) {
    precondition(times[up] - times[down] >= UInt64(DesktopMouse.pressHold) * 1000, "held \(times[up] - times[down]) ns")
  }
}
// A second press releases the first one where it was actually held.
events = []
mouse.down(at: CGPoint(x: 5, y: 10), button: .left)
mouse.down(at: CGPoint(x: 80, y: 90), button: .left)
precondition(events.map { $0.type } == [.mouseMoved, .leftMouseDown, .leftMouseUp, .mouseMoved, .leftMouseDown])
precondition(events[2].location == CGPoint(x: 5, y: 10))
mouse.release()
print("native mouse sequences passed")
`);
  const built = spawnSync("xcrun", ["swiftc", "-module-cache-path", path.join(folder, "cache"), file, "-o", binary], { encoding: "utf8", timeout: 45000 });
  assert.equal(built.status, 0, built.stderr);
  const checked = spawnSync(binary, [], { encoding: "utf8", timeout: 10000 });
  assert.equal(checked.status, 0, checked.stderr || checked.error?.message);
  assert.match(checked.stdout, /native mouse sequences passed/);
});
