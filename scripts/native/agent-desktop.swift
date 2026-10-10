import AppKit
import ApplicationServices
import Foundation
import ScreenCaptureKit
import Security

// This Mac's screen and input for an agent preset (server/agent-desktop.mjs).
// One process per agent session, fed JSON lines: first the rules, then one
// request at a time (a screenshot, one input action, an app to open, what is
// in front, the app catalog). Every action is checked against exactly what it
// would reach, the window under the pointer or the focused element, right
// before it is posted, in this process. The rules are data from the server
// (server/agent-guard.mjs): the protected apps, Reach's own names and
// addresses, the preset's app set, the owner's hidden apps.
struct Refusal: Error { let message: String; let kind: String }
func refuse(_ message: String, _ kind: String = "blocked") throws -> Never { throw Refusal(message: message, kind: kind) }

// BEGIN PURE DESKTOP POLICY — compiled directly by policy tests without macOS UI.
struct Rules {
  var mode = "view"                 // "full", "apps" (allowedApps only) or "view" (screenshots only)
  var hosts: [String] = []          // Reach's addresses, lowercased
  var titles: [String] = ["reach"]  // words marking Reach's own windows
  var allowedApps: [[String: String]] = []   // Apps preset: {id, bundleId}
  var hiddenApps: [[String: String]] = []    // the owner's extra hidden apps: {id, bundleId, name}
  var protectedAppIds: [String] = []
  var protectedAppNames: [String] = []
  var reachWords: [String] = ["reach", "tailscale", "tailnet"]
  var privatePanes: [String] = []
  var protectedTitleWords: [String] = []
  var protectedPagePatterns: [String] = []
  var terminalLike: [String] = []
  var patterns: [NSRegularExpression] = []
}
let reachReason = "That's Reach. The agent can't use Reach."
let protectedReason = "That holds passwords or controls who may use this Mac. It stays closed to the agent."
let hiddenReason = "The owner hid this app from the agent."
let notAllowedReason = "That's not one of the apps this agent may use."
let secureReason = "That's a password field. Use the Password box so the password stays hidden."
func lower(_ value: String) -> String { value.precomposedStringWithCompatibilityMapping.lowercased() }
// "reach" as a word: Reach.app, com.reach.app, "Reach — node"; not Preacher.
func mentionsReach(_ value: String, _ rules: Rules) -> Bool {
  let text = lower(value)
  for word in rules.reachWords {
    var search = text.startIndex
    while let range = text.range(of: word, range: search..<text.endIndex) {
      let before = range.lowerBound == text.startIndex ? nil : text[text.index(before: range.lowerBound)]
      let after = range.upperBound == text.endIndex ? nil : text[range.upperBound]
      let letter: (Character?) -> Bool = { $0.map { $0.isLetter } ?? false }
      if !letter(before) && !letter(after) { return true }
      search = range.upperBound
    }
  }
  return false
}
func matchesApp(_ bundleId: String, _ path: String, _ entry: [String: String]) -> Bool {
  let id = lower(bundleId), wanted = lower(entry["bundleId"] ?? "")
  if !wanted.isEmpty, !id.isEmpty, id == wanted { return true }
  let want = lower(entry["id"] ?? "")
  return !want.isEmpty && !path.isEmpty && lower(path) == want
}
func fileName(_ path: String) -> String {
  let last = path.split(separator: "/").last.map(String.init) ?? ""
  return lower(last.hasSuffix(".app") ? String(last.dropLast(4)) : last)
}
// Reach, Tailscale, the password stores, the security prompts, the tools that
// stop Reach: never, whatever the preset.
func protectedApp(_ bundleId: String, _ name: String, _ path: String, _ rules: Rules) -> String? {
  let id = lower(bundleId), lname = lower(name), file = fileName(path)
  if mentionsReach("\(id) \(lname) \(file)", rules) { return reachReason }
  if rules.protectedAppIds.contains(where: { id == $0 || id.hasPrefix($0.hasSuffix(".") ? $0 : $0 + ".") }) { return protectedReason }
  if rules.protectedAppNames.contains(lname) || rules.protectedAppNames.contains(file) { return protectedReason }
  return nil
}
func settingsApp(_ bundleId: String) -> Bool {
  ["com.apple.systempreferences", "com.apple.settings"].contains(lower(bundleId))
}
// Which apps the agent may touch at all: the preset's set in Apps mode, every
// app but the protected and hidden ones in Full mode, none in view mode.
func appReason(_ bundleId: String, _ name: String, _ path: String, _ rules: Rules) -> String? {
  if let reason = protectedApp(bundleId, name, path, rules) { return reason }
  if rules.hiddenApps.contains(where: { matchesApp(bundleId, path, $0) || (!($0["name"] ?? "").isEmpty && lower($0["name"]!) == lower(name)) }) { return hiddenReason }
  if rules.mode == "apps" {
    if !rules.allowedApps.contains(where: { matchesApp(bundleId, path, $0) }) { return notAllowedReason }
  }
  return nil
}
// Reach's own windows (by title), System Settings' privacy panes, and the
// windows that show saved passwords or run code.
func mailIdentityCandidate(_ bundleId: String, _ path: String) -> Bool {
  bundleId == "com.apple.mail" && path == "/System/Applications/Mail.app"
}
func titleReason(_ title: String, _ bundleId: String, _ rules: Rules, verifiedMail: Bool = false) -> String? {
  let value = lower(title)
  // Only the native verifier may supply this context. Mail message subjects
  // are not browser/terminal titles; failed or unknown identity stays closed.
  let mailContent = verifiedMail && bundleId == "com.apple.mail"
  if value.isEmpty { return nil }
  if !mailContent && rules.titles.contains(where: { !$0.isEmpty && value.contains($0) }) && mentionsReach(value, rules) { return reachReason }
  if settingsApp(bundleId) && rules.privatePanes.contains(where: value.contains) { return protectedReason }
  for word in rules.protectedTitleWords {
    if word == "keychain", mailContent, value.contains(word) {
      // Keep credential dialogs conservative, including singular "password".
      let credential = #"\b(passwords?|passphrase|unlock|locked|security|access|authentication|permissions?|credentials?|authori[sz]e|sign[ -]?in|log[ -]?in)\b"#
      if value.trimmingCharacters(in: .whitespacesAndNewlines) == word || value.range(of: credential, options: .regularExpression) != nil { return protectedReason }
      continue
    }
    if word == "passwords" { if value == word || value.hasPrefix(word + " ") || value.hasSuffix(" " + word) || value.contains("saved passwords") { return protectedReason } }
    else if value.contains(word) { return protectedReason }
  }
  return nil
}
// Match the server's narrow HTTP(S) exception. Ambiguous input keeps the
// original conservative check; no host alias canonicalization happens here.
func reachHostSubject(_ value: String) -> String {
  func matches(_ pattern: String, _ text: String) -> Bool { text.range(of: pattern, options: .regularExpression) != nil }
  if matches(#"[\s\\"'`<>\x00-\x1f\x7f-\x9f\u200e\u200f\u2028-\u202e\u2066-\u2069]"#, value) || matches(#"%(?![a-f0-9]{2})"#, value) { return value }
  guard let start = value.range(of: #"^https?://"#, options: .regularExpression) else { return value }
  let authority = String(value[start.upperBound...].prefix { !"/?#".contains($0) })
  guard !authority.isEmpty, matches(#"^[a-z0-9.!$&'()*+,;=_~:@\[\]-]+$"#, authority),
    let expression = try? NSRegularExpression(pattern: #"^(?:[^@]*@)?(\[[a-f0-9:.]+\]|[a-z0-9._-]+)(?::([0-9]{1,5}))?$"#),
    let parts = expression.firstMatch(in: authority, range: NSRange(authority.startIndex..., in: authority)),
    let hostRange = Range(parts.range(at: 1), in: authority) else { return value }
  if let portRange = Range(parts.range(at: 2), in: authority), (Int(authority[portRange]) ?? 65536) > 65535 { return value }
  let rawHost = String(authority[hostRange])
  let host = rawHost.hasPrefix("[") ? String(rawHost.dropFirst().dropLast()) : rawHost
  var ipv4 = in_addr(), ipv6 = in6_addr()
  let validIP = rawHost.hasPrefix("[") ? inet_pton(AF_INET6, host, &ipv6) == 1 : inet_pton(AF_INET, host, &ipv4) == 1
  let dns = #"^(?:[a-z0-9_](?:[a-z0-9_-]*[a-z0-9_])?\.)*[a-z_](?:[a-z0-9_-]*[a-z0-9_])?\.?$"#
  if !validIP && (rawHost.hasPrefix("[") || !matches(dns, host)) { return value }
  guard let parsed = URLComponents(string: value), ["http", "https"].contains(parsed.scheme ?? ""),
    !(parsed.host ?? "").isEmpty, parsed.url != nil else { return value }
  return authority
}
// A page address: Reach's own, or one that reveals saved passwords or runs code.
func urlReason(_ url: String, _ rules: Rules) -> String? {
  let value = lower(url).trimmingCharacters(in: .whitespacesAndNewlines)
  if value.isEmpty { return nil }
  let subject = reachHostSubject(value)
  if rules.hosts.contains(where: { !$0.isEmpty && subject.contains($0) }) { return reachReason }
  for pattern in rules.patterns where pattern.firstMatch(in: value, range: NSRange(value.startIndex..., in: value)) != nil { return protectedReason }
  return nil
}
func terminalLikeApp(_ bundleId: String, _ name: String, _ path: String, _ rules: Rules) -> Bool {
  let all = "\(lower(bundleId)) \(lower(name)) \(lower(path))"
  return rules.terminalLike.contains(where: { !$0.isEmpty && all.contains($0) })
}
func compile(_ sources: [String]) -> [NSRegularExpression] {
  sources.compactMap { try? NSRegularExpression(pattern: $0, options: [.caseInsensitive]) }
}
// A compositor surface cannot identify the app that would receive a pointer
// event. Keep its protected-title checks, but require an actual app identity.
func pointerIdentityKnown(_ bundleId: String, _ name: String, _ path: String, _ pid: Int) -> Bool {
  guard pid > 0, !bundleId.isEmpty || !path.isEmpty else { return false }
  let name = lower(name).trimmingCharacters(in: .whitespacesAndNewlines)
  return !["window server", "windowserver"].contains(name) && lower(bundleId) != "com.apple.windowserver"
}
// Command shortcuts can paste clipboard content or invoke autofill. A secure
// field accepts navigation only; entering its content belongs to the owner.
func secureKeyAllowed(_ name: String, _ command: Bool) -> Bool {
  !command && ["tab", "escape", "esc", "return", "enter", "left", "right", "up", "down"].contains(name)
}
// END PURE DESKTOP POLICY

// BEGIN PURE DESKTOP TEXT
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
// END PURE DESKTOP TEXT

// BEGIN NATIVE MAIL IDENTITY — Foundation/Security only; no UI access.
// Do not cache a successful PID: process IDs can be reused. Validate the code
// currently running, its Apple requirement, and its own path each time.
func trustedMailIdentity(_ pid: pid_t, _ bundleId: String, _ path: String) -> Bool {
  guard pid > 0, mailIdentityCandidate(bundleId, path) else { return false }
  var requirement: SecRequirement?
  guard SecRequirementCreateWithString(#"anchor apple and identifier "com.apple.mail""# as CFString, [], &requirement) == errSecSuccess,
    let requirement else { return false }
  var code: SecCode?
  guard SecCodeCopyGuestWithAttributes(nil, [kSecGuestAttributePid: pid] as CFDictionary, [], &code) == errSecSuccess,
    let code, SecCodeCheckValidity(code, [], requirement) == errSecSuccess else { return false }
  var staticCode: SecStaticCode?
  guard SecCodeCopyStaticCode(code, [], &staticCode) == errSecSuccess, let staticCode else { return false }
  var codeURL: CFURL?
  guard SecCodeCopyPath(staticCode, [], &codeURL) == errSecSuccess, let codeURL else { return false }
  return (codeURL as URL).standardizedFileURL.resolvingSymlinksInPath().path == path
}
// END NATIVE MAIL IDENTITY


func out(_ value: [String: Any]) {
  let data = (try? JSONSerialization.data(withJSONObject: value)) ?? Data("{}".utf8)
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write(Data([10]))
}
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
func pidOf(_ element: AXUIElement) -> pid_t { var pid: pid_t = 0; AXUIElementGetPid(element, &pid); return pid }

struct Seen { var bundle = ""; var name = ""; var path = ""; var title = ""; var url = ""; var secure = false; var role = ""; var pid: pid_t = 0 }
func canonical(_ url: URL) -> String { url.standardizedFileURL.resolvingSymlinksInPath().path }
func appInfo(_ pid: pid_t) -> (String, String, String) {
  let app = NSRunningApplication(processIdentifier: pid)
  return (app?.bundleIdentifier ?? "", app?.localizedName ?? "", app?.bundleURL.map(canonical) ?? "")
}
// What an accessibility element belongs to: its app, its window's title, for
// web content the page address, and whether it takes a password.
func seen(_ element: AXUIElement) -> Seen {
  var s = Seen(pid: pidOf(element))
  (s.bundle, s.name, s.path) = appInfo(s.pid)
  s.role = string(element, kAXRoleAttribute)
  let subrole = string(element, kAXSubroleAttribute)
  s.secure = s.role == "AXSecureTextField" || subrole == "AXSecureTextField"
  var node: AXUIElement? = element
  for _ in 0..<60 {
    guard let current = node else { break }
    let role = string(current, kAXRoleAttribute)
    if role == "AXWebArea", s.url.isEmpty { s.url = string(current, "AXURL") }
    if role == kAXWindowRole { s.title = string(current, kAXTitleAttribute); break }
    node = elementAttr(current, kAXParentAttribute)
  }
  if s.title.isEmpty, let window = elementAttr(element, kAXWindowAttribute) { s.title = string(window, kAXTitleAttribute) }
  // A browser's address bar holds the page the next key would reach.
  if s.url.isEmpty, s.role == "AXTextField" || s.role == "AXComboBox" {
    let value = string(element, kAXValueAttribute)
    if value.contains("://") || value.contains(":") { s.url = value }
  }
  return s
}
func windowTitleReason(_ title: String, _ bundleId: String, _ path: String, _ pid: pid_t, _ rules: Rules) -> String? {
  titleReason(title, bundleId, rules, verifiedMail: trustedMailIdentity(pid, bundleId, path))
}
func check(_ s: Seen, _ rules: Rules) throws {
  if let reason = appReason(s.bundle, s.name, s.path, rules) { try refuse(reason) }
  if let reason = windowTitleReason(s.title, s.bundle, s.path, s.pid, rules) { try refuse(reason) }
  if let reason = urlReason(s.url, rules) { try refuse(reason) }
}
// The window server's view of a point: the topmost window there, from any
// layer (menu bar items and the Dock included). Checked as well as accessibility.
func windowAt(_ point: CGPoint) -> Seen? {
  guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] else { return nil }
  for info in list {
    guard let bounds = info[kCGWindowBounds as String] as? [String: CGFloat],
      CGRect(x: bounds["X"] ?? 0, y: bounds["Y"] ?? 0, width: bounds["Width"] ?? 0, height: bounds["Height"] ?? 0).contains(point),
      (info[kCGWindowAlpha as String] as? Double ?? 1) > 0 else { continue }
    let pid = info[kCGWindowOwnerPID as String] as? pid_t ?? 0
    var s = Seen(pid: pid)
    (s.bundle, s.name, s.path) = appInfo(pid)
    if s.name.isEmpty { s.name = info[kCGWindowOwnerName as String] as? String ?? "" }
    s.title = info[kCGWindowName as String] as? String ?? ""
    return s
  }
  return nil
}
// The system's own surfaces: the Dock opens any app, Spotlight and Control
// Center reach everywhere. Full control may use them (except where Reach is);
// the Apps preset may not.
// What the agent never switches from Control Center or the menu bar: the
// network Reach answers through and who may reach this Mac.
let systemGuardedWords = ["wi-fi", "wifi", "vpn", "network", "ethernet", "firewall", "sharing", "airplane"]
let systemGuardedReason = "That control can cut Reach's connection or change who reaches this Mac. It stays with the owner."
let systemSurfaces = ["com.apple.dock", "com.apple.spotlight", "com.apple.controlcenter", "com.apple.systemuiserver", "com.apple.notificationcenterui", "com.apple.windowmanager"]
func checkPoint(_ point: CGPoint, _ rules: Rules, _ expected: [String: String]? = nil) throws -> Seen {
  // Match the same identified observations that authorize the input. A
  // compositor without an app identity is not a conflicting target; Full
  // control still needs a verified AX app (Apps keeps its stricter refusal).
  func checkExpected(_ target: Seen) throws {
    guard let expected, pointerIdentityKnown(target.bundle, target.name, target.path, Int(target.pid)) else { return }
    if target.bundle != expected["bundle"] || (expected["title"] != nil && !target.title.isEmpty && String(target.title.prefix(200)) != expected["title"]) {
      try refuse("The shortcut's target window changed. Look again before continuing.", "retry")
    }
  }
  let window = windowAt(point)
  if let window {
    if rules.mode == "apps", systemSurfaces.contains(lower(window.bundle)) || window.bundle.isEmpty { try refuse(notAllowedReason) }
    if systemSurfaces.contains(lower(window.bundle)) {
      if mentionsReach(window.title, rules) { try refuse(reachReason) }
    } else { try check(window, rules) }
    try checkExpected(window)
  }
  var element: AXUIElement?
  if AXUIElementCopyElementAtPosition(AXUIElementCreateSystemWide(), Float(point.x), Float(point.y), &element) == .success, let element {
    let s = seen(element)
    if systemSurfaces.contains(lower(s.bundle)) {
      if rules.mode == "apps" { try refuse(notAllowedReason) }
      // A Dock item or menu of an app that hosts Reach (Reach's terminal, a Reach tab).
      let label = string(element, kAXTitleAttribute)
      if mentionsReach(label, rules) { try refuse(reachReason) }
      let words = lower([label, string(element, kAXDescriptionAttribute), string(element, kAXHelpAttribute)].joined(separator: " "))
      if mentionsReach(words, rules) { try refuse(reachReason) }
      // Control Center and menu-bar controls that cut the connection Reach
      // answers through, or change who can reach this Mac.
      if systemGuardedWords.contains(where: { words.contains($0) }) { try refuse(systemGuardedReason) }
      // A Dock item or Spotlight result opens an app: that app's own rules
      // apply (protected, hidden, not chosen), as when opening it directly.
      let url = string(element, kAXURLAttribute)
      if url.hasPrefix("file://"), let target = URL(string: url), target.path.hasSuffix(".app") || target.path.hasSuffix(".app/"),
        let bundle = Bundle(url: target) {
        let appName = bundle.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String ?? bundle.object(forInfoDictionaryKey: "CFBundleName") as? String ?? ""
        if let reason = appReason(bundle.bundleIdentifier ?? "", appName, canonical(target), rules) { try refuse(reason) }
      }
      if let app = NSWorkspace.shared.runningApplications.first(where: { !label.isEmpty && $0.localizedName == label }),
        let reason = appReason(app.bundleIdentifier ?? "", app.localizedName ?? "", app.bundleURL.map(canonical) ?? "", rules) { try refuse(reason) }
      if rules.mode != "full", let app = NSWorkspace.shared.runningApplications.first(where: { $0.localizedName == label }), hostsReach(app, rules) { try refuse(reachReason) }
    } else {
      try check(s, rules)
      // Accessibility can't always name an element's window (deep web
      // content). The window server's window here, checked above, names it
      // when it is the same app's. Only an unnamed window falls back to the
      // whole app, where any window showing Reach closes every window.
      let named = window.map { $0.pid == s.pid && !$0.title.isEmpty } ?? false
      if rules.mode != "full", s.title.isEmpty, !named, let app = NSRunningApplication(processIdentifier: pidOf(element)), hostsReach(app, rules) { try refuse(reachReason) }
    }
    if pointerIdentityKnown(s.bundle, s.name, s.path, Int(s.pid)) { try checkExpected(s); return s }
  }
  if let window, pointerIdentityKnown(window.bundle, window.name, window.path, Int(window.pid)) { return window }
  // Full control is light: a point no app claims (the desktop, a compositor
  // layer) stays usable. Named protected targets were refused above.
  if rules.mode == "full", expected == nil { return window ?? Seen() }
  try refuse("The app at this point could not be verified. Look again and retry.", "retry")
}
// Any of this app's windows is Reach's (Reach's terminal, a Reach tab).
func hostsReach(_ app: NSRunningApplication, _ rules: Rules) -> Bool {
  let element = AXUIElementCreateApplication(app.processIdentifier)
  guard let windows = attr(element, kAXWindowsAttribute) as? [AXUIElement] else { return false }
  return windows.contains { windowTitleReason(string($0, kAXTitleAttribute), app.bundleIdentifier ?? "", app.bundleURL.map(canonical) ?? "", app.processIdentifier, rules) == reachReason }
}
struct Focus { let app: NSRunningApplication; let element: Seen; let terminalLike: Bool }
// Keys and text go to the focused element; check it and its app.
// A shortcut (⌘ or ⌃ held) or a navigation key goes to the app in front;
// some apps (Electron) never name a focused element. Text and plain letters
// still need the verified element, so nothing is spelled into a password.
func focus(_ rules: Rules, appOnly: Bool = false) throws -> Focus {
  guard let front = NSWorkspace.shared.frontmostApplication, front.processIdentifier > 0 else { try refuse("Nothing is ready for typing.", "retry") }
  let bundle = front.bundleIdentifier ?? "", name = front.localizedName ?? "", path = front.bundleURL.map(canonical) ?? ""
  if let reason = appReason(bundle, name, path, rules) { try refuse(reason) }
  let app = AXUIElementCreateApplication(front.processIdentifier)
  var s = Seen(bundle: bundle, name: name, path: path, pid: front.processIdentifier)
  if let window = elementAttr(app, kAXFocusedWindowAttribute) { s.title = string(window, kAXTitleAttribute) }
  try check(s, rules)
  // AppKit's foreground observation and Accessibility must identify the same
  // process. Never authorize global keys from a stale or unverifiable app.
  var focusedPid: pid_t = 0
  // Keys go to the focused element, wherever it is. When Accessibility names
  // one, it is judged (its app, window, page, password field), never only the
  // app in front: a password manager's popup or a sign-in prompt can hold
  // focus without being in front. Only an app that names no focused element
  // at all (some Electron apps) falls back to the app in front, for
  // shortcuts or in Full control.
  guard let focused = elementAttr(AXUIElementCreateSystemWide(), kAXFocusedUIElementAttribute),
    AXUIElementGetPid(focused, &focusedPid) == .success, focusedPid > 0 else {
    if appOnly || rules.mode == "full" { return Focus(app: front, element: s, terminalLike: terminalLikeApp(bundle, name, path, rules)) }
    try refuse("The focused app could not be verified. Look again before typing or pressing a key.", "retry")
  }
  let element = seen(focused)
  guard element.pid == focusedPid, focusedPid == front.processIdentifier else {
    guard appOnly || rules.mode == "full", element.pid == focusedPid,
      let owner = NSRunningApplication(processIdentifier: element.pid) else {
      try refuse("The focused app changed while it was checked. Look again before typing or pressing a key.", "retry")
    }
    try check(element, rules)
    return Focus(app: owner, element: element, terminalLike: terminalLikeApp(element.bundle, element.name, element.path, rules))
  }
  try check(element, rules)
  s = element; s.bundle = bundle; s.name = name; s.path = path
  return Focus(app: front, element: s, terminalLike: terminalLikeApp(bundle, name, path, rules))
}
// No longer called: guessing the owner's hands from input timing stopped
// agents when nobody was at the Mac. The owner pauses an agent instead
// (Agents → Pause).
func checkOwner(_ sinceAgent: Double) throws {
  let human = CGEventSource.secondsSinceLastEventType(.hidSystemState, eventType: CGEventType(rawValue: ~0)!)
  if human < 1.5 && human + 0.3 < sinceAgent { try refuse("You're using the Mac. The agent waits until you stop.", "paused") }
}

let keyCodes: [String: CGKeyCode] = [
  "return": 36, "enter": 36, "tab": 48, "space": 49, "delete": 51, "backspace": 51, "escape": 53, "esc": 53,
  "left": 123, "right": 124, "down": 125, "up": 126, "forwarddelete": 117, "home": 115, "end": 119, "pageup": 116, "pagedown": 121,
  "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97, "f7": 98, "f8": 100, "f9": 101, "f10": 109, "f11": 103,
  "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9, "b": 11, "q": 12, "w": 13, "e": 14, "r": 15,
  "y": 16, "t": 17, "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "=": 24, "9": 25, "7": 26, "-": 27, "8": 28, "0": 29,
  "]": 30, "o": 31, "u": 32, "[": 33, "i": 34, "p": 35, "l": 37, "j": 38, "'": 39, "k": 40, ";": 41, "\\": 42, ",": 43, "/": 44,
  "n": 45, "m": 46, ".": 47, "`": 50,
]
let source = CGEventSource(stateID: .privateState)
var lastPosted = Date.distantPast
func post(_ event: CGEvent?, pause: useconds_t = 8000) { event?.post(tap: .cghidEventTap); lastPosted = Date(); if pause > 0 { usleep(pause) } }
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
let browserIds = ["com.apple.safari", "com.google.chrome", "org.chromium", "org.mozilla.firefox", "com.microsoft.edgemac", "com.brave.browser", "company.thebrowser", "com.operasoftware", "com.vivaldi", "com.duckduckgo", "com.kagi"]
func isBrowser(_ bundle: String) -> Bool { let id = lower(bundle); return browserIds.contains(where: { id.hasPrefix($0) }) }

func perform(_ action: [String: Any], _ display: CGRect, _ rules: Rules, _ expected: [String: String]? = nil) throws -> [String: Any] {
  if rules.mode == "view" { try refuse("This agent can only look. It has no mouse or keyboard here.") }
  let type = action["type"] as? String ?? ""
  func point(_ x: String, _ y: String) throws -> CGPoint {
    guard let nx = action[x] as? Double, let ny = action[y] as? Double, (0...1).contains(nx), (0...1).contains(ny) else {
      try refuse("Choose a point on the screen.", "invalid")
    }
    let p = CGPoint(x: display.minX + nx * display.width, y: display.minY + ny * display.height)
    return p
  }
  if let expected {
    let current = front(rules)
    if expected.contains(where: { (current[$0.key] as? String) != $0.value }) || current["secure"] as? Bool == true || !(current["blocked"] as? String ?? "").isEmpty {
      try refuse("The shortcut's app, window or focused field changed. Look again before continuing.", "retry")
    }
  }
  var reached: [String: Any] = [:]
  switch type {
  case "move":
    let p = try point("x", "y")
    _ = try checkPoint(p, rules, expected)
    post(CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: p, mouseButton: .left))
  case "element":
    // A numbered label: its live center, then an ordinary checked click.
    guard let snap = action["snapshot"] as? String, let n = action["n"] as? Int,
      let list = snapshots.last(where: { $0.id == snap })?.elements, n >= 1, n <= list.count else {
      try refuse("That label is from an older look. Look at the labels again.", "retry")
    }
    guard let rect = frameOf(list[n - 1]), rect.width > 0, rect.height > 0 else { try refuse("That element is gone. Look again.", "retry") }
    let visible = rect.intersection(display)
    guard !visible.isNull, visible.width >= 1, visible.height >= 1 else { try refuse("That element is out of view. Scroll to it first.", "retry") }
    var click: [String: Any] = ["type": "click", "x": Double((visible.midX - display.minX) / display.width), "y": Double((visible.midY - display.minY) / display.height)]
    if let button = action["button"] { click["button"] = button }
    if let count = action["count"] { click["count"] = count }
    return try perform(click, display, rules, expected)
  case "click":
    let p = try point("x", "y")
    let target = try checkPoint(p, rules, expected)
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
    reached = ["app": target.name, "bundle": target.bundle]
  case "drag":
    let from = try point("x", "y"), to = try point("toX", "toY")
    _ = try checkPoint(from, rules, expected)
    _ = try checkPoint(to, rules, expected)
    post(CGEvent(mouseEventSource: source, mouseType: .leftMouseDown, mouseCursorPosition: from, mouseButton: .left))
    for step in 1...12 {
      let t = CGFloat(step) / 12
      post(CGEvent(mouseEventSource: source, mouseType: .leftMouseDragged,
        mouseCursorPosition: CGPoint(x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t), mouseButton: .left))
    }
    post(CGEvent(mouseEventSource: source, mouseType: .leftMouseUp, mouseCursorPosition: to, mouseButton: .left))
  case "scroll":
    let p = try point("x", "y")
    _ = try checkPoint(p, rules, expected)
    let dx = Int32(max(-2000, min(2000, action["dx"] as? Double ?? 0)))
    let dy = Int32(max(-2000, min(2000, action["dy"] as? Double ?? 0)))
    post(CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: p, mouseButton: .left))
    post(CGEvent(scrollWheelEvent2Source: source, units: .pixel, wheelCount: 2, wheel1: -dy, wheel2: -dx, wheel3: 0))
  case "type":
    guard let text = action["text"] as? String, !text.isEmpty, text.utf16.count <= 2000 else { try refuse("Type up to 2000 characters.", "invalid") }
    let target = try focus(rules)
    // Vault values (username, email, password) may go into any field but a
    // terminal; ordinary text never goes into a password field.
    let secret = action["secret"] as? Bool == true
    if target.element.secure && !secret { try refuse(secureReason) }
    if secret && target.terminalLike { try refuse("Vault values don't go into a terminal. Click the sign-in field first.") }
    // The server checked the text as prose or as a command; if the focus
    // moved to a terminal since, it must look again.
    if target.terminalLike && action["terminalLikeChecked"] as? Bool != true { try refuse("A terminal is in front now. Try again.", "retry") }
    for line in text.components(separatedBy: "\n").enumerated() {
      if line.offset > 0 {
        post(CGEvent(keyboardEventSource: source, virtualKey: 36, keyDown: true))
        post(CGEvent(keyboardEventSource: source, virtualKey: 36, keyDown: false))
      }
      for chunk in keyboardChunks(line.element) {
        // A character at a time, quickly: down and up, then a short breath.
        for down in [true, false] {
          let event = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: down)
          event?.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: chunk)
          post(event, pause: down ? 0 : 3000)
        }
      }
    }
    reached = ["app": target.app.localizedName ?? "", "bundle": target.app.bundleIdentifier ?? ""]
  case "key":
    guard let name = (action["key"] as? String)?.lowercased(), let code = keyCodes[name] else { try refuse("Unknown key.", "invalid") }
    let mods = action["modifiers"] as? [String] ?? []
    let shortcut = flags(mods)
    let chord = shortcut.contains(.maskCommand) || shortcut.contains(.maskControl)
    let target = try focus(rules, appOnly: chord || ["tab", "escape", "esc", "left", "right", "up", "down", "home", "end", "pageup", "pagedown"].contains(name))
    let command = shortcut.contains(.maskCommand), option = shortcut.contains(.maskAlternate)
    // ⌘Q or ⌘W on a window holding Reach would close Reach.
    if command, ["q", "w"].contains(name), hostsReach(target.app, rules) { try refuse(reachReason) }
    // The developer tools read a page's passwords and run code.
    if isBrowser(target.app.bundleIdentifier ?? ""), (command && option && ["i", "j", "c"].contains(name)) || name == "f12" { try refuse(protectedReason) }
    if target.element.secure, !secureKeyAllowed(name, command) { try refuse(secureReason) }
    for down in [true, false] {
      let event = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: down)
      event?.flags = shortcut
      post(event)
    }
    reached = ["app": target.app.localizedName ?? "", "bundle": target.app.bundleIdentifier ?? ""]
  default:
    try refuse("Unknown action.", "invalid")
  }
  reached["ok"] = true
  return reached
}

