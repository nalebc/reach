// An agent acting inside one app without the Mac's pointer or keyboard, so a
// person can keep using the Mac at the same time (server/agent-apps.mjs).
// JSON lines in and out: {id, cmd, …} -> {id, done, …}.
//
// Window-level (safe even while a person uses the same app): `press` and
// `text` act on the element at a point on the agent's own hidden display,
// through Accessibility. App-level (keys, menus): only while the app isn't in
// front and the agent's window is the app's key window, so nothing lands in a
// window the person is using. Anything else answers done: false and the
// server falls back (the pointer, when nobody is at the Mac) or waits.
// Nothing here moves the pointer or brings an app to the front.
import AppKit
import ApplicationServices
import Carbon

let source = CGEventSource(stateID: .privateState)
// The text field each thread last focused, for `text`.
var fields: [String: AXUIElement] = [:]

func attr(_ e: AXUIElement, _ name: String) -> AnyObject? {
  var v: AnyObject?
  return AXUIElementCopyAttributeValue(e, name as CFString, &v) == .success ? v : nil
}
func role(_ e: AXUIElement) -> String { (attr(e, kAXRoleAttribute) as? String) ?? "" }
func actions(_ e: AXUIElement) -> [String] {
  var names: CFArray?
  return AXUIElementCopyActionNames(e, &names) == .success ? (names as? [String]) ?? [] : []
}
func parent(_ e: AXUIElement) -> AXUIElement? { attr(e, kAXParentAttribute).map { $0 as! AXUIElement } }
func window(_ e: AXUIElement) -> AXUIElement? {
  if let w = attr(e, kAXWindowAttribute) { return (w as! AXUIElement) }
  var at: AXUIElement? = e
  for _ in 0..<40 {
    guard let x = at else { return nil }
    if role(x) == kAXWindowRole { return x }
    at = parent(x)
  }
  return nil
}
let textRoles: Set<String> = [kAXTextFieldRole, kAXTextAreaRole, kAXComboBoxRole, "AXSearchField"]

func running(_ path: String) -> NSRunningApplication? {
  NSWorkspace.shared.runningApplications.first { $0.bundleURL?.path == path }
}
// A point on a display, in that display's points, as the screen's global point.
func global(_ display: String, _ x: Double, _ y: Double) -> CGPoint {
  let id = CGDirectDisplayID(UInt32(display) ?? CGMainDisplayID())
  let origin = CGDisplayBounds(id).origin
  return CGPoint(x: origin.x + x, y: origin.y + y)
}
func element(_ app: AXUIElement, _ at: CGPoint) -> AXUIElement? {
  var found: AXUIElement?
  return AXUIElementCopyElementAtPosition(app, Float(at.x), Float(at.y), &found) == .success ? found : nil
}
// App-level input is safe only when it can only reach the agent's window,
// or when nobody is at the Mac (`alone`, the server's call).
var alone = false
func appLevelSafe(_ app: NSRunningApplication, _ ax: AXUIElement, _ agentWindow: AXUIElement?) -> String? {
  if alone { return nil }
  if NSWorkspace.shared.frontmostApplication?.processIdentifier == app.processIdentifier {
    return "the app is in front"
  }
  guard let mine = agentWindow else { return "no agent window" }
  guard let key = attr(ax, kAXFocusedWindowAttribute) ?? attr(ax, kAXMainWindowAttribute) else {
    return "no key window"
  }
  return CFEqual(key, mine) ? nil : "another window of the app is in use"
}

