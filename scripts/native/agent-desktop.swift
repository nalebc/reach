import AppKit
import ApplicationServices
import Foundation
import ScreenCaptureKit

// Full control of this Mac for an invited agent, except Reach. One request per
// run: a screenshot with Reach's windows left out, or one input action. Every
// action is checked against exactly what it would reach (the window under the
// pointer, or the focused one) right before it is posted, in this process.
struct Refusal: Error { let message: String; let kind: String }
func refuse(_ message: String, _ kind: String = "blocked") throws -> Never { throw Refusal(message: message, kind: kind) }
func out(_ value: [String: Any]) {
  let data = (try? JSONSerialization.data(withJSONObject: value)) ?? Data("{}".utf8)
  FileHandle.standardOutput.write(data)
}

// BEGIN PURE DESKTOP POLICY — compiled directly by policy tests without macOS UI.
let reachReason = "That's Reach. The agent can't use Reach."
// Back doors into Reach: Tailscale (who your phone is), iPhone Mirroring (your
// phone itself), password prompts and keychains, Force Quit and Activity
// Monitor (they stop Reach), and System Settings' privacy panes.
func appBlocked(_ bundleId: String, _ name: String) -> Bool {
  let id = bundleId.lowercased(), value = "\(id) \(name.lowercased())"
  if ["reach", "tailscale", "tailnet"].contains(where: value.contains) { return true }
  let ids = ["com.apple.screencontinuity", "com.apple.keychainaccess", "com.apple.passwords", "com.apple.securityagent",
    "com.apple.localauthentication.uiagent", "com.apple.coreauthui", "com.apple.loginwindow", "com.apple.activitymonitor"]
  if ids.contains(where: { id == $0 || id.hasPrefix($0 + ".") }) { return true }
  return ["iphone mirroring", "securityagent", "keychain access", "activity monitor", "loginwindow"].contains(name.lowercased())
}
func settingsApp(_ bundleId: String) -> Bool {
  ["com.apple.systempreferences", "com.apple.settings"].contains(bundleId.lowercased())
}
let privatePanes = ["privacy", "security", "accessibility", "screen recording", "screen & system audio", "login items",
  "users & groups", "passwords", "full disk access", "automation", "input monitoring", "vpn", "tailscale"]
// titles: words that mark Reach's own windows (its name, its start script).
func titleBlocked(_ title: String, _ bundleId: String, _ titles: [String]) -> Bool {
  let value = title.lowercased()
  if titles.contains(where: { !$0.isEmpty && value.contains($0) }) { return true }
  return settingsApp(bundleId) && privatePanes.contains(where: value.contains)
}
// hosts: Reach's addresses (its tailnet name, and local host:port forms).
func urlBlocked(_ url: String, _ hosts: [String]) -> Bool {
  let value = url.lowercased()
  return hosts.contains(where: { !$0.isEmpty && value.contains($0) })
}
func target(_ bundleId: String, _ name: String, _ title: String, _ url: String, _ titles: [String], _ hosts: [String]) -> String? {
  appBlocked(bundleId, name) || titleBlocked(title, bundleId, titles) || urlBlocked(url, hosts) ? reachReason : nil
}
// END PURE DESKTOP POLICY

func attr(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
  AXUIElementSetMessagingTimeout(element, 0.25)
  var value: CFTypeRef?
  guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else { return nil }
  return value
}
func elementAttr(_ element: AXUIElement, _ name: String) -> AXUIElement? {
  guard let value = attr(element, name), CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
  return (value as! AXUIElement)
}
func string(_ element: AXUIElement, _ name: String) -> String {
  if let value = attr(element, name) {
    if let text = value as? String { return text }
    if CFGetTypeID(value) == CFURLGetTypeID() { return (value as! URL).absoluteString }
  }
  return ""
}

struct Rules { let hosts: [String]; let titles: [String] }
struct Seen { let bundle: String; let name: String; let title: String; let url: String }

