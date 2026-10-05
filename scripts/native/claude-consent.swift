// Presses one button on the Claude app's own consent card (letting Claude use
// apps), as the person chose on their phone: "Deny" or "Allow for this
// session". Only inside a card that holds both of those buttons and says what
// Reach expects (each --expect text, e.g. "Allow Claude to use" and the app's
// name), only once that card has been on screen a moment (a card that has
// just appeared ignores presses), and it reports pressed only once the card
// is gone. `--find` only reports whether the card is there. Prints one JSON
// line and exits.
import AppKit
import ApplicationServices

let choices = ["Deny", "Allow for this session"]

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
func says(_ e: AXUIElement, _ choice: String) -> Bool {
  let text = label(e)
  return text == choice || text.hasPrefix(choice + " ")
}
func children(_ e: AXUIElement) -> [AXUIElement] { (attr(e, kAXChildrenAttribute) as? [AXUIElement]) ?? [] }

func out(_ value: [String: Any]) -> Never {
  let data = (try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])) ?? Data("{}".utf8)
  print(String(data: data, encoding: .utf8) ?? "{}")
  exit(0)
}

// Text compared without spaces, so a title split across elements still matches.
func squeezed(_ text: String) -> String { text.filter { !$0.isWhitespace }.lowercased() }

// The card: the nearest element holding a "Deny" and an "Allow for this
// session" button and every expected text. Breadth first from the windows.
func findCard(_ app: AXUIElement, expect: [String], budget: inout Int) -> [String: AXUIElement]? {
  var queue = (attr(app, kAXWindowsAttribute) as? [AXUIElement]) ?? []
  var allow: [AXUIElement] = []
  var i = 0
  while i < queue.count, budget > 0 {
    let e = queue[i]
    i += 1
    budget -= 1
    if str(e, kAXRoleAttribute) == (kAXButtonRole as String), says(e, choices[1]) { allow.append(e) }
    queue.append(contentsOf: children(e))
  }
  for button in allow {
    var up: AXUIElement? = button
    for _ in 0..<8 {
      guard let parent = up.flatMap({ attr($0, kAXParentAttribute) }) else { break }
      let box = parent as! AXUIElement
      var found: [String: AXUIElement] = [:]
      var text = ""
      var stack = [box]
      var seen = 0
      while let next = stack.popLast(), seen < 400 {
        seen += 1
        let role = str(next, kAXRoleAttribute)
        if role == (kAXButtonRole as String) {
          for choice in choices where says(next, choice) && found[choice] == nil { found[choice] = next }
        } else if role == (kAXStaticTextRole as String) {
          text += str(next, kAXValueAttribute)
        }
        stack.append(contentsOf: children(next).reversed())
      }
      if found.count == choices.count {
        let all = squeezed(text)
        return expect.allSatisfy({ all.contains(squeezed($0)) }) ? found : nil
      }
      up = box
    }
  }
  return nil
}

@main
struct ClaudeConsent {
  static func main() {
    let args = CommandLine.arguments
    let find = args.contains("--find")
    let press = args.firstIndex(of: "--press").flatMap { $0 + 1 < args.count ? args[$0 + 1] : nil }
    let expect = args.indices.filter { args[$0] == "--expect" && $0 + 1 < args.count }.map { args[$0 + 1] }
    guard find || press.map(choices.contains) == true else { out(["error": "Choose Deny or Allow for this session."]) }
    guard AXIsProcessTrusted() else { out(["error": "Reach needs Accessibility to answer the Claude app."]) }
    guard let running = NSRunningApplication.runningApplications(withBundleIdentifier: "com.anthropic.claudefordesktop").first
    else { out(["error": "The Claude app isn't open."]) }
    let app = AXUIElementCreateApplication(running.processIdentifier)
    // Electron builds its page's accessibility tree only once asked.
    AXUIElementSetAttributeValue(app, "AXManualAccessibility" as CFString, kCFBooleanTrue)
    let started = Date()
    let look = { () -> [String: AXUIElement]? in
      var budget = 60000
      return findCard(app, expect: expect, budget: &budget)
    }
    let ms = { Int(Date().timeIntervalSince(started) * 1000) }
    // The tree may still be building right after it's asked for; the card may
    // be appearing (the window was just switched to it).
    var since: Date?
    var ready = false
    while !ready, Date().timeIntervalSince(started) < 7 {
      if look() == nil {
        since = nil
      } else if find {
        out(["found": true, "ms": ms()])
      } else if since == nil {
        since = Date()
      } else {
        ready = Date().timeIntervalSince(since!) >= 1
      }
      if !ready { usleep(250_000) }
    }
    guard ready, let choice = press else { out(find ? ["found": false, "ms": ms()] : ["error": "The Claude app isn't showing that request."]) }
    // Pressed, then gone: answered. Still there: once more, then say so.
    for attempt in 0..<2 {
      guard let card = look(), let button = card[choice] else {
        out(attempt == 0 ? ["error": "This request was already answered."] : ["pressed": choice, "ms": ms()])
      }
      guard AXUIElementPerformAction(button, kAXPressAction as CFString) == .success
      else { out(["error": "Couldn't press it in the Claude app."]) }
      for _ in 0..<10 {
        usleep(200_000)
        if look() == nil { out(["pressed": choice, "ms": ms()]) }
      }
    }
    out(["error": "The Claude app didn't take the answer."])
  }
}
