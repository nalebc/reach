import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

// Stopping the agent's desktop helper (the owner takes over: SIGTERM ~300 ms
// after stop(), server/agent-desktop.mjs) between a button's down and up, as
// in a long drag or a fill batch, must not leave the button held for the
// owner. The helper tracks what it holds and lets go before exiting.
const desktopSource = () =>
  fs.readFile(new URL("../scripts/native/agent-desktop.swift", import.meta.url), "utf8");

test("the desktop helper lets go of held buttons and keys on SIGTERM, without the batch", async () => {
  const source = await desktopSource();
  const main = source.split("@main struct Main")[1];
  assert.match(main, /termination\.setEventHandler \{ letGo\(\); exit\(0\) \}/);
  // Every event goes through post(), which records what it holds.
  const production = source.split("// END PURE DESKTOP POLICY")[1].replace(/func (post|letGo)\([\s\S]*?\n}/g, "");
  assert.doesNotMatch(production, /\.post\(tap:/, "events are posted only through post() and letGo()");
  const post = source.split("func post(_ event: CGEvent?")[1].split("\n}")[0];
  assert.match(post, /heldLock\.lock\(\)\n\s+if stopping \{ heldLock\.unlock\(\); return \}/);
  assert.match(post, /case \.leftMouseDown, \.leftMouseDragged: heldButtons\[CGMouseButton\.left\.rawValue\] = event\.location/);
  assert.match(post, /case \.leftMouseUp: heldButtons\[CGMouseButton\.left\.rawValue\] = nil/);
  // The pause is outside the lock: a stop never waits on a sleeping batch.
  assert.match(post, /heldLock\.unlock\(\)\n\s+lastPosted = Date\(\); if pause > 0 \{ usleep\(pause\) \}/);
});

test("compiled: a stop mid-drag releases the button where the drag was, then posts nothing", {
  skip: process.platform !== "darwin" || process.env.REACH_TEST_APP_NATIVE !== "1",
}, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "agent-desktop-release-"));
  try {
    const source = await desktopSource();
    const at = source.indexOf("var lastPosted"), end = source.indexOf("func flags(");
    assert.ok(at > 0 && end > at);
    const held = source.slice(at, end);
    // Recording stand-ins for CoreGraphics events: nothing reaches the Mac.
    const stubs = String.raw`
enum CGEventType { case mouseMoved, leftMouseDown, leftMouseUp, rightMouseDown, rightMouseUp, leftMouseDragged, rightMouseDragged, keyDown, keyUp }
enum CGMouseButton: UInt32 { case left = 0, right = 1 }
enum CGEventField { case keyboardEventKeycode }
enum CGEventTapLocation { case cghidEventTap }
let source = 0
var posted: [(type: CGEventType, at: CGPoint, key: CGKeyCode)] = []
final class CGEvent {
  let type: CGEventType, location: CGPoint, key: CGKeyCode
  init?(mouseEventSource: Int, mouseType: CGEventType, mouseCursorPosition: CGPoint, mouseButton: CGMouseButton) { type = mouseType; location = mouseCursorPosition; key = 0 }
  init?(keyboardEventSource: Int, virtualKey: CGKeyCode, keyDown: Bool) { type = keyDown ? .keyDown : .keyUp; location = .zero; key = virtualKey }
  func getIntegerValueField(_ field: CGEventField) -> Int64 { Int64(key) }
  func post(tap: CGEventTapLocation) { posted.append((type, location, key)) }
}
`;
    const harness = String.raw`
func check(_ value: Bool, _ label: String) { if !value { print("FAILED: " + label); exit(1) } }
func reset() { posted = []; stopping = false; heldButtons = [:]; heldKeys = [] }
func mouse(_ type: CGEventType, _ x: CGFloat) -> CGEvent? { CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: CGPoint(x: x, y: x), mouseButton: .left) }
// Mid-drag: released at the last point dragged to, never the live cursor.
reset()
post(mouse(.leftMouseDown, 10), pause: 0); post(mouse(.leftMouseDragged, 20), pause: 0); post(mouse(.leftMouseDragged, 30), pause: 0)
letGo()
check(posted.count == 4 && posted[3].type == .leftMouseUp && posted[3].at == CGPoint(x: 30, y: 30), "button let go where it was held")
post(mouse(.leftMouseDragged, 40), pause: 0); post(mouse(.leftMouseUp, 40), pause: 0); post(mouse(.leftMouseDown, 40), pause: 0)
check(posted.count == 4, "nothing posted once stopping")
// A complete click holds nothing: no stray release.
reset()
post(mouse(.leftMouseDown, 5), pause: 0); post(mouse(.leftMouseUp, 5), pause: 0)
letGo()
check(posted.count == 2, "nothing to let go after a whole click")
// A right button, and a key between its down and up.
reset()
post(CGEvent(mouseEventSource: source, mouseType: .rightMouseDown, mouseCursorPosition: CGPoint(x: 7, y: 8), mouseButton: .right), pause: 0)
post(CGEvent(keyboardEventSource: source, virtualKey: 36, keyDown: true), pause: 0)
letGo()
check(posted.contains { $0.type == .rightMouseUp && $0.at == CGPoint(x: 7, y: 8) }, "right button let go")
check(posted.contains { $0.type == .keyUp && $0.key == 36 }, "key let go")
check(posted.count == 4, "only what was held is released")
print("held input released")
`;
    const main = path.join(directory, "main.swift"), binary = path.join(directory, "release");
    const program = "import Foundation\nimport CoreGraphics\n" + stubs + held + harness;
    assert.doesNotMatch(program, /import (?:AppKit|ApplicationServices)/);
    await fs.writeFile(main, program);
    const build = spawnSync("/usr/bin/xcrun", ["swiftc", "-module-cache-path", path.join(directory, "cache"), main, "-o", binary], { encoding: "utf8", timeout: 180000 });
    assert.equal(build.status, 0, build.stderr);
    const run = spawnSync(binary, [], { encoding: "utf8", timeout: 10000 });
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.match(run.stdout, /held input released/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
