// Answers one macOS dialog the way the person chose on their phone, through
// the same Accessibility input Reach's screen control uses, and nothing else:
//
//   --press --window <id> --button <title>
//       Presses that exact button (by Accessibility, with a hit-tested mouse
//       fallback when AXPress is unsupported or has no effect) on
//       that exact dialog, if the dialog still has it; then reports whether
//       the dialog closed (macOS may refuse input from apps on some dialogs).
//       Only dialogs macOS itself shows (its own processes, signed by Apple).
//   --password --window <id>      (the password comes on stdin)
//       Types the password into macOS's password dialog, one character at a
//       time, each only while that dialog (SecurityAgent, signed by Apple, the
//       only one up) has the keyboard in a password field (no shortcuts:
//       keys mean other things on other layouts); then presses
//       Return, only if the field holds as many characters as were sent
//       (where macOS says). Refuses otherwise: a password never goes anywhere
//       else. It is never printed.
//
// Never edits macOS's permission settings or goes around its protections.
// Prints one JSON line.
import AppKit
import ApplicationServices
import Carbon
import Security

func attr(_ e: AXUIElement, _ name: String) -> AnyObject? {
  var v: AnyObject?
  return AXUIElementCopyAttributeValue(e, name as CFString, &v) == .success ? v : nil
}
func str(_ e: AXUIElement, _ name: String) -> String { (attr(e, name) as? String) ?? "" }
func children(_ e: AXUIElement) -> [AXUIElement] { (attr(e, kAXChildrenAttribute) as? [AXUIElement]) ?? [] }
func out(_ value: [String: Any]) -> Never {
  let data = (try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])) ?? Data("{}".utf8)
  print(String(data: data, encoding: .utf8) ?? "{}")
  exit(0)
}

// The macOS processes that show the dialogs Reach answers (as the watcher,
// mac-prompts.swift, finds them); passwords only go to SecurityAgent.
let presenters: Set<String> = ["UserNotificationCenter", "universalAccessAuthWarn", "CoreServicesUIAgent"]

// The dialog's window as the window server lists it: owner, pid, frame.
struct Dialog { let owner: String; let pid: pid_t; let frame: CGRect }
func windows() -> [[String: Any]] {
  CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
}
func dialog(_ id: CGWindowID) -> Dialog? {
  guard let w = windows().first(where: { ($0[kCGWindowNumber as String] as? Int).map { CGWindowID($0) } == id }) else { return nil }
  let b = w[kCGWindowBounds as String] as? [String: Any] ?? [:]
  return Dialog(
    owner: w[kCGWindowOwnerName as String] as? String ?? "",
    pid: pid_t(w[kCGWindowOwnerPID as String] as? Int ?? 0),
    frame: CGRect(x: b["X"] as? Double ?? 0, y: b["Y"] as? Double ?? 0, width: b["Width"] as? Double ?? 0, height: b["Height"] as? Double ?? 0))
}
func gone(_ id: CGWindowID, within seconds: Double) -> Bool {
  let until = Date().addingTimeInterval(seconds)
  while Date() < until {
    if dialog(id) == nil { return true }
    usleep(150_000)
  }
  return dialog(id) == nil
}
// Password dialogs on screen now (a dialog-sized SecurityAgent window).
func passwordDialogs() -> Int {
  windows().filter { w in
    let b = w[kCGWindowBounds as String] as? [String: Any] ?? [:]
    return (w[kCGWindowOwnerName as String] as? String) == "SecurityAgent" && (b["Width"] as? Double ?? 0) > 40 && (b["Height"] as? Double ?? 0) > 40
  }.count
}