let keyCodes: [String: CGKeyCode] = [
  "enter": 36, "tab": 48, "space": 49, "backspace": 51, "escape": 53, "delete": 117, "home": 115,
  "end": 119, "pageup": 116, "pagedown": 121, "left": 123, "right": 124, "down": 125, "up": 126,
  "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9, "b": 11, "q": 12,
  "w": 13, "e": 14, "r": 15, "y": 16, "t": 17, "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23,
  "9": 25, "7": 26, "8": 28, "0": 29, "o": 31, "u": 32, "i": 34, "p": 35, "l": 37, "j": 38, "k": 40,
  "n": 45, "m": 46, "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97, "f7": 98,
  "f8": 100, "f9": 101, "f10": 109, "f11": 103, "f12": 111,
]
let modifierFlags: [String: CGEventFlags] = [
  "meta": .maskCommand, "alt": .maskAlternate, "control": .maskControl, "shift": .maskShift,
  "fn": .maskSecondaryFn, "caps": .maskAlphaShift,
]
// BEGIN KEY LAYOUT — the same as desktop-input.swift's (one per binary).
// Letters and digits press the key that types them on the Mac's current
// keyboard layout, not the US key in that place: on AZERTY the US Q key
// types "a", so ⌘A went out as ⌘Q (quit), ⌘Z as ⌘W and "a" as "q". With ⌘
// held a layout can type other letters (Dvorak – QWERTY ⌘, Cyrillic, Greek):
// shortcuts read that layer. Never the keypad: AZERTY's keypad 1 is its only
// unshifted "1". What the layout doesn't type keeps its US key.
final class KeyLayout {
  // What a key code types on a layout, with Carbon modifiers (cmdKey, shiftKey).
  typealias Translate = (_ code: UInt16, _ modifiers: Int) -> String?
  static func find(_ key: String, _ modifiers: Int, near us: CGKeyCode,
    _ translate: Translate) -> CGKeyCode?
  {
    func types(_ code: UInt16) -> Bool { translate(code, modifiers)?.lowercased() == key }
    if types(us) { return us }
    return (UInt16(0)..<128).first { !(65...92).contains($0) && types($0) }
  }
  // The key for a letter or digit, and whether it needs Shift; nil keeps
  // the US key.
  static func resolve(_ key: String, _ flags: CGEventFlags, us: CGKeyCode,
    _ translate: Translate) -> (CGKeyCode, Bool)?
  {
    let command = flags.contains(.maskCommand)
    if let code = find(key, command ? cmdKey : 0, near: us, translate) { return (code, false) }
    // Digits keep their keys on every layout; AZERTY types them with Shift.
    // Only plain typing adds it: ⌘1 there is the same key without Shift.
    guard flags.intersection([.maskCommand, .maskControl, .maskAlternate, .maskShift]).isEmpty,
      "0123456789".contains(key), let code = find(key, shiftKey, near: us, translate)
    else { return nil }
    return (code, true)
  }
  // UCKeyTranslate over a layout's own data, without dead keys.
  static func translator(_ source: TISInputSource) -> Translate? {
    guard let raw = TISGetInputSourceProperty(source, kTISPropertyUnicodeKeyLayoutData) else {
      return nil
    }
    let data = Unmanaged<CFData>.fromOpaque(raw).takeUnretainedValue()
    let kind = UInt32(LMGetKbdType())
    return { code, modifiers in
      withExtendedLifetime(source) {
        guard let bytes = CFDataGetBytePtr(data) else { return nil }
        var dead: UInt32 = 0, length = 0
        var text = [UniChar](repeating: 0, count: 4)
        let status = UCKeyTranslate(
          UnsafeRawPointer(bytes).assumingMemoryBound(to: UCKeyboardLayout.self), code,
          UInt16(kUCKeyActionDown), UInt32(modifiers >> 8) & 0xFF, kind,
          OptionBits(kUCKeyTranslateNoDeadKeysMask), &dead, text.count, &length, &text)
        return status == noErr ? String(utf16CodeUnits: text, count: length) : nil
      }
    }
  }
  // Looked up once per layout: the source changes when the owner switches.
  private var source = ""
  private var known: [String: (CGKeyCode, Bool)?] = [:]
  func key(_ key: String, _ flags: CGEventFlags, us: CGKeyCode) -> (CGKeyCode, Bool)? {
    // Text Input Sources answer on the main thread only (newer macOS asserts
    // elsewhere): off it, the US key.
    guard key.count == 1, "abcdefghijklmnopqrstuvwxyz0123456789".contains(key), Thread.isMainThread
    else { return nil }
    // This helper never runs its loop otherwise: a layout switch since the
    // last key gets in here.
    CFRunLoopRunInMode(.defaultMode, 0, false)
    guard let current = TISCopyCurrentKeyboardLayoutInputSource()?.takeRetainedValue(),
      let id = TISGetInputSourceProperty(current, kTISPropertyInputSourceID)
    else { return nil }
    let layout = "\(Unmanaged<CFString>.fromOpaque(id).takeUnretainedValue()) \(LMGetKbdType())"
    if layout != source {
      source = layout
      known = [:]
    }
    let plain = flags.intersection([.maskCommand, .maskControl, .maskAlternate, .maskShift]).isEmpty
    let entry = "\(key) \(flags.contains(.maskCommand)) \(plain)"
    if let found = known[entry] { return found }
    let found = KeyLayout.translator(current).flatMap { KeyLayout.resolve(key, flags, us: us, $0) }
    known[entry] = .some(found)
    return found
  }
}
// END KEY LAYOUT
let keyLayout = KeyLayout()
// BEGIN PURE INPUT TEXT — the same as agent-desktop.swift's (one per binary).
// Each keyboard event must contain complete UTF-16 surrogate pairs. Splitting
// an emoji between events can insert two replacement characters in the app.
// One character (grapheme) per event: some apps (Calculator, SwiftUI
// fields) read only the first character of a key event, so "7*3" in one
// event typed "7". A character longer than 16 units splits by scalar.
func keyboardChunks(_ text: String) -> [[UInt16]] {
  var result: [[UInt16]] = []
  for character in text {
    let units = Array(String(character).utf16)
    if units.count <= 16 { result.append(units); continue }
    var chunk: [UInt16] = []
    for scalar in String(character).unicodeScalars {
      let part = Array(String(scalar).utf16)
      if chunk.count + part.count > 16 { result.append(chunk); chunk = [] }
      chunk.append(contentsOf: part)
    }
    if !chunk.isEmpty { result.append(chunk) }
  }
  return result
}
// END PURE INPUT TEXT

