// A window on the Mac's main display for the user journeys to click through
// Reach (test/journeys/screen.test.mjs): orange until a click reaches it,
// then green, so the phone's own live screen shows the click landed. Above
// every other window, so a click at its middle can only reach it. Writes
// <out>.ready (its middle and the display's size, in points from the
// display's top left, then its own size) and <out>.clicks (how many clicks
// reached it). Gone after two minutes whatever happens.
import AppKit

final class Target: NSView {
  var clicks = 0
  let out: String
  init(frame: NSRect, out: String) {
    self.out = out
    super.init(frame: frame)
    wantsLayer = true
    layer?.backgroundColor = NSColor(srgbRed: 1, green: 0.55, blue: 0, alpha: 1).cgColor
  }
  required init?(coder: NSCoder) { fatalError() }
  override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
  override func mouseDown(with event: NSEvent) {
    clicks += 1
    layer?.backgroundColor = NSColor(srgbRed: 0, green: 0.75, blue: 0.2, alpha: 1).cgColor
    try? String(clicks).write(toFile: out + ".clicks", atomically: true, encoding: .utf8)
  }
}

let out = CommandLine.arguments[1]
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let screen = NSScreen.screens[0]
let size = NSSize(width: 420, height: 260)
let origin = NSPoint(x: screen.frame.minX + 120, y: screen.frame.maxY - 200 - size.height)
let window = NSWindow(contentRect: NSRect(origin: origin, size: size), styleMask: [.borderless], backing: .buffered, defer: false)
window.level = .screenSaver
window.contentView = Target(frame: NSRect(origin: .zero, size: size), out: out)
window.orderFrontRegardless()
let middleX = window.frame.midX - screen.frame.minX
let middleY = screen.frame.maxY - window.frame.midY
try? "\(middleX),\(middleY),\(screen.frame.width),\(screen.frame.height),\(size.width),\(size.height)".write(toFile: out + ".ready", atomically: true, encoding: .utf8)
DispatchQueue.main.asyncAfter(deadline: .now() + 120) { exit(0) }
app.run()
