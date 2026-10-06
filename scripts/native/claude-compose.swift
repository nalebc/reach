// Puts a message from the phone into the Claude app's own message box and
// presses its Send, as the person would at the Mac: the app's own Claude Code
// process runs it and its window shows it at once (a chat that is working
// queues it, as the app does). Only when the window's header names the chat
// it is meant for, and never over text already in the box. Which chat is
// on screen is read by the app's own id for it (--session local_…, from its
// page's address: two chats can share a name, never an id); without one, by
// the name in the header (--title, exactly).
// Pictures are pasted (Edit > Paste) and the clipboard is put back after.
// `--check` only reports what the window shows. Prints one JSON line.
import AppKit
import ApplicationServices

func attr(_ e: AXUIElement, _ name: String) -> AnyObject? {
  var v: AnyObject?
  return AXUIElementCopyAttributeValue(e, name as CFString, &v) == .success ? v : nil
}
func str(_ e: AXUIElement, _ name: String) -> String { (attr(e, name) as? String) ?? "" }
func children(_ e: AXUIElement) -> [AXUIElement] { (attr(e, kAXChildrenAttribute) as? [AXUIElement]) ?? [] }
func label(_ e: AXUIElement) -> String {
  let title = str(e, kAXTitleAttribute)
  return (title.isEmpty ? str(e, kAXDescriptionAttribute) : title).trimmingCharacters(in: .whitespacesAndNewlines)
}
// What this run does, as its reply names it ("sent", "drafted", "stopped"):
// a refusal says it didn't ({"sent": false, "error": …}), so Reach knows
// nothing happened and may try again (every refusal comes before Send).
nonisolated(unsafe) var replyAction = ""
func out(_ value: [String: Any]) -> Never {
  var value = value
  if value["error"] != nil, !replyAction.isEmpty, value[replyAction] == nil { value[replyAction] = false }
  let data = (try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])) ?? Data("{}".utf8)
  print(String(data: data, encoding: .utf8) ?? "{}")
  exit(0)
}

struct Window {
  var titles: [String] = []  // the chat named in the header ("<title>, rename session")
  var sessions: [String] = []  // the chat on screen by the app's own id (local_…), from its page's address
  var boxes: [AXUIElement] = []  // message boxes
    var send: AXUIElement?  // the button that says exactly "Send"
    var stop: AXUIElement?
    var mode: AXUIElement?  // the composer's permission mode menu, named for the mode it's in
    var modeName = ""
}
// The permission modes the Claude app's menu lists that Reach may pick, as it
// names them. Never "Bypass permissions": that one is turned on at the Mac.
let modeNames = ["Auto", "Manual", "Accept edits", "Plan"]
// Each element's role, children, title and description in one call to the
// app (not one call each): the whole window is walked about a third faster.
let looked = [kAXRoleAttribute, kAXChildrenAttribute, kAXTitleAttribute, kAXDescriptionAttribute] as CFArray
// The app's id for a chat, as its page's address carries it
// (https://claude.ai/epitaxy/local_<uuid>).
let sessionPattern = try! NSRegularExpression(pattern: "local_[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}")
func sessionIn(_ s: String) -> String? {
  guard let m = sessionPattern.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)), let r = Range(m.range, in: s) else { return nil }
  return String(s[r])
}
func look(_ app: AXUIElement) -> Window {
  var found = Window()
  var queue = (attr(app, kAXWindowsAttribute) as? [AXUIElement]) ?? []
  var i = 0
  while i < queue.count, i < 60000 {
    let e = queue[i]
    i += 1
    var values: CFArray?
    guard AXUIElementCopyMultipleAttributeValues(e, looked, AXCopyMultipleAttributeOptions(rawValue: 0), &values) == .success,
      let v = values as? [AnyObject], v.count == 4
    else { continue }
    let role = (v[0] as? String) ?? ""
    let description = (v[3] as? String) ?? ""
    switch role {
    case "AXWebArea":
      if let url = attr(e, "AXURL") as? URL, let session = sessionIn(url.absoluteString), !found.sessions.contains(session) {
        found.sessions.append(session)
      }
    case kAXTextAreaRole as String:
      // The message box is labelled "Prompt" (other fields come and go).
      if description == "Prompt" { found.boxes.append(e) }
    case kAXPopUpButtonRole as String:
      let title = (v[2] as? String) ?? ""
      let text = (title.isEmpty ? description : title).trimmingCharacters(in: .whitespacesAndNewlines)
      if modeNames.contains(text) || text == "Bypass permissions" { found.mode = e; found.modeName = text }
    case kAXButtonRole as String:
      let title = (v[2] as? String) ?? ""
      let text = (title.isEmpty ? description : title).trimmingCharacters(in: .whitespacesAndNewlines)
      if text.hasSuffix(", rename session") { found.titles.append(String(text.dropLast(", rename session".count))) }
      if text == "Send" { found.send = e }
      if text == "Stop" || text == "Stop response" { found.stop = e }
    default:
      break
    }
    if let kids = v[1] as? [AXUIElement] { queue.append(contentsOf: kids) }
  }
  return found
}
func value(_ box: AXUIElement) -> String { str(box, kAXValueAttribute).trimmingCharacters(in: .whitespacesAndNewlines) }
func enabled(_ e: AXUIElement?) -> Bool { e.map { (attr($0, kAXEnabledAttribute) as? Bool) ?? false } ?? false }