// macOS's own: the process is signed by Apple (an app can call itself
// SecurityAgent; it can't sign as Apple).
func signedByApple(_ pid: pid_t) -> Bool {
  var code: SecCode?
  guard SecCodeCopyGuestWithAttributes(nil, [kSecGuestAttributePid: pid] as CFDictionary, [], &code) == errSecSuccess, let code
  else { return false }
  var requirement: SecRequirement?
  guard SecRequirementCreateWithString("anchor apple" as CFString, [], &requirement) == errSecSuccess, let requirement
  else { return false }
  return SecCodeCheckValidity(code, [], requirement) == errSecSuccess
}

// The dialog's own buttons, read from its Accessibility window (the one whose
// frame is the window server's), right before pressing.
func buttons(of d: Dialog) -> [String: AXUIElement] {
  let app = AXUIElementCreateApplication(d.pid)
  // Its windows; an app showing only a panel may list it only among its
  // top-level elements.
  var windows = (attr(app, kAXWindowsAttribute) as? [AXUIElement]) ?? []
  if windows.isEmpty { windows = children(app).filter { str($0, kAXRoleAttribute) == (kAXWindowRole as String) } }
  let frame = { (w: AXUIElement) -> CGRect in
    var p = CGPoint.zero, s = CGSize.zero
    if let v = attr(w, kAXPositionAttribute) { AXValueGetValue(v as! AXValue, .cgPoint, &p) }
    if let v = attr(w, kAXSizeAttribute) { AXValueGetValue(v as! AXValue, .cgSize, &s) }
    return CGRect(origin: p, size: s)
  }
  let match = windows.first { w in
    let f = frame(w)
    return abs(f.minX - d.frame.minX) < 3 && abs(f.minY - d.frame.minY) < 3 && abs(f.width - d.frame.width) < 3 && abs(f.height - d.frame.height) < 3
  }
  guard let window = match else { return [:] }
  var found: [String: AXUIElement] = [:]
  var queue = [window]
  var i = 0
  while i < queue.count, i < 2000 {
    let e = queue[i]
    i += 1
    if str(e, kAXRoleAttribute) == (kAXButtonRole as String) {
      let title = str(e, kAXTitleAttribute).trimmingCharacters(in: .whitespacesAndNewlines)
      if !title.isEmpty, found[title] == nil { found[title] = e }
    }
    queue.append(contentsOf: children(e))
  }
  return found
}

// A reused system window/button must not turn the fallback into an answer
// to the next question. Remember only static dialog text, never field values.
func buttonContext(_ button: AXUIElement) -> [String]? {
  var node = button
  for _ in 0..<20 {
    if str(node, kAXRoleAttribute) == (kAXWindowRole as String) {
      var queue = [node], texts: [String] = []
      var i = 0
      while i < queue.count, i < 2000 {
        let e = queue[i]
        i += 1
        if str(e, kAXRoleAttribute) == (kAXStaticTextRole as String) { texts.append(str(e, kAXValueAttribute)) }
        queue.append(contentsOf: children(e))
      }
      return i == queue.count && texts.contains(where: { !$0.isEmpty }) ? texts : nil
    }
    guard let parent = attr(node, kAXParentAttribute) else { return nil }
    node = parent as! AXUIElement
  }
  return nil
}

