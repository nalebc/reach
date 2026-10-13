// A disposable, non-networked app for native-agent-live.test.mjs. The only
// editable value belongs to this synthetic form; stdin reports that value
// independently of the agent's Accessibility observation.
import AppKit

final class AgentForm: NSObject, NSApplicationDelegate {
  let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 460, height: 190),
    styleMask: [.titled], backing: .buffered, defer: false)
  let field = NSTextField(frame: NSRect(x: 30, y: 80, width: 390, height: 28))
  var events: [[String: Any]] = []

  func report() {
    let rect = window.convertToScreen(field.convert(field.bounds, to: nil))
    let point = CGPoint(x: rect.midX, y: NSScreen.screens[0].frame.maxY - rect.midY)
    let windows = (CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] ?? [])
      .filter { item in
        guard let bounds = item[kCGWindowBounds as String] as? [String: CGFloat] else { return false }
        return CGRect(x: bounds["X"] ?? 0, y: bounds["Y"] ?? 0, width: bounds["Width"] ?? 0, height: bounds["Height"] ?? 0).contains(point)
          && (item[kCGWindowAlpha as String] as? Double ?? 1) > 0
      }.prefix(3).map { item -> [String: Any] in
        let pid = item[kCGWindowOwnerPID as String] as? pid_t ?? 0
        return ["fixture": pid == ProcessInfo.processInfo.processIdentifier,
          "bundle": NSRunningApplication(processIdentifier: pid)?.bundleIdentifier ?? "",
          "layer": item[kCGWindowLayer as String] ?? 0]
      }
    let object: [String: Any] = ["value": field.currentEditor()?.string ?? field.stringValue,
      "bundle": Bundle.main.bundleIdentifier ?? "", "pid": ProcessInfo.processInfo.processIdentifier,
      "pointOwners": windows, "events": events, "editing": field.currentEditor() != nil,
      "editable": field.isEditable]
    FileHandle.standardOutput.write(try! JSONSerialization.data(withJSONObject: object))
    FileHandle.standardOutput.write(Data([10]))
  }
  func applicationDidFinishLaunching(_ notification: Notification) {
    window.title = "Synthetic Agent Form"
    // Normal AppKit text editing resolves Command+A through the Edit menu.
    let menu = NSMenu(), applicationItem = NSMenuItem(), editItem = NSMenuItem()
    applicationItem.submenu = NSMenu(title: "Agent Fixture")
    let edit = NSMenu(title: "Edit")
    edit.addItem(NSMenuItem(title: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a"))
    editItem.submenu = edit
    menu.addItem(applicationItem)
    menu.addItem(editItem)
    NSApp.mainMenu = menu
    let label = NSTextField(labelWithString: "Disposable local agent test")
    label.frame = NSRect(x: 30, y: 130, width: 390, height: 24)
    field.placeholderString = "Fixture note"
    field.setAccessibilityLabel("Fixture note")
    field.setAccessibilityIdentifier("fixture-note")
    NSEvent.addLocalMonitorForEvents(matching: [.keyDown, .keyUp, .leftMouseDown]) { event in
      if event.window == self.window, self.events.count < 60 {
        self.events.append(["type": event.type.rawValue, "characters": event.type == .leftMouseDown ? "" : event.characters ?? "",
          "command": event.modifierFlags.contains(.command), "keyCode": event.type == .leftMouseDown ? 0 : event.keyCode])
      }
      return event
    }
    window.contentView!.addSubview(label)
    window.contentView!.addSubview(field)
    // Keep this small disposable form above desktop widgets/Notification
    // Center compositor surfaces, so an Apps-only test never clicks them.
    window.level = .statusBar
    window.center()
    window.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)
    report()
  }
}
let app = NSApplication.shared
let fixture = AgentForm()
app.delegate = fixture
app.setActivationPolicy(.regular)
DispatchQueue.global().async {
  while let command = readLine() {
    if command == "state" { DispatchQueue.main.async { fixture.report() } }
  }
  exit(0)
}
app.run()