func pressMenu(_ app: AXUIElement, _ path: [String]) -> Bool {
  guard let bar = attr(app, kAXMenuBarAttribute) else { return false }
  var current = bar as! AXUIElement
  for (n, title) in path.enumerated() {
    guard let item = children(current).first(where: { str($0, kAXTitleAttribute) == title }) else { return false }
    if n == path.count - 1 { return AXUIElementPerformAction(item, kAXPressAction as CFString) == .success }
    current = children(item).first ?? item
  }
  return false
}

@main
struct ClaudeCompose {
  static func main() {
    let args = CommandLine.arguments
    let option = { (name: String) -> String? in args.firstIndex(of: name).flatMap { $0 + 1 < args.count ? args[$0 + 1] : nil } }
    let images = args.indices.filter { args[$0] == "--image" && $0 + 1 < args.count }.map { args[$0 + 1] }
    var payload: [String: Any] = [:]
    if args.contains("--json") {
      let data = FileHandle.standardInput.readDataToEndOfFile()
      guard data.count <= 524288, let decoded = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
      else { out(["error": "Invalid composer request."]) }
      payload = decoded
    }
    replyAction =
      args.contains("--check") || args.contains("--mode") ? ""
      : args.contains("--stop") ? "stopped" : payload["draft"] as? Bool == true ? "drafted" : "sent"
    guard AXIsProcessTrusted() else { out(["error": "Reach needs Accessibility to type in the Claude app."]) }
    guard let running = NSRunningApplication.runningApplications(withBundleIdentifier: "com.anthropic.claudefordesktop").first
    else { out(["error": "The Claude app isn't open."]) }
    let app = AXUIElementCreateApplication(running.processIdentifier)
    AXUIElementSetAttributeValue(app, "AXManualAccessibility" as CFString, kCFBooleanTrue)
    var window = look(app)
    if window.titles.isEmpty {
      usleep(400_000)  // the page's tree may still be building
      window = look(app)
    }
    if args.contains("--check") {
      out(["titles": window.titles, "sessions": window.sessions, "boxes": window.boxes.count, "draft": window.boxes.first.map { !value($0).isEmpty } ?? false])
    }
    guard let title = option("--title") else { out(["error": "Say which chat to use."]) }
    let text = (payload["text"] as? String) ?? option("--text") ?? ""
    // The right chat (by its id when Reach gives one), one message box,
    // nothing typed in it. Right after Reach switches the window to this chat
    // it can still show the one before for a moment: looked at again for up
    // to --wait ms (2 s unless said) before giving up.
    let session = option("--session")
    let showing = { (w: Window) -> Bool in session.map { w.sessions == [$0] } ?? (w.titles == [title]) }
    let until = Date().addingTimeInterval(min(Double(option("--wait") ?? "") ?? 2000, 20000) / 1000)
    while !showing(window), Date() < until {
      usleep(250_000)
      window = look(app)
    }
    guard showing(window) else { out(["error": "The Claude app is showing another chat.", "titles": window.titles, "sessions": window.sessions]) }
    // A permission mode picked on the phone: chosen in the app's own menu, as
    // a person would, so the app and the phone show the same one.
    if let wanted = option("--mode") {
      guard modeNames.contains(wanted) else { out(["error": "Reach can't pick that mode."]) }
      guard let button = window.mode else { out(["error": "Couldn't find the Claude app's permission mode."]) }
      if window.modeName == wanted { out(["mode": wanted]) }
      guard AXUIElementPerformAction(button, kAXPressAction as CFString) == .success
      else { out(["error": "Couldn't open the Claude app's permission modes."]) }
      // Its items read "<mode> <what it does>" ("Plan Create a plan before…").
      var item: AXUIElement?
      for _ in 0..<20 where item == nil {
        usleep(50_000)
        var queue = (attr(app, kAXWindowsAttribute) as? [AXUIElement]) ?? []
        var i = 0
        while i < queue.count, i < 60000, item == nil {
          let e = queue[i]
          i += 1
          if str(e, kAXRoleAttribute) == kAXMenuItemRole as String {
            let text = label(e)
            if text == wanted || text.hasPrefix(wanted + " ") { item = e }
          }
          queue.append(contentsOf: children(e))
        }
      }
      guard let pick = item, AXUIElementPerformAction(pick, kAXPressAction as CFString) == .success else {
        AXUIElementPerformAction(button, kAXPressAction as CFString)  // close the menu again
        out(["error": "Couldn't pick that mode in the Claude app."])
      }
      for _ in 0..<20 {
        usleep(50_000)
        if look(app).modeName == wanted { out(["mode": wanted]) }
      }
      out(["error": "The Claude app didn't switch to that mode."])
    }
    if args.contains("--stop") {
      guard let stop = window.stop, enabled(stop), AXUIElementPerformAction(stop, kAXPressAction as CFString) == .success
      else { out(["error": "Claude's Stop button isn't available in this chat."]) }
      out(["stopped": true])
    }
    guard window.boxes.count == 1, let box = window.boxes.first else { out(["error": "Couldn't find the Claude app's message box."]) }
    let expected = (payload["expected"] as? String) ?? ""
    // What Reach put there, or the very message being sent (its own draft,
    // synced as it was typed): fine. Anything else was typed on the Mac and is
    // never overwritten. An empty box reads "\n" (its editor keeps a line
    // break), so the space around the text doesn't count.
    let trimmed = { (s: String) in s.trimmingCharacters(in: .whitespacesAndNewlines) }
    let current = value(box)
    guard current == trimmed(expected) || (!text.isEmpty && current == trimmed(text)) else {
      out(["error": "This chat's box in the Claude app has text typed on your Mac. Reach won't overwrite it: send or clear it there.", "draft": true])
    }
    if payload["draft"] as? Bool == true {
      // No focus changes, clipboard access, key presses or Send during typing.
      guard AXUIElementSetAttributeValue(box, kAXValueAttribute as CFString, text as CFString) == .success,
        showing(look(app)), value(box) == trimmed(text)
      else { out(["error": "Claude couldn't update this draft."]) }
      out(["drafted": true])
    }
    AXUIElementSetAttributeValue(box, kAXFocusedAttribute as CFString, kCFBooleanTrue)
    // Pictures: pasted one at a time, the clipboard put back after.
    if !images.isEmpty {
      let pasteboard = NSPasteboard.general
      let saved = (pasteboard.pasteboardItems ?? []).map { item in item.types.compactMap { t in item.data(forType: t).map { (t, $0) } } }
      defer {
        pasteboard.clearContents()
        let restored = saved.map { pairs -> NSPasteboardItem in
          let item = NSPasteboardItem()
          for (type, data) in pairs { item.setData(data, forType: type) }
          return item
        }
        if !restored.isEmpty { pasteboard.writeObjects(restored) }
      }
      for file in images {
        guard let data = try? Data(contentsOf: URL(fileURLWithPath: file)), let image = NSImage(data: data),
          let tiff = image.tiffRepresentation, let png = NSBitmapImageRep(data: tiff)?.representation(using: .png, properties: [:])
        else { out(["error": "A picture couldn't be read."]) }
        pasteboard.clearContents()
        pasteboard.setData(png, forType: .png)
        guard showing(look(app)), pressMenu(app, ["Edit", "Paste"]) else { out(["error": "Couldn't paste the picture into the Claude app."]) }
        usleep(700_000)
      }
    }
    // The text, then a last look that it's still the same chat before Send.
    // The app enables Send a frame after the text goes in: looked for again
    // at once (no fixed 300 ms pause), for up to a second.
    if !text.isEmpty || !expected.isEmpty {
      guard AXUIElementSetAttributeValue(box, kAXValueAttribute as CFString, text as CFString) == .success
      else { out(["error": "Claude couldn't update the message."]) }
      usleep(20_000)
    }
    window = look(app)
    for _ in 0..<12 where showing(window) && !enabled(window.send) {
      usleep(50_000)
      window = look(app)
    }
    guard showing(window) else { out(["error": "The Claude app switched to another chat."]) }
    guard window.boxes.count == 1, let currentBox = window.boxes.first, value(currentBox) == trimmed(text)
    else { out(["error": "The message changed before Send. Reach hasn't sent it."]) }
    guard let send = window.send, enabled(send) else { out(["error": "The Claude app's Send isn't available."]) }
    guard AXUIElementPerformAction(send, kAXPressAction as CFString) == .success else { out(["error": "Couldn't press Send in the Claude app."]) }
    // The box emptying says the app took it: read on the box itself (one call,
    // not a walk of the whole window). Reach confirms from the transcript too.
    for _ in 0..<25 {
      usleep(20_000)
      if value(currentBox).isEmpty { out(["sent": true]) }
    }
    // The app received Send. An uncertain UI refresh must not retry it and
    // accidentally submit the same message twice.
    out(["sent": true, "unconfirmed": true])
  }
}
