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
// - `--answer --q <question> --pick <label> [--pick …] [--q …]`: a question
//   card in the Claude app (Claude's multiple choice), answered as tapped
//   there: each question found by its exact words, its option(s) pressed by
//   their exact label (never a guess between two), then Submit; reported
//   answered only once the question is gone.
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

// What an option says: its own label, else the words inside it.
func optionText(_ e: AXUIElement) -> String {
  let own = label(e)
  if !own.isEmpty { return own }
  var text: [String] = []
  var stack = children(e)
  while let next = stack.popLast(), text.count < 20 {
    if str(next, kAXRoleAttribute) == (kAXStaticTextRole as String) {
      let v = str(next, kAXValueAttribute).trimmingCharacters(in: .whitespacesAndNewlines)
      if !v.isEmpty { text.append(v) }
    }
    stack.append(contentsOf: children(next).reversed())
  }
  return text.joined(separator: " ")
}
let optionRoles: Set<String> = [kAXButtonRole as String, kAXRadioButtonRole as String, kAXCheckBoxRole as String, "AXMenuItemRadio", "AXMenuItemCheckBox"]
// The one control for a label: exactly that label, else one starting with it
// and then its description ("Plan Create a plan first"); two candidates: none.
func control(_ buttons: [(String, AXUIElement)], _ pick: String) -> AXUIElement? {
  let exact = buttons.filter { $0.0 == pick }
  if exact.count == 1 { return exact[0].1 }
  if exact.count > 1 { return nil }
  let prefixed = buttons.filter { $0.0.hasPrefix(pick + " ") || $0.0.hasPrefix(pick + "\n") }
  return prefixed.count == 1 ? prefixed[0].1 : nil
}
// Where the question shows: the nearest element around its words that holds
// a control for every pick.
func findQuestion(_ app: AXUIElement, _ question: String, _ picks: [String]) -> (box: AXUIElement, buttons: [(String, AXUIElement)])? {
  let want = squeezed(question)
  guard !want.isEmpty else { return nil }
  var queue = (attr(app, kAXWindowsAttribute) as? [AXUIElement]) ?? []
  var texts: [AXUIElement] = []
  var i = 0
  while i < queue.count, i < 60000 {
    let e = queue[i]
    i += 1
    if str(e, kAXRoleAttribute) == (kAXStaticTextRole as String), squeezed(str(e, kAXValueAttribute)).contains(want) { texts.append(e) }
    queue.append(contentsOf: children(e))
  }
  for text in texts {
    var up: AXUIElement? = text
    for _ in 0..<10 {
      guard let parent = up.flatMap({ attr($0, kAXParentAttribute) }) else { break }
      let box = parent as! AXUIElement
      var buttons: [(String, AXUIElement)] = []
      var stack = [box]
      var seen = 0
      while let next = stack.popLast(), seen < 1500 {
        seen += 1
        if optionRoles.contains(str(next, kAXRoleAttribute)) {
          buttons.append((optionText(next), next))
          continue
        }
        stack.append(contentsOf: children(next).reversed())
      }
      if !picks.isEmpty, picks.allSatisfy({ control(buttons, $0) != nil }) { return (box, buttons) }
      up = box
    }
  }
  return nil
}
func shows(_ app: AXUIElement, _ question: String) -> Bool {
  let want = squeezed(question)
  var queue = (attr(app, kAXWindowsAttribute) as? [AXUIElement]) ?? []
  var i = 0
  while i < queue.count, i < 60000 {
    let e = queue[i]
    i += 1
    if str(e, kAXRoleAttribute) == (kAXStaticTextRole as String), squeezed(str(e, kAXValueAttribute)).contains(want) { return true }
    queue.append(contentsOf: children(e))
  }
  return false
}
func press(_ e: AXUIElement) -> Bool { AXUIElementPerformAction(e, kAXPressAction as CFString) == .success }