// The key this helper holds down in an app between its down and up. Stopped
// in between (SIGTERM, main), it lets go first; once stopping, nothing more
// is posted. One event at a time under `heldLock`.
let heldLock = NSLock()
var heldKey: (pid: pid_t, key: CGKeyCode)? = nil
var stopping = false
func send(_ e: CGEvent?, _ pid: pid_t, key: CGKeyCode, down: Bool) {
  heldLock.lock(); defer { heldLock.unlock() }
  if stopping { return }
  e?.postToPid(pid)
  heldKey = down ? (pid, key) : nil
}
func letGo() {
  heldLock.lock(); defer { heldLock.unlock() }
  stopping = true
  if let held = heldKey { CGEvent(keyboardEventSource: source, virtualKey: held.key, keyDown: false)?.postToPid(held.pid) }
  heldKey = nil
}
func post(_ pid: pid_t, key: CGKeyCode, flags: CGEventFlags) {
  for down in [true, false] {
    let e = CGEvent(keyboardEventSource: source, virtualKey: key, keyDown: down)
    e?.flags = flags
    send(e, pid, key: key, down: down)
  }
}
func post(_ pid: pid_t, text: String) {
  for chunk in keyboardChunks(text) {
    for down in [true, false] {
      let e = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: down)
      e?.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: chunk)
      send(e, pid, key: 0, down: down)
    }
  }
}
// Whether an Accessibility change surely didn't happen. One the app didn't
// answer in time (busy, hung), or any error not known to mean "refused", may
// still land: unknown, so the server neither falls back to the pointer
// (a second press) nor reports it done.
let refusedErrors: [AXError] = [.actionUnsupported, .attributeUnsupported, .parameterizedAttributeUnsupported,
  .illegalArgument, .invalidUIElement, .notImplemented, .apiDisabled, .noValue]
func outcome(_ error: AXError, _ done: [String: Any], refused why: String) -> [String: Any] {
  if error == .success { return done }
  if refusedErrors.contains(error) { return ["done": false, "why": why] }
  return ["done": false, "unknown": true, "why": "the app didn't answer in time"]
}
// Menu titles match as shown, with or without a trailing "…".
func same(_ a: String, _ b: String) -> Bool {
  let trim = { (s: String) in s.replacingOccurrences(of: "…", with: "").replacingOccurrences(of: "...", with: "").trimmingCharacters(in: .whitespaces).lowercased() }
  return trim(a) == trim(b)
}

