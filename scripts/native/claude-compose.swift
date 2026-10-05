// Puts a message from the phone into the Claude app's own message box and
// presses its Send, as the person would at the Mac: the app's own Claude Code
// process runs it and its window shows it at once (a chat that is working
// queues it, as the app does). Only when the window's header names the chat
// it is meant for (--title, exactly), and never over text already in the box.
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
func out(_ value: [String: Any]) -> Never {
  let data = (try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])) ?? Data("{}".utf8)
  print(String(data: data, encoding: .utf8) ?? "{}")
  exit(0)
}

struct Window {
  var titles: [String] = []  // the chat named in the header ("<title>, rename session")
  var boxes: [AXUIElement] = []  // message boxes
    var send: AXUIElement?  // the button that says exactly "Send"
    var stop: AXUIElement?
}
func look(_ app: AXUIElement) -> Window {
  var found = Window()
  var queue = (attr(app, kAXWindowsAttribute) as? [AXUIElement]) ?? []
  var i = 0
  while i < queue.count, i < 60000 {
    let e = queue[i]
    i += 1
    switch str(e, kAXRoleAttribute) {
    case kAXTextAreaRole as String:
      // The message box is labelled "Prompt" (other fields come and go).
      if str(e, kAXDescriptionAttribute) == "Prompt" { found.boxes.append(e) }
    case kAXButtonRole as String:
      let text = label(e)
      if text.hasSuffix(", rename session") { found.titles.append(String(text.dropLast(", rename session".count))) }
      if text == "Send" { found.send = e }
      if text == "Stop" || text == "Stop response" { found.stop = e }
    default:
      break
    }
    queue.append(contentsOf: children(e))
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
      out(["titles": window.titles, "boxes": window.boxes.count, "draft": window.boxes.first.map { !value($0).isEmpty } ?? false])
    }
    var payload: [String: Any] = [:]
    if args.contains("--json") {
      let data = FileHandle.standardInput.readDataToEndOfFile()
      guard data.count <= 524288, let decoded = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
      else { out(["error": "Invalid composer request."]) }
      payload = decoded
    }
    guard let title = option("--title") else { out(["error": "Say which chat to use."]) }
    let text = (payload["text"] as? String) ?? option("--text") ?? ""
    // The right chat, one message box, nothing typed in it.
    guard window.titles == [title] else { out(["error": "The Claude app is showing another chat.", "titles": window.titles]) }
    if args.contains("--stop") {
      guard let stop = window.stop, enabled(stop), AXUIElementPerformAction(stop, kAXPressAction as CFString) == .success
      else { out(["error": "Claude's Stop button isn't available in this chat."]) }
      out(["stopped": true])
    }
    guard window.boxes.count == 1, let box = window.boxes.first else { out(["error": "Couldn't find the Claude app's message box."]) }
    let expected = (payload["expected"] as? String) ?? ""
    guard str(box, kAXValueAttribute) == expected else { out(["error": "The draft changed on your Mac. Reach hasn't overwritten it.", "draft": true]) }
    if payload["draft"] as? Bool == true {
      // No focus changes, clipboard access, key presses or Send during typing.
      guard AXUIElementSetAttributeValue(box, kAXValueAttribute as CFString, text as CFString) == .success,
        look(app).titles == [title], str(box, kAXValueAttribute) == text
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
        guard look(app).titles == [title], pressMenu(app, ["Edit", "Paste"]) else { out(["error": "Couldn't paste the picture into the Claude app."]) }
        usleep(700_000)
      }
    }
    // The text, then a last look that it's still the same chat before Send.
    if !text.isEmpty || !expected.isEmpty {
      guard AXUIElementSetAttributeValue(box, kAXValueAttribute as CFString, text as CFString) == .success
      else { out(["error": "Claude couldn't update the message."]) }
      usleep(300_000)
    }
    window = look(app)
    guard window.titles == [title] else { out(["error": "The Claude app switched to another chat."]) }
    guard window.boxes.count == 1, let currentBox = window.boxes.first, str(currentBox, kAXValueAttribute) == text
    else { out(["error": "The message changed before Send. Reach hasn't sent it."]) }
    guard let send = window.send, enabled(send) else { out(["error": "The Claude app's Send isn't available."]) }
    guard AXUIElementPerformAction(send, kAXPressAction as CFString) == .success else { out(["error": "Couldn't press Send in the Claude app."]) }
    for _ in 0..<15 {
      usleep(200_000)
      if let box = look(app).boxes.first, value(box).isEmpty { out(["sent": true]) }
    }
    // The app received Send. An uncertain UI refresh must not retry it and
    // accidentally submit the same message twice.
    out(["sent": true, "unconfirmed": true])
  }
}
