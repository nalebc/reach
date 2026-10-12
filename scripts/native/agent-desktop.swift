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
struct Refusal: Error { let message: String; let kind: String; var candidates: [[String: String]] = [] }
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
  var moneySites: [String] = []                    // bank sites (server/money-sites.mjs)
  var money: [String: NSRegularExpression] = [:]   // their words, by kind (moneyPatterns)
  var moneyReadWords: Set<String> = []             // the words a bank page's buttons may say
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
  if rules.mode == "full" { return nil }
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
  if rules.mode == "full" { return nil }
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
  if rules.mode == "full" { return nil }
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
// Whether a numbered control has been covered since the agent looked: what
// is under its center belongs to another app, or sits in a dialog, sheet,
// menu or popover the control isn't in. Then a click meant for it would
// land on that instead, so none is sent (batched actions included). Other
// things of the same page under the point (a card's own link) take the
// click as a real one would.
func coveredControl<T>(_ hit: T, _ target: T, parent: (T) -> T?, equal: (T, T) -> Bool,
                       sameApp: (T, T) -> Bool, overlay: (T) -> Bool) -> Bool {
  func chain(_ start: T) -> [T] {
    var out = [start]
    while out.count < 40, let up = parent(out[out.count - 1]) { out.append(up) }
    return out
  }
  if !sameApp(hit, target) { return true }
  let hits = chain(hit), targets = chain(target)
  if hits.contains(where: { equal($0, target) }) || targets.contains(where: { equal($0, hit) }) { return false }
  // Up from what's under the point, until the branch the control is in.
  for element in hits {
    if targets.contains(where: { equal($0, element) }) { break }
    if overlay(element) { return true }
  }
  return false
}
// How well a control on screen matches the name the agent gave: the same
// (ignoring case and spacing) grades 3, starting with it 2, containing it 1,
// nothing 0.
func nameMatch(_ name: String, _ wanted: String) -> Int {
  let squeeze = { (text: String) in lower(text).split(whereSeparator: \.isWhitespace).joined(separator: " ") }
  let have = squeeze(name), want = squeeze(wanted)
  if have.isEmpty || want.isEmpty { return 0 }
  if have == want { return 3 }
  if have.hasPrefix(want) { return 2 }
  if have.contains(want) { return 1 }
  return 0
}
// Which control the agent means, from each one's grade and its distance from
// where the control was last seen (infinite when nowhere in particular): the
// best grade; among equals, one clearly nearer than the rest. Otherwise none,
// with how many were equally good, so the agent says which.
func pickControl(_ graded: [(grade: Int, distance: Double)]) -> (index: Int?, candidates: Int) {
  let best = graded.map { $0.grade }.max() ?? 0
  if best == 0 { return (nil, 0) }
  let top = graded.enumerated().filter { $0.element.grade == best }
  if top.count == 1 { return (top[0].offset, 1) }
  let nearest = top.sorted { $0.element.distance < $1.element.distance }
  if nearest[0].element.distance.isFinite, nearest[1].element.distance > nearest[0].element.distance + 24 { return (nearest[0].offset, top.count) }
  return (nil, top.count)
}
// What the agent typed from its vault, wherever the screen shows it again (a
// field's value, "Signed in as …"): dots before the agent reads it. Values
// under three characters aren't tracked: they would blank ordinary text.
func hideSecrets(_ text: String, _ secrets: [String]) -> String {
  var out = text
  for secret in secrets where secret.count >= 3 && out.range(of: secret, options: .caseInsensitive) != nil {
    out = out.replacingOccurrences(of: secret, with: "•••", options: .caseInsensitive)
  }
  return out
}
// Bank, card, brokerage and payment sites (server/money-sites.mjs, the same
// rules and test corpus): the agent signs in from its vault, reads, searches,
// filters by date, downloads and signs out. Nothing that moves money or
// changes the account. A rule that didn't arrive refuses; so does a page, a
// control or a field that can't be read.
let moneyReason = "On a bank site the agent reads, downloads and signs in or out. It doesn't move money or change the account."
let moneyLabelReason = "On a bank site the agent presses only controls it can read. This one has no name."
let moneyFieldReason = "On a bank site the agent types only into sign-in, code, search and date fields."
let moneyPageReason = "This bank page moves money. The agent may read it and leave (Back, Accounts, Sign out), nothing else."
let moneyButtonReason = "On a bank site the agent presses only what reads, downloads, filters, opens an account or signs out."
let moneyPasteReason = "On a bank site the agent doesn't paste or drag."
let moneyUnreadReason = "The page here couldn't be read yet. Describe the screen, then try again."
let moneyKinds = ["moneyMove": "move", "moneyCommit": "commit", "moneyAuthPage": "authPage", "moneyAuthOk": "authOk",
  "moneyExit": "exit", "moneySafe": "safe", "moneyFieldDeny": "fieldDeny", "moneyFieldOk": "fieldOk", "accountNumber": "accountNumber",
  "moneyReadPage": "readPage", "moneyReadOk": "readOk", "moneyTile": "tile"]
func moneyPatterns(_ sources: [String: String]) -> [String: NSRegularExpression] {
  var out: [String: NSRegularExpression] = [:]
  for (key, kind) in moneyKinds {
    if let source = sources[key], let pattern = try? NSRegularExpression(pattern: source, options: [.caseInsensitive]) { out[kind] = pattern }
  }
  return out
}
// The words that refuse (move, commit, fieldDeny) match everything when missing.
func moneyHas(_ kind: String, _ text: String, _ rules: Rules) -> Bool {
  guard let pattern = rules.money[kind] else { return ["move", "commit", "fieldDeny"].contains(kind) }
  return pattern.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)) != nil
}
// AXPressable: something the page made clickable without saying what it is
// (a card, a row): judged like a link.
let moneyActionRoles: Set<String> = ["AXButton", "AXLink", "AXCheckBox", "AXRadioButton", "AXPopUpButton", "AXMenuButton", "AXComboBox",
  "AXMenuItem", "AXTab", "AXDisclosureTriangle", "AXIncrementor", "AXSlider", "AXSwitch", "AXToggle", "AXPressable"]
