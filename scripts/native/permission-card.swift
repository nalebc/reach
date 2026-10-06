// Reads or answers one permission card in the Claude app or the Codex app
// (--app claude|codex), so the phone shows that card as the app draws it and
// answers it as if tapped there:
// - `--read`: the card's words and its buttons, in the app's order, and the
//   choices in its menu (the Codex app's "Approval options"), opened and
//   closed again to read them.
// - `--press <label>`: presses the card's button with exactly that label, or
//   the menu's choice with exactly that label (opening the menu first).
// Only inside a card that holds a Deny button and says what Reach expects
// (each --expect text: the command, the file, the address the request is
// about); a press only once the card has been on screen a moment (a card that
// has just appeared ignores presses), reported pressed only once it's gone.
// Prints one JSON line and exits.
import AppKit
import ApplicationServices

func attr(_ e: AXUIElement, _ name: String) -> AnyObject? {
  var v: AnyObject?
  return AXUIElementCopyAttributeValue(e, name as CFString, &v) == .success ? v : nil
}
func str(_ e: AXUIElement, _ name: String) -> String { (attr(e, name) as? String) ?? "" }
// What a button says: Chromium puts it in the title or the description.
func label(_ e: AXUIElement) -> String {
  let title = str(e, kAXTitleAttribute).trimmingCharacters(in: .whitespacesAndNewlines)
  return title.isEmpty ? str(e, kAXDescriptionAttribute).trimmingCharacters(in: .whitespacesAndNewlines) : title
}
// "Deny" matches "Deny" and "Deny Esc" (the shortcut shown beside it), never "Denying".
func starts(_ text: String, _ word: String) -> Bool { text == word || text.hasPrefix(word + " ") }
func children(_ e: AXUIElement) -> [AXUIElement] { (attr(e, kAXChildrenAttribute) as? [AXUIElement]) ?? [] }

func out(_ value: [String: Any]) -> Never {
  let data = (try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])) ?? Data("{}".utf8)
  print(String(data: data, encoding: .utf8) ?? "{}")
  exit(0)
}

// Text compared without spaces, so a command split across elements still matches.
func squeezed(_ text: String) -> String { text.filter { !$0.isWhitespace }.lowercased() }

let buttonRoles: Set<String> = [kAXButtonRole as String, "AXPopUpButton", "AXMenuButton"]
// A button that opens a menu rather than answering.
func opensMenu(_ e: AXUIElement, _ role: String) -> Bool {
  role != (kAXButtonRole as String) || (attr(e, "AXHasPopup") as? Bool) == true
}
// The menu items on screen now (an open dropdown), with what they say.
func menuItems(_ app: AXUIElement) -> [(label: String, item: AXUIElement)] {
  var queue = (attr(app, kAXWindowsAttribute) as? [AXUIElement]) ?? []
  var found: [(String, AXUIElement)] = []
  var i = 0
  while i < queue.count, i < 60000 {
    let e = queue[i]
    i += 1
    let role = str(e, kAXRoleAttribute)
    if role == "AXMenuItem" || role == "AXMenuItemCheckBox" || role == "AXMenuItemRadio" {
      var text = label(e)
      if text.isEmpty {
        var stack = children(e)
        while let next = stack.popLast() {
          if str(next, kAXRoleAttribute) == (kAXStaticTextRole as String) { text += str(next, kAXValueAttribute) }
          stack.append(contentsOf: children(next))
        }
      }
      let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
      if !trimmed.isEmpty { found.append((trimmed, e)) }
      continue
    }
    queue.append(contentsOf: children(e))
  }
  return found
}
// Closes an open menu: Escape, to that app only.
func escape(_ pid: pid_t) {
  for down in [true, false] { CGEvent(keyboardEventSource: nil, virtualKey: 53, keyDown: down)?.postToPid(pid) }
  usleep(250_000)
}
struct Card {
  var buttons: [(label: String, button: AXUIElement, menu: Bool)] = []
  // Its words in reading order (a button's own words are its label).
  var texts: [String] = []
}

// The card: the nearest element around a Deny button that holds another
// button, an Allow, and every expected text. Breadth first from the windows.
func findCard(_ app: AXUIElement, expect: [String]) -> Card? {
  var queue = (attr(app, kAXWindowsAttribute) as? [AXUIElement]) ?? []
  var denies: [AXUIElement] = []
  var i = 0
  while i < queue.count, i < 60000 {
    let e = queue[i]
    i += 1
    if str(e, kAXRoleAttribute) == (kAXButtonRole as String), starts(label(e), "Deny") { denies.append(e) }
    queue.append(contentsOf: children(e))
  }
  for deny in denies {
    var up: AXUIElement? = deny
    for _ in 0..<8 {
      guard let parent = up.flatMap({ attr($0, kAXParentAttribute) }) else { break }
      let box = parent as! AXUIElement
      var card = Card()
      var stack = [box]
      var seen = 0
      while let next = stack.popLast(), seen < 800 {
        seen += 1
        let role = str(next, kAXRoleAttribute)
        if buttonRoles.contains(role) {
          card.buttons.append((label(next), next, opensMenu(next, role)))
          continue
        }
        if role == (kAXStaticTextRole as String) {
          let value = str(next, kAXValueAttribute).trimmingCharacters(in: .whitespacesAndNewlines)
          if !value.isEmpty { card.texts.append(value) }
        }
        stack.append(contentsOf: children(next).reversed())
      }
      if card.buttons.count >= 2 && card.buttons.contains(where: { starts($0.label, "Allow") }) {
        let all = squeezed(card.texts.joined())
        return expect.allSatisfy({ all.contains(squeezed($0)) }) ? card : nil
      }
      up = box
    }
  }
  return nil
}

