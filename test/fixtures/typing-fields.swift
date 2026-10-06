// A window of text fields as real apps draw them, for test/typing-native.test.mjs:
// an AppKit field, a SwiftUI field with a placeholder drawn over it (as the
// ChatGPT app's composer is), a web page's input and a rich-text box, and a
// plain label that is no field. Prints each one's centre (global points, top-
// left origin) as one JSON line, then stays until stdin closes.
import AppKit
import SwiftUI
import WebKit

struct Composer: View {
  @State var text = ""
  var body: some View {
    ZStack(alignment: .topLeading) {
      TextEditor(text: $text).frame(width: 260, height: 60)
      // Drawn over the field, like the apps' placeholders and glass layers.
      Text("Ask anything").foregroundColor(.gray).padding(8).frame(width: 260, height: 60, alignment: .topLeading)
        .background(Color.white.opacity(0.01)).allowsHitTesting(false)
    }
  }
}

// A see-through layer over a text box (apps draw these for placeholders, glass
// and drop targets): Accessibility's hit test answers with the layer, whose
// ancestors aren't the box (what the ChatGPT app's composer answers).
final class Glass: NSView {
  override func isAccessibilityElement() -> Bool { true }
  override func accessibilityRole() -> NSAccessibility.Role? { .group }
}

// A drawn surface with nothing inside it, as a game, a canvas or a remote
// desktop looks to Accessibility: the Mac can't see its text fields.
final class Canvas: NSView {
  override func isAccessibilityElement() -> Bool { true }
  override func accessibilityRole() -> NSAccessibility.Role? { .group }
  override func draw(_ dirtyRect: NSRect) {
    NSColor.systemTeal.setFill()
    dirtyRect.fill()
  }
}

final class Fixture: NSObject, NSApplicationDelegate, WKNavigationDelegate {
  let window = NSWindow(
    contentRect: NSRect(x: 0, y: 0, width: 900, height: 420), styleMask: [.titled], backing: .buffered,
    defer: false)
  let native = NSTextField(frame: NSRect(x: 20, y: 360, width: 260, height: 24))
  let label = NSTextField(labelWithString: "Not a field")
  let swiftUI = NSHostingView(rootView: Composer())
  let web = WKWebView(frame: NSRect(x: 320, y: 20, width: 300, height: 380))
  let covered = NSScrollView(frame: NSRect(x: 20, y: 100, width: 260, height: 70))
  let glass = Glass(frame: NSRect(x: 20, y: 100, width: 260, height: 70))
  let canvas = Canvas(frame: NSRect(x: 640, y: 120, width: 240, height: 180))

  func applicationDidFinishLaunching(_ notification: Notification) {
    let content = window.contentView!
    label.frame = NSRect(x: 20, y: 300, width: 260, height: 24)
    swiftUI.frame = NSRect(x: 20, y: 200, width: 260, height: 60)
    let box = NSTextView(frame: NSRect(x: 0, y: 0, width: 260, height: 70))
    covered.documentView = box
    for view in [native, label, swiftUI, web, covered, glass, canvas] as [NSView] { content.addSubview(view) }
    web.navigationDelegate = self
    web.loadHTMLString(
      """
      <body style="margin:0;font:16px system-ui">
      <input id="input" placeholder="Search" style="position:absolute;left:20px;top:20px;width:240px;height:28px">
      <div id="rich" contenteditable style="position:absolute;left:20px;top:100px;width:240px;height:80px;border:1px solid #999"></div>
      </body>
      """, baseURL: nil)
    window.level = .floating
    window.center()
    window.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)
  }

  // Global points with a top-left origin, as Accessibility and the helper use.
  func centre(_ rect: NSRect) -> [String: Double] {
    let top = NSScreen.screens[0].frame.maxY
    return ["x": Double(rect.midX), "y": Double(top - rect.midY)]
  }
  func onScreen(_ view: NSView, _ local: NSRect? = nil) -> NSRect {
    window.convertToScreen(view.convert(local ?? view.bounds, to: nil))
  }

  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    let script = "['input','rich'].map(id => { const r = document.getElementById(id).getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; })"
    webView.evaluateJavaScript(script) { value, _ in
      let boxes = value as? [[Double]] ?? []
      // Web coordinates are top-down inside the (flipped) web view.
      func box(_ b: [Double]) -> NSRect {
        let r = NSRect(x: b[0], y: b[1], width: b[2], height: b[3])
        return self.onScreen(webView, webView.isFlipped ? r : NSRect(x: r.minX, y: webView.bounds.height - r.maxY, width: r.width, height: r.height))
      }
      let bounds = CGDisplayBounds(CGMainDisplayID())
      let out: [String: Any] = [
        "display": ["x": bounds.minX, "y": bounds.minY, "width": bounds.width, "height": bounds.height],
        "fields": [
          ["name": "AppKit text field", "at": self.centre(self.onScreen(self.native))],
          ["name": "SwiftUI field under a placeholder layer", "at": self.centre(self.onScreen(self.swiftUI))],
          ["name": "text box under a see-through layer (the ChatGPT app's composer)", "at": self.centre(self.onScreen(self.covered))],
          ["name": "web input", "at": self.centre(box(boxes[0]))],
          ["name": "web rich-text box", "at": self.centre(box(boxes[1]))],
        ],
        "notFields": [
          ["name": "label", "at": self.centre(self.onScreen(self.label)), "blind": false],
          ["name": "canvas the Mac can't see into", "at": self.centre(self.onScreen(self.canvas)), "blind": true],
        ],
      ]
      let data = try! JSONSerialization.data(withJSONObject: out)
      FileHandle.standardOutput.write(data)
      FileHandle.standardOutput.write(Data([10]))
    }
  }
}

let app = NSApplication.shared
let fixture = Fixture()
app.delegate = fixture
app.setActivationPolicy(.regular)
DispatchQueue.global().async {
  while readLine() != nil {}
  exit(0)
}
app.run()