// Some system dialogs expose buttons but don't implement AXPress. Use the
// same ordinary mouse input as the live screen, only if Accessibility's
// hit test still identifies the exact button in the exact dialog. macOS
// can reject this too; never report success until the dialog closes.
func clickButton(_ button: AXUIElement, title: String, context: [String], dialog d: Dialog, id: CGWindowID) -> Bool {
  guard let current = dialog(id), current.pid == d.pid, current.owner == d.owner, current.frame == d.frame,
    let fresh = buttons(of: current)[title], CFEqual(fresh, button), buttonContext(fresh) == context,
    (attr(fresh, kAXEnabledAttribute) as? Bool) == true,
    let position = attr(fresh, kAXPositionAttribute), CFGetTypeID(position) == AXValueGetTypeID(),
    let size = attr(fresh, kAXSizeAttribute), CFGetTypeID(size) == AXValueGetTypeID()
  else { return false }
  var p = CGPoint.zero, s = CGSize.zero
  guard AXValueGetValue(position as! AXValue, .cgPoint, &p), AXValueGetValue(size as! AXValue, .cgSize, &s),
    p.x.isFinite, p.y.isFinite, s.width.isFinite, s.height.isFinite, s.width > 0, s.height > 0
  else { return false }
  let rect = CGRect(origin: p, size: s)
  guard d.frame.contains(rect) else { return false }
  let point = CGPoint(x: rect.midX, y: rect.midY)
  var hit: AXUIElement?
  guard AXUIElementCopyElementAtPosition(AXUIElementCreateSystemWide(), Float(point.x), Float(point.y), &hit) == .success,
    let hit, CFEqual(hit, fresh), let source = CGEventSource(stateID: .hidSystemState),
    let down = CGEvent(mouseEventSource: source, mouseType: .leftMouseDown, mouseCursorPosition: point, mouseButton: .left),
    let up = CGEvent(mouseEventSource: source, mouseType: .leftMouseUp, mouseCursorPosition: point, mouseButton: .left)
  else { return false }
  down.flags = []
  up.flags = []
  down.post(tap: .cghidEventTap)
  up.post(tap: .cghidEventTap)
  return true
}

// Where the keyboard is, asked live each time (never remembered): the
// password dialog's app has it, secure input is on (as macOS turns it on for
// password fields), and where Accessibility says which field, it is a
// password field of that dialog. `nil` when it isn't so.
func passwordField(_ d: Dialog, _ id: CGWindowID) -> AXUIElement?? {
  guard dialog(id) != nil, passwordDialogs() == 1, IsSecureEventInputEnabled() else { return nil }
  let system = AXUIElementCreateSystemWide()
  var pid: pid_t = 0
  guard let app = attr(system, kAXFocusedApplicationAttribute) else { return nil }
  AXUIElementGetPid(app as! AXUIElement, &pid)
  guard pid == d.pid else { return nil }
  guard let focused = attr(system, kAXFocusedUIElementAttribute) else { return .some(nil) }
  let field = focused as! AXUIElement
  var owner: pid_t = 0
  AXUIElementGetPid(field, &owner)
  guard owner == d.pid, str(field, kAXSubroleAttribute) == (kAXSecureTextFieldSubrole as String) else { return nil }
  return .some(field)
}
// How many characters the field holds, where macOS says (never what they are).
func characters(in field: AXUIElement) -> Int? {
  if let n = attr(field, kAXNumberOfCharactersAttribute) as? Int { return n }
  return nil
}
func key(_ code: CGKeyCode, _ flags: CGEventFlags = []) {
  let source = CGEventSource(stateID: .hidSystemState)
  for down in [true, false] {
    let e = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: down)
    e?.flags = flags
    e?.post(tap: .cghidEventTap)
  }
}
// Delete, `count` times, each only while `ok` still holds.
func erase(_ count: Int, while ok: () -> Bool) -> Bool {
  for _ in 0..<min(count, 300) {
    guard ok() else { return false }
    key(51)
  }
  return true
}
func type(_ scalar: Unicode.Scalar) {
  let source = CGEventSource(stateID: .hidSystemState)
  let units = Array(String(scalar).utf16)
  for down in [true, false] {
    let e = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: down)
    e?.keyboardSetUnicodeString(stringLength: units.count, unicodeString: units)
    e?.flags = []
    e?.post(tap: .cghidEventTap)
  }
}