// What an accessibility element belongs to: its app, its window's title, and
// for web content the page address.
func seen(_ element: AXUIElement) -> Seen {
  var pid: pid_t = 0
  AXUIElementGetPid(element, &pid)
  let app = NSRunningApplication(processIdentifier: pid)
  var title = "", url = ""
  var node: AXUIElement? = element
  for _ in 0..<60 {
    guard let current = node else { break }
    let role = string(current, kAXRoleAttribute)
    if role == "AXWebArea", url.isEmpty { url = string(current, "AXURL") }
    if role == kAXWindowRole { title = string(current, kAXTitleAttribute); break }
    node = elementAttr(current, kAXParentAttribute)
  }
  if title.isEmpty, let window = elementAttr(element, kAXWindowAttribute) { title = string(window, kAXTitleAttribute) }
  return Seen(bundle: app?.bundleIdentifier ?? "", name: app?.localizedName ?? "", title: title, url: url)
}
func check(_ s: Seen, _ rules: Rules) throws {
  if let reason = target(s.bundle, s.name, s.title, s.url, rules.titles, rules.hosts) { try refuse(reason) }
}
// The window server's view of the same point: the topmost window there, from
// any layer (menu bar items included). Checked as well as accessibility.
func windowAt(_ point: CGPoint) -> Seen? {
  guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] else { return nil }
  for info in list {
    guard let bounds = info[kCGWindowBounds as String] as? [String: CGFloat],
      CGRect(x: bounds["X"] ?? 0, y: bounds["Y"] ?? 0, width: bounds["Width"] ?? 0, height: bounds["Height"] ?? 0).contains(point),
      (info[kCGWindowAlpha as String] as? Double ?? 1) > 0 else { continue }
    let pid = info[kCGWindowOwnerPID as String] as? pid_t ?? 0
    let app = NSRunningApplication(processIdentifier: pid)
    return Seen(bundle: app?.bundleIdentifier ?? "", name: info[kCGWindowOwnerName as String] as? String ?? "",
      title: info[kCGWindowName as String] as? String ?? "", url: "")
  }
  return nil
}
func checkPoint(_ point: CGPoint, _ rules: Rules) throws {
  if let window = windowAt(point) { try check(window, rules) }
  var element: AXUIElement?
  if AXUIElementCopyElementAtPosition(AXUIElementCreateSystemWide(), Float(point.x), Float(point.y), &element) == .success, let element {
    let s = seen(element)
    try check(s, rules)
    // A terminal holding Reach can't be quit or closed from its menus or Dock.
    if s.title.isEmpty, let app = NSRunningApplication(processIdentifier: pidOf(element)), hostsReach(app, rules) { try refuse(reachReason) }
    if s.bundle == "com.apple.dock", let app = NSWorkspace.shared.runningApplications.first(where: { $0.localizedName == string(element, kAXTitleAttribute) }),
      hostsReach(app, rules) { try refuse(reachReason) }
  }
}
func pidOf(_ element: AXUIElement) -> pid_t { var pid: pid_t = 0; AXUIElementGetPid(element, &pid); return pid }
// Any of this app's windows is Reach's (Reach's terminal, a Reach tab).
func hostsReach(_ app: NSRunningApplication, _ rules: Rules) -> Bool {
  let element = AXUIElementCreateApplication(app.processIdentifier)
  guard let windows = attr(element, kAXWindowsAttribute) as? [AXUIElement] else { return false }
  return windows.contains { titleBlocked(string($0, kAXTitleAttribute), app.bundleIdentifier ?? "", rules.titles) }
}
// Keys and text go to the focused element; check it and its app.
func checkFocus(_ rules: Rules, quitting: Bool) throws {
  guard let front = NSWorkspace.shared.frontmostApplication else { try refuse("Nothing is ready for typing.") }
  if appBlocked(front.bundleIdentifier ?? "", front.localizedName ?? "") { try refuse(reachReason) }
  if quitting, hostsReach(front, rules) { try refuse(reachReason) }
  let app = AXUIElementCreateApplication(front.processIdentifier)
  if let window = elementAttr(app, kAXFocusedWindowAttribute) {
    try check(Seen(bundle: front.bundleIdentifier ?? "", name: front.localizedName ?? "", title: string(window, kAXTitleAttribute), url: ""), rules)
  }
  if let focused = elementAttr(AXUIElementCreateSystemWide(), kAXFocusedUIElementAttribute) { try check(seen(focused), rules) }
}