func moneyNameWords(_ text: String) -> [String] {
  var words: [String] = [], current = ""
  for character in text {
    if character.isLetter || character.isNumber { current.append(character) }
    else if !current.isEmpty { words.append(current); current = "" }
  }
  if !current.isEmpty { words.append(current) }
  return words
}
let moneyFieldRoles: Set<String> = ["AXTextField", "AXTextArea", "AXSearchField", "AXComboBox", "AXSecureTextField"]
func moneyPlain(_ value: String) -> String { lower(value).split(whereSeparator: \.isWhitespace).joined(separator: " ") }
func moneyTidy(_ value: String) -> String {
  let split = value.precomposedStringWithCompatibilityMapping.replacingOccurrences(of: "([a-z])([A-Z])", with: "$1 $2", options: .regularExpression)
  return split.lowercased().replacingOccurrences(of: "[_/#?&=+.\\-:]+", with: " ", options: .regularExpression)
    .split(whereSeparator: \.isWhitespace).joined(separator: " ")
}
func moneyHost(_ url: String) -> String? {
  let value = url.trimmingCharacters(in: .whitespacesAndNewlines)
  if let parts = URLComponents(string: value), let scheme = parts.scheme, let host = parts.host, !host.isEmpty {
    return ["http", "https"].contains(lower(scheme)) ? lower(host) : nil
  }
  // An address URLComponents won't take still names its host.
  guard let match = value.range(of: #"^https?://(?:[^/?#@]*@)?([^/?#:@\[\]]+)"#, options: [.regularExpression, .caseInsensitive]) else { return nil }
  let authority = value[match].replacingOccurrences(of: #"^https?://(?:[^/?#@]*@)?"#, with: "", options: [.regularExpression, .caseInsensitive])
  return authority.isEmpty ? nil : lower(authority)
}
func moneySite(_ url: String, _ rules: Rules) -> Bool {
  if rules.mode == "full" { return false }
  guard var host = moneyHost(url), !host.isEmpty else { return false }
  if host.hasSuffix(".") { host.removeLast() }
  return rules.moneySites.contains { !$0.isEmpty && (host == $0 || host.hasSuffix("." + $0)) }
}
// A page and the frames it holds: the bank's when any of them is.
func moneyFrames(_ urls: [String], _ rules: Rules) -> Bool { urls.contains { moneySite($0, rules) } }
// url: one page address, or several (a page and its frames) separated by spaces.
func moneyPage(_ url: String, _ title: String, _ rules: Rules) -> String {
  var rest = url
  if let parts = URLComponents(string: url.trimmingCharacters(in: .whitespacesAndNewlines)), parts.host != nil {
    rest = parts.percentEncodedPath + " " + (parts.percentEncodedQuery.map { "?" + $0 } ?? "") + " " + (parts.percentEncodedFragment.map { "#" + $0 } ?? "")
  }
  let words = moneyTidy(rest) + " " + moneyTidy(title)
  if moneyHas("move", words, rules) { return "move" }
  if moneyHas("authPage", words, rules) { return "auth" }
  if moneyHas("readPage", words, rules) { return "read" }
  return ""
}
func moneyClickReason(_ url: String, _ title: String, _ labels: [String], _ role: String, _ rules: Rules) -> String? {
  if rules.mode == "full" { return nil }
  let page = moneyPage(url, title, rules)
  let names = labels.map(moneyPlain).filter { !$0.isEmpty }
  let own = names.first ?? "", all = names.joined(separator: " ")
  if page == "move" { return moneyHas("exit", own, rules) ? nil : moneyPageReason }
  if moneyFieldRoles.contains(role) { return moneyHas("move", all, rules) ? moneyReason : nil }
  if page == "auth" && moneyHas("authOk", own, rules) { return nil }
  if moneyHas("safe", own, rules) || moneyHas("exit", own, rules) { return nil }
  if page == "read" && moneyHas("readOk", own, rules) { return nil }
  if moneyHas("move", all, rules) || moneyHas("commit", all, rules) { return moneyReason }
  if all.isEmpty { return moneyActionRoles.contains(role) ? moneyLabelReason : nil }
  if !moneyActionRoles.contains(role) { return nil } // text the page didn't make clickable
  // Only reading words (in a language these rules know), or an account's
  // tile showing its number or balance.
  if moneyNameWords(own).allSatisfy({ $0.allSatisfy(\.isNumber) || rules.moneyReadWords.contains($0) }) { return nil }
  if ["AXLink", "AXPressable"].contains(role), moneyHas("tile", all, rules) { return nil }
  return moneyButtonReason
}
func moneyTypeReason(_ url: String, _ title: String, _ label: String, secure: Bool, secret: Bool, _ rules: Rules) -> String? {
  if rules.mode == "full" { return nil }
  if moneyPage(url, title, rules) == "move" { return moneyPageReason }
  if secure { return secret ? nil : moneyFieldReason }
  let name = moneyPlain(label)
  if name.isEmpty || moneyHas("fieldDeny", name, rules) || moneyHas("move", name, rules) { return moneyFieldReason }
  return moneyHas("fieldOk", name, rules) ? nil : moneyFieldReason
}
let moneyNavigation: Set<String> = ["tab", "escape", "esc", "up", "down", "left", "right", "home", "end", "pageup", "pagedown"]
let moneyBrowserCommands: Set<String> = ["[", "]", "l", "w", "f", "c", "a", "t"]
func moneyKeyReason(_ url: String, _ title: String, _ key: String, command: Bool, control: Bool, field: Bool, secure: Bool,
                    labels: [String], role: String, _ rules: Rules) -> String? {
  if rules.mode == "full" { return nil }
  let name = key.lowercased()
  let inField = { moneyTypeReason(url, title, labels.first ?? "", secure: secure, secret: true, rules) }
  if (command || control) && ["v", "y"].contains(name) { return moneyPasteReason }
  if ["return", "enter", "space"].contains(name) { return field || secure ? inField() : moneyClickReason(url, title, labels, role, rules) }
  if command && !control && moneyBrowserCommands.contains(name) { return nil }
  if !command && !control && moneyNavigation.contains(name) { return nil }
  if field || secure { return command || control ? (moneyPage(url, title, rules) == "move" ? moneyPageReason : nil) : inField() }
  return moneyPage(url, title, rules) == "move" ? moneyPageReason : nil
}
// Account and card numbers on a bank page: only their last four digits.
func maskAccountNumbers(_ text: String, _ rules: Rules) -> String {
  if rules.mode == "full" { return text }
  guard let pattern = rules.money["accountNumber"] else { return text }
  var out = text
  for match in pattern.matches(in: text, range: NSRange(text.startIndex..., in: text)).reversed() {
    guard let range = Range(match.range, in: out) else { continue }
    out.replaceSubrange(range, with: "••••" + String(out[range].filter(\.isNumber).suffix(4)))
  }
  return out
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

// BEGIN NATIVE CURSOR IDENTITY — Foundation/Security only; no UI access.
// The WindowServer cursor is drawn above every app and is not an input
// surface. A window claiming its layer/name is insufficient: validate the
// current process's Apple signature, code identifier and sealed-system path.
// Never cache success by PID; the process can exit and its PID can be reused.
func trustedCursorIdentity(_ pid: pid_t) -> Bool {
  guard pid > 0 else { return false }
  var requirement: SecRequirement?
  guard SecRequirementCreateWithString(#"anchor apple and identifier "com.apple.WindowServer""# as CFString, [], &requirement) == errSecSuccess,
    let requirement else { return false }
  var code: SecCode?
  guard SecCodeCopyGuestWithAttributes(nil, [kSecGuestAttributePid: pid] as CFDictionary, [], &code) == errSecSuccess,
    let code, SecCodeCheckValidity(code, [], requirement) == errSecSuccess else { return false }
  var staticCode: SecStaticCode?
  guard SecCodeCopyStaticCode(code, [], &staticCode) == errSecSuccess, let staticCode else { return false }
  var codeURL: CFURL?
  guard SecCodeCopyPath(staticCode, [], &codeURL) == errSecSuccess, let codeURL else { return false }
  let expected = URL(fileURLWithPath: "/System/Library/PrivateFrameworks/SkyLight.framework/Resources/WindowServer")
    .standardizedFileURL.resolvingSymlinksInPath().path
  return (codeURL as URL).standardizedFileURL.resolvingSymlinksInPath().path == expected
}
// END NATIVE CURSOR IDENTITY


func out(_ value: [String: Any]) {
  let data = (try? JSONSerialization.data(withJSONObject: value)) ?? Data("{}".utf8)
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write(Data([10]))
}
// Display selection is request-local; references remember the display they
// were observed on. Never silently aim at a different monitor after unplug.
var selectedDisplay: CGDirectDisplayID? = nil
func displayID() -> CGDirectDisplayID { selectedDisplay ?? CGMainDisplayID() }
func displayBounds() -> CGRect { CGDisplayBounds(displayID()) }
func chooseDisplay(_ value: Any?) throws {
  selectedDisplay = nil
  if let number = value as? NSNumber {
    guard number.doubleValue >= 1, number.doubleValue <= Double(UInt32.max), number.doubleValue.rounded() == number.doubleValue,
      CGDisplayIsActive(number.uint32Value) != 0 else { try refuse("That display is disconnected. List displays again.", "retry") }
    selectedDisplay = number.uint32Value
  }
}
func displays() -> [String: Any] {
  var ids = [CGDirectDisplayID](repeating: 0, count: 32), count: UInt32 = 0
  CGGetActiveDisplayList(32, &ids, &count)
  return ["ok": true, "displays": ids.prefix(Int(count)).map { id -> [String: Any] in
    let r = CGDisplayBounds(id)
    return ["id": id, "main": id == CGMainDisplayID(), "x": r.minX, "y": r.minY, "width": r.width, "height": r.height]
  }]
}
var screenRevision: UInt64 = 0
var screenObserver: AXObserver? = nil
var observerPID: pid_t = 0
var observerLoop: CFRunLoop? = nil
var observedElements: [AXUIElement] = []
let observedNotifications = [kAXFocusedWindowChangedNotification, kAXFocusedUIElementChangedNotification, kAXWindowCreatedNotification, kAXUIElementDestroyedNotification, kAXValueChangedNotification, kAXTitleChangedNotification, kAXLayoutChangedNotification]
func watchScreen() {
  guard let app = NSWorkspace.shared.frontmostApplication else { return }
  let loop = CFRunLoopGetCurrent()
  if observerPID != app.processIdentifier || observerLoop !== loop {
    if let observer = screenObserver, let previous = observerLoop { CFRunLoopRemoveSource(previous, AXObserverGetRunLoopSource(observer), .defaultMode) }
    screenObserver = nil; observedElements = []; observerPID = app.processIdentifier; observerLoop = loop; screenRevision &+= 1
    var observer: AXObserver?
    guard AXObserverCreate(observerPID, { _, _, _, _ in screenRevision &+= 1 }, &observer) == .success, let observer else { return }
    screenObserver = observer
    CFRunLoopAddSource(loop, AXObserverGetRunLoopSource(observer), .defaultMode)
  }
  guard let observer = screenObserver else { return }
  let ax = AXUIElementCreateApplication(observerPID)
  let elements = [ax, elementAttr(ax, kAXFocusedWindowAttribute), elementAttr(ax, kAXFocusedUIElementAttribute)].compactMap { $0 }
  if elements.count == observedElements.count && zip(elements, observedElements).allSatisfy({ CFEqual($0.0, $0.1) }) { return }
  for element in observedElements {
    for name in observedNotifications { AXObserverRemoveNotification(observer, element, name as CFString) }
  }
  observedElements = elements
  for element in elements {
    for name in observedNotifications { AXObserverAddNotification(observer, element, name as CFString, nil) }
  }
}
func waitChange(_ revision: UInt64, _ ms: Int) -> [String: Any] {
  watchScreen()
  let end = Date().addingTimeInterval(Double(max(1, min(ms, 400))) / 1000)
  repeat {
    if screenRevision != revision { break }
    let left = end.timeIntervalSinceNow
    if left <= 0 { break }
    CFRunLoopRunInMode(.defaultMode, min(left, 0.05), true)
  } while Date() < end
  return ["ok": true, "revision": screenRevision, "changed": screenRevision != revision]
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

// web: inside a page (url is the page's); frames: the addresses of every page
// it is inside, the frame first, the tab's last; labels: what it says, from
// the element up to the control it is part of; control: that control's role;
// bank: a bank site's page (moneyAt).
struct Seen { var bundle = ""; var name = ""; var path = ""; var title = ""; var url = ""; var secure = false; var role = ""; var pid: pid_t = 0; var web = false; var frames: [String] = []; var labels: [String] = []; var control = ""; var bank = false }
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
  var chain: [(name: String, role: String, element: AXUIElement)] = []
  for _ in 0..<60 {
    guard let current = node else { break }
    let role = string(current, kAXRoleAttribute)
    if role == "AXWebArea" {
      let address = string(current, "AXURL")
      if s.url.isEmpty { s.url = address }
      s.frames.append(address); s.web = true
    }
    if role == kAXWindowRole { s.title = string(current, kAXTitleAttribute); break }
    if !s.web, chain.count < 6 { chain.append((spokenName(current, role), role, current)) }
    node = elementAttr(current, kAXParentAttribute)
  }
  // What a press here presses: the nearest control up from the element,
  // else the nearest thing the page made clickable, else the element and
  // what holds it (all of their words count).
  if let at = chain.firstIndex(where: { moneyActionRoles.contains($0.role) || moneyFieldRoles.contains($0.role) }) {
    s.labels = chain[...at].map { $0.name }; s.control = chain[at].role
  } else if let at = chain.firstIndex(where: { $0.role != "AXStaticText" && pressable($0.element) }) {
    s.labels = chain[...at].map { $0.name }; s.control = "AXPressable"
  } else { s.labels = chain.map { $0.name } }
  // Outside a page (a browser's toolbar): only its own name, judged as a button.
  if !s.web { s.labels = Array(s.labels.prefix(1)); s.control = "AXButton" }
  if s.title.isEmpty, let window = elementAttr(element, kAXWindowAttribute) { s.title = string(window, kAXTitleAttribute) }
  // A browser's address bar holds the page the next key would reach.
  if s.url.isEmpty, s.role == "AXTextField" || s.role == "AXComboBox" {
    let value = string(element, kAXValueAttribute)
    if value.contains("://") || value.contains(":") { s.url = value }
  }
  return s
}
// What a person would hear for an element: a text's words, a control's name
// (a field's label or placeholder), its linked label.
func spokenName(_ element: AXUIElement, _ role: String) -> String {
  if role == "AXStaticText" { let value = string(element, kAXValueAttribute); if !value.isEmpty { return String(value.prefix(120)) } }
  var name = labelName(element, role, secure: role == "AXSecureTextField")
  if name.isEmpty, let title = elementAttr(element, kAXTitleUIElementAttribute) {
    name = string(title, kAXValueAttribute).isEmpty ? string(title, kAXTitleAttribute) : string(title, kAXValueAttribute)
  }
  return String(name.prefix(120))
}
func pressable(_ element: AXUIElement) -> Bool {
  var names: CFArray?
  return AXUIElementCopyActionNames(element, &names) == .success && ((names as? [String]) ?? []).contains("AXPress")
}
// Chromium and Electron build their web trees only for assistive apps.
func buildWebTree(_ pid: pid_t) {
  AXUIElementSetAttributeValue(AXUIElementCreateApplication(pid), "AXManualAccessibility" as CFString, kCFBooleanTrue)
}
// The pages in a window, with where each is: a bounded walk.
func webAreas(_ window: AXUIElement) -> [(url: String, frame: CGRect)] {
  var found: [(url: String, frame: CGRect)] = []
  var stack = [window], visited = 0
  let deadline = Date().addingTimeInterval(0.3)
  while let node = stack.popLast(), visited < 3000, found.count < 8, Date() < deadline {
    visited += 1
    if string(node, kAXRoleAttribute) == "AXWebArea" {
      if let frame = frameOf(node) { found.append((url: string(node, "AXURL"), frame: frame)) }
      continue
    }
    if let children = attr(node, kAXChildrenAttribute) as? [AXUIElement] { stack.append(contentsOf: children) }
  }
  return found
}
// Bank sites, for a click, a drag or the focused element of a browser: the
// page it reaches, when that page is a bank's (url, title); nil otherwise.
// When the element isn't inside a page as accessibility tells it, the page
// whose frame holds the point decides; a bank page reached that way has no
// readable control there, so it is refused.
func moneyAt(_ s: inout Seen, _ point: CGPoint?, _ rules: Rules) throws -> (url: String, title: String)? {
  if rules.mode == "full" { return nil }
  guard isBrowser(s.bundle), !rules.moneySites.isEmpty else { return nil }
  if s.web {
    // A bank's page holds the frames inside it (a payment form served from
    // elsewhere): any of them on a bank site makes it the bank's, and all of
    // their addresses say what the page does.
    let addresses = s.frames.filter { !$0.isEmpty }
    if addresses.isEmpty { try refuse(moneyUnreadReason, "retry") }
    return moneyFrames(addresses, rules) ? (addresses.joined(separator: " "), s.title) : nil
  }
  let app = AXUIElementCreateApplication(s.pid)
  guard let window = elementAttr(app, kAXFocusedWindowAttribute) ?? elementAttr(app, kAXMainWindowAttribute) else { return nil }
  let pages = webAreas(window)
  let page = point.map { p in pages.first { $0.frame.contains(p) } } ?? pages.first
  guard let page else { return nil }   // the browser's own controls: tabs, toolbar, address bar
  if page.url.isEmpty || moneySite(page.url, rules) {
    // A field outside the page (the address bar, find) takes its own text.
    if point == nil, moneyFieldRoles.contains(s.role) { return nil }
    if point != nil { try refuse(moneyUnreadReason, "retry") }
    if page.url.isEmpty { try refuse(moneyUnreadReason, "retry") }
    s.control = "AXButton"
    return (page.url, s.title.isEmpty ? string(window, kAXTitleAttribute) : s.title)
  }
  return nil
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
    if (info[kCGWindowLayer as String] as? Int) == Int(CGWindowLevelForKey(.cursorWindow)), trustedCursorIdentity(pid) { continue }
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
func checkPoint(_ point: CGPoint, _ rules: Rules, _ expected: [String: String]? = nil, activate: Bool = false) throws -> Seen {
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
  if let window, isBrowser(window.bundle) { buildWebTree(window.pid) }
  if let window {
    if rules.mode == "apps", systemSurfaces.contains(lower(window.bundle)) || window.bundle.isEmpty { try refuse(notAllowedReason) }
    if systemSurfaces.contains(lower(window.bundle)) {
      if rules.mode != "full", mentionsReach(window.title, rules) { try refuse(reachReason) }
    } else { try check(window, rules) }
    try checkExpected(window)
  }
  var element: AXUIElement?
  if AXUIElementCopyElementAtPosition(AXUIElementCreateSystemWide(), Float(point.x), Float(point.y), &element) == .success, let element {
    var s = seen(element)
    if systemSurfaces.contains(lower(s.bundle)) {
      if rules.mode == "apps" { try refuse(notAllowedReason) }
      // A Dock item or menu of an app that hosts Reach (Reach's terminal, a Reach tab).
      let label = string(element, kAXTitleAttribute)
      if rules.mode != "full", mentionsReach(label, rules) { try refuse(reachReason) }
      let words = lower([label, string(element, kAXDescriptionAttribute), string(element, kAXHelpAttribute)].joined(separator: " "))
      if rules.mode != "full", mentionsReach(words, rules) { try refuse(reachReason) }
      // Control Center and menu-bar controls that cut the connection Reach
      // answers through, or change who can reach this Mac.
      if rules.mode != "full", systemGuardedWords.contains(where: { words.contains($0) }) { try refuse(systemGuardedReason) }
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
      // A bank's page: what a click would press, judged before it is sent.
      if s.title.isEmpty, named, let window { s.title = window.title }
      if let page = try moneyAt(&s, point, rules) {
        s.bank = true
        if activate, let reason = moneyClickReason(page.url, page.title, s.labels, s.control, rules) { try refuse(reason) }
      }
    }
    if pointerIdentityKnown(s.bundle, s.name, s.path, Int(s.pid)) { try checkExpected(s); return s }
  }
  if var window, pointerIdentityKnown(window.bundle, window.name, window.path, Int(window.pid)) {
    if try moneyAt(&window, point, rules) != nil { window.bank = true }
    return window
  }
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
  if isBrowser(bundle) { buildWebTree(front.processIdentifier) }
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
// BEGIN NATIVE PLAIN TEXT EVENT
// A prior shortcut (notably replace's Command+A) leaves modifiers in this
// private event source. Prose and line breaks must never become shortcuts.
func plainTextEvent(_ key: CGKeyCode, down: Bool) -> CGEvent? {
  let event = CGEvent(keyboardEventSource: source, virtualKey: key, keyDown: down)
  event?.flags = []
  return event
}
// END NATIVE PLAIN TEXT EVENT
var lastPosted = Date.distantPast
// What this helper holds down between a press and its release: buttons (at
// the last point it posted for them) and keys. Stopped mid-click or mid-drag
// (SIGTERM, Main), it lets go of them where it held them before exiting, so
// the owner never inherits a held button. One event at a time under
// `heldLock`, never a whole batch: the owner's stop isn't held up. Once
// stopping, nothing more is posted.
let heldLock = NSLock()
var heldButtons: [UInt32: CGPoint] = [:]
var heldKeys = Set<CGKeyCode>()
var stopping = false
func post(_ event: CGEvent?, pause: useconds_t = 8000) {
  heldLock.lock()
  if stopping { heldLock.unlock(); return }
  if let event {
    event.post(tap: .cghidEventTap)
    let key = CGKeyCode(truncatingIfNeeded: event.getIntegerValueField(.keyboardEventKeycode))
    switch event.type {
    case .leftMouseDown, .leftMouseDragged: heldButtons[CGMouseButton.left.rawValue] = event.location
    case .rightMouseDown, .rightMouseDragged: heldButtons[CGMouseButton.right.rawValue] = event.location
    case .leftMouseUp: heldButtons[CGMouseButton.left.rawValue] = nil
    case .rightMouseUp: heldButtons[CGMouseButton.right.rawValue] = nil
    case .keyDown: heldKeys.insert(key)
    case .keyUp: heldKeys.remove(key)
    default: break
    }
  }
  heldLock.unlock()
  lastPosted = Date(); if pause > 0 { usleep(pause) }
}
// On SIGTERM: release what is held, then post nothing more (the process
// exits right after).
func letGo() {
  heldLock.lock(); defer { heldLock.unlock() }
  stopping = true
  for (raw, at) in heldButtons {
    let right = raw == CGMouseButton.right.rawValue
    CGEvent(mouseEventSource: source, mouseType: right ? .rightMouseUp : .leftMouseUp, mouseCursorPosition: at,
      mouseButton: right ? .right : .left)?.post(tap: .cghidEventTap)
  }
  for key in heldKeys { CGEvent(keyboardEventSource: source, virtualKey: key, keyDown: false)?.post(tap: .cghidEventTap) }
  heldButtons = [:]; heldKeys = []
}
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
    if let ref = action["ref"] as? String {
      let (control, screen) = try referencedControl(ref, rules)
      return try clickControl(control, in: screen, action, display, rules, expected)
    }
    // A numbered label, as the control is now: a fresh read of the screen
    // finds the same role and name nearest to where it was, so a redraw since
    // the agent looked changes nothing. Unnamed, or renamed since (Play →
    // Pause): where it is now, if it still is.
    guard let snap = action["snapshot"] as? String, let n = action["n"] as? Int,
      let snapshot = snapshots.last(where: { $0.id == snap }), n >= 1, n <= snapshot.controls.count else {
      try refuse("That label is from an older look. Look at the labels again.", "retry")
    }
    let remembered = snapshot.controls[n - 1]
    guard NSWorkspace.shared.frontmostApplication?.processIdentifier == snapshot.pid else { try refuse("Another app is in front now. Describe the screen again.", "retry") }
    let screen = try readScreen(rules, text: false)
    let control: Control
    if !remembered.name.isEmpty,
       let found = try? findControl(screen, name: remembered.name, role: String(remembered.role.dropFirst(2)), near: CGPoint(x: remembered.frame.midX, y: remembered.frame.midY)) {
      control = found
    } else if let rect = frameOf(remembered.element), rect.width > 0, rect.height > 0 {
      control = Control(element: remembered.element, role: remembered.role, name: remembered.name, secure: remembered.secure, frame: rect)
    } else { try refuse("That control is gone. Describe the screen again.", "retry") }
    return try clickControl(control, in: screen, action, display, rules, expected)
  case "press":
    // A control by its name, as the screen describes it: no number needed.
    guard let wanted = action["name"] as? String, !wanted.isEmpty, wanted.count <= 120 else { try refuse("Name the control to press.", "invalid") }
    let screen = try readScreen(rules, text: false)
    let candidates: Screen
    if let within = action["within"] as? String {
      candidates = Screen(pid: screen.pid, app: screen.app, bundle: screen.bundle, title: screen.title,
        controls: screen.controls.filter { squeezed($0.context).contains(squeezed(within)) }, values: [:], texts: [], headings: [], truncated: screen.truncated, display: screen.display)
    } else { candidates = screen }
    let control = try findControl(candidates, name: wanted, role: action["role"] as? String)
    return try clickControl(control, in: screen, action, display, rules, expected)
  case "fill":
    // A form in one go: each field found by its label, clicked, typed into
    // through the same checks as typing (a password field takes a vault value
    // only; vault values never go into a terminal); Enter at the end if asked.
    guard let fields = action["fields"] as? [[String: Any]], !fields.isEmpty, fields.count <= 12 else { try refuse("Give the fields to fill.", "invalid") }
    var screen = try readScreen(rules, text: false)
    var filled: [String] = []
    for (index, field) in fields.enumerated() {
      guard let label = field["label"] as? String, !label.isEmpty, label.count <= 120, let text = field["text"] as? String, !text.isEmpty else {
        try refuse("Each field needs a label and text.", "invalid")
      }
      let secret = field["secret"] as? Bool == true
      // Typing can change the form (a new field appears, one goes): read again.
      if index > 0 { screen = try readScreen(rules, text: false) }
      let control = try findControl(screen, name: label, fields: true)
      if rules.mode != "full", control.secure && !secret { try refuse(secureReason) }
      _ = try clickControl(control, in: screen, [:], display, rules, expected)
      usleep(150_000)
      if action["replace"] as? Bool == true, rules.mode == "full" || !control.secure {
        _ = try perform(["type": "key", "key": "a", "modifiers": ["cmd"]], display, rules, expected)
      }
      var typing: [String: Any] = ["type": "type", "text": text]
      if secret || control.secure { typing["secret"] = true }
      if let checked = action["terminalLikeChecked"] { typing["terminalLikeChecked"] = checked }
      if action["paste"] as? Bool == true, !secret && !control.secure { typing["paste"] = true }
      _ = try perform(typing, display, rules, expected)
      filled.append(control.name)
    }
    if action["submit"] as? Bool == true { _ = try perform(["type": "key", "key": "enter"], display, rules, expected) }
    reached = ["app": screen.app, "bundle": screen.bundle, "filled": filled]
  case "click":
    let p = try point("x", "y")
    let target = try checkPoint(p, rules, expected, activate: true)
    let right = action["button"] as? String == "right"
    let count = max(1, min(3, action["count"] as? Int ?? 1))
    let (down, up): (CGEventType, CGEventType) = right ? (.rightMouseDown, .rightMouseUp) : (.leftMouseDown, .leftMouseUp)
    let mods = flags(action["modifiers"] as? [String] ?? [])
    // A long press: one press, the button down holdMs before it lets go. A
    // stop meanwhile (SIGTERM) lets go at once (letGo).
    let holdMs = count == 1 ? max(0, min(10000, action["holdMs"] as? Int ?? 0)) : 0
    post(CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: p, mouseButton: .left))
    for click in 1...count {
      for kind in [down, up] {
        let event = CGEvent(mouseEventSource: source, mouseType: kind, mouseCursorPosition: p, mouseButton: right ? .right : .left)
        event?.setIntegerValueField(.mouseEventClickState, value: Int64(click))
        event?.flags = mods
        post(event, pause: kind == down && holdMs > 0 ? useconds_t(holdMs) * 1000 : 8000)
      }
    }
    reached = ["app": target.name, "bundle": target.bundle]
  case "drag":
    let from = try point("x", "y"), to = try point("toX", "toY")
    let start = try checkPoint(from, rules, expected), end = try checkPoint(to, rules, expected)
    if start.bank || end.bank { try refuse(moneyPasteReason) }
    // holdMs: down that long before moving (a long press picks it up);
    // durationMs: the move spread over that long, a step every ~16 ms.
    let holdMs = max(0, min(5000, action["holdMs"] as? Int ?? 0))
    let durationMs = max(0, min(5000, action["durationMs"] as? Int ?? 0))
    let steps = durationMs > 0 ? max(12, min(300, durationMs / 16)) : 12
    let stepPause: useconds_t = durationMs > 0 ? useconds_t(durationMs * 1000 / steps) : 8000
    post(CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: from, mouseButton: .left))
    post(CGEvent(mouseEventSource: source, mouseType: .leftMouseDown, mouseCursorPosition: from, mouseButton: .left), pause: holdMs > 0 ? useconds_t(holdMs) * 1000 : 8000)
    for step in 1...steps {
      let t = CGFloat(step) / CGFloat(steps)
      post(CGEvent(mouseEventSource: source, mouseType: .leftMouseDragged,
        mouseCursorPosition: CGPoint(x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t), mouseButton: .left), pause: stepPause)
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
    if rules.mode != "full", target.element.secure && !secret { try refuse(secureReason) }
    if rules.mode != "full", secret && target.terminalLike { try refuse("Vault values don't go into a terminal. Click the sign-in field first.") }
    var field = target.element
    if let page = try moneyAt(&field, nil, rules),
      let reason = moneyTypeReason(page.url, page.title, field.labels.first ?? "", secure: field.secure, secret: secret, rules) { try refuse(reason) }
    if secret || target.element.secure { rememberSecret(text) }
    // The server checked the text as prose or as a command; if the focus
    // moved to a terminal since, it must look again.
    if target.terminalLike && action["terminalLikeChecked"] as? Bool != true { try refuse("A terminal is in front now. Try again.", "retry") }
    if action["paste"] as? Bool == true {
      // Long text in one go: on the clipboard, ⌘V, then the owner's clipboard
      // text back. Never a vault value: those are typed, unseen.
      if secret { try refuse("Vault values are typed, never pasted.", "invalid") }
      let board = NSPasteboard.general
      let previous = board.string(forType: .string)
      board.clearContents()
      board.setString(text, forType: .string)
      usleep(40_000)
      for down in [true, false] {
        let event = CGEvent(keyboardEventSource: source, virtualKey: 9, keyDown: down)
        event?.flags = .maskCommand
        post(event)
      }
      usleep(250_000)
      if board.string(forType: .string) == text { board.clearContents(); if let previous { board.setString(previous, forType: .string) } }
      reached = ["app": target.app.localizedName ?? "", "bundle": target.app.bundleIdentifier ?? "", "pasted": true]
      break
    }
    for line in text.components(separatedBy: "\n").enumerated() {
      if line.offset > 0 {
        post(plainTextEvent(36, down: true))
        post(plainTextEvent(36, down: false))
      }
      for chunk in keyboardChunks(line.element) {
        // A character at a time, quickly: down and up, then a short breath.
        for down in [true, false] {
          let event = plainTextEvent(0, down: down)
          event?.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: chunk)
          post(event, pause: down ? 0 : 3000)
        }
      }
    }
    reached = ["app": target.app.localizedName ?? "", "bundle": target.app.bundleIdentifier ?? ""]
  case "menu":
    return try pressMenu(action["path"] as? [String] ?? [], rules)
  case "key":
    guard let name = (action["key"] as? String)?.lowercased(), let code = keyCodes[name] else { try refuse("Unknown key.", "invalid") }
    let mods = action["modifiers"] as? [String] ?? []
    let shortcut = flags(mods)
    let chord = shortcut.contains(.maskCommand) || shortcut.contains(.maskControl)
    let target = try focus(rules, appOnly: chord || ["tab", "escape", "esc", "left", "right", "up", "down", "home", "end", "pageup", "pagedown"].contains(name))
    let command = shortcut.contains(.maskCommand), option = shortcut.contains(.maskAlternate)
    // ⌘Q or ⌘W on a window holding Reach would close Reach.
    if rules.mode != "full", command, ["q", "w"].contains(name), hostsReach(target.app, rules) { try refuse(reachReason) }
    // The developer tools read a page's passwords and run code.
    if rules.mode != "full", isBrowser(target.app.bundleIdentifier ?? ""), (command && option && ["i", "j", "c"].contains(name)) || name == "f12" { try refuse(protectedReason) }
    if rules.mode != "full", target.element.secure, !secureKeyAllowed(name, command) { try refuse(secureReason) }
    var focused = target.element
    if let page = try moneyAt(&focused, nil, rules),
      let reason = moneyKeyReason(page.url, page.title, name, command: command, control: shortcut.contains(.maskControl),
        field: moneyFieldRoles.contains(focused.role), secure: focused.secure, labels: focused.labels, role: focused.control, rules) { try refuse(reason) }
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

// A field showing what the agent typed from its vault (an email, say) is
// blacked out of its screenshot, as its value is left out of the screen as
// text. Best effort: a window that can't be read is shown as it is.
func redacted(_ image: CGImage, _ rules: Rules) -> CGImage {
  guard !typedSecrets.isEmpty, let screen = try? readScreen(rules, text: false) else { return image }
  let boxes = screen.controls.enumerated().compactMap { index, control -> CGRect? in
    guard fieldRoles.contains(control.role), !control.secure, let value = screen.values[index], value.contains("•••") else { return nil }
    return control.frame
  }
  guard !boxes.isEmpty, let space = CGColorSpace(name: CGColorSpace.sRGB),
    let context = CGContext(data: nil, width: image.width, height: image.height, bitsPerComponent: 8, bytesPerRow: 0, space: space,
      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return image }
  let scale = CGFloat(image.width) / screen.display.width
  context.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
  context.setFillColor(CGColor(gray: 0, alpha: 1))
  for box in boxes {
    // Accessibility counts from the top left; the context from the bottom left.
    let x = (box.minX - screen.display.minX) * scale, w = box.width * scale
    let y = CGFloat(image.height) - (box.maxY - screen.display.minY) * scale, h = box.height * scale
    context.fill(CGRect(x: x - 2, y: y - 2, width: w + 4, height: h + 4))
  }
  return context.makeImage() ?? image
}
@available(macOS 14.0, *)
func shot(_ rules: Rules, _ maxWidth: Int) async throws -> [String: Any] {
  let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
  guard let display = content.displays.first(where: { $0.displayID == displayID() }) else {
    try refuse("No screen to show.", "unavailable")
  }
  let filter: SCContentFilter
  // A selected app can itself host Reach or a password-manager window.
  // Apply these exclusions in Apps mode as well as full-screen modes.
  // The Dock's full-screen windows. The Dock itself is one, titled "Dock"
  // (layer 20, display-sized on macOS 26), and stays. Mission Control, App
  // Exposé and Launchpad add untitled ones that draw every window's preview:
  // while any is up, all of them are left out, so what is hidden stays
  // hidden there too (screen-stream.swift has the same rule).
  let dockLayer = { (window: SCWindow) -> Bool in
    lower(window.owningApplication?.bundleIdentifier ?? "") == "com.apple.dock" && window.windowLayer > 0 &&
      window.frame.width >= display.frame.width * 0.9 && window.frame.height >= display.frame.height * 0.9
  }
  let overview = content.windows.contains { dockLayer($0) && $0.title != "Dock" }
  let excluded = content.windows.filter { window in
    let app = window.owningApplication
    let path = app.flatMap { NSRunningApplication(processIdentifier: $0.processID)?.bundleURL.map(canonical) } ?? ""
    let dockOverlay = dockLayer(window) && (overview || window.title != "Dock")
    return (rules.mode != "full" && dockOverlay) || appReason(app?.bundleIdentifier ?? "", app?.applicationName ?? "", path, rules) != nil ||
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
  let bitmap = NSBitmapImageRep(cgImage: redacted(image, rules))
  guard let data = bitmap.representation(using: .jpeg, properties: [.compressionFactor: 0.7]), data.count < 6 * 1024 * 1024 else {
    try refuse("The screen couldn't be encoded.", "unavailable")
  }
  return ["ok": true, "jpeg": data.base64EncodedString(), "width": image.width, "height": image.height, "hidden": hidden,
    "displayId": display.displayID, "displayWidth": Int(display.width), "displayHeight": Int(display.height)]
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
// accessibility tree. The agent picks one by number, or names it (press,
// fill); the click lands at its live center through the same checks as any
// click (clickControl).
struct Control { let element: AXUIElement; let role: String; let name: String; let secure: Bool; let frame: CGRect; var context: String = "" }
struct Screen {
  let pid: pid_t, app: String, bundle: String, title: String
  let controls: [Control], values: [Int: String]
  let texts: [(String, CGRect, String)], headings: [CGRect]
  let truncated: Bool, display: CGRect
}
var snapshots: [(id: String, pid: pid_t, controls: [Control])] = []
var snapshotDisplays: [String: CGDirectDisplayID] = [:]
let labelRoles: Set<String> = ["AXButton", "AXLink", "AXCheckBox", "AXRadioButton", "AXPopUpButton", "AXMenuButton",
  "AXComboBox", "AXTextField", "AXTextArea", "AXSecureTextField", "AXSearchField", "AXMenuItem", "AXMenuBarItem",
  "AXTab", "AXDisclosureTriangle", "AXIncrementor", "AXSlider", "AXSwitch", "AXToggle", "AXDockItem"]
let fieldRoles: Set<String> = ["AXTextField", "AXTextArea", "AXSearchField", "AXComboBox", "AXSecureTextField"]
// What the agent typed from its vault (type or fill with secret): never shown
// back to it, in the screen as text or a screenshot. In this process only,
// for this session.
var typedSecrets: [String] = []
func rememberSecret(_ text: String) {
  let value = text.trimmingCharacters(in: .whitespacesAndNewlines)
  guard value.count >= 3, !typedSecrets.contains(value) else { return }
  typedSecrets.append(value)
  if typedSecrets.count > 16 { typedSecrets.removeFirst() }
}
func frameOf(_ element: AXUIElement) -> CGRect? {
  var p = CGPoint.zero, size = CGSize.zero
  guard let position = attr(element, kAXPositionAttribute), CFGetTypeID(position) == AXValueGetTypeID(),
    let extent = attr(element, kAXSizeAttribute), CFGetTypeID(extent) == AXValueGetTypeID(),
    AXValueGetValue(position as! AXValue, .cgPoint, &p), AXValueGetValue(extent as! AXValue, .cgSize, &size) else { return nil }
  return CGRect(origin: p, size: size)
}
struct ElementReference { let element: AXUIElement; let window: AXUIElement?; let pid: pid_t; let role: String; let name: String; let context: String; let display: CGDirectDisplayID; var at: Date }
var elementReferences: [String: ElementReference] = [:]
func rememberElement(_ element: AXUIElement, prefix: String, window: AXUIElement? = nil, name: String = "", context: String = "") -> String {
  let now = Date(), pid = pidOf(element)
  elementReferences = elementReferences.filter { now.timeIntervalSince($0.value.at) < 300 }
  if let pair = elementReferences.first(where: { $0.key.hasPrefix(prefix + "-") && $0.value.pid == pid && CFEqual($0.value.element, element) && $0.value.name == name && $0.value.context == context && $0.value.display == displayID() && (($0.value.window == nil && window == nil) || ($0.value.window != nil && window != nil && CFEqual($0.value.window!, window!))) }) {
    elementReferences[pair.key]?.at = now; return pair.key
  }
  if elementReferences.count >= 2048, let oldest = elementReferences.min(by: { $0.value.at < $1.value.at }) { elementReferences.removeValue(forKey: oldest.key) }
  let ref = prefix + "-" + UUID().uuidString.lowercased()
  elementReferences[ref] = ElementReference(element: element, window: window, pid: pid, role: string(element, kAXRoleAttribute), name: name, context: context, display: displayID(), at: now)
  return ref
}
func referencedControl(_ ref: String, _ rules: Rules) throws -> (Control, Screen) {
  guard let entry = elementReferences[ref], ref.hasPrefix("e-"), Date().timeIntervalSince(entry.at) < 300,
    let front = NSWorkspace.shared.frontmostApplication, front.processIdentifier == entry.pid else { try refuse("That control reference is stale. Observe again.", "retry") }
  let ax = AXUIElementCreateApplication(entry.pid)
  let secure = entry.role == "AXSecureTextField" || string(entry.element, kAXSubroleAttribute) == "AXSecureTextField"
  guard let window = elementAttr(ax, kAXFocusedWindowAttribute), let remembered = entry.window, CFEqual(window, remembered),
    string(entry.element, kAXRoleAttribute) == entry.role,
    maskAccountNumbers(labelName(entry.element, entry.role, secure: secure), rules) == maskAccountNumbers(entry.name, rules),
    let context = controlContext(entry.element, window: window), maskAccountNumbers(context, rules) == maskAccountNumbers(entry.context, rules),
    attr(entry.element, kAXEnabledAttribute) as? Bool != false, let rect = frameOf(entry.element) else { try refuse("That control changed. Observe again.", "retry") }
  try check(seen(entry.element), rules)
  let title = string(window, kAXTitleAttribute)
  let control = Control(element: entry.element, role: entry.role, name: entry.name, secure: secure, frame: rect, context: context)
  let screen = Screen(pid: entry.pid, app: front.localizedName ?? "", bundle: front.bundleIdentifier ?? "", title: title,
    controls: [control], values: [:], texts: [], headings: [], truncated: false, display: displayBounds())
  return (control, screen)
}
func contextLabel(_ node: AXUIElement, _ role: String, _ children: [AXUIElement]) -> String {
  guard ["AXGroup", "AXRow", "AXCell", "AXToolbar", "AXTable", "AXList", "AXTabGroup", "AXSheet"].contains(role) else { return "" }
  let label = [string(node, kAXTitleAttribute), string(node, kAXDescriptionAttribute)].first { !$0.isEmpty } ?? ""
  if label.isEmpty, ["AXRow", "AXCell"].contains(role) {
    return children.prefix(4).filter { string($0, kAXRoleAttribute) == "AXStaticText" }.map { string($0, kAXValueAttribute) }.joined(separator: " ")
  }
  return label
}
func controlContext(_ element: AXUIElement, window: AXUIElement) -> String? {
  var node = elementAttr(element, kAXParentAttribute), parts: [String] = []
  for _ in 0..<40 {
    guard let parent = node else { return nil }
    let role = string(parent, kAXRoleAttribute)
    if role == "AXWindow", !CFEqual(parent, window) { return nil }
    if ["AXWindow", "AXApplication"].contains(role) { return hideSecrets(String(parts.reversed().joined(separator: " > ").prefix(400)), typedSecrets) }
    let title = contextLabel(parent, role, attr(parent, kAXChildrenAttribute) as? [AXUIElement] ?? [])
    if !title.isEmpty { parts.append(title) }
    node = elementAttr(parent, kAXParentAttribute)
  }
  return nil
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
  return hideSecrets(String(name.prefix(120)), typedSecrets)
}
// The front window read through accessibility: its controls, what fields
// hold, and (unless skipped) what a person reads there. One walk, bounded.
func readScreen(_ rules: Rules, text wantText: Bool = true) throws -> Screen {
  if rules.mode == "view" { try refuse("This agent can only look.") }
  watchScreen()
  guard let front = NSWorkspace.shared.frontmostApplication, front.processIdentifier > 0 else { try refuse("Nothing is in front.", "retry") }
  let bundle = front.bundleIdentifier ?? "", name = front.localizedName ?? "", path = front.bundleURL.map(canonical) ?? ""
  if let reason = appReason(bundle, name, path, rules) { try refuse(reason) }
  let app = AXUIElementCreateApplication(front.processIdentifier)
  // Chromium and Electron build their web trees only for assistive apps.
  AXUIElementSetAttributeValue(app, "AXManualAccessibility" as CFString, kCFBooleanTrue)
  let display = displayBounds()
  var found: [Control] = []
  var texts: [(String, CGRect, String)] = [], headings: [CGRect] = [], values: [Int: String] = [:]
  var textChars = 0
  var bank = false
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
  var stack = roots.reversed().map { (node: $0, context: "") }
  var visited = 0
  let deadline = Date().addingTimeInterval(0.8)
  while let entry = stack.popLast(), visited < 6000, found.count < 400, Date() < deadline {
    let node = entry.node
    visited += 1
    let role = string(node, kAXRoleAttribute)
    if role == "AXWebArea", urlReason(string(node, "AXURL"), rules) != nil { continue }
    if role == "AXWebArea", moneySite(string(node, "AXURL"), rules) { bank = true }
    if role == "AXMenu" { continue } // closed menus' items are not on screen
    let subrole = string(node, kAXSubroleAttribute)
    let secure = role == "AXSecureTextField" || subrole == "AXSecureTextField"
    if wantText, role == "AXHeading", let rect = frameOf(node) { headings.append(rect) }
    if role == "AXStaticText" {
      if wantText, texts.count < 500, textChars < 20000 {
        let words = (string(node, kAXValueAttribute).isEmpty ? string(node, kAXTitleAttribute) : string(node, kAXValueAttribute))
          .split(whereSeparator: \.isWhitespace).joined(separator: " ")
        if !words.isEmpty, let rect = frameOf(node), rect.width >= 1, rect.height >= 1 {
          let visible = rect.intersection(display)
          if !visible.isNull, visible.height >= 2 {
            let line = hideSecrets(String(words.prefix(300)), typedSecrets)
            texts.append((line, visible, entry.context))
            textChars += line.count
          }
        }
      }
      continue
    }
    if labelRoles.contains(role) || secure {
      if let rect = frameOf(node), rect.width >= 4, rect.height >= 4 {
        let visible = rect.intersection(display)
        if !visible.isNull, visible.width >= 2, visible.height >= 2, attr(node, kAXEnabledAttribute) as? Bool != false {
          // What a field holds is on screen already; a password field's never,
          // nor what the agent typed from its vault.
          if !secure, fieldRoles.contains(role) {
            let value = string(node, kAXValueAttribute).split(whereSeparator: \.isWhitespace).joined(separator: " ")
            if !value.isEmpty { values[found.count] = hideSecrets(String(value.prefix(120)), typedSecrets) }
          }
          found.append(Control(element: node, role: role, name: labelName(node, role, secure: secure), secure: secure, frame: visible, context: entry.context))
        }
      }
      // A control's own parts (a link's text, a button's image) are the control.
      if role != "AXMenuBarItem" { continue }
    }
    if let children = attr(node, kAXChildrenAttribute) as? [AXUIElement] {
      var context = entry.context
      let label = contextLabel(node, role, children)
      if !label.isEmpty { context = String((context.isEmpty ? label : context + " > " + label).prefix(400)) }
      stack.append(contentsOf: children.reversed().map { (node: $0, context: hideSecrets(context, typedSecrets)) })
    }
  }
  // A bank's page: account and card numbers down to their last four digits.
  if bank {
    found = found.map { Control(element: $0.element, role: $0.role, name: maskAccountNumbers($0.name, rules), secure: $0.secure, frame: $0.frame, context: maskAccountNumbers($0.context, rules)) }
    values = values.mapValues { maskAccountNumbers($0, rules) }
    texts = texts.map { (maskAccountNumbers($0.0, rules), $0.1, maskAccountNumbers($0.2, rules)) }
  }
  // Reading order: rows from the top, left to right inside a row.
  let order = { (a: CGRect, b: CGRect) -> Bool in
    let ay = (a.midY / 12).rounded(), by = (b.midY / 12).rounded()
    return ay != by ? ay < by : a.minX < b.minX
  }
  let indexed = found.enumerated().map { ($0.offset, $0.element) }.sorted { order($0.1.frame, $1.1.frame) }
  let kept = Array(indexed.prefix(250))
  let keptValues = Dictionary(uniqueKeysWithValues: kept.enumerated().compactMap { position, entry in values[entry.0].map { (position, $0) } })
  texts.sort { order($0.1, $1.1) }
  return Screen(pid: front.processIdentifier, app: name, bundle: bundle, title: windowTitle, controls: kept.map { $0.1 }, values: keptValues,
    texts: texts, headings: headings, truncated: found.count > kept.count || visited >= 6000 || texts.count >= 500 || textChars >= 20000 || Date() >= deadline, display: display)
}
func elements(_ rules: Rules) throws -> [String: Any] { snapshotPayload(try readScreen(rules)) }
// The control the agent named, in a fresh read of the screen: the best match
// by name (and role, when given; fields only, for a form); among equals the
// one nearest to where it was last seen. Several equally good: the agent
// says which, by number.
func findControl(_ screen: Screen, name: String, role: String? = nil, fields: Bool = false, near: CGPoint? = nil) throws -> Control {
  let graded = screen.controls.map { control -> (grade: Int, distance: Double) in
    let roleOk = role.map { lower(control.role) == "ax" + lower($0) || lower(control.role) == lower($0) } ?? true
    let kindOk = !fields || fieldRoles.contains(control.role) || control.secure
    let distance = near.map { hypot(control.frame.midX - $0.x, control.frame.midY - $0.y) } ?? Double.infinity
    return (grade: roleOk && kindOk ? nameMatch(control.name, name) : 0, distance: distance)
  }
  let pick = pickControl(graded)
  if let index = pick.index { return screen.controls[index] }
  let what = fields ? "field" : "control", shown = String(name.prefix(60))
  if pick.candidates > 1 {
    let window = elementAttr(AXUIElementCreateApplication(screen.pid), kAXFocusedWindowAttribute)
    let candidates = screen.controls.enumerated().filter { graded[$0.offset].grade > 0 }.prefix(8).map { pair -> [String: String] in
      let control = pair.element
      return ["ref": rememberElement(control.element, prefix: "e", window: window, name: control.name, context: control.context), "name": control.name, "role": String(control.role.dropFirst(2)), "context": control.context]
    }
    throw Refusal(message: "\(pick.candidates) \(what)s match \"\(shown)\". Choose one of the returned refs.", kind: "invalid", candidates: candidates)
  }
  try refuse("No \(what) named \"\(shown)\" is on screen. Describe the screen.", "retry")
}
// A click at a control's live center, judged like any click. Refused when
// another app's window, or a dialog, sheet or menu of this app, has covered
// the control since the agent looked: the click would land on that instead.
func clickControl(_ control: Control, in screen: Screen, _ action: [String: Any], _ display: CGRect, _ rules: Rules, _ expected: [String: String]?) throws -> [String: Any] {
  let visible = control.frame.intersection(display)
  guard !visible.isNull, visible.width >= 1, visible.height >= 1 else { try refuse("That control is out of view. Scroll to it first.", "retry") }
  let center = CGPoint(x: visible.midX, y: visible.midY)
  if let window = windowAt(center), window.pid > 0, window.pid != screen.pid,
     pointerIdentityKnown(window.bundle, window.name, window.path, Int(window.pid)), !systemSurfaces.contains(lower(window.bundle)) {
    try refuse("Another app's window now covers that control. Describe the screen again.", "retry")
  }
  var hit: AXUIElement?
  if AXUIElementCopyElementAtPosition(AXUIElementCreateSystemWide(), Float(center.x), Float(center.y), &hit) == .success, let hit, pidOf(hit) == screen.pid,
     coveredControl(hit, control.element, parent: { elementAttr($0, kAXParentAttribute) }, equal: { CFEqual($0, $1) },
       sameApp: { pidOf($0) == pidOf($1) },
       overlay: { ["AXSheet", "AXMenu", "AXPopover", "AXDrawer"].contains(string($0, kAXRoleAttribute))
         || ["AXDialog", "AXSystemDialog", "AXApplicationDialog", "AXApplicationAlert", "AXApplicationAlertDialog"].contains(string($0, kAXSubroleAttribute)) }) {
    try refuse("A dialog or menu now covers that control. Describe the screen again and answer it first.", "retry")
  }
  var click: [String: Any] = ["type": "click", "x": Double((center.x - display.minX) / display.width), "y": Double((center.y - display.minY) / display.height)]
  if let button = action["button"] { click["button"] = button }
  if let count = action["count"] { click["count"] = count }
  if let holdMs = action["holdMs"] { click["holdMs"] = holdMs }
  var result = try perform(click, display, rules, expected)
  result["pressed"] = control.name
  return result
}

func front(_ rules: Rules, detail: Bool = false) -> [String: Any] {
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
  let display = displayBounds()
  layout = "\(Int(display.width)),\(Int(display.height))"
  if let window = elementAttr(AXUIElementCreateApplication(app.processIdentifier), kAXFocusedWindowAttribute) { layout += "|" + geometry(window) }
  if let focused = elementAttr(AXUIElementCreateSystemWide(), kAXFocusedUIElementAttribute), pidOf(focused) == app.processIdentifier {
    layout += "|" + geometry(focused) + "|" + string(focused, kAXRoleAttribute) + "|" + string(focused, kAXIdentifierAttribute)
  }
  var result: [String: Any] = ["ok": true, "app": name, "bundle": bundle, "title": blocked == nil ? String(s.title.prefix(200)) : "",
    "terminalLike": terminalLikeApp(bundle, name, path, rules), "secure": s.secure, "blocked": blocked ?? "", "path": path, "layout": String(layout.prefix(2000))]
  // Asked for (reach_front): a browser's page and tabs, so the agent needn't describe the screen to know where it is.
  if detail, blocked == nil, rules.mode != "view", isBrowser(bundle), let window = elementAttr(AXUIElementCreateApplication(app.processIdentifier), kAXFocusedWindowAttribute) {
    let page = windowPage(window, app.processIdentifier, rules)
    if !page.isEmpty { result["url"] = page }
    let tabs = windowTabs(window)
    if !tabs.isEmpty { result["tabs"] = tabs.prefix(30).map { ["ref": rememberElement($0.element, prefix: "t", window: window, name: $0.title), "title": hideSecrets(String($0.title.prefix(120)), typedSecrets), "selected": $0.selected] } }
  }
  return result
}

// MARK: - Navigation: windows, tabs, menus, finding and reading, opening files.
// Faster ways around the Mac for an agent, all read or driven through
// accessibility under the same rules as a look or a click: protected and
// hidden apps are left out, never named; Reach's own windows stay closed.

// Menu and tab titles match without a trailing ellipsis, whatever the case.
func sameTitle(_ a: String, _ b: String) -> Bool {
  let trim = { (s: String) in lower(s).replacingOccurrences(of: "…", with: "").replacingOccurrences(of: "...", with: "").trimmingCharacters(in: .whitespaces) }
  return trim(a) == trim(b)
}
func squeezed(_ text: String) -> String { lower(text).split(whereSeparator: \.isWhitespace).joined(separator: " ") }
func bundleName(_ bundle: Bundle) -> String {
  bundle.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String ?? bundle.object(forInfoDictionaryKey: "CFBundleName") as? String ?? bundle.bundleURL.deletingPathExtension().lastPathComponent
}
let appleMenuReason = "The Apple menu (sleep, restart, log out) stays with the owner."
let programReason = "That file would run as a program. Open documents, not programs or scripts."
// Files that run when opened, whatever app claims them.
let programExtensions: Set<String> = ["app", "command", "tool", "sh", "zsh", "bash", "fish", "scpt", "scptd", "applescript", "workflow", "action", "pkg", "mpkg", "dmg", "terminal", "jar", "webloc", "inetloc", "url", "prefpane", "saver", "qlgenerator", "plugin", "bundle", "kext", "dylib", "xip", "mobileconfig", "osax", "xpc", "appex", "framework"]
// Apps that run what they open, so an agent never opens a file with them.
let runnerApps: Set<String> = ["com.apple.scripteditor2", "com.apple.automator", "com.apple.shortcuts", "com.apple.installer", "com.apple.systempreferences", "com.apple.terminal", "com.apple.dt.xcode"]

// The tabs of a browser window: the tab buttons in its tab bar, the chosen one marked.
func windowTabs(_ window: AXUIElement) -> [(title: String, selected: Bool, element: AXUIElement)] {
  var found: [(title: String, selected: Bool, element: AXUIElement)] = []
  var stack = [window], visited = 0
  let deadline = Date().addingTimeInterval(0.25)
  while let node = stack.popLast(), visited < 1500, found.count < 40, Date() < deadline {
    visited += 1
    let role = string(node, kAXRoleAttribute)
    if role == "AXWebArea" || role == "AXMenu" || role == "AXMenuBar" { continue }
    if role == "AXRadioButton" || role == "AXTab" {
      let parentRole = elementAttr(node, kAXParentAttribute).map { string($0, kAXRoleAttribute) } ?? ""
      if role == "AXTab" || string(node, kAXSubroleAttribute) == "AXTabButton" || parentRole == "AXTabGroup" {
        let title = [string(node, kAXTitleAttribute), string(node, kAXDescriptionAttribute)].first { !$0.isEmpty } ?? ""
        let selected = (attr(node, kAXValueAttribute) as? NSNumber)?.intValue == 1 || attr(node, kAXSelectedAttribute) as? Bool == true
        if !title.isEmpty { found.append((title, selected, node)) }
      }
      continue
    }
    if let children = attr(node, kAXChildrenAttribute) as? [AXUIElement] { stack.append(contentsOf: children.reversed()) }
  }
  return found
}
// The page a browser window shows, when the agent may know it.
func windowPage(_ window: AXUIElement, _ pid: pid_t, _ rules: Rules) -> String {
  buildWebTree(pid)
  guard let page = webAreas(window).first, !page.url.isEmpty, urlReason(page.url, rules) == nil else { return "" }
  return String(page.url.prefix(2048))
}
// Every window the agent may know of (reach_windows): the windows of the apps
// its rules allow, with their titles; a browser's with its page and tabs.
func windowList(_ rules: Rules) throws -> [String: Any] {
  let frontPid = NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0
  var windows: [[String: Any]] = []
  let deadline = Date().addingTimeInterval(1.5)
  for app in NSWorkspace.shared.runningApplications where app.activationPolicy == .regular {
    if windows.count >= 120 || Date() > deadline { break }
    let bundle = app.bundleIdentifier ?? "", name = app.localizedName ?? "", path = app.bundleURL.map(canonical) ?? ""
    if appReason(bundle, name, path, rules) != nil { continue }
    let ax = AXUIElementCreateApplication(app.processIdentifier)
    AXUIElementSetMessagingTimeout(ax, 0.3)
    guard let list = attr(ax, kAXWindowsAttribute) as? [AXUIElement] else { continue }
    for window in list.prefix(24) {
      guard string(window, kAXRoleAttribute) == kAXWindowRole else { continue }
      let title = string(window, kAXTitleAttribute)
      if windowTitleReason(title, bundle, path, app.processIdentifier, rules) != nil { continue }
      var entry: [String: Any] = ["id": rememberElement(window, prefix: "w"), "app": name, "bundle": bundle,
        "title": hideSecrets(String(title.prefix(200)), typedSecrets),
        "minimized": attr(window, kAXMinimizedAttribute) as? Bool == true,
        "front": app.processIdentifier == frontPid && attr(window, kAXMainAttribute) as? Bool == true]
      if ["AXDialog", "AXSystemDialog"].contains(string(window, kAXSubroleAttribute)) { entry["dialog"] = true }
      if isBrowser(bundle) {
        let page = windowPage(window, app.processIdentifier, rules)
        if !page.isEmpty { entry["url"] = page }
        let tabs = windowTabs(window)
        if !tabs.isEmpty { entry["tabs"] = tabs.map { ["ref": rememberElement($0.element, prefix: "t", window: window, name: $0.title), "title": hideSecrets(String($0.title.prefix(120)), typedSecrets), "selected": $0.selected] } }
      }
      windows.append(entry)
    }
  }
  return ["ok": true, "windows": windows]
}
// One window brought forward (reach_focus_window), by the id the list gave and
// its title checked again; unminimized if needed; a browser tab by its title,
// chosen through accessibility (no pointer, so it runs beside the person).
func focusWindow(_ id: String, title wanted: String, tab: String, tabRef: String = "", _ rules: Rules) throws -> [String: Any] {
  if rules.mode == "view" { try refuse("This agent can only look.") }
  let pid: pid_t, window: AXUIElement
  if id.hasPrefix("w-"), let reference = elementReferences[id], Date().timeIntervalSince(reference.at) < 300 {
    pid = reference.pid
    guard let live = attr(AXUIElementCreateApplication(pid), kAXWindowsAttribute) as? [AXUIElement], live.contains(where: { CFEqual($0, reference.element) }) else { try refuse("That window is gone. List windows again.", "retry") }
    window = reference.element
  } else {
    let parts = id.split(separator: ":")
    guard parts.count == 2, let process = pid_t(parts[0]), let index = Int(parts[1]), index >= 0, index < 24,
      let live = attr(AXUIElementCreateApplication(process), kAXWindowsAttribute) as? [AXUIElement], index < live.count else { try refuse("That window is gone. List windows again.", "retry") }
    pid = process; window = live[index]
  }
  guard let app = NSRunningApplication(processIdentifier: pid) else { try refuse("That app is gone.", "retry") }
  let bundle = app.bundleIdentifier ?? "", name = app.localizedName ?? "", path = app.bundleURL.map(canonical) ?? ""
  if let reason = appReason(bundle, name, path, rules) { try refuse(reason) }
  let title = string(window, kAXTitleAttribute)
  if let reason = windowTitleReason(title, bundle, path, pid, rules) { try refuse(reason) }
  if !wanted.isEmpty, !sameTitle(title, wanted), !lower(title).hasPrefix(lower(wanted)) { try refuse("That window has changed. List the windows again.", "retry") }
  if attr(window, kAXMinimizedAttribute) as? Bool == true { AXUIElementSetAttributeValue(window, kAXMinimizedAttribute as CFString, kCFBooleanFalse) }
  AXUIElementPerformAction(window, kAXRaiseAction as CFString)
  AXUIElementSetAttributeValue(window, kAXMainAttribute as CFString, kCFBooleanTrue)
  app.activate(options: [])
  lastPosted = Date()
  let front = waitFront(bundle, app)
  var result: [String: Any] = ["ok": true, "app": name, "bundle": bundle, "front": front]
  if !tab.isEmpty || !tabRef.isEmpty {
    guard isBrowser(bundle) else { try refuse("Only a browser window has tabs.", "invalid") }
    let tabs = windowTabs(window)
    let reference = elementReferences[tabRef]
    let pick = pickControl(tabs.map { candidate in
      let exact = reference.map { Date().timeIntervalSince($0.at) < 300 && $0.pid == pid && $0.window.map { CFEqual($0, window) } == true && CFEqual($0.element, candidate.element) && $0.name == candidate.title } ?? false
      return (grade: tabRef.isEmpty ? nameMatch(candidate.title, tab) : (exact ? 3 : 0), distance: Double.infinity)
    })
    guard let at = pick.index else {
      if pick.candidates > 1 { try refuse("\(pick.candidates) tabs match \"\(String(tab.prefix(60)))\". Give more of the title.", "invalid") }
      try refuse("No tab named \"\(String(tab.prefix(60)))\" in that window. List the windows again.", "retry")
    }
    if windowTitleReason(tabs[at].title, bundle, path, pid, rules) != nil { try refuse(protectedReason) }
    guard AXUIElementPerformAction(tabs[at].element, kAXPressAction as CFString) == .success else { try refuse("That tab couldn't be chosen. Click it instead.", "retry") }
    usleep(150_000)
    result["tab"] = hideSecrets(String(tabs[at].title.prefix(120)), typedSecrets)
  }
  result["title"] = hideSecrets(String(string(window, kAXTitleAttribute).prefix(200)), typedSecrets)
  return result
}

// A menu item's keyboard shortcut, as the menu shows it (⇧⌘S).
func menuShortcut(_ item: AXUIElement) -> String {
  guard let char = attr(item, kAXMenuItemCmdCharAttribute) as? String, !char.isEmpty else { return "" }
  let mods = (attr(item, kAXMenuItemCmdModifiersAttribute) as? NSNumber)?.intValue ?? 0
  var names: [String] = []
  if mods & 4 != 0 { names.append("⌃") }
  if mods & 2 != 0 { names.append("⌥") }
  if mods & 1 != 0 { names.append("⇧") }
  if mods & 8 == 0 { names.append("⌘") }
  return names.joined() + char.uppercased()
}
// A menu's items (a menu bar item or a menu item holds its menu as its only child).
func menuChildren(_ menu: AXUIElement) -> [AXUIElement] {
  var items = attr(menu, kAXChildrenAttribute) as? [AXUIElement] ?? []
  if items.count == 1, string(items[0], kAXRoleAttribute) == "AXMenu" { items = attr(items[0], kAXChildrenAttribute) as? [AXUIElement] ?? [] }
  return items
}
func menuItems(_ menu: AXUIElement, depth: Int, limit: Int, count: inout Int, deadline: Date) -> [[String: Any]] {
  var items: [[String: Any]] = []
  for child in menuChildren(menu) {
    if count >= limit || Date() > deadline { break }
    let title = string(child, kAXTitleAttribute)
    if title.isEmpty { continue } // a separator
    count += 1
    var entry: [String: Any] = ["title": hideSecrets(String(title.prefix(80)), typedSecrets)]
    if attr(child, kAXEnabledAttribute) as? Bool == false { entry["enabled"] = false }
    let key = menuShortcut(child)
    if !key.isEmpty { entry["key"] = key }
    if let mark = attr(child, kAXMenuItemMarkCharAttribute) as? String, !mark.isEmpty { entry["checked"] = true }
    if !(attr(child, kAXChildrenAttribute) as? [AXUIElement] ?? []).isEmpty {
      if depth > 0 { entry["items"] = menuItems(child, depth: depth - 1, limit: limit, count: &count, deadline: deadline) } else { entry["submenu"] = true }
    }
    items.append(entry)
  }
  return items
}
// The front app, checked like a look: its name, path and accessibility element.
func frontApp(_ rules: Rules) throws -> (app: NSRunningApplication, bundle: String, name: String, path: String, ax: AXUIElement, title: String) {
  if rules.mode == "view" { try refuse("This agent can only look.") }
  guard let front = NSWorkspace.shared.frontmostApplication, front.processIdentifier > 0 else { try refuse("Nothing is in front.", "retry") }
  let bundle = front.bundleIdentifier ?? "", name = front.localizedName ?? "", path = front.bundleURL.map(canonical) ?? ""
  if let reason = appReason(bundle, name, path, rules) { try refuse(reason) }
  let ax = AXUIElementCreateApplication(front.processIdentifier)
  var title = ""
  if let window = elementAttr(ax, kAXFocusedWindowAttribute) ?? elementAttr(ax, kAXMainWindowAttribute) {
    title = string(window, kAXTitleAttribute)
    if let reason = windowTitleReason(title, bundle, path, front.processIdentifier, rules) { try refuse(reason) }
  }
  return (front, bundle, name, path, ax, String(title.prefix(200)))
}
// The menu bar of the app in front (reach_menus): every menu's items with
// their shortcuts; one menu named, with its submenus too. Never the Apple menu.
func menuBar(_ rules: Rules, menu wanted: String) throws -> [String: Any] {
  let front = try frontApp(rules)
  guard let bar = elementAttr(front.ax, kAXMenuBarAttribute), let tops = attr(bar, kAXChildrenAttribute) as? [AXUIElement] else { try refuse("This app has no menu bar to read.", "retry") }
  var count = 0
  let deadline = Date().addingTimeInterval(1.5)
  var menus: [[String: Any]] = []
  for (index, top) in tops.prefix(30).enumerated() {
    let title = string(top, kAXTitleAttribute)
    if title.isEmpty || (rules.mode != "full" && (index == 0 || title == "Apple")) { continue }
    if !wanted.isEmpty && !sameTitle(title, wanted) { continue }
    menus.append(["title": String(title.prefix(80)), "items": menuItems(top, depth: wanted.isEmpty ? 0 : 2, limit: 400, count: &count, deadline: deadline)])
  }
  if !wanted.isEmpty && menus.isEmpty { try refuse("No menu named \"\(String(wanted.prefix(60)))\". Read the menus without a name first.", "invalid") }
  return ["ok": true, "app": front.name, "bundle": front.bundle, "title": front.title, "menus": menus, "truncated": count >= 400 || Date() > deadline]
}
// A menu item by its path (["File", "Export As", "PDF…"]), pressed through
// accessibility: no pointer, so it runs beside the person using the Mac.
func pressMenu(_ names: [String], _ rules: Rules) throws -> [String: Any] {
  guard !names.isEmpty, names.count <= 6, names.allSatisfy({ !$0.isEmpty && $0.count <= 80 }) else { try refuse("Give the menu path, menu title first.", "invalid") }
  let target = try focus(rules, appOnly: true)
  let ax = AXUIElementCreateApplication(target.app.processIdentifier)
  guard let bar = elementAttr(ax, kAXMenuBarAttribute), let tops = attr(bar, kAXChildrenAttribute) as? [AXUIElement], tops.count > 1 else { try refuse("This app has no menu bar.", "retry") }
  if rules.mode != "full", sameTitle(names[0], "apple") || sameTitle(names[0], string(tops[0], kAXTitleAttribute)) { try refuse(appleMenuReason) }
  var level: AXUIElement = bar
  var chosen: AXUIElement?
  for (i, name) in names.enumerated() {
    var items = menuChildren(level)
    if i == 0 && rules.mode != "full" { items = Array(items.dropFirst()) }
    let pick = pickControl(items.map { item -> (grade: Int, distance: Double) in
      let title = string(item, kAXTitleAttribute)
      return (grade: sameTitle(title, name) ? 3 : nameMatch(title, name) == 2 ? 2 : 0, distance: Double.infinity)
    })
    guard let at = pick.index else {
      if pick.candidates > 1 { try refuse("\(pick.candidates) menu items match \"\(String(name.prefix(60)))\". Give the full title.", "invalid") }
      try refuse("No menu item \"\(String(name.prefix(60)))\" in \(i == 0 ? "the menu bar" : names[i - 1]). Read the menus with reach_menus.", "retry")
    }
    chosen = items[at]; level = items[at]
  }
  guard let item = chosen else { try refuse("Give the menu path.", "invalid") }
  let title = string(item, kAXTitleAttribute), word = lower(title)
  if attr(item, kAXEnabledAttribute) as? Bool == false { try refuse("\"\(String(title.prefix(60)))\" is dimmed right now.", "retry") }
  if !(attr(item, kAXChildrenAttribute) as? [AXUIElement] ?? []).isEmpty { try refuse("\"\(String(title.prefix(60)))\" opens a submenu. Add the item inside it to the path.", "invalid") }
  // Quitting or closing where Reach lives would close Reach (as ⌘Q and ⌘W).
  if rules.mode != "full", ["quit", "close", "exit"].contains(where: { word.hasPrefix($0) }), hostsReach(target.app, rules) { try refuse(reachReason) }
  if rules.mode != "full", mentionsReach(title, rules) { try refuse(reachReason) }
  // The developer tools and saved passwords, as for keys and typed addresses.
  if rules.mode != "full", rules.protectedTitleWords.contains(where: { word.contains($0) }) || word.contains("inspect element") { try refuse(protectedReason) }
  guard AXUIElementPerformAction(item, kAXPressAction as CFString) == .success else { try refuse("That menu item couldn't be pressed. Use its shortcut key instead.", "retry") }
  lastPosted = Date()
  return ["ok": true, "app": target.app.localizedName ?? "", "bundle": target.app.bundleIdentifier ?? "", "pressed": names.map { String($0.prefix(80)) }.joined(separator: " › ")]
}

// The numbered controls and visible text of a read screen, as the agent
// receives them (reach_elements); the snapshot remembers the controls so a
// number can be pressed later.
func snapshotPayload(_ screen: Screen) -> [String: Any] {
  let id = String(UUID().uuidString.prefix(8).lowercased())
  snapshots.append((id: id, pid: screen.pid, controls: screen.controls))
  snapshotDisplays[id] = displayID()
  if snapshots.count > 16 { snapshots.removeFirst(snapshots.count - 16) }
  snapshotDisplays = snapshotDisplays.filter { pair in snapshots.contains { $0.id == pair.key } }
  let display = screen.display
  let place = { (rect: CGRect) -> [String: Any] in
    ["x": Double((rect.minX - display.minX) / display.width), "y": Double((rect.minY - display.minY) / display.height),
     "w": Double(rect.width / display.width), "h": Double(rect.height / display.height)]
  }
  let items: [[String: Any]] = screen.controls.enumerated().map { index, item in
    let window = elementAttr(AXUIElementCreateApplication(screen.pid), kAXFocusedWindowAttribute)
    var entry: [String: Any] = ["ref": rememberElement(item.element, prefix: "e", window: window, name: item.name, context: item.context), "context": item.context, "n": index + 1, "role": String(item.role.dropFirst(2)), "name": item.name, "secure": item.secure]
    if let value = screen.values[index] { entry["value"] = value }
    return entry.merging(place(item.frame)) { first, _ in first }
  }
  let lines: [[String: Any]] = screen.texts.map { text, rect, context in
    var entry: [String: Any] = ["text": text, "context": context]
    if screen.headings.contains(where: { $0.contains(CGPoint(x: rect.midX, y: rect.midY)) }) { entry["heading"] = true }
    return entry.merging(place(rect)) { first, _ in first }
  }
  return ["ok": true, "snapshot": id, "windowRef": elementAttr(AXUIElementCreateApplication(screen.pid), kAXFocusedWindowAttribute).map { rememberElement($0, prefix: "w") } ?? "", "revision": screenRevision, "displayId": displayID(), "app": screen.app, "title": screen.title, "items": items, "texts": lines, "truncated": screen.truncated]
}
// Something in the front window by its words (reach_find): a control by name
// (and role), or text, anywhere in the window, what is scrolled out of view
// included. Brought into view through accessibility, then the screen read
// again so the agent gets its number in a fresh snapshot.
func findOnScreen(_ rules: Rules, text: String, name: String, role: String) throws -> [String: Any] {
  let front = try frontApp(rules)
  AXUIElementSetAttributeValue(front.ax, "AXManualAccessibility" as CFString, kCFBooleanTrue)
  guard let window = elementAttr(front.ax, kAXFocusedWindowAttribute) ?? elementAttr(front.ax, kAXMainWindowAttribute) else { try refuse("No window is in front.", "retry") }
  let wantText = squeezed(text), wantName = squeezed(name)
  guard !wantText.isEmpty || !wantName.isEmpty else { try refuse("Say what to find: text, or a control's name.", "invalid") }
  var best: (element: AXUIElement, grade: Int, role: String, label: String)?
  var candidates = 0
  var stack = [window], visited = 0
  let deadline = Date().addingTimeInterval(1.5)
  while let node = stack.popLast(), visited < 15000, Date() < deadline {
    visited += 1
    let nodeRole = string(node, kAXRoleAttribute)
    if nodeRole == "AXWebArea", urlReason(string(node, "AXURL"), rules) != nil { continue }
    if nodeRole == "AXMenu" || nodeRole == "AXMenuBar" { continue }
    let secure = nodeRole == "AXSecureTextField" || string(node, kAXSubroleAttribute) == "AXSecureTextField"
    var grade = 0, label = ""
    if !wantName.isEmpty {
      if labelRoles.contains(nodeRole) || secure, role.isEmpty || lower(nodeRole) == "ax" + lower(role) || lower(nodeRole) == lower(role) {
        label = labelName(node, nodeRole, secure: secure)
        grade = nameMatch(label, name)
      }
    } else if nodeRole == "AXStaticText" || labelRoles.contains(nodeRole) {
      let raw = nodeRole == "AXStaticText"
        ? (string(node, kAXValueAttribute).isEmpty ? string(node, kAXTitleAttribute) : string(node, kAXValueAttribute))
        : labelName(node, nodeRole, secure: secure) + (secure ? "" : " " + string(node, kAXValueAttribute))
      let words = squeezed(hideSecrets(raw, typedSecrets))
      if words == wantText { grade = 3 } else if words.hasPrefix(wantText) { grade = 2 } else if words.contains(wantText) { grade = 1 }
      label = String(words.prefix(160))
    }
    if grade > 0 {
      if best == nil || grade > best!.grade { best = (node, grade, nodeRole, label); candidates = 1 } else if grade == best!.grade { candidates += 1 }
      if grade == 3 { break }
    }
    // A control's own parts are the control.
    if labelRoles.contains(nodeRole), nodeRole != "AXMenuBarItem" { continue }
    if let children = attr(node, kAXChildrenAttribute) as? [AXUIElement] { stack.append(contentsOf: children.reversed()) }
  }
  let unfinished = visited >= 15000 || Date() >= deadline
  guard let hit = best else { return ["ok": true, "found": false, "app": front.name, "title": front.title, "truncated": unfinished] }
  // Out of the window's view: scrolled to, through accessibility (no pointer).
  var scrolled = false, inView = true
  let display = displayBounds()
  let shown = frameOf(window).map { $0.intersection(display) } ?? display
  let visible = { (rect: CGRect?) -> Bool in
    guard let rect, rect.width >= 1, rect.height >= 1 else { return false }
    let seen = rect.intersection(shown)
    return !seen.isNull && seen.height >= 2 && seen.width >= 2
  }
  if !visible(frameOf(hit.element)) {
    scrolled = AXUIElementPerformAction(hit.element, "AXScrollToVisible" as CFString) == .success
    if scrolled { usleep(250_000) }
    inView = visible(frameOf(hit.element))
  }
  let screen = try readScreen(rules)
  var payload = snapshotPayload(screen)
  payload["found"] = true
  payload["role"] = String(hit.role.dropFirst(2))
  payload[wantName.isEmpty ? "text" : "name"] = hit.label
  payload["matches"] = candidates
  payload["inView"] = inView
  payload["scrolled"] = scrolled
  payload["truncated"] = screen.truncated || unfinished
  if let n = screen.controls.firstIndex(where: { CFEqual($0.element, hit.element) }) { payload["n"] = n + 1 }
  else if !wantName.isEmpty, let frame = frameOf(hit.element),
    let control = try? findControl(screen, name: hit.label, role: String(hit.role.dropFirst(2)), near: CGPoint(x: frame.midX, y: frame.midY)),
    let n = screen.controls.firstIndex(where: { CFEqual($0.element, control.element) }) { payload["n"] = n + 1 }
  if let frame = frameOf(hit.element), !inView {
    payload["direction"] = frame.midY > shown.maxY ? "below" : frame.midY < shown.minY ? "above" : frame.midX > shown.maxX ? "right" : "left"
    payload["distance"] = Int(max(abs(frame.midY - shown.midY) - shown.height / 2, abs(frame.midX - shown.midX) - shown.width / 2))
  }
  return payload
}
// The front window's whole text (reach_read_page): what a person could read
// there, in order, what is scrolled out of view included, up to 60000
// characters. Controls appear in brackets; a password field is never read.
func readPage(_ rules: Rules) throws -> [String: Any] {
  let front = try frontApp(rules)
  AXUIElementSetAttributeValue(front.ax, "AXManualAccessibility" as CFString, kCFBooleanTrue)
  guard let window = elementAttr(front.ax, kAXFocusedWindowAttribute) ?? elementAttr(front.ax, kAXMainWindowAttribute) else { try refuse("No window is in front.", "retry") }
  var lines: [String] = [], chars = 0, lastLine = ""
  var bank = false, url = ""
  func add(_ raw: String, heading: Bool = false) {
    let text = raw.split(whereSeparator: \.isNewline).map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }.joined(separator: "\n")
    if text.isEmpty { return }
    let line = (heading ? "# " : "") + hideSecrets(String(text.prefix(20000)), typedSecrets)
    if line == lastLine { return }
    lines.append(line); lastLine = line; chars += line.count
  }
  // In a browser the page is what the agent reads, not the toolbar and bookmarks.
  var roots = [window]
  if isBrowser(front.bundle) {
    buildWebTree(front.app.processIdentifier)
    var pages: [AXUIElement] = []
    var look = [window], seen = 0
    while let node = look.popLast(), seen < 3000, pages.count < 4 {
      seen += 1
      if string(node, kAXRoleAttribute) == "AXWebArea" { pages.append(node); continue }
      if let children = attr(node, kAXChildrenAttribute) as? [AXUIElement] { look.append(contentsOf: children) }
    }
    if !pages.isEmpty { roots = pages }
  }
  var stack = roots.reversed() as [AXUIElement], visited = 0
  let deadline = Date().addingTimeInterval(2.0)
  while let node = stack.popLast(), visited < 20000, chars < 60000, Date() < deadline {
    visited += 1
    let role = string(node, kAXRoleAttribute)
    if role == "AXWebArea" {
      let address = string(node, "AXURL")
      if urlReason(address, rules) != nil { continue }
      if moneySite(address, rules) { bank = true }
      if url.isEmpty { url = address }
    }
    if role == "AXMenu" || role == "AXMenuBar" { continue }
    if role == "AXSecureTextField" || string(node, kAXSubroleAttribute) == "AXSecureTextField" { add("[password field]"); continue }
    switch role {
    case "AXStaticText":
      add(string(node, kAXValueAttribute).isEmpty ? string(node, kAXTitleAttribute) : string(node, kAXValueAttribute)); continue
    case "AXHeading":
      let own = string(node, kAXValueAttribute).isEmpty ? string(node, kAXTitleAttribute) : string(node, kAXValueAttribute)
      if !own.isEmpty { add(own, heading: true); continue }
    case "AXTextArea", "AXTextField", "AXComboBox", "AXSearchField":
      let value = string(node, kAXValueAttribute), label = labelName(node, role, secure: false)
      add(label.isEmpty ? value : value.isEmpty ? "[\(label)]" : "\(label): \(value)"); continue
    case "AXButton", "AXLink", "AXCheckBox", "AXRadioButton", "AXPopUpButton", "AXMenuButton", "AXTab", "AXMenuItem", "AXMenuBarItem":
      let label = labelName(node, role, secure: false)
      if !label.isEmpty { add("[\(label)]") }
      continue
    case "AXImage":
      let described = string(node, kAXDescriptionAttribute)
      if !described.isEmpty { add("(image: \(described))") }
      continue
    default: break
    }
    if let children = attr(node, kAXChildrenAttribute) as? [AXUIElement] { stack.append(contentsOf: children.reversed()) }
  }
  var text = lines.joined(separator: "\n")
  if bank { text = maskAccountNumbers(text, rules) }
  return ["ok": true, "app": front.name, "bundle": front.bundle, "title": front.title, "url": url.isEmpty ? "" : String(url.prefix(2048)),
    "text": String(text.prefix(60000)), "truncated": visited >= 20000 || chars >= 60000 || Date() >= deadline]
}

// A file opened in the app that owns it (reach_open_file), or shown in the
// Finder: never a program or a script (opening one runs it), never with an app
// the agent may not use, never with one that runs what it opens.
func openFile(_ path: String, reveal: Bool, _ rules: Rules) throws -> [String: Any] {
  if rules.mode == "view" { try refuse("This agent can only look.") }
  guard path.hasPrefix("/"), path.utf8.count <= 4096, FileManager.default.fileExists(atPath: path) else { try refuse("That file isn't there.", "invalid") }
  let url = URL(fileURLWithPath: path)
  if rules.mode != "full", programExtensions.contains(lower(url.pathExtension)) { try refuse(programReason) }
  var isDirectory: ObjCBool = false
  FileManager.default.fileExists(atPath: path, isDirectory: &isDirectory)
  if rules.mode != "full", isDirectory.boolValue, !lower(url.pathExtension).isEmpty { try refuse(programReason) } // a bundle
  let finderPath = canonical(URL(fileURLWithPath: "/System/Library/CoreServices/Finder.app"))
  if reveal || isDirectory.boolValue {
    if let reason = appReason("com.apple.finder", "Finder", finderPath, rules) { try refuse(reason) }
    NSWorkspace.shared.activateFileViewerSelecting([url])
    lastPosted = Date()
    return ["ok": true, "app": "Finder", "bundle": "com.apple.finder", "front": waitFront("com.apple.finder", nil)]
  }
  guard let appURL = NSWorkspace.shared.urlForApplication(toOpen: url), let bundle = Bundle(url: appURL), let bundleId = bundle.bundleIdentifier else { try refuse("No app on this Mac opens that file.", "unavailable") }
  let name = bundleName(bundle), appPath = canonical(appURL)
  if let reason = appReason(bundleId, name, appPath, rules) { try refuse(reason) }
  if rules.mode != "full", runnerApps.contains(lower(bundleId)) || terminalLikeApp(bundleId, name, appPath, rules) { try refuse(programReason) }
  let configuration = NSWorkspace.OpenConfiguration()
  configuration.activates = true
  let done = DispatchSemaphore(value: 0)
  var failure: Error?
  var opened: NSRunningApplication?
  NSWorkspace.shared.open([url], withApplicationAt: appURL, configuration: configuration) { app, error in opened = app; failure = error; done.signal() }
  if done.wait(timeout: .now() + 8) == .timedOut { try refuse("The app is taking too long to open the file.", "retry") }
  if failure != nil { try refuse("The file couldn't be opened.", "unavailable") }
  lastPosted = Date()
  return ["ok": true, "app": name, "bundle": bundleId, "front": waitFront(bundleId, opened)]
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
  r.moneySites = strings("moneySites")
  r.moneyReadWords = Set(strings("moneyReadWords"))
  r.money = moneyPatterns(Dictionary(uniqueKeysWithValues: moneyKinds.keys.compactMap { key in (request[key] as? String).map { (key, $0) } }))
  return r
}

@main struct Main {
  static func main() async {
    var current: Rules?
    signal(SIGTERM, SIG_IGN)
    let termination = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .global())
    termination.setEventHandler { letGo(); exit(0) }
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
        let action = request["action"] as? [String: Any]
        let refDisplay = (action?["ref"] as? String).flatMap { elementReferences[$0]?.display } ?? (action?["snapshot"] as? String).flatMap { snapshotDisplays[$0] }
        try chooseDisplay(request["displayId"] ?? action?["displayId"] ?? refDisplay.map { NSNumber(value: $0) })
        switch op {
        case "displays": out(displays())
        case "wait-change": out(waitChange((request["revision"] as? NSNumber)?.uint64Value ?? screenRevision, request["ms"] as? Int ?? 400))
        case "shot":
          guard CGPreflightScreenCaptureAccess() else { try refuse("Reach needs Screen Recording to show the Mac to an agent.", "unavailable") }
          out(try await shot(rules, max(320, min(3840, request["maxWidth"] as? Int ?? 2560))))
        case "act":
          guard AXIsProcessTrusted() else { try refuse("Reach needs Accessibility to let an agent use this Mac.", "unavailable") }
          guard let action = request["action"] as? [String: Any] else { try refuse("Choose an action.", "invalid") }
          out(try perform(action, displayBounds(), rules, request["expected"] as? [String: String]))
        case "open":
          guard AXIsProcessTrusted() else { try refuse("Reach needs Accessibility to let an agent use this Mac.", "unavailable") }
          out(try open(request["app"] as? String ?? "", rules))
        case "front":
          out(front(rules, detail: request["detail"] as? Bool == true))
        case "windows":
          guard AXIsProcessTrusted() else { try refuse("Reach needs Accessibility to let an agent use this Mac.", "unavailable") }
          out(try windowList(rules))
        case "focus":
          guard AXIsProcessTrusted() else { try refuse("Reach needs Accessibility to let an agent use this Mac.", "unavailable") }
          out(try focusWindow(request["id"] as? String ?? "", title: request["title"] as? String ?? "", tab: request["tab"] as? String ?? "", tabRef: request["tabRef"] as? String ?? "", rules))
        case "menus":
          guard AXIsProcessTrusted() else { try refuse("Reach needs Accessibility to let an agent use this Mac.", "unavailable") }
          out(try menuBar(rules, menu: request["menu"] as? String ?? ""))
        case "find":
          guard AXIsProcessTrusted() else { try refuse("Reach needs Accessibility to let an agent use this Mac.", "unavailable") }
          out(try findOnScreen(rules, text: request["text"] as? String ?? "", name: request["name"] as? String ?? "", role: request["role"] as? String ?? ""))
        case "read":
          guard AXIsProcessTrusted() else { try refuse("Reach needs Accessibility to let an agent use this Mac.", "unavailable") }
          out(try readPage(rules))
        case "open-file":
          guard AXIsProcessTrusted() else { try refuse("Reach needs Accessibility to let an agent use this Mac.", "unavailable") }
          out(try openFile(request["path"] as? String ?? "", reveal: request["reveal"] as? Bool == true, rules))
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
        out(["error": refusal.message, "kind": refusal.kind, "candidates": refusal.candidates])
      } catch {
        out(["error": "The Mac couldn't do that.", "kind": "unavailable"])
      }
    }
    termination.cancel()
  }
}
