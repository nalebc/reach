import AppKit
import ApplicationServices
import Foundation

final class Input: @unchecked Sendable {
  let lock = NSLock()
  let source = CGEventSource(stateID: .hidSystemState)
  var held: CGMouseButton? = nil
  var buttons = Set<UInt32>()
  var currentFlags: CGEventFlags = []
  var last = Date()
  var point = CGPoint.zero
  let display: CGDirectDisplayID
  init(_ display: CGDirectDisplayID) { self.display = display }
  var typingElement: AXUIElement?
  var typingToken = ""
  func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?
    AXUIElementSetMessagingTimeout(element, 0.15)
    guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else {
      return nil
    }
    return value
  }
  func focused() -> AXUIElement? {
    guard let value = attribute(AXUIElementCreateSystemWide(), kAXFocusedUIElementAttribute),
      CFGetTypeID(value) == AXUIElementGetTypeID()
    else { return nil }
    return (value as! AXUIElement)
  }
  func textTarget(_ p: [String: Any]) -> [String: Any] {
    guard let element = focused() else {
      typingElement = nil
      typingToken = ""
      return ["editable": false]
    }
    let role = attribute(element, kAXRoleAttribute) as? String ?? ""
    let subrole = attribute(element, kAXSubroleAttribute) as? String ?? ""
    var settable: DarwinBoolean = false
    AXUIElementIsAttributeSettable(element, kAXValueAttribute as CFString, &settable)
    let enabled = attribute(element, kAXEnabledAttribute) as? Bool ?? true
    var editable =
      enabled
      && (["AXTextField", "AXTextArea", "AXSearchField", "AXComboBox"].contains(role)
        || settable.boolValue && role == "AXUnknown")
    if let x = p["x"] as? Double, let y = p["y"] as? Double {
      let bounds = CGDisplayBounds(display)
      let click = CGPoint(
        x: bounds.minX + x * max(0, bounds.width - 1),
        y: bounds.minY + y * max(0, bounds.height - 1))
      var origin = CGPoint.zero
      var size = CGSize.zero
      if let position = attribute(element, kAXPositionAttribute),
        let dimensions = attribute(element, kAXSizeAttribute),
        CFGetTypeID(position) == AXValueGetTypeID(), CFGetTypeID(dimensions) == AXValueGetTypeID(),
        AXValueGetValue(position as! AXValue, .cgPoint, &origin),
        AXValueGetValue(dimensions as! AXValue, .cgSize, &size)
      {
        editable =
          editable && CGRect(origin: origin, size: size).insetBy(dx: -2, dy: -2).contains(click)
      } else {
        editable = false
      }
    }
    guard editable else {
      typingElement = nil
      typingToken = ""
      return ["editable": false]
    }
    if typingElement == nil || !CFEqual(typingElement!, element) {
      typingElement = element
      typingToken = UUID().uuidString
    }
    // Never read the value, label, selected text or surrounding document.
    return ["editable": true, "focus": typingToken, "secure": subrole == "AXSecureTextField"]
  }
  // Apps whose web content (Chrome, Electron apps such as Claude) was asked
  // to describe itself: they only list their text fields once asked.
  var describing = Set<pid_t>()
  // Is there a text field at this point? Asked when a finger touches down,
  // so the phone can open its keyboard on the same tap. Nothing is clicked,
  // focused or read: only the kind of element under the finger.
  func probe(_ p: [String: Any]) -> [String: Any] {
    guard let x = p["x"] as? Double, let y = p["y"] as? Double else { return ["field": false] }
    let bounds = CGDisplayBounds(display)
    let at = CGPoint(
      x: bounds.minX + x * max(0, bounds.width - 1),
      y: bounds.minY + y * max(0, bounds.height - 1))
    let system = AXUIElementCreateSystemWide()
    AXUIElementSetMessagingTimeout(system, 0.1)
    var hit: AXUIElement?
    guard AXUIElementCopyElementAtPosition(system, Float(at.x), Float(at.y), &hit) == .success,
      var element = hit
    else { return ["field": false] }
    var pid: pid_t = 0
    if AXUIElementGetPid(element, &pid) == .success, pid > 0, !describing.contains(pid) {
      describing.insert(pid)
      let app = AXUIElementCreateApplication(pid)
      AXUIElementSetMessagingTimeout(app, 0.1)
      AXUIElementSetAttributeValue(app, "AXManualAccessibility" as CFString, kCFBooleanTrue)
      if AXUIElementCopyElementAtPosition(system, Float(at.x), Float(at.y), &hit) == .success,
        let again = hit
      {
        element = again
      }
    }
    // The field itself, or what's drawn inside it (its text, a placeholder).
    for _ in 0..<4 {
      let role = attribute(element, kAXRoleAttribute) as? String ?? ""
      if ["AXTextField", "AXTextArea", "AXSearchField", "AXComboBox"].contains(role) {
        let enabled = attribute(element, kAXEnabledAttribute) as? Bool ?? true
        let subrole = attribute(element, kAXSubroleAttribute) as? String ?? ""
        return ["field": enabled, "secure": subrole == "AXSecureTextField"]
      }
      // Inside an editable web area (a rich editor such as a chat box).
      if attribute(element, "AXEditableAncestor") != nil { return ["field": true, "secure": false] }
      guard let parent = attribute(element, kAXParentAttribute),
        CFGetTypeID(parent) == AXUIElementGetTypeID()
      else { break }
      element = parent as! AXUIElement
    }
    return ["field": false]
  }
  func checkTyping(_ token: String) throws {
    guard !token.isEmpty, token == typingToken, let expected = typingElement,
      let current = focused(), CFEqual(expected, current)
    else {
      typingElement = nil
      typingToken = ""
      throw NSError(domain: "The typing target changed. Tap the text field again.", code: 1)
    }
  }
  func keyPress(_ code: CGKeyCode) {
    for down in [true, false] {
      let e = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: down)
      e?.flags = []
      e?.post(tap: .cghidEventTap)
    }
  }
  func insertText(_ text: String) {
    for scalar in text.unicodeScalars {
      let units = Array(String(scalar).utf16)
      for down in [true, false] {
        let e = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: down)
        e?.keyboardSetUnicodeString(stringLength: units.count, unicodeString: units)
        e?.flags = []
        e?.post(tap: .cghidEventTap)
      }
    }
  }
  func flags(_ p: [String: Any]) -> CGEventFlags {
    var f: CGEventFlags = []
    for m in p["modifiers"] as? [String] ?? [] {
      switch m {
      case "meta": f.insert(.maskCommand)
      case "alt": f.insert(.maskAlternate)
      case "control": f.insert(.maskControl)
      case "shift": f.insert(.maskShift)
      case "caps": f.insert(.maskAlphaShift)
      case "fn": f.insert(.maskSecondaryFn)
      default: break
      }
    }
    return f
  }
  // Physical arrow, navigation and function keys carry these flags. macOS
  // system shortcuts (Mission Control, switching desktops) ignore synthetic
  // key events without them.
  static func keyFlags(_ code: CGKeyCode) -> CGEventFlags {
    switch code {
    case 123, 124, 125, 126: return [.maskSecondaryFn, .maskNumericPad]
    case 114, 115, 116, 117, 119, 121: return .maskSecondaryFn
    case 122, 120, 99, 118, 96, 97, 98, 100, 101, 109, 103, 111, 105, 107, 113, 106, 64, 79, 80,
      90:
      return .maskSecondaryFn
    default: return []
    }
  }
  // Modifier keys pressed around a shortcut, outermost first.
  static let modifierKeys: [(CGKeyCode, CGEventFlags)] = [
    (59, .maskControl), (58, .maskAlternate), (56, .maskShift), (55, .maskCommand),
    (63, .maskSecondaryFn),
  ]
  func mouseKind(_ button: CGMouseButton, _ down: Bool) -> CGEventType {
    button == .left
      ? (down ? .leftMouseDown : .leftMouseUp)
      : button == .right
        ? (down ? .rightMouseDown : .rightMouseUp) : (down ? .otherMouseDown : .otherMouseUp)
  }
  func release() {
    if let held { buttons.insert(held.rawValue) }
    for b in buttons {
      if let button = CGMouseButton(rawValue: b) {
        CGEvent(
          mouseEventSource: source, mouseType: mouseKind(button, false), mouseCursorPosition: point,
          mouseButton: button)?.post(tap: .cghidEventTap)
      }
    }
    buttons.removeAll()
    held = nil
    currentFlags = []
  }
  // MARK: Context shortcuts: the frontmost app and its own menu commands.
  // Reads titles and keyboard equivalents only; never window or document content.
  var menuCache: (pid: pid_t, stamp: String, at: Date, items: [[String: Any]])?
  func children(_ element: AXUIElement) -> [AXUIElement] {
    attribute(element, kAXChildrenAttribute) as? [AXUIElement] ?? []
  }
  func menuBar(_ app: NSRunningApplication) -> AXUIElement? {
    let root = AXUIElementCreateApplication(app.processIdentifier)
    guard let bar = attribute(root, kAXMenuBarAttribute), CFGetTypeID(bar) == AXUIElementGetTypeID()
    else { return nil }
    return (bar as! AXUIElement)
  }
  static let glyphs: [String: String] = [
    "\u{F700}": "↑", "\u{F701}": "↓", "\u{F702}": "←", "\u{F703}": "→", "\u{8}": "⌫",
    "\u{7F}": "⌫", "\u{F728}": "⌦", "\u{1B}": "Esc", "\u{9}": "Tab", "\u{D}": "Return",
    " ": "Space",
  ]
  func collectMenu(_ element: AXUIElement, path: [String], depth: Int, into items: inout [[String: Any]]) {
    // Menu bar items and submenu items contain an AXMenu whose children are the items.
    for menu in children(element) {
      for item in children(menu) {
        guard items.count < 300, let title = attribute(item, kAXTitleAttribute) as? String,
          !title.isEmpty
        else { continue }
        let submenu = children(item)
        if !submenu.isEmpty {
          if depth < 1 { collectMenu(item, path: path + [title], depth: depth + 1, into: &items) }
          continue
        }
        guard attribute(item, kAXEnabledAttribute) as? Bool ?? true else { continue }
        var entry: [String: Any] = ["path": path + [title]]
        if let char = attribute(item, kAXMenuItemCmdCharAttribute) as? String, !char.isEmpty {
          let mods = attribute(item, kAXMenuItemCmdModifiersAttribute) as? Int ?? 0
          var names: [String] = []
          if mods & 4 != 0 { names.append("control") }
          if mods & 2 != 0 { names.append("alt") }
          if mods & 1 != 0 { names.append("shift") }
          if mods & 8 == 0 { names.append("meta") }
          entry["shortcut"] = ["key": Input.glyphs[char] ?? char.uppercased(), "modifiers": names]
        }
        items.append(entry)
      }
    }
  }
  func context(since: String?) -> [String: Any] {
    guard let app = NSWorkspace.shared.frontmostApplication else { return ["app": NSNull()] }
    let pid = app.processIdentifier
    if menuCache == nil || menuCache!.pid != pid || Date().timeIntervalSince(menuCache!.at) > 20 {
      var items: [[String: Any]] = []
      if let bar = menuBar(app) {
        // Skip the Apple menu; it is the same in every app.
        for top in children(bar).dropFirst() {
          guard let title = attribute(top, kAXTitleAttribute) as? String, !title.isEmpty else {
            continue
          }
          collectMenu(top, path: [title], depth: 0, into: &items)
        }
      }
      menuCache = (pid, UUID().uuidString, Date(), items)
    }
    let identity: [String: Any] = [
      "name": app.localizedName ?? "", "bundle": app.bundleIdentifier ?? "",
    ]
    if since == menuCache!.stamp {
      return ["app": identity, "stamp": menuCache!.stamp, "unchanged": true]
    }
    return ["app": identity, "stamp": menuCache!.stamp, "items": menuCache!.items]
  }
  func pressMenu(_ path: [String]) throws {
    guard let app = NSWorkspace.shared.frontmostApplication, var current = menuBar(app) else {
      throw NSError(domain: "No app is in front on your laptop.", code: 1)
    }
    for (index, title) in path.enumerated() {
      let candidates =
        index == 0 ? children(current) : children(current).flatMap { children($0) }
      guard
        let next = candidates.first(where: {
          attribute($0, kAXTitleAttribute) as? String == title
        })
      else { throw NSError(domain: "That command is no longer in the app's menu.", code: 1) }
      current = next
    }
    guard AXUIElementPerformAction(current, kAXPressAction as CFString) == .success else {
      throw NSError(domain: "The app did not accept that command.", code: 1)
    }
    menuCache = nil
  }
  func action(_ p: [String: Any]) throws -> [String: Any] {
    lock.lock()
    defer { lock.unlock() }
    last = Date()
    guard AXIsProcessTrusted() else {
      release()
      throw NSError(
        domain: "Allow Accessibility for Reach’s desktop input helper in System Settings.", code: 1)
    }
    guard CGDisplayIsActive(display) != 0 else {
      release()
      throw NSError(domain: "This display disconnected. Select a display again.", code: 1)
    }
    let type = p["type"] as? String ?? ""
    if type == "focus" { return ["target": textTarget(p)] }
    if type == "probe" { return probe(p) }
    if type == "context" { return context(since: p["since"] as? String) }
    if type == "menu", let path = p["path"] as? [String] {
      try pressMenu(path)
      return [:]
    }
    if let token = p["focus"] as? String { try checkTyping(token) }
    if type == "type-edit", let text = p["text"] as? String, let count = p["delete"] as? Int {
      guard count >= 0, count <= 256, text.utf8.count <= 8000, p["focus"] is String else {
        throw NSError(domain: "Invalid typing edit.", code: 1)
      }
      for _ in 0..<count { keyPress(51) }
      insertText(text)
      return [:]
    }
    if type == "release" {
      release()
      return [:]
    }
    if type == "heartbeat" {
      let bounds = CGDisplayBounds(display)
      let cursor = CGEvent(source: nil)?.location ?? bounds.origin
      return [
        "cursor": [
          "x": min(1, max(0, (cursor.x - bounds.minX) / max(1, bounds.width - 1))),
          "y": min(1, max(0, (cursor.y - bounds.minY) / max(1, bounds.height - 1))),
        ]
      ]
    }
    if type == "selection-read" {
      guard let element = focused(),
        attribute(element, kAXSubroleAttribute) as? String != "AXSecureTextField"
      else { throw NSError(domain: "Select non-password text on your laptop first.", code: 1) }
      guard let text = attribute(element, kAXSelectedTextAttribute) as? String, !text.isEmpty else {
        throw NSError(
          domain:
            "This app does not expose selected text. Use Command+C on the laptop, then open Clipboard in Screen options.",
          code: 1)
      }
      guard text.utf8.count <= 16384 else {
        throw NSError(domain: "Selected text exceeds 16 KiB.", code: 1)
      }
      return ["text": text]
    }
    if type == "clipboard-read" {
      let text = NSPasteboard.general.string(forType: .string) ?? ""
      guard text.utf8.count <= 16384 else {
        throw NSError(domain: "Clipboard text exceeds 16 KiB.", code: 1)
      }
      return ["text": text]
    }
    if type == "clipboard-write", let text = p["text"] as? String {
      NSPasteboard.general.clearContents()
      NSPasteboard.general.setString(text, forType: .string)
      return [:]
    }
    if ["move", "down", "up", "click"].contains(type), let x = p["x"] as? Double,
      let y = p["y"] as? Double
    {
      let bounds = CGDisplayBounds(display)
      point = CGPoint(
        x: bounds.minX + x * max(0, bounds.width - 1),
        y: bounds.minY + y * max(0, bounds.height - 1))
      let button: CGMouseButton = p["button"] as? String == "right" ? .right : .left
      func post(_ kind: CGEventType, _ b: CGMouseButton, _ count: Int = 1) {
        let e = CGEvent(
          mouseEventSource: source, mouseType: kind, mouseCursorPosition: point, mouseButton: b)
        e?.setIntegerValueField(.mouseEventClickState, value: Int64(count))
        e?.post(tap: .cghidEventTap)
      }
      if type == "move" {
        post(
          held == .left ? .leftMouseDragged : held == .right ? .rightMouseDragged : .mouseMoved,
          held ?? .left)
      }
      if type == "down" {
        release()
        held = button
        post(button == .left ? .leftMouseDown : .rightMouseDown, button)
      }
      if type == "up" { release() }
      if type == "click" {
        release()
        for c in 1...(p["count"] as? Int ?? 1) {
          post(button == .left ? .leftMouseDown : .rightMouseDown, button, c)
          post(button == .left ? .leftMouseUp : .rightMouseUp, button, c)
        }
      }
    } else if type == "scroll" {
      let dx = p["dx"] as? Double ?? 0
      let dy = p["dy"] as? Double ?? 0
      guard dx.isFinite, dy.isFinite, abs(dx) <= 120, abs(dy) <= 120 else {
        throw NSError(domain: "Invalid scroll", code: 1)
      }
      let e = CGEvent(
        scrollWheelEvent2Source: source, units: .pixel, wheelCount: 2, wheel1: Int32(dy),
        wheel2: Int32(dx), wheel3: 0)
      let phase: [String: Int64] = [
        "none": 0, "began": 1, "changed": 2, "ended": 4, "cancelled": 8,
      ]
      let momentum: [String: Int64] = ["none": 0, "began": 1, "changed": 2, "ended": 3]
      e?.setIntegerValueField(.scrollWheelEventFixedPtDeltaAxis1, value: Int64(dy * 65536))
      e?.setIntegerValueField(.scrollWheelEventFixedPtDeltaAxis2, value: Int64(dx * 65536))
      e?.setIntegerValueField(
        .scrollWheelEventScrollPhase, value: phase[p["phase"] as? String ?? "none"] ?? 0)
      e?.setIntegerValueField(
        .scrollWheelEventMomentumPhase, value: momentum[p["momentum"] as? String ?? "none"] ?? 0)
      e?.flags = currentFlags
      e?.post(tap: .cghidEventTap)
    } else if type == "text", let text = p["text"] as? String {
      insertText(text)
    } else if type == "key", let key = p["key"] as? String {
      let keys: [String: CGKeyCode] = [
        "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9, "b": 11,
        "q": 12, "w": 13, "e": 14, "r": 15, "y": 16, "t": 17, "1": 18, "2": 19, "3": 20, "4": 21,
        "6": 22, "5": 23, "9": 25, "7": 26, "8": 28, "0": 29, "o": 31, "u": 32, "i": 34, "p": 35,
        "l": 37, "j": 38, "k": 40, "n": 45, "m": 46, "enter": 36, "tab": 48, "space": 49,
        "backspace": 51, "escape": 53, "home": 115, "pageup": 116, "delete": 117, "end": 119,
        "pagedown": 121, "left": 123, "right": 124, "down": 125, "up": 126, "f1": 122, "f2": 120,
        "f3": 99, "f4": 118, "f5": 96, "f6": 97, "f7": 98, "f8": 100, "f9": 101, "f10": 109,
        "f11": 103, "f12": 111,
      ]
      guard let code = keys[key] else { throw NSError(domain: "Unsupported key", code: 1) }
      let flags = flags(p)
      // Press modifiers as real keys: system shortcuts (⌘Tab, Mission Control,
      // switching desktops) ignore modifiers carried only as event flags.
      var active: CGEventFlags = []
      var pressed: [(CGKeyCode, CGEventFlags)] = []
      for (modifier, flag) in Input.modifierKeys where flags.contains(flag) {
        active.insert(flag)
        let e = CGEvent(keyboardEventSource: source, virtualKey: modifier, keyDown: true)
        e?.flags = active
        e?.post(tap: .cghidEventTap)
        pressed.append((modifier, flag))
      }
      for down in [true, false] {
        let e = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: down)
        e?.flags = flags.union(Input.keyFlags(code))
        e?.post(tap: .cghidEventTap)
      }
      for (modifier, flag) in pressed.reversed() {
        active.remove(flag)
        let e = CGEvent(keyboardEventSource: source, virtualKey: modifier, keyDown: false)
        e?.flags = active
        e?.post(tap: .cghidEventTap)
      }
    } else {
      throw NSError(domain: "Unsupported input", code: 1)
    }
    return [:]
  }
}
@main struct DesktopInput {
  static func main() {
    let value = CommandLine.arguments.dropFirst().first ?? "primary"
    let display = value == "primary" ? CGMainDisplayID() : UInt32(value) ?? 0
    let input = Input(display)
    // Independent native failsafe: even a wedged server cannot leave a drag held.
    let timer = DispatchSource.makeTimerSource(queue: .global())
    timer.schedule(deadline: .now() + 1, repeating: 0.5)
    timer.setEventHandler {
      input.lock.lock()
      if Date().timeIntervalSince(input.last) > 2 { input.release() }
      input.lock.unlock()
    }
    timer.resume()
    signal(SIGTERM, SIG_IGN)
    let termination = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .global())
    termination.setEventHandler {
      input.lock.lock()
      input.release()
      exit(0)
    }
    termination.resume()
    while let line = readLine() {
      autoreleasepool {
        var result: [String: Any]
        do {
          guard let data = line.data(using: .utf8),
            let action = try JSONSerialization.jsonObject(with: data) as? [String: Any]
          else { throw NSError(domain: "Invalid input", code: 1) }
          result = try input.action(action)
          result["ok"] = true
        } catch { result = ["error": (error as NSError).domain] }
        if let data = try? JSONSerialization.data(withJSONObject: result) {
          FileHandle.standardOutput.write(data)
          FileHandle.standardOutput.write(Data([10]))
        }
      }
    }
    input.lock.lock()
    input.release()
    input.lock.unlock()
    timer.cancel()
    termination.cancel()
  }
}