@main
struct PermissionCard {
  static func main() {
    let args = CommandLine.arguments
    let value = { (name: String) in args.firstIndex(of: name).flatMap { $0 + 1 < args.count ? args[$0 + 1] : nil } }
    let read = args.contains("--read")
    let press = value("--press")
    let expect = args.indices.filter { args[$0] == "--expect" && $0 + 1 < args.count }.map { args[$0 + 1] }
    guard read || !(press ?? "").isEmpty else { out(["error": "Choose a button."]) }
    // Never a card that doesn't name this request.
    guard !expect.isEmpty, expect.allSatisfy({ !squeezed($0).isEmpty }) else { out(["error": "Reach doesn't know which request this is."]) }
    let apps = ["claude": ("com.anthropic.claudefordesktop", "Claude"), "codex": ("com.openai.codex", "Codex")]
    guard let (bundle, name) = apps[value("--app") ?? "claude"] else { out(["error": "Choose the Claude app or the Codex app."]) }
    guard AXIsProcessTrusted() else { out(["error": "Reach needs Accessibility to answer it."]) }
    guard let running = NSRunningApplication.runningApplications(withBundleIdentifier: bundle).first
    else { out(["error": "The \(name) app isn't open."]) }
    let app = AXUIElementCreateApplication(running.processIdentifier)
    // Electron builds its page's accessibility tree only once asked.
    AXUIElementSetAttributeValue(app, "AXManualAccessibility" as CFString, kCFBooleanTrue)
    let started = Date()
    let look = { findCard(app, expect: expect) }
    let ms = { Int(Date().timeIntervalSince(started) * 1000) }
    // The tree may still be building right after it's asked for; the card may
    // be appearing (the window was just switched to it).
    var since: Date?
    var ready = false
    while !ready, Date().timeIntervalSince(started) < 7 {
      if let card = look() {
        if read {
          // The menu's choices: opened, read, closed again.
          var more: [String] = []
          if let menu = card.buttons.first(where: { $0.menu }) {
            let before = Set(menuItems(app).map { $0.label })
            if AXUIElementPerformAction(menu.button, kAXPressAction as CFString) == .success {
              usleep(400_000)
              more = menuItems(app).map { $0.label }.filter { !before.contains($0) }
              escape(running.processIdentifier)
            }
          }
          out([
            "found": true,
            "texts": card.texts,
            "buttons": card.buttons.map { ["label": $0.label, "menu": $0.menu] },
            "more": more,
            "ms": ms(),
          ])
        }
        if since == nil { since = Date() } else { ready = Date().timeIntervalSince(since!) >= 1 }
      } else {
        since = nil
      }
      if !ready { usleep(250_000) }
    }
    guard ready, let choice = press else { out(read ? ["found": false, "ms": ms()] : ["error": "The app isn't showing that request."]) }
    // Pressed, then gone: answered. Still there: once more, then say so.
    for attempt in 0..<2 {
      guard let card = look() else {
        out(attempt == 0 ? ["error": "This request was already answered."] : ["pressed": choice, "ms": ms()])
      }
      // Exactly the button chosen: one with that label, never a menu; else
      // the menu's choice with that label, the menu opened first.
      let matching = card.buttons.filter { $0.label == choice && !$0.menu }
      if matching.count == 1 {
        guard AXUIElementPerformAction(matching[0].button, kAXPressAction as CFString) == .success
        else { out(["error": "Couldn't press it in the app."]) }
      } else if matching.isEmpty, let menu = card.buttons.first(where: { $0.menu }) {
        let before = Set(menuItems(app).map { $0.label })
        guard AXUIElementPerformAction(menu.button, kAXPressAction as CFString) == .success
        else { out(["error": "Couldn't open the card's menu in the app."]) }
        usleep(400_000)
        let items = menuItems(app).filter { $0.label == choice && !before.contains($0.label) }
        guard items.count == 1 else {
          escape(running.processIdentifier)
          out(["error": "The card no longer offers \"\(choice)\"."])
        }
        guard AXUIElementPerformAction(items[0].item, kAXPressAction as CFString) == .success
        else { escape(running.processIdentifier); out(["error": "Couldn't press it in the app."]) }
      } else {
        out(["error": "The card no longer offers \"\(choice)\".", "buttons": card.buttons.map { $0.label }])
      }
      for _ in 0..<10 {
        usleep(200_000)
        if look() == nil { out(["pressed": choice, "ms": ms()]) }
      }
    }
    out(["error": "The app didn't take the answer."])
  }
}
