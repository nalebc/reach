// A window on the Mac's main display that records, as the Mac itself sees
// them, every click, key and text change Reach's screen control delivers
// (test/journeys/screen-control.test.mjs). Top: a grid of 4×2 cells, each
// logging the clicks it gets (where inside it, the click count, which
// button). Below: a one-line text field and a text view with known words.
// Writes <out>.ready (JSON: the display's size and each region's rectangle,
// in points from the display's top left) and appends JSON lines to
// <out>.events. <out>.field and <out>.text hold the fields' current text.
// Gone after ten minutes whatever happens.
import AppKit

let out = CommandLine.arguments[1]
let started = Date()
var lines: [String] = []
func log(_ entry: [String: Any]) {
  var e = entry
  e["t"] = Int(Date().timeIntervalSince(started) * 1000)
  guard let data = try? JSONSerialization.data(withJSONObject: e), let s = String(data: data, encoding: .utf8) else { return }
  lines.append(s)
  try? (lines.joined(separator: "\n") + "\n").write(toFile: out + ".events", atomically: true, encoding: .utf8)
}

final class Cell: NSView {
  let index: Int
  init(frame: NSRect, index: Int) {
    self.index = index
    super.init(frame: frame)
    wantsLayer = true
    let hue = CGFloat(index) / 8
    layer?.backgroundColor = NSColor(hue: hue, saturation: 0.55, brightness: 0.9, alpha: 1).cgColor
    layer?.borderColor = NSColor.black.cgColor
    layer?.borderWidth = 2
  }
  required init?(coder: NSCoder) { fatalError() }
  override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
  private func record(_ kind: String, _ event: NSEvent) {
    let p = convert(event.locationInWindow, from: nil)
    log(["kind": kind, "cell": index, "x": Double(p.x), "y": Double(bounds.height - p.y), "count": event.clickCount])
  }
  override func mouseDown(with event: NSEvent) { record("down", event) }
  override func mouseUp(with event: NSEvent) { record("up", event) }
  override func rightMouseDown(with event: NSEvent) { record("right", event) }
  override func scrollWheel(with event: NSEvent) {
    log(["kind": "scroll", "cell": index, "dx": Double(event.scrollingDeltaX), "dy": Double(event.scrollingDeltaY)])
  }
}

final class Window: NSWindow {
  override var canBecomeKey: Bool { true }
  override var canBecomeMain: Bool { true }
}

final class Delegate: NSObject, NSTextFieldDelegate, NSTextViewDelegate {
  func controlTextDidChange(_ note: Notification) {
    guard let f = note.object as? NSTextField else { return }
    try? f.stringValue.write(toFile: out + ".field", atomically: true, encoding: .utf8)
    log(["kind": "field", "value": f.stringValue])
  }
  func textDidChange(_ note: Notification) {
    guard let v = note.object as? NSTextView else { return }
    try? v.string.write(toFile: out + ".text", atomically: true, encoding: .utf8)
    log(["kind": "text", "value": v.string])
  }
  func textViewDidChangeSelection(_ note: Notification) {
    guard let v = note.object as? NSTextView else { return }
    let r = v.selectedRange()
    let s = (v.string as NSString).substring(with: r)
    log(["kind": "selection", "location": r.location, "length": r.length, "selected": s])
  }
}

let app = NSApplication.shared
app.setActivationPolicy(.regular)
let screen = NSScreen.screens[0]
let width: CGFloat = 900, height: CGFloat = 520
let origin = NSPoint(x: screen.frame.minX + 80, y: screen.frame.maxY - 60 - height)
let window = Window(contentRect: NSRect(origin: origin, size: NSSize(width: width, height: height)), styleMask: [.borderless], backing: .buffered, defer: false)
window.level = .floating
let root = NSView(frame: NSRect(x: 0, y: 0, width: width, height: height))
root.wantsLayer = true
root.layer?.backgroundColor = NSColor.white.cgColor
window.contentView = root
let delegate = Delegate()

// Regions, top-left based (the display's own orientation), for .ready.
var regions: [String: [String: Double]] = [:]
func place(_ view: NSView, _ name: String, x: CGFloat, top: CGFloat, w: CGFloat, h: CGFloat) {
  view.frame = NSRect(x: x, y: height - top - h, width: w, height: h)
  root.addSubview(view)
  regions[name] = ["x": Double(origin.x - screen.frame.minX + x), "y": Double(screen.frame.maxY - origin.y - height + top), "width": Double(w), "height": Double(h)]
}

let cellW = width / 4, cellH: CGFloat = 110
for i in 0..<8 {
  let cell = Cell(frame: .zero, index: i)
  place(cell, "cell\(i)", x: CGFloat(i % 4) * cellW, top: CGFloat(i / 4) * cellH, w: cellW, h: cellH)
}
let field = NSTextField(string: "")
field.font = NSFont.systemFont(ofSize: 22)
field.placeholderString = "field"
field.delegate = delegate
place(field, "field", x: 20, top: 2 * cellH + 20, w: width - 40, h: 34)
let scroll = NSScrollView(frame: .zero)
let text = NSTextView(frame: NSRect(x: 0, y: 0, width: width - 40, height: 200))
text.font = NSFont.systemFont(ofSize: 22)
text.string = "alpha bravo charlie delta echo foxtrot"
text.isRichText = false
text.isAutomaticQuoteSubstitutionEnabled = false
text.isAutomaticDashSubstitutionEnabled = false
text.isAutomaticTextReplacementEnabled = false
text.isAutomaticSpellingCorrectionEnabled = false
text.isContinuousSpellCheckingEnabled = false
text.delegate = delegate
scroll.documentView = text
scroll.hasVerticalScroller = true
place(scroll, "text", x: 20, top: 2 * cellH + 74, w: width - 40, h: height - (2 * cellH + 74) - 20)

// Every key and click the app gets, before anything handles it.
NSEvent.addLocalMonitorForEvents(matching: [.keyDown, .leftMouseDown, .rightMouseDown, .otherMouseDown]) { event in
  if event.type == .keyDown {
    log(["kind": "key", "chars": event.characters ?? "", "code": Int(event.keyCode), "mods": Int(event.modifierFlags.rawValue & NSEvent.ModifierFlags.deviceIndependentFlagsMask.rawValue), "repeat": event.isARepeat])
  } else {
    let p = event.locationInWindow
    log(["kind": "mouse", "type": Int(event.type.rawValue), "x": Double(p.x), "y": Double(height - p.y), "count": event.clickCount])
  }
  return event
}

window.makeKeyAndOrderFront(nil)
app.activate(ignoringOtherApps: true)
let ready: [String: Any] = ["display": ["width": Double(screen.frame.width), "height": Double(screen.frame.height)], "regions": regions]
if let data = try? JSONSerialization.data(withJSONObject: ready) { try? data.write(to: URL(fileURLWithPath: out + ".ready")) }
DispatchQueue.main.asyncAfter(deadline: .now() + 600) { exit(0) }
app.run()