@available(macOS 14.0, *)
func shot(_ rules: Rules, _ maxWidth: Int) async throws -> [String: Any] {
  let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
  guard let display = content.displays.first(where: { $0.displayID == CGMainDisplayID() }) ?? content.displays.first else {
    try refuse("No screen to show.", "unavailable")
  }
  let filter: SCContentFilter
  // A selected app can itself host Reach or a password-manager window.
  // Apply these exclusions in Apps mode as well as full-screen modes.
  let excluded = content.windows.filter { window in
    let app = window.owningApplication
    let path = app.flatMap { NSRunningApplication(processIdentifier: $0.processID)?.bundleURL.map(canonical) } ?? ""
    // Mission Control, App Exposé and Launchpad draw every window's preview
    // in the Dock's own full-screen layer: left out, so what is hidden stays
    // hidden there too.
    let dockOverlay = lower(app?.bundleIdentifier ?? "") == "com.apple.dock" && window.windowLayer > 0 &&
      window.frame.width >= display.frame.width * 0.9 && window.frame.height >= display.frame.height * 0.9
    return dockOverlay || appReason(app?.bundleIdentifier ?? "", app?.applicationName ?? "", path, rules) != nil ||
      windowTitleReason(window.title ?? "", app?.bundleIdentifier ?? "", path, app?.processID ?? 0, rules) != nil
  }
  var hidden = 0
  if rules.mode == "apps" {
    // Only the preset's apps appear; the rest of the screen is black.
    let apps = content.applications.filter { app in rules.allowedApps.contains(where: { matchesApp(app.bundleIdentifier, "", $0) }) }
    filter = SCContentFilter(display: display, including: apps, exceptingWindows: excluded)
    hidden = content.windows.count - content.windows.filter { window in
      apps.contains(where: { $0.processID == window.owningApplication?.processID }) && !excluded.contains(where: { $0.windowID == window.windowID })
    }.count
  } else {
    // Reach's windows, the protected apps and the owner's hidden apps are left out.
    filter = SCContentFilter(display: display, excludingWindows: excluded)
    hidden = excluded.count
  }
  let config = SCStreamConfiguration()
  // The display's own pixels (Retina is 2x its points), capped by maxWidth:
  // small controls stay legible to an agent aiming at them.
  let backing = NSScreen.screens.first { screen in
    (screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value == display.displayID
  }?.backingScaleFactor ?? 1
  let scale = min(Double(backing), Double(maxWidth) / Double(display.width))
  config.width = max(1, Int(Double(display.width) * scale))
  config.height = max(1, Int(Double(display.height) * scale))
  config.showsCursor = true
  config.capturesAudio = false
  let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
  let bitmap = NSBitmapImageRep(cgImage: image)
  guard let data = bitmap.representation(using: .jpeg, properties: [.compressionFactor: 0.7]), data.count < 6 * 1024 * 1024 else {
    try refuse("The screen couldn't be encoded.", "unavailable")
  }
  return ["ok": true, "jpeg": data.base64EncodedString(), "width": image.width, "height": image.height, "hidden": hidden,
    "displayWidth": Int(display.width), "displayHeight": Int(display.height)]
}

// Every app on this Mac: running ones first, then the Applications folders.
func catalog() -> [String: Any] {
  let running = Dictionary(uniqueKeysWithValues: NSWorkspace.shared.runningApplications
    .filter { $0.activationPolicy == .regular }.compactMap { app in app.bundleURL.map { (canonical($0), true) } }.filter { $0.0.hasSuffix(".app") }.reversed())
  var paths = Set(running.keys)
  let fm = FileManager.default
  for root in ["/Applications", "/System/Applications", "/System/Applications/Utilities", NSHomeDirectory() + "/Applications"] {
    guard let entries = try? fm.contentsOfDirectory(atPath: root) else { continue }
    for entry in entries.prefix(500) {
      let full = root + "/" + entry
      if entry.hasSuffix(".app") { paths.insert(canonical(URL(fileURLWithPath: full))) }
      else if !entry.hasPrefix("."), let nested = try? fm.contentsOfDirectory(atPath: full) {
        for child in nested.prefix(100) where child.hasSuffix(".app") { paths.insert(canonical(URL(fileURLWithPath: full + "/" + child))) }
      }
    }
  }
  let apps: [[String: Any]] = paths.sorted().prefix(1024).compactMap { path in
    guard let bundle = Bundle(path: path), let bundleId = bundle.bundleIdentifier else { return nil }
    let name = bundle.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String ?? bundle.object(forInfoDictionaryKey: "CFBundleName") as? String ?? URL(fileURLWithPath: path).deletingPathExtension().lastPathComponent
    return ["id": path, "name": String(name.prefix(100)), "bundleId": bundleId, "running": running[path] ?? false]
  }
  return ["ok": true, "apps": apps]
}
// Open or bring forward one app, by its path, within the rules.
func open(_ path: String, _ rules: Rules) throws -> [String: Any] {
  if rules.mode == "view" { try refuse("This agent can only look.") }
  guard path.hasPrefix("/"), path.hasSuffix(".app"), let bundle = Bundle(path: path), let bundleId = bundle.bundleIdentifier else { try refuse("Choose an app on this Mac.", "invalid") }
  let name = bundle.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String ?? bundle.object(forInfoDictionaryKey: "CFBundleName") as? String ?? ""
  if let reason = appReason(bundleId, name, canonical(URL(fileURLWithPath: path)), rules) { try refuse(reason) }
  let configuration = NSWorkspace.OpenConfiguration()
  configuration.activates = true
  let done = DispatchSemaphore(value: 0)
  var failure: Error?
  var opened: NSRunningApplication?
  NSWorkspace.shared.openApplication(at: URL(fileURLWithPath: path), configuration: configuration) { app, error in opened = app; failure = error; done.signal() }
  if done.wait(timeout: .now() + 8) == .timedOut { try refuse("The app is taking too long to open.", "retry") }
  if failure != nil { try refuse("The app couldn't be opened.", "unavailable") }
  lastPosted = Date()
  return ["ok": true, "app": name, "bundle": bundleId, "front": waitFront(bundleId, opened)]
}
// "Opened" means in front: the agent's next click or key goes there. macOS
// may hold a background helper's activation back, so ask once more through
// Accessibility, and wait for it to land before answering.
func waitFront(_ bundleId: String, _ opened: NSRunningApplication?) -> Bool {
  let front = { NSWorkspace.shared.frontmostApplication?.bundleIdentifier == bundleId }
  let deadline = Date().addingTimeInterval(1.5)
  var nudged = false
  while !front() && Date() < deadline {
    if !nudged, Date() > deadline.addingTimeInterval(-1.2), let app = opened ?? NSRunningApplication.runningApplications(withBundleIdentifier: bundleId).first {
      AXUIElementSetAttributeValue(AXUIElementCreateApplication(app.processIdentifier), kAXFrontmostAttribute as CFString, kCFBooleanTrue)
      nudged = true
    }
    RunLoop.current.run(until: Date().addingTimeInterval(0.05))
  }
  return front()
}
// A website in the owner's own browser (their cookies and sign-ins): the
// default browser for web links, or a chosen one. Reach's own pages and the
// pages that show saved passwords stay closed, as when typing an address.
func openURL(_ text: String, _ browserPath: String, _ rules: Rules) throws -> [String: Any] {
  if rules.mode == "view" { try refuse("This agent can only look.") }
  guard text.utf8.count <= 2048, let url = URL(string: text), ["http", "https"].contains(url.scheme?.lowercased() ?? ""),
    !(url.host ?? "").isEmpty else { try refuse("Give a web address that starts with https://.", "invalid") }
  if let reason = urlReason(text, rules) { try refuse(reason) }
  let appURL = browserPath.isEmpty ? NSWorkspace.shared.urlForApplication(toOpen: url) : URL(fileURLWithPath: browserPath)
  guard let appURL, appURL.path.hasSuffix(".app"), let bundle = Bundle(url: appURL), let bundleId = bundle.bundleIdentifier else {
    try refuse("There is no browser to open it in.", "unavailable")
  }
  let name = bundle.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String ?? bundle.object(forInfoDictionaryKey: "CFBundleName") as? String ?? ""
  guard isBrowser(bundleId) else { try refuse("Open websites in a web browser.", "invalid") }
  if let reason = appReason(bundleId, name, canonical(appURL), rules) { try refuse(reason) }
  let configuration = NSWorkspace.OpenConfiguration()
  configuration.activates = true
  let done = DispatchSemaphore(value: 0)
  var failure: Error?
  var opened: NSRunningApplication?
  NSWorkspace.shared.open([url], withApplicationAt: appURL, configuration: configuration) { app, error in opened = app; failure = error; done.signal() }
  if done.wait(timeout: .now() + 8) == .timedOut { try refuse("The browser is taking too long to open.", "retry") }
  if failure != nil { try refuse("The website couldn't be opened.", "unavailable") }
  lastPosted = Date()
  return ["ok": true, "app": name, "bundle": bundleId, "front": waitFront(bundleId, opened)]
}
// What is in front right now: for the owner's "using X" line and for the
// server's check of typed text (a terminal takes commands).

// Numbered elements: what can be clicked in the front window, read from the
// accessibility tree. The agent picks one by number; the click lands at its
// live center through the same checks as any click (perform "element").
var snapshots: [(id: String, elements: [AXUIElement])] = []
let labelRoles: Set<String> = ["AXButton", "AXLink", "AXCheckBox", "AXRadioButton", "AXPopUpButton", "AXMenuButton",
  "AXComboBox", "AXTextField", "AXTextArea", "AXSecureTextField", "AXSearchField", "AXMenuItem", "AXMenuBarItem",
  "AXTab", "AXDisclosureTriangle", "AXIncrementor", "AXSlider", "AXSwitch", "AXToggle", "AXDockItem"]
func frameOf(_ element: AXUIElement) -> CGRect? {
  var p = CGPoint.zero, size = CGSize.zero
  guard let position = attr(element, kAXPositionAttribute), CFGetTypeID(position) == AXValueGetTypeID(),
    let extent = attr(element, kAXSizeAttribute), CFGetTypeID(extent) == AXValueGetTypeID(),
    AXValueGetValue(position as! AXValue, .cgPoint, &p), AXValueGetValue(extent as! AXValue, .cgSize, &size) else { return nil }
  return CGRect(origin: p, size: size)
}
func labelName(_ element: AXUIElement, _ role: String, secure: Bool) -> String {
  var parts = [string(element, kAXTitleAttribute), string(element, kAXDescriptionAttribute)]
  if role == "AXTextField" || role == "AXTextArea" || role == "AXSearchField" || role == "AXComboBox" || secure {
    parts.append(string(element, kAXPlaceholderValueAttribute))
  } else if ["AXButton", "AXLink", "AXPopUpButton", "AXMenuButton", "AXTab", "AXRadioButton", "AXCheckBox"].contains(role) {
    parts.append(string(element, kAXValueAttribute))
  }
  let known = ["AXCloseButton": "Close window", "AXMinimizeButton": "Minimize", "AXZoomButton": "Zoom window",
    "AXFullScreenButton": "Full screen", "AXToolbarButton": "Toolbar"]
  if let named = known[string(element, kAXSubroleAttribute)] { parts.insert(named, at: 0) }
  parts.append(string(element, kAXHelpAttribute))
  let name = parts.map { $0.split(whereSeparator: \.isWhitespace).joined(separator: " ") }.first { !$0.isEmpty } ?? ""
  return String(name.prefix(60))
}
func elements(_ rules: Rules) throws -> [String: Any] {
  if rules.mode == "view" { try refuse("This agent can only look.") }
  guard let front = NSWorkspace.shared.frontmostApplication, front.processIdentifier > 0 else { try refuse("Nothing is in front.", "retry") }
  let bundle = front.bundleIdentifier ?? "", name = front.localizedName ?? "", path = front.bundleURL.map(canonical) ?? ""
  if let reason = appReason(bundle, name, path, rules) { try refuse(reason) }
  let app = AXUIElementCreateApplication(front.processIdentifier)
  // Chromium and Electron build their web trees only for assistive apps.
  AXUIElementSetAttributeValue(app, "AXManualAccessibility" as CFString, kCFBooleanTrue)
  let display = CGDisplayBounds(CGMainDisplayID())
  var found: [(AXUIElement, String, String, Bool, CGRect)] = []
  // The screen as text too: what a person reads there, in the same walk.
  var texts: [(String, CGRect)] = [], headings: [CGRect] = [], values: [Int: String] = [:]
  var textChars = 0
  var roots: [AXUIElement] = []
  var windowTitle = ""
  if let window = elementAttr(app, kAXFocusedWindowAttribute) ?? elementAttr(app, kAXMainWindowAttribute) {
    var s = Seen(bundle: bundle, name: name, path: path, pid: front.processIdentifier)
    s.title = string(window, kAXTitleAttribute)
    try check(s, rules)
    windowTitle = String(s.title.prefix(200))
    roots.append(window)
  }
  if let menu = elementAttr(app, kAXMenuBarAttribute) { roots.append(menu) }
  var stack = roots.reversed() as [AXUIElement]
  var visited = 0
  let deadline = Date().addingTimeInterval(0.8)
  while let node = stack.popLast(), visited < 6000, found.count < 400, Date() < deadline {
    visited += 1
    let role = string(node, kAXRoleAttribute)
    if role == "AXWebArea", urlReason(string(node, "AXURL"), rules) != nil { continue }
    if role == "AXMenu" { continue } // closed menus' items are not on screen
    let subrole = string(node, kAXSubroleAttribute)
    let secure = role == "AXSecureTextField" || subrole == "AXSecureTextField"
    if role == "AXHeading", let rect = frameOf(node) { headings.append(rect) }
    if role == "AXStaticText", texts.count < 500, textChars < 20000 {
      let words = (string(node, kAXValueAttribute).isEmpty ? string(node, kAXTitleAttribute) : string(node, kAXValueAttribute))
        .split(whereSeparator: \.isWhitespace).joined(separator: " ")
      if !words.isEmpty, let rect = frameOf(node), rect.width >= 1, rect.height >= 1 {
        let visible = rect.intersection(display)
        if !visible.isNull, visible.height >= 2 {
          let line = String(words.prefix(300))
          texts.append((line, visible))
          textChars += line.count
        }
      }
      continue
    }
    if labelRoles.contains(role) || secure {
      if let rect = frameOf(node), rect.width >= 4, rect.height >= 4 {
        let visible = rect.intersection(display)
        if !visible.isNull, visible.width >= 2, visible.height >= 2, attr(node, kAXEnabledAttribute) as? Bool != false {
          // What a field holds is on screen already; a password field's never.
          if !secure, ["AXTextField", "AXTextArea", "AXSearchField", "AXComboBox"].contains(role) {
            let value = string(node, kAXValueAttribute).split(whereSeparator: \.isWhitespace).joined(separator: " ")
            if !value.isEmpty { values[found.count] = String(value.prefix(120)) }
          }
          found.append((node, role, labelName(node, role, secure: secure), secure, visible))
        }
      }
      // A control's own parts (a link's text, a button's image) are the control.
      if role != "AXMenuBarItem" { continue }
    }
    if let children = attr(node, kAXChildrenAttribute) as? [AXUIElement] { stack.append(contentsOf: children.reversed()) }
  }
  // Reading order: rows from the top, left to right inside a row.
  let order = { (a: CGRect, b: CGRect) -> Bool in
    let ay = (a.midY / 12).rounded(), by = (b.midY / 12).rounded()
    return ay != by ? ay < by : a.minX < b.minX
  }
  let indexed = found.enumerated().map { ($0.offset, $0.element) }.sorted { order($0.1.4, $1.1.4) }
  found = indexed.map { $0.1 }
  let foundValues = Dictionary(uniqueKeysWithValues: indexed.enumerated().compactMap { position, entry in values[entry.0].map { (position, $0) } })
  texts.sort { order($0.1, $1.1) }
  let kept = Array(found.prefix(250))
  let id = UUID().uuidString.prefix(8).lowercased()
  snapshots.append((id: String(id), elements: kept.map { $0.0 }))
  if snapshots.count > 4 { snapshots.removeFirst(snapshots.count - 4) }
  let place = { (rect: CGRect) -> [String: Any] in
    ["x": Double((rect.minX - display.minX) / display.width), "y": Double((rect.minY - display.minY) / display.height),
     "w": Double(rect.width / display.width), "h": Double(rect.height / display.height)]
  }
  let items: [[String: Any]] = kept.enumerated().map { index, item in
    var entry: [String: Any] = ["n": index + 1, "role": String(item.1.dropFirst(2)), "name": item.2, "secure": item.3]
    if let value = foundValues[index] { entry["value"] = value }
    return entry.merging(place(item.4)) { first, _ in first }
  }
  let lines: [[String: Any]] = texts.map { text, rect in
    var entry: [String: Any] = ["text": text]
    if headings.contains(where: { $0.contains(CGPoint(x: rect.midX, y: rect.midY)) }) { entry["heading"] = true }
    return entry.merging(place(rect)) { first, _ in first }
  }
  return ["ok": true, "snapshot": String(id), "app": name, "title": windowTitle, "items": items, "texts": lines,
          "truncated": found.count > kept.count || visited >= 6000 || texts.count >= 500 || textChars >= 20000]
}

func front(_ rules: Rules) -> [String: Any] {
  guard let app = NSWorkspace.shared.frontmostApplication else { return ["ok": true, "app": "", "bundle": ""] }
  let bundle = app.bundleIdentifier ?? "", name = app.localizedName ?? "", path = app.bundleURL.map(canonical) ?? ""
  var s = Seen(bundle: bundle, name: name, path: path, pid: app.processIdentifier)
  if let window = elementAttr(AXUIElementCreateApplication(app.processIdentifier), kAXFocusedWindowAttribute) { s.title = string(window, kAXTitleAttribute) }
  if let focused = elementAttr(AXUIElementCreateSystemWide(), kAXFocusedUIElementAttribute), pidOf(focused) == app.processIdentifier {
    let element = seen(focused); s.url = element.url; s.secure = element.secure
  }
  let blocked = appReason(bundle, name, path, rules) ?? windowTitleReason(s.title, bundle, path, s.pid, rules) ?? urlReason(s.url, rules)
  // An app the owner hid from the agent: not even its name (security audit L6).
  if blocked == hiddenReason {
    return ["ok": true, "app": "", "bundle": "", "title": "", "terminalLike": false, "secure": false, "blocked": hiddenReason, "path": "", "layout": ""]
  }
  // Geometry and focus identity, without field values, let saved actions stop
  // when the window moves or the focused control changes.
  var layout = ""
  func geometry(_ element: AXUIElement) -> String {
    var p = CGPoint.zero, size = CGSize.zero
    if let value = attr(element, kAXPositionAttribute), CFGetTypeID(value) == AXValueGetTypeID() { AXValueGetValue(value as! AXValue, .cgPoint, &p) }
    if let value = attr(element, kAXSizeAttribute), CFGetTypeID(value) == AXValueGetTypeID() { AXValueGetValue(value as! AXValue, .cgSize, &size) }
    return "\(Int(p.x)),\(Int(p.y)),\(Int(size.width)),\(Int(size.height))"
  }
  let display = CGDisplayBounds(CGMainDisplayID())
  layout = "\(Int(display.width)),\(Int(display.height))"
  if let window = elementAttr(AXUIElementCreateApplication(app.processIdentifier), kAXFocusedWindowAttribute) { layout += "|" + geometry(window) }
  if let focused = elementAttr(AXUIElementCreateSystemWide(), kAXFocusedUIElementAttribute), pidOf(focused) == app.processIdentifier {
    layout += "|" + geometry(focused) + "|" + string(focused, kAXRoleAttribute) + "|" + string(focused, kAXIdentifierAttribute)
  }
  return ["ok": true, "app": name, "bundle": bundle, "title": blocked == nil ? String(s.title.prefix(200)) : "",
    "terminalLike": terminalLikeApp(bundle, name, path, rules), "secure": s.secure, "blocked": blocked ?? "", "path": path, "layout": String(layout.prefix(2000))]
}

func rules(from request: [String: Any]) -> Rules {
  var r = Rules()
  func strings(_ key: String) -> [String] { (request[key] as? [String] ?? []).map(lower) }
  func apps(_ key: String) -> [[String: String]] {
    (request[key] as? [[String: Any]] ?? []).map { entry in
      Dictionary(uniqueKeysWithValues: entry.compactMap { key, value in (value as? String).map { (key, $0) } })
    }
  }
  r.mode = ["full", "apps", "view"].contains(request["mode"] as? String ?? "") ? request["mode"] as! String : "view"
  r.hosts = strings("hosts"); r.titles = strings("titles").isEmpty ? ["reach"] : strings("titles")
  r.allowedApps = apps("allowedApps"); r.hiddenApps = apps("hiddenApps")
  r.protectedAppIds = strings("protectedAppIds"); r.protectedAppNames = strings("protectedAppNames")
  if !strings("reachWords").isEmpty { r.reachWords = strings("reachWords") }
  r.privatePanes = strings("privatePanes"); r.protectedTitleWords = strings("protectedTitleWords")
  r.protectedPagePatterns = request["protectedPagePatterns"] as? [String] ?? []
  r.terminalLike = strings("terminalLike")
  r.patterns = compile(r.protectedPagePatterns)
  return r
}

@main struct Main {
  static func main() async {
    var current: Rules?
    signal(SIGTERM, SIG_IGN)
    let termination = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .global())
    termination.setEventHandler { exit(0) }
    termination.resume()
    while let line = readLine() {
      do {
        guard line.utf8.count <= 262144, let data = line.data(using: .utf8),
          let request = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { try refuse("Invalid request.", "invalid") }
        let op = request["op"] as? String ?? ""
        if op == "rules" {
          current = rules(from: request)
          out(["ok": true, "accessibility": AXIsProcessTrusted(), "screen": CGPreflightScreenCaptureAccess(), "mode": current!.mode])
          continue
        }
        if op == "catalog" { out(catalog()); continue }
        guard let rules = current else { try refuse("Rules come first.", "invalid") }
        guard #available(macOS 14.0, *) else { try refuse("Screen access for agents needs macOS 14 or later.", "unavailable") }
        switch op {
        case "shot":
          guard CGPreflightScreenCaptureAccess() else { try refuse("Reach needs Screen Recording to show the Mac to an agent.", "unavailable") }
          out(try await shot(rules, max(320, min(3840, request["maxWidth"] as? Int ?? 2560))))
        case "act":
          guard AXIsProcessTrusted() else { try refuse("Reach needs Accessibility to let an agent use this Mac.", "unavailable") }
          guard let action = request["action"] as? [String: Any] else { try refuse("Choose an action.", "invalid") }
          out(try perform(action, CGDisplayBounds(CGMainDisplayID()), rules, request["expected"] as? [String: String]))
        case "open":
          guard AXIsProcessTrusted() else { try refuse("Reach needs Accessibility to let an agent use this Mac.", "unavailable") }
          out(try open(request["app"] as? String ?? "", rules))
        case "front":
          out(front(rules))
        case "open-url":
          guard AXIsProcessTrusted() else { try refuse("Reach needs Accessibility to let an agent use this Mac.", "unavailable") }
          out(try openURL(request["url"] as? String ?? "", request["app"] as? String ?? "", rules))
        case "elements":
          guard AXIsProcessTrusted() else { try refuse("Reach needs Accessibility to let an agent use this Mac.", "unavailable") }
          out(try elements(rules))
        case "browser-check":
          guard AXIsProcessTrusted() else { try refuse("Reach needs Accessibility to let an agent use this Mac.", "unavailable") }
          let path = request["app"] as? String ?? ""
          guard rules.mode != "view", path.hasPrefix("/"), path.hasSuffix(".app"),
            let bundle = Bundle(path: path), let id = bundle.bundleIdentifier,
            ["com.google.Chrome", "com.apple.Safari"].contains(id) else { try refuse("Choose Chrome or Safari within this agent's app access.", "blocked") }
          let name = bundle.object(forInfoDictionaryKey: "CFBundleName") as? String ?? ""
          if let reason = appReason(id, name, canonical(URL(fileURLWithPath: path)), rules) { try refuse(reason) }
          // Check the permission without sending an event or displaying a consent
          // dialog to a guest. TCC attributes this helper to the app running Reach.
          if !NSRunningApplication.runningApplications(withBundleIdentifier: id).isEmpty {
            let target = NSAppleEventDescriptor(bundleIdentifier: id)
            let permission = AEDeterminePermissionToAutomateTarget(target.aeDesc, AEEventClass(typeWildCard), AEEventID(typeWildCard), false)
            if permission == errAEEventNotPermitted || permission == errAEEventWouldRequireUserConsent {
              try refuse("The owner needs to allow Reach’s Terminal to control \(name) in System Settings → Privacy & Security → Automation.", "setup_required")
            }
            guard permission == noErr else { try refuse("\(name) is not ready for browser tools. The owner should open a browser window and try again.", "setup_required") }
          }
          out(["ok": true, "app": name, "bundle": id])
        default:
          try refuse("Unknown request.", "invalid")
        }
      } catch let refusal as Refusal {
        out(["error": refusal.message, "kind": refusal.kind])
      } catch {
        out(["error": "The Mac couldn't do that.", "kind": "unavailable"])
      }
    }
    termination.cancel()
  }
}