// The owner's own hands come first: any real input in the last moments pauses
// the agent. sinceAgent is how long ago the agent's own last event was posted.
func checkOwner(_ sinceAgent: Double) throws {
  let human = CGEventSource.secondsSinceLastEventType(.hidSystemState, eventType: CGEventType(rawValue: ~0)!)
  if human < 1.5 && human + 0.3 < sinceAgent { try refuse("You're using the Mac. The agent waits until you stop.", "paused") }
}

let keyCodes: [String: CGKeyCode] = [
  "return": 36, "enter": 36, "tab": 48, "space": 49, "delete": 51, "backspace": 51, "escape": 53, "esc": 53,
  "left": 123, "right": 124, "down": 125, "up": 126, "forwarddelete": 117, "home": 115, "end": 119, "pageup": 116, "pagedown": 121,
  "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9, "b": 11, "q": 12, "w": 13, "e": 14, "r": 15,
  "y": 16, "t": 17, "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "=": 24, "9": 25, "7": 26, "-": 27, "8": 28, "0": 29,
  "]": 30, "o": 31, "u": 32, "[": 33, "i": 34, "p": 35, "l": 37, "j": 38, "'": 39, "k": 40, ";": 41, "\\": 42, ",": 43, "/": 44,
  "n": 45, "m": 46, ".": 47, "`": 50,
]
let source = CGEventSource(stateID: .privateState)
func post(_ event: CGEvent?) { event?.post(tap: .cghidEventTap); usleep(8000) }
func flags(_ mods: [String]) -> CGEventFlags {
  var value: CGEventFlags = []
  for mod in mods {
    switch mod {
    case "cmd", "command", "meta": value.insert(.maskCommand)
    case "shift": value.insert(.maskShift)
    case "option", "alt": value.insert(.maskAlternate)
    case "control", "ctrl": value.insert(.maskControl)
    default: break
    }
  }
  return value
}

func perform(_ action: [String: Any], _ display: CGRect, _ rules: Rules) throws {
  let type = action["type"] as? String ?? ""
  func point(_ x: String, _ y: String) throws -> CGPoint {
    guard let nx = action[x] as? Double, let ny = action[y] as? Double, (0...1).contains(nx), (0...1).contains(ny) else {
      try refuse("Choose a point on the screen.", "invalid")
    }
    return CGPoint(x: display.minX + nx * display.width, y: display.minY + ny * display.height)
  }
  switch type {
  case "move":
    let p = try point("x", "y")
    try checkPoint(p, rules)
    post(CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: p, mouseButton: .left))
  case "click":
    let p = try point("x", "y")
    try checkPoint(p, rules)
    let right = action["button"] as? String == "right"
    let count = max(1, min(3, action["count"] as? Int ?? 1))
    let (down, up): (CGEventType, CGEventType) = right ? (.rightMouseDown, .rightMouseUp) : (.leftMouseDown, .leftMouseUp)
    let mods = flags(action["modifiers"] as? [String] ?? [])
    post(CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: p, mouseButton: .left))
    for click in 1...count {
      for kind in [down, up] {
        let event = CGEvent(mouseEventSource: source, mouseType: kind, mouseCursorPosition: p, mouseButton: right ? .right : .left)
        event?.setIntegerValueField(.mouseEventClickState, value: Int64(click))
        event?.flags = mods
        post(event)
      }
    }
  case "drag":
    let from = try point("x", "y"), to = try point("toX", "toY")
    try checkPoint(from, rules)
    try checkPoint(to, rules)
    post(CGEvent(mouseEventSource: source, mouseType: .leftMouseDown, mouseCursorPosition: from, mouseButton: .left))
    for step in 1...12 {
      let t = CGFloat(step) / 12
      post(CGEvent(mouseEventSource: source, mouseType: .leftMouseDragged,
        mouseCursorPosition: CGPoint(x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t), mouseButton: .left))
    }
    post(CGEvent(mouseEventSource: source, mouseType: .leftMouseUp, mouseCursorPosition: to, mouseButton: .left))
  case "scroll":
    let p = try point("x", "y")
    try checkPoint(p, rules)
    let dx = Int32(max(-2000, min(2000, action["dx"] as? Double ?? 0)))
    let dy = Int32(max(-2000, min(2000, action["dy"] as? Double ?? 0)))
    post(CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: p, mouseButton: .left))
    post(CGEvent(scrollWheelEvent2Source: source, units: .pixel, wheelCount: 2, wheel1: -dy, wheel2: -dx, wheel3: 0))
  case "type":
    guard let text = action["text"] as? String, !text.isEmpty, text.utf16.count <= 2000 else { try refuse("Type up to 2000 characters.", "invalid") }
    try checkFocus(rules, quitting: false)
    for line in text.components(separatedBy: "\n").enumerated() {
      if line.offset > 0 {
        post(CGEvent(keyboardEventSource: source, virtualKey: 36, keyDown: true))
        post(CGEvent(keyboardEventSource: source, virtualKey: 36, keyDown: false))
      }
      let units = Array(line.element.utf16)
      for start in stride(from: 0, to: units.count, by: 16) {
        let chunk = Array(units[start..<min(start + 16, units.count)])
        for down in [true, false] {
          let event = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: down)
          event?.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: chunk)
          post(event)
        }
      }
    }
  case "key":
    guard let name = (action["key"] as? String)?.lowercased(), let code = keyCodes[name] else { try refuse("Unknown key.", "invalid") }
    let mods = action["modifiers"] as? [String] ?? []
    let shortcut = flags(mods)
    // ⌘Q or ⌘W on a terminal holding Reach would close Reach.
    try checkFocus(rules, quitting: shortcut.contains(.maskCommand) && ["q", "w"].contains(name))
    for down in [true, false] {
      let event = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: down)
      event?.flags = shortcut
      post(event)
    }
  default:
    try refuse("Unknown action.", "invalid")
  }
}