func handle(_ r: [String: Any]) -> [String: Any] {
  let cmd = r["cmd"] as? String ?? ""
  if cmd == "probe" { return ["done": true, "trusted": AXIsProcessTrusted()] }
  // Whether the app is running already (starting one can take the focus).
  if cmd == "running" {
    return ["done": true, "running": (r["app"] as? String).flatMap(running) != nil]
  }
  guard AXIsProcessTrusted() else { return ["done": false, "why": "Accessibility is off for Reach"] }
  guard let path = r["app"] as? String, let app = running(path) else {
    return ["done": false, "why": "the app isn't running"]
  }
  let ax = AXUIElementCreateApplication(app.processIdentifier)
  alone = r["alone"] as? Bool == true
  let thread = r["thread"] as? String ?? ""
  let display = r["display"] as? String ?? "primary"
  let at: CGPoint? = {
    guard let x = r["x"] as? Double, let y = r["y"] as? Double else { return nil }
    return global(display, x, y)
  }()
  let agentWindow = at.flatMap { element(ax, $0) }.flatMap(window)
  switch cmd {
  case "press":
    guard let point = at, let hit = element(ax, point) else { return ["done": false, "why": "nothing there"] }
    // A text field: focus it (its window only), for `text` after.
    var e: AXUIElement? = hit
    for _ in 0..<3 {
      guard let x = e else { break }
      if textRoles.contains(role(x)) {
        let error = AXUIElementSetAttributeValue(x, kAXFocusedAttribute as CFString, kCFBooleanTrue)
        if error == .success { fields[thread] = x }
        return outcome(error, ["done": true, "kind": "focused", "role": role(x)], refused: "can't focus that field")
      }
      e = parent(x)
    }
    e = hit
    for _ in 0..<6 {
      guard let x = e else { break }
      if actions(x).contains(kAXPressAction as String) {
        let error = AXUIElementPerformAction(x, kAXPressAction as CFString)
        return outcome(error, ["done": true, "kind": "pressed", "role": role(x)], refused: "press refused")
      }
      e = parent(x)
    }
    return ["done": false, "why": "nothing to press there"]
  case "text":
    guard let text = r["text"] as? String else { return ["done": false, "why": "no text"] }
    // Into the field the agent focused in its own window: no keyboard at all.
    // Refused there: typed instead. Unanswered: it may still land, so never
    // typed a second time.
    if let field = fields[thread] {
      let error = AXUIElementSetAttributeValue(field, kAXSelectedTextAttribute as CFString, text as CFString)
      let inserted = outcome(error, ["done": true, "kind": "inserted"], refused: "")
      if inserted["done"] as? Bool == true || inserted["unknown"] as? Bool == true { return inserted }
    }
    if let why = appLevelSafe(app, ax, agentWindow ?? fields[thread].flatMap(window)) {
      return ["done": false, "why": why]
    }
    post(app.processIdentifier, text: text)
    return ["done": true, "kind": "posted"]
  case "key":
    guard let name = r["key"] as? String, var code = keyCodes[name] else { return ["done": false, "why": "unknown key"] }
    if let why = appLevelSafe(app, ax, agentWindow ?? fields[thread].flatMap(window)) {
      return ["done": false, "why": why]
    }
    var flags = CGEventFlags()
    for m in (r["modifiers"] as? [String]) ?? [] { if let f = modifierFlags[m] { flags.insert(f) } }
    // The key that types this letter or digit on the Mac's own layout.
    if let typed = keyLayout.key(name, flags, us: code) {
      code = typed.0
      if typed.1 { flags.insert(.maskShift) }
    }
    post(app.processIdentifier, key: code, flags: flags)
    return ["done": true, "kind": "posted"]
  case "menu":
    guard let names = r["path"] as? [String], !names.isEmpty else { return ["done": false, "why": "no menu path"] }
    if let why = appLevelSafe(app, ax, agentWindow ?? fields[thread].flatMap(window)) {
      return ["done": false, "why": why]
    }
    guard let bar = attr(ax, kAXMenuBarAttribute) else { return ["done": false, "why": "no menu bar"] }
    var level: AXUIElement = bar as! AXUIElement
    for (i, name) in names.enumerated() {
      var items = (attr(level, kAXChildrenAttribute) as? [AXUIElement]) ?? []
      // A menu bar item or menu item holds its menu as its only child.
      if items.count == 1, role(items[0]) == kAXMenuRole { items = (attr(items[0], kAXChildrenAttribute) as? [AXUIElement]) ?? [] }
      guard let item = items.first(where: { same((attr($0, kAXTitleAttribute) as? String) ?? "", name) }) else {
        return ["done": false, "why": "no menu item \(name)"]
      }
      if i == names.count - 1 {
        if (attr(item, kAXEnabledAttribute) as? Bool) == false { return ["done": false, "why": "\(name) is dimmed"] }
        let error = AXUIElementPerformAction(item, kAXPressAction as CFString)
        return outcome(error, ["done": true, "kind": "menu"], refused: "menu refused")
      }
      level = item
    }
    return ["done": false, "why": "no menu"]
  default:
    return ["done": false, "why": "unknown command"]
  }
}

@main
struct AgentInput {
  static func main() {
    setvbuf(stdout, nil, _IOLBF, 0)
    // Every Accessibility call of this process gives up after 1 s (the default
    // is about 6), well inside the server's 5 s; a change that timed out
    // answers unknown (outcome). A request makes several calls, so the
    // server still treats its own timeout as unknown.
    AXUIElementSetMessagingTimeout(AXUIElementCreateSystemWide(), 1.0)
    signal(SIGTERM, SIG_IGN)
    let termination = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .global())
    termination.setEventHandler { letGo(); exit(0) }
    termination.resume()
    while let line = readLine() {
      guard let data = line.data(using: .utf8),
        let request = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
      else { continue }
      var reply = handle(request)
      reply["id"] = request["id"]
      if let out = try? JSONSerialization.data(withJSONObject: reply),
        let text = String(data: out, encoding: .utf8)
      {
        print(text)
      }
    }
    termination.cancel()
  }
}