@main
struct MacAnswer {
  static func main() {
    let args = CommandLine.arguments
    let option = { (name: String) -> String? in args.firstIndex(of: name).flatMap { $0 + 1 < args.count ? args[$0 + 1] : nil } }
    guard let raw = option("--window"), let number = UInt32(raw) else { out(["error": "Which dialog?"]) }
    let id = CGWindowID(number)
    guard AXIsProcessTrusted() else { out(["error": "Reach needs Accessibility to answer your Mac."]) }
    guard let d = dialog(id) else { out(["error": "That dialog was already answered.", "gone": true]) }

    if args.contains("--press") {
      guard let title = option("--button") else { out(["error": "Which button?"]) }
      guard d.owner != "SecurityAgent" else { out(["error": "A password dialog is answered with the password."]) }
      guard presenters.contains(d.owner), signedByApple(d.pid) else { out(["error": "That isn't one of your Mac's own dialogs."]) }
      // Re-read right before pressing: only a button the dialog has now.
      guard let button = buttons(of: d)[title] else { out(["error": "That button isn't on the dialog any more."]) }
      let context = buttonContext(button)
      let result = AXUIElementPerformAction(button, kAXPressAction as CFString)
      if gone(id, within: 2.5) { out(["pressed": title]) }
      // A timeout/cannotComplete is ambiguous: do not send another answer.
      if result == .success || result == .actionUnsupported {
        if let context, clickButton(button, title: title, context: context, dialog: d, id: id), gone(id, within: 2.5) { out(["pressed": title]) }
      }
      out(["error": "macOS didn't confirm the press from Reach. Answer this dialog on the Mac.", "refused": true, "axError": result.rawValue])
    }

    if args.contains("--password") {
      let input = FileHandle.standardInput.readDataToEndOfFile()
      var secret = String(decoding: input, as: UTF8.self)
      if secret.hasSuffix("\n") { secret.removeLast() }
      defer { secret = String(repeating: " ", count: secret.count) }
      // No control characters (none can be typed into a password field;
      // Tab would move to another field, Escape cancel the dialog).
      guard !secret.isEmpty, secret.count <= 256, !secret.unicodeScalars.contains(where: { $0.value < 0x20 || $0.value == 0x7F })
      else { out(["error": "Enter your password."]) }
      guard d.owner == "SecurityAgent", signedByApple(d.pid) else { out(["error": "That isn't your Mac's password dialog."]) }
      let noKeyboard: [String: Any] = ["error": "Your Mac's password dialog doesn't have the keyboard. Type it at the Mac.", "refused": true]
      guard passwordDialogs() == 1 else { out(["error": "More than one password dialog is up. Type it at the Mac.", "refused": true]) }
      guard let front = NSWorkspace.shared.frontmostApplication, front.bundleIdentifier == "com.apple.SecurityAgent",
        front.processIdentifier == d.pid, case .some(let field) = passwordField(d, id)
      else { out(noKeyboard) }
      let hasKeyboard = { () -> Bool in
        if case .some = passwordField(d, id) { return true }
        return false
      }
      // Whatever is in the field already goes first, where macOS says how
      // much (Delete is the same key on every keyboard layout; a shortcut
      // like Command-A isn't).
      if let field, let count = characters(in: field), !erase(count, while: hasKeyboard) { out(noKeyboard) }
      // Fail closed: each key goes to that dialog's password field or
      // nowhere; the keyboard is checked again before every one.
      for scalar in secret.unicodeScalars {
        guard hasKeyboard() else { out(noKeyboard) }
        type(scalar)
      }
      usleep(150_000)
      guard case .some(let now) = passwordField(d, id) else { out(noKeyboard) }
      // Where macOS says how many characters the field holds, all of them
      // must have arrived: a short password would only count as a wrong one.
      if let field = now ?? field, let count = characters(in: field), count != secret.utf16.count, count != secret.count {
        _ = erase(count, while: hasKeyboard)
        out(["error": "macOS didn't take all of the typing from Reach. Type it at the Mac.", "refused": true])
      }
      guard hasKeyboard() else { out(noKeyboard) }
      key(36)  // Return
      if gone(id, within: 3) { out(["done": true]) }
      out(["error": "The dialog is still up: the password wasn't accepted, or macOS didn't take typing from Reach.", "stayed": true])
    }
    out(["error": "Press a button or send the password."])
  }
}
