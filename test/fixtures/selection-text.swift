import AppKit

// A window whose text view has a known selection, in front with keyboard
// focus, for test/typing-native.test.mjs's Copy selected text check. Each
// "select <location> <length>" line on stdin selects that range and answers
// "selected". "launch <JSON {app, args}>" opens that app in front of it, as
// an app in front opening a link does (macOS brings nothing forward for a
// process in the background), and answers "launched <pid>". Nothing is
// typed or clicked. "front" answers "front <pid>": the app in front now.
// "copyonly" puts in front a view that only copies on ⌘C.
let app = NSApplication.shared
app.setActivationPolicy(.regular)
let window = NSWindow(
  contentRect: NSRect(x: 240, y: 240, width: 460, height: 120), styleMask: [.titled], backing: .buffered,
  defer: false)
window.title = "Reach selection fixture"
// An app's view that copies on ⌘C but tells Accessibility nothing about a
// selection (as Numbers' table does).
final class CopyOnlyView: NSView {
  override var acceptsFirstResponder: Bool { true }
  override func performKeyEquivalent(with event: NSEvent) -> Bool {
    guard event.modifierFlags.contains(.command), event.charactersIgnoringModifiers == "c" else {
      return super.performKeyEquivalent(with: event)
    }
    NSPasteboard.general.clearContents()
    NSPasteboard.general.setString("copied by the app", forType: .string)
    return true
  }
}
let copyOnly = CopyOnlyView(frame: NSRect(x: 0, y: 0, width: 460, height: 120))
let view = NSTextView(frame: NSRect(x: 0, y: 0, width: 460, height: 120))
view.string = "Reach copies this native selection"
window.contentView = view
window.makeKeyAndOrderFront(nil)
window.makeFirstResponder(view)
app.activate(ignoringOtherApps: true)
func select(_ location: Int, _ length: Int) {
  app.activate(ignoringOtherApps: true)
  window.makeKeyAndOrderFront(nil)
  window.makeFirstResponder(view)
  view.setSelectedRange(NSRange(location: location, length: length))
}
select(6, 18)
DispatchQueue.global().async {
  while let line = readLine() {
    let parts = line.split(separator: " ").compactMap { Int($0) }
    if line.hasPrefix("launch "),
      let data = line.dropFirst(7).data(using: .utf8),
      let request = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      let path = request["app"] as? String, let args = request["args"] as? [String]
    {
      DispatchQueue.main.async {
        let configuration = NSWorkspace.OpenConfiguration()
        configuration.activates = true
        configuration.createsNewApplicationInstance = true
        configuration.arguments = args
        NSWorkspace.shared.openApplication(at: URL(fileURLWithPath: path), configuration: configuration) { launched, error in
          DispatchQueue.main.async {
            // This very instance, not another of the same app (yours).
            if let launched {
              if #available(macOS 14.0, *) { app.yieldActivation(to: launched) }
              launched.activate()
            }
            print(launched.map { "launched \($0.processIdentifier)" } ?? "not launched \(error?.localizedDescription ?? "")")
            fflush(stdout)
          }
        }
      }
      continue
    }
    if line == "copyonly" {
      DispatchQueue.main.async {
        app.activate(ignoringOtherApps: true)
        window.contentView = copyOnly
        window.makeKeyAndOrderFront(nil)
        window.makeFirstResponder(copyOnly)
        print("copyonly")
        fflush(stdout)
      }
      continue
    }
    if line == "front" {
      DispatchQueue.main.async {
        print("front \(NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0)")
        fflush(stdout)
      }
      continue
    }
    guard line.hasPrefix("select "), parts.count == 2 else { continue }
    DispatchQueue.main.async {
      select(parts[0], parts[1])
      print("selected")
      fflush(stdout)
    }
  }
  DispatchQueue.main.async { app.terminate(nil) }
}
DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
  print("ready")
  fflush(stdout)
}
app.run()
