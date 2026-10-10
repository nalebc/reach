// What a browser needs before agents' saved tools can drive it with Apple
// Events (server/tool-setup.mjs), read and switched for the owner:
//   <bundle> check        whether macOS lets Reach control it (never prompts)
//   <bundle> ask          the same, showing macOS's own prompt on the Mac
//                         when it hasn't asked yet; the owner answers there
//                         (or from the phone, through Reach's Mac prompts)
//   <bundle> script-status <menu path…>   the browser's own "Allow JavaScript
//                         from Apple Events" menu item: on, off, or unknown
//   <bundle> script-on <menu path…>       the same, pressed once if off
// Menu items are reached through Accessibility (Reach's own permission),
// never by moving the mouse; the browser needn't be in front.
import AppKit
import ApplicationServices
import CoreServices
import Foundation

@main
struct AutomationCheck {
  static func attr(_ e: AXUIElement, _ name: String) -> AnyObject? {
    var v: AnyObject?
    return AXUIElementCopyAttributeValue(e, name as CFString, &v) == .success ? v : nil
  }
  static func str(_ e: AXUIElement, _ name: String) -> String { (attr(e, name) as? String) ?? "" }
  static func out(_ value: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: value), let text = String(data: data, encoding: .utf8) { print(text) }
    else { print("{\"status\":null}") }
  }
  // A menu item by its titles from the menu bar down ("View", "Developer",
  // "Allow JavaScript from Apple Events"). Each level is a menu whose items
  // are its children; a submenu sits one AXMenu below its item.
  static func menuItem(_ pid: pid_t, _ path: [String]) -> AXUIElement? {
    guard let bar = attr(AXUIElementCreateApplication(pid), kAXMenuBarAttribute) else { return nil }
    var node = bar as! AXUIElement
    for title in path {
      var items = attr(node, kAXChildrenAttribute) as? [AXUIElement] ?? []
      if items.count == 1, str(items[0], kAXRoleAttribute) == "AXMenu" { items = attr(items[0], kAXChildrenAttribute) as? [AXUIElement] ?? [] }
      guard let found = items.first(where: { str($0, kAXTitleAttribute) == title }) else { return nil }
      node = found
    }
    return node
  }
  static func main() {
    let args = CommandLine.arguments
    guard args.count >= 3, ["check", "ask", "script-status", "script-on"].contains(args[2]),
      args[1].range(of: "^[A-Za-z0-9.-]{1,200}$", options: .regularExpression) != nil
    else { out(["status": NSNull()]); exit(2) }
    let bundle = args[1], mode = args[2]
    if mode == "script-status" || mode == "script-on" {
      let path = Array(args.dropFirst(3))
      guard !path.isEmpty, path.count <= 4, path.allSatisfy({ !$0.isEmpty && $0.count <= 80 }) else { out(["status": NSNull()]); exit(2) }
      guard let app = NSRunningApplication.runningApplications(withBundleIdentifier: bundle).first else { out(["status": -600]); return }
      guard let item = menuItem(app.processIdentifier, path) else { out(["javascript": "unknown"]); return }
      let on = { !str(item, "AXMenuItemMarkChar").isEmpty }
      if mode == "script-on", !on() {
        AXUIElementPerformAction(item, kAXPressAction as CFString)
        usleep(400_000)
      }
      out(["javascript": on() ? "on" : "off"])
      return
    }
    var target = AEAddressDesc()
    let id = Array(bundle.utf8)
    let created = id.withUnsafeBufferPointer { AECreateDesc(DescType(typeApplicationBundleID), $0.baseAddress, $0.count, &target) }
    guard created == noErr else { out(["status": NSNull()]); exit(1) }
    defer { AEDisposeDesc(&target) }
    // 0 allowed, -1743 turned off, -1744 not asked yet, -600 not running.
    let status = AEDeterminePermissionToAutomateTarget(&target, AEEventClass(typeWildCard), AEEventID(typeWildCard), mode == "ask")
    out(["status": Int(status)])
  }
}