@available(macOS 14.0, *)
func shot(_ rules: Rules, _ maxWidth: Int) async throws -> [String: Any] {
  let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
  guard let display = content.displays.first(where: { $0.displayID == CGMainDisplayID() }) ?? content.displays.first else {
    try refuse("No screen to show.", "unavailable")
  }
  // Reach's windows (and its back doors) are left out of the picture.
  let hidden = content.windows.filter { window in
    let app = window.owningApplication
    return target(app?.bundleIdentifier ?? "", app?.applicationName ?? "", window.title ?? "", "", rules.titles, rules.hosts) != nil
  }
  let filter = SCContentFilter(display: display, excludingWindows: hidden)
  let config = SCStreamConfiguration()
  let scale = min(1, Double(maxWidth) / Double(display.width))
  config.width = max(1, Int(Double(display.width) * scale))
  config.height = max(1, Int(Double(display.height) * scale))
  config.showsCursor = true
  config.capturesAudio = false
  let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
  let bitmap = NSBitmapImageRep(cgImage: image)
  guard let data = bitmap.representation(using: .jpeg, properties: [.compressionFactor: 0.7]), data.count < 6 * 1024 * 1024 else {
    try refuse("The screen couldn't be encoded.", "unavailable")
  }
  return ["jpeg": data.base64EncodedString(), "width": image.width, "height": image.height, "hidden": hidden.count]
}

@main struct Main {
  static func main() async {
    do {
      let data = FileHandle.standardInput.readDataToEndOfFile()
      guard data.count <= 65536, let request = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
        try refuse("Invalid request.", "invalid")
      }
      let rules = Rules(
        hosts: (request["hosts"] as? [String] ?? []).map { $0.lowercased() },
        titles: (request["titles"] as? [String] ?? []).map { $0.lowercased() })
      guard !rules.titles.isEmpty else { try refuse("Reach's windows are unknown.", "invalid") }
      guard AXIsProcessTrusted() else { try refuse("Reach needs Accessibility to control this Mac.", "unavailable") }
      guard #available(macOS 14.0, *) else { try refuse("Full control needs macOS 14 or later.", "unavailable") }
      switch request["op"] as? String {
      case "shot":
        out(try await shot(rules, max(320, min(2560, request["maxWidth"] as? Int ?? 1440))))
      case "act":
        guard let action = request["action"] as? [String: Any] else { try refuse("Choose an action.", "invalid") }
        try checkOwner(request["sinceAgent"] as? Double ?? 60)
        try perform(action, CGDisplayBounds(CGMainDisplayID()), rules)
        out(["ok": true])
      default:
        try refuse("Unknown request.", "invalid")
      }
    } catch let refusal as Refusal {
      out(["error": refusal.message, "kind": refusal.kind])
    } catch {
      out(["error": "The Mac couldn't do that.", "kind": "unavailable"])
    }
  }
}