@main
struct PermissionCard {
  static func main() {
    let args = CommandLine.arguments
    let value = { (name: String) in args.firstIndex(of: name).flatMap { $0 + 1 < args.count ? args[$0 + 1] : nil } }
    let read = args.contains("--read")
    // How much of its window an app lets Reach see: Chromium apps that don't
    // build an accessibility tree show only a handful of elements.
    if args.contains("--probe") {
      let apps = ["claude": "com.anthropic.claudefordesktop", "codex": "com.openai.codex"]
      guard let bundle = apps[value("--app") ?? "claude"],
        let running = NSRunningApplication.runningApplications(withBundleIdentifier: bundle).first
      else { out(["elements": 0]) }
      let app = AXUIElementCreateApplication(running.processIdentifier)
      AXUIElementSetAttributeValue(app, "AXManualAccessibility" as CFString, kCFBooleanTrue)
      var count = 0
      for _ in 0..<4 {
        var queue = (attr(app, kAXWindowsAttribute) as? [AXUIElement]) ?? []
        var i = 0
        while i < queue.count, i < 400 { queue.append(contentsOf: children(queue[i])); i += 1 }
        count = i
        if count >= 50 { break }
        usleep(300_000)
      }
      out(["elements": count])
    }
    if args.contains("--answer") {
      // The questions in order, each with its picks.
      var asked: [(question: String, picks: [String])] = []
      var i = 0
      while i < args.count {
        if args[i] == "--q", i + 1 < args.count { asked.append((args[i + 1], [])) }
        if args[i] == "--pick", i + 1 < args.count, !asked.isEmpty { asked[asked.count - 1].picks.append(args[i + 1]) }
        i += 1
      }
      guard !asked.isEmpty, asked.allSatisfy({ !squeezed($0.question).isEmpty && !$0.picks.isEmpty }) else { out(["error": "Choose an answer for each question."]) }
      guard AXIsProcessTrusted() else { out(["error": "Reach needs Accessibility to answer it."]) }
      guard let running = NSRunningApplication.runningApplications(withBundleIdentifier: "com.anthropic.claudefordesktop").first
      else { out(["error": "The Claude app isn't open."]) }
      let app = AXUIElementCreateApplication(running.processIdentifier)
      AXUIElementSetAttributeValue(app, "AXManualAccessibility" as CFString, kCFBooleanTrue)
      var last: AXUIElement?
      for (n, q) in asked.enumerated() {
        // Found, then on screen a moment (a card that has just appeared ignores presses).
        var found: (box: AXUIElement, buttons: [(String, AXUIElement)])?
        let start = Date()
        var since: Date?
        while Date().timeIntervalSince(start) < 7 {
          if let f = findQuestion(app, q.question, q.picks) {
            found = f
            if n > 0 { break }
            if since == nil { since = Date() } else if Date().timeIntervalSince(since!) >= 1 { break }
          } else { since = nil; found = nil }
          usleep(250_000)
        }
        guard let card = found else {
          out(["error": n == 0 ? "The Claude app isn't showing this question." : "The Claude app didn't go on to the next question."])
        }
        for pick in q.picks {
          guard let option = control(card.buttons, pick), press(option) else { out(["error": "The card no longer offers \"\(pick)\"."]) }
          usleep(250_000)
        }
        last = card.box
        // More to answer, not on screen yet: the card's Next.
        if n + 1 < asked.count {
          usleep(300_000)
          if !shows(app, asked[n + 1].question),
            let next = card.buttons.first(where: { $0.0 == "Next" || $0.0.hasPrefix("Next ") }) {
            _ = press(next.1)
          }
        }
      }
      // Submit, when the card has one (a single question may go on its own).
      usleep(300_000)
      if shows(app, asked[0].question), let box = last {
        var buttons: [(String, AXUIElement)] = []
        var stack = [box]
        while let next = stack.popLast(), buttons.count < 200 {
          if optionRoles.contains(str(next, kAXRoleAttribute)) { buttons.append((optionText(next), next)); continue }
          stack.append(contentsOf: children(next))
        }
        let submits = buttons.filter { b in ["Submit", "Submit answers", "Send", "Done"].contains { b.0 == $0 || b.0.hasPrefix($0 + " ") } }
        if submits.count == 1 { _ = press(submits[0].1) }
      }
      for _ in 0..<15 {
        usleep(200_000)
        if !shows(app, asked[0].question) { out(["answered": true]) }
      }
      out(["error": "The Claude app didn't take the answer."])
    }
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
