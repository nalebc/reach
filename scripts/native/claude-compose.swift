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
    var popups: [(AXUIElement, String)] = []  // every pop-up button and what it reads ("Opus 5.5 Medium")
}
// Claude Code's effort levels as the Claude app names them (its phone app's
// sheet: Low, Medium, High, Extra high, Max).
let effortNames = ["Low", "Medium", "High", "Extra high", "Max"]
// The model chip reads "<model> <effort>"; it's the one ending in a level.
func effortOf(_ text: String) -> String? {
  let text = text.hasPrefix("Effort: ") ? String(text.dropFirst(8)) : text
  if text == "Extra" { return "Extra high" }
  return effortNames.sorted { $0.count > $1.count }.first { text == $0 || text.hasSuffix(" " + $0) }
}
func modelOf(_ text: String) -> String? {
  if text.hasPrefix("Effort: ") { return nil }
  if text.hasPrefix("Model: ") { return String(text.dropFirst(7)) }
  if let effort = effortOf(text), text.hasSuffix(" " + effort) { return String(text.dropLast(effort.count + 1)) }
  return nil
}
// Bounded traversal for native menu/confirmation controls.
func elements(_ root: AXUIElement, includeRoot: Bool = false, limit: Int = 60000) -> [AXUIElement] {
  var queue = includeRoot ? [root] : ((attr(root, kAXWindowsAttribute) as? [AXUIElement]) ?? children(root))
  var i = 0
  while i < queue.count, i < limit {
    let child = queue[i]; i += 1
    if queue.count < limit { queue.append(contentsOf: children(child).prefix(limit - queue.count)) }
  }
  return queue
}
// Testable dispatch/acknowledgement gate. Session identity is read again at
// each action, never retained from menu discovery or an earlier selection.
struct SettingsSessionGate {
  let session: String?
  var selectionAttempted = false
  func permits(_ sessions: [String]) -> Bool {
    session.map { sessions == [$0] } ?? false
  }
  mutating func perform(sessions: () -> [String], selection: Bool = false, action: () -> Bool) -> Bool {
    guard permits(sessions()) else { return false }
    if selection { selectionAttempted = true }
    return action()
  }
  func confirms(_ sessions: [String], matched: Bool) -> Bool {
    permits(sessions) && matched
  }
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
      found.popups.append((e, text))
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
      args.contains("--check") || args.contains("--model") || args.contains("--mode") || args.contains("--effort") ? ""
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
      out(["titles": window.titles, "sessions": window.sessions, "boxes": window.boxes.count, "draft": window.boxes.first.map { !value($0).isEmpty } ?? false, "popups": window.popups.map { $0.1 }])
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
    // Model changes use only the app's exact model menu and acknowledgement.
    // Never edit its record or send a slash command into the conversation.
    if let wanted = option("--model") {
      guard session != nil else { out(["error": "Say the exact Claude session to change its model."]) }
      guard !wanted.isEmpty, wanted.count <= 80, !wanted.contains("\n") else { out(["error": "Invalid model name."]) }
      let chips = window.popups.filter { modelOf($0.1) != nil }
      guard chips.count == 1, let chip = chips.first, let previous = modelOf(chip.1)
      else { out(["error": "Couldn't identify the Claude app's model menu."]) }
      if previous == wanted { out(["model": wanted]) }
      guard enabled(chip.0), showing(look(app)), AXUIElementPerformAction(chip.0, kAXPressAction as CFString) == .success
      else { out(["error": "Couldn't open the Claude app's model menu."]) }
      func closeModelMenu() {
        guard showing(look(app)) else { return }
        guard elements(app).contains(where: { ["AXMenu", "AXMenuItem", "AXMenuItemRadio", "AXMenuItemCheckbox"].contains(str($0, kAXRoleAttribute)) }) else { return }
        guard showing(look(app)) else { return }
        for down in [true, false] {
          let key = CGEvent(keyboardEventSource: nil, virtualKey: 53, keyDown: down)
          key?.postToPid(running.processIdentifier)
        }
      }
      let itemRoles: Set<String> = [kAXMenuItemRole as String, "AXMenuItemRadio", "AXMenuItemCheckbox"]
      func modelItems(_ name: String) -> [AXUIElement] {
        elements(app).filter { itemRoles.contains(str($0, kAXRoleAttribute)) && label($0) == name }
      }
      var items: [AXUIElement] = []
      for _ in 0..<20 where items.isEmpty { usleep(50_000); items = modelItems(wanted) }
      if items.isEmpty {
        let more = modelItems("More models")
        if more.count == 1, showing(look(app)), AXUIElementPerformAction(more[0], kAXPressAction as CFString) == .success {
          for _ in 0..<20 where items.isEmpty { usleep(50_000); items = modelItems(wanted) }
        }
      }
      guard items.count == 1, showing(look(app)), enabled(items[0]) else {
        closeModelMenu()
        out(["error": "Couldn't find that exact model in the Claude app."])
      }
      guard showing(look(app)) else { out(["error": "The Claude app changed chats before model selection."]) }
      guard AXUIElementPerformAction(items[0], kAXPressAction as CFString) == .success else {
        out(["error": "Claude didn't confirm the model selection. Check its model before trying again.", "unconfirmed": true])
      }
      // Existing sessions ask about their model-specific cache. Only accept
      // this exact from/to confirmation, within one bounded dialog/group;
      // never toggle “Don't ask again” or accept an unrelated prompt.
      let notice = "This session is cached for \(previous). Switching to \(wanted) means Claude re-reads the whole session on your next message, which uses more of your limit."
      var confirmed = false
      for _ in 0..<40 {
        usleep(50_000)
        let current = look(app)
        guard showing(current) else { out(["error": "The Claude app changed chats before confirming the model.", "unconfirmed": true]) }
        let selected = current.popups.compactMap { modelOf($0.1) }
        if selected == [wanted] { out(["model": wanted]) }
        if !confirmed {
          let buttons = elements(app).filter { str($0, kAXRoleAttribute) == kAXButtonRole as String && label($0) == "Switch model" }
          if buttons.count == 1 {
            let button = buttons[0]
            var parent = attr(button, kAXParentAttribute).map { $0 as! AXUIElement }
            var matched = false
            for _ in 0..<8 {
              guard let container = parent else { break }
              let role = str(container, kAXRoleAttribute)
              if role == "AXWebArea" || role == kAXWindowRole as String || role == kAXApplicationRole as String { break }
              if ["AXGroup", "AXDialog", "AXSheet"].contains(role) {
                let contents = elements(container, includeRoot: true, limit: 4000)
                let text = contents.map { e -> String in
                  let name = label(e)
                  return name.isEmpty ? str(e, kAXValueAttribute) : name
                }
                let cancel = contents.filter { str($0, kAXRoleAttribute) == kAXButtonRole as String && label($0) == "Cancel" }
                if text.contains("Switch model?"), text.contains(notice), cancel.count == 1 { matched = true; break }
              }
              parent = attr(container, kAXParentAttribute).map { $0 as! AXUIElement }
            }
            guard matched, showing(look(app)), enabled(button) else {
              out(["error": "Claude showed an unexpected model confirmation. Review it in Claude.", "unconfirmed": true])
            }
            guard AXUIElementPerformAction(button, kAXPressAction as CFString) == .success else {
              out(["error": "Claude couldn't confirm the model switch. Review it in Claude.", "unconfirmed": true])
            }
            confirmed = true
          }
        }
      }
      out(["error": "Claude didn't confirm the model change. Check its model before trying again.", "unconfirmed": true])
    }
    // Native setting actions are bound to the exact app session at dispatch,
    // including menu navigation and cleanup. Once a selection is attempted,
    // any later refusal is uncertain, never a claim that nothing changed.
    var settings = SettingsSessionGate(session: session)
    func settingsError(_ message: String) -> Never {
      out(["error": message, "unconfirmed": settings.selectionAttempted])
    }
    func settingsWindow() -> Window {
      let current = look(app)
      guard settings.permits(current.sessions) else {
        settingsError("The Claude app changed chats. Check this setting in Claude before trying again.")
      }
      return current
    }
    func settingsPress(_ element: AXUIElement, selection: Bool = false) -> Bool {
      settings.perform(sessions: { look(app).sessions }, selection: selection) {
        enabled(element) && AXUIElementPerformAction(element, kAXPressAction as CFString) == .success
      }
    }
    func settingsKeys(_ keyCode: CGKeyCode, flags: CGEventFlags = []) -> Bool {
      settings.perform(sessions: { look(app).sessions }) {
        // One shortcut action: always release a key sent to this process.
        for down in [true, false] {
          let key = CGEvent(keyboardEventSource: nil, virtualKey: keyCode, keyDown: down)
          key?.flags = flags
          key?.postToPid(running.processIdentifier)
        }
        return true
      }
    }
    func closeSettingsMenu() {
      guard settings.permits(look(app).sessions) else { return }
      // Escape only while a menu is still open in the target session. Do not
      // use a stale popup reference that could reopen a dismissed menu.
      let open = elements(app).contains { ["AXMenu", "AXMenuItem", "AXMenuItemRadio", "AXMenuItemCheckbox"].contains(str($0, kAXRoleAttribute)) }
      if open { _ = settingsKeys(53) }
    }
    // A permission mode picked on the phone: chosen in the app's own menu.
    if let wanted = option("--mode") {
      guard modeNames.contains(wanted) else { settingsError("Reach can't pick that mode.") }
      let current = settingsWindow()
      guard let button = current.mode else { settingsError("Couldn't find the Claude app's permission mode.") }
      if settings.confirms(current.sessions, matched: current.modeName == wanted) { out(["mode": wanted]) }
      guard settingsPress(button) else { settingsError("Couldn't open the Claude app's permission modes.") }
      var items: [AXUIElement] = []
      for _ in 0..<20 where items.isEmpty {
        usleep(50_000)
        _ = settingsWindow()
        items = elements(app).filter {
          guard ["AXMenuItem", "AXMenuItemRadio", "AXMenuItemCheckbox"].contains(str($0, kAXRoleAttribute)) else { return false }
          let text = label($0)
          return text == wanted || text.hasPrefix(wanted + " ")
        }
      }
      guard items.count == 1 else {
        closeSettingsMenu()
        settingsError("Couldn't identify that permission mode in the Claude app.")
      }
      guard settingsPress(items[0], selection: true) else {
        closeSettingsMenu()
        settingsError("Claude couldn't confirm the permission mode. Check it in Claude before trying again.")
      }
      for _ in 0..<20 {
        usleep(50_000)
        let current = settingsWindow()
        if settings.confirms(current.sessions, matched: current.modeName == wanted) { out(["mode": wanted]) }
      }
      settingsError("Claude didn't confirm the permission mode. Check it in Claude before trying again.")
    }
    // Effort selection works through a dedicated chip or the older model
    // menu. A shortcut fallback is also gated immediately before dispatch.
    if let wanted = option("--effort") {
      guard effortNames.contains(wanted) else { settingsError("Reach can't pick that effort level.") }
      let current = settingsWindow()
      let chips = current.popups.filter { effortOf($0.1) != nil }
      guard chips.count <= 1 else { settingsError("Couldn't identify the Claude app's effort control.") }
      let chip = chips.first
      if let chip = chip, settings.confirms(current.sessions, matched: effortOf(chip.1) == wanted) { out(["effort": wanted]) }
      let itemRoles: Set<String> = [kAXMenuItemRole as String, "AXMenuItemRadio", "AXMenuItemCheckbox"]
      func find(_ match: (String) -> Bool) -> AXUIElement? {
        for _ in 0..<20 {
          usleep(50_000)
          _ = settingsWindow()
          let matches = elements(app).filter { itemRoles.contains(str($0, kAXRoleAttribute)) && match(label($0)) }
          if matches.count > 1 { settingsError("Claude showed ambiguous effort controls. Review them in Claude.") }
          if let item = matches.first { return item }
        }
        return nil
      }
      let isWanted = { (t: String) in t == wanted || (wanted == "Extra high" && t == "Extra") || t.hasPrefix(wanted + " ") || t.hasPrefix(wanted + "\n") }
      var item: AXUIElement?
      if let chip = chip {
        guard settingsPress(chip.0) else { settingsError("Couldn't open the Claude app's effort control.") }
        item = find(isWanted)
        if item == nil, let row = find({ $0 == "Effort" || $0.hasPrefix("Effort ") }) {
          guard settingsPress(row) else { settingsError("Couldn't open the Claude app's effort menu.") }
          item = find(isWanted)
        }
        if item == nil { closeSettingsMenu() }
      }
      if item == nil {
        guard settingsKeys(14, flags: [.maskCommand, .maskShift]) else {
          settingsError("The Claude app changed chats before opening effort settings.")
        }
        item = find(isWanted)
      }
      guard let pick = item else {
        closeSettingsMenu()
        settingsError("Couldn't find that effort level in the Claude app.")
      }
      guard settingsPress(pick, selection: true) else {
        closeSettingsMenu()
        settingsError("Claude couldn't confirm the thinking level. Check it in Claude before trying again.")
      }
      for _ in 0..<20 {
        usleep(50_000)
        let current = settingsWindow()
        let selected = current.popups.compactMap { effortOf($0.1) }
        if settings.confirms(current.sessions, matched: selected == [wanted]) { out(["effort": wanted]) }
      }
      // Pressed, but not acknowledged: Reach must confirm the app's record.
      out(["effort": wanted, "unconfirmed": true])
    }
    if args.contains("--stop") {
      guard let stop = window.stop, enabled(stop), AXUIElementPerformAction(stop, kAXPressAction as CFString) == .success
      else { out(["error": "Claude's Stop button isn't available in this chat."]) }
      out(["stopped": true])
    }
    guard window.boxes.count == 1, let box = window.boxes.first else { out(["error": "Couldn't find the Claude app's message box."]) }
    // What Reach put there (any draft it may have left, a write it never saw
    // confirmed included), or the very message being sent (its own draft,
    // synced as it was typed): fine. Anything else was typed on the Mac and is
    // never overwritten. An empty box reads "\n" (its editor keeps a line
    // break), so the space around the text doesn't count.
    let known = (payload["expected"] as? [String]) ?? [(payload["expected"] as? String) ?? ""]
    let trimmed = { (s: String) in s.trimmingCharacters(in: .whitespacesAndNewlines) }
    let current = value(box)
    guard known.contains(where: { current == trimmed($0) }) || (!text.isEmpty && current == trimmed(text)) else {
      out(["error": "This chat's box in the Claude app has text typed on your Mac. Reach won't overwrite it: send or clear it there.", "draft": true])
    }
    if payload["draft"] as? Bool == true {
      // No focus changes, clipboard access, key presses or Send during typing.
      guard AXUIElementSetAttributeValue(box, kAXValueAttribute as CFString, text as CFString) == .success
      else { out(["error": "Claude couldn't update this draft."]) }
      // The editor shows the text a frame or more later: read back for up to
      // a second, as before Send (one read at once missed it, and Reach then
      // took its own draft for text typed on the Mac).
      for _ in 0..<20 where value(box) != trimmed(text) { usleep(50_000) }
      guard value(box) == trimmed(text), showing(look(app)) else { out(["error": "Claude couldn't update this draft."]) }
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
    if !text.isEmpty || !current.isEmpty {
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
