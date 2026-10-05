// Watches for macOS's own dialogs (privacy prompts like "… wants access to
// control …", "downloaded from the internet" warnings, password requests) so
// the phone can show what the Mac is asking. Read only: it never presses a
// button and never reads a field. A password dialog is reported only as "a
// password is asked for": no picture, no text.
// These dialogs come from a few system apps (verified on macOS 26.6: an
// Automation prompt is an untitled UserNotificationCenter window on the
// dialog layer) and don't announce themselves through Accessibility, so the
// window list is checked twice a second; a line is printed only on change.
import AppKit
import ApplicationServices
import ScreenCaptureKit
import Security

let presenters: [String: String] = [
  "UserNotificationCenter": "privacy",
  "universalAccessAuthWarn": "privacy",
  "CoreServicesUIAgent": "security",
  "SecurityAgent": "password",
]

func attr(_ e: AXUIElement, _ name: String) -> AnyObject? {
  var v: AnyObject?
  return AXUIElementCopyAttributeValue(e, name as CFString, &v) == .success ? v : nil
}
func str(_ e: AXUIElement, _ name: String) -> String { (attr(e, name) as? String) ?? "" }

// Labels and button titles, where macOS exposes them; never a field.
func collect(_ e: AXUIElement, _ texts: inout [String], _ buttons: inout [String], depth: Int = 0) {
  if depth > 12 || texts.count > 12 { return }
  let role = str(e, kAXRoleAttribute)
  if role == kAXStaticTextRole as String {
    let value = str(e, kAXValueAttribute)
    if !value.isEmpty { texts.append(String(value.prefix(600))) }
  } else if role == kAXButtonRole as String {
    let title = str(e, kAXTitleAttribute)
    if !title.isEmpty { buttons.append(String(title.prefix(80))) }
  } else if role == kAXTextFieldRole as String || role == "AXSecureTextField" {
    return
  }
  for child in (attr(e, kAXChildrenAttribute) as? [AXUIElement]) ?? [] { collect(child, &texts, &buttons, depth: depth + 1) }
}

struct Seen { let kind: String; let owner: String; let pid: pid_t; var line: [String: Any] }

// macOS's own: the process is signed by Apple (an app can call itself
// SecurityAgent and draw a look-alike; it can't sign as Apple).
func signedByApple(_ pid: pid_t) -> Bool {
  var code: SecCode?
  guard SecCodeCopyGuestWithAttributes(nil, [kSecGuestAttributePid: pid] as CFDictionary, [], &code) == errSecSuccess, let code
  else { return false }
  var requirement: SecRequirement?
  guard SecRequirementCreateWithString("anchor apple" as CFString, [], &requirement) == errSecSuccess, let requirement
  else { return false }
  return SecCodeCheckValidity(code, [], requirement) == errSecSuccess
}

final class Watcher {
  var current: [CGWindowID: Seen] = [:]
  var last = ""
  // Checked once per process.
  var apple: [pid_t: Bool] = [:]

  func windows() -> [(CGWindowID, String, pid_t, String, [String: Double])] {
    let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
    var found: [(CGWindowID, String, pid_t, String, [String: Double])] = []
    // A process id can be reused: remembered only while its windows are up.
    let up = Set(list.compactMap { ($0[kCGWindowOwnerPID as String] as? Int).map { pid_t($0) } })
    apple = apple.filter { up.contains($0.key) }
    for w in list {
      let owner = w[kCGWindowOwnerName as String] as? String ?? ""
      guard let kind = presenters[owner] else { continue }
      let layer = w[kCGWindowLayer as String] as? Int ?? 0
      let bounds = w[kCGWindowBounds as String] as? [String: Any] ?? [:]
      let width = bounds["Width"] as? Double ?? 0, height = bounds["Height"] as? Double ?? 0
      // Dialogs, not menu-bar items or invisible helpers.
      if layer < 0 || width < 120 || height < 80 { continue }
      // Where it is on screen (global points, as the displays are listed),
      // so the phone's screen view can open on it.
      let place = ["x": bounds["X"] as? Double ?? 0, "y": bounds["Y"] as? Double ?? 0, "width": width, "height": height]
      let pid = pid_t(w[kCGWindowOwnerPID as String] as? Int ?? 0)
      // Only macOS's own dialogs, never a look-alike by another app.
      if apple[pid] == nil { apple[pid] = signedByApple(pid) }
      guard apple[pid] == true else { continue }
      found.append((CGWindowID(w[kCGWindowNumber as String] as? Int ?? 0), kind, pid, owner, place))
    }
    return found
  }

  func describe(_ id: CGWindowID, _ kind: String, _ pid: pid_t, _ owner: String, _ place: [String: Double]) -> [String: Any] {
    var line: [String: Any] = ["id": Int(id), "kind": kind, "owner": owner, "bounds": place]
    if kind == "password" { return line }
    var texts: [String] = [], buttons: [String] = []
    var preferred = ""
    if AXIsProcessTrusted() {
      let app = AXUIElementCreateApplication(pid)
      for window in (attr(app, kAXWindowsAttribute) as? [AXUIElement]) ?? [] {
        collect(window, &texts, &buttons)
        // The button Return presses, drawn in the accent color.
        if preferred.isEmpty, let button = attr(window, kAXDefaultButtonAttribute) { preferred = str(button as! AXUIElement, kAXTitleAttribute) }
      }
    }
    if !texts.isEmpty { line["texts"] = texts }
    if !buttons.isEmpty { line["buttons"] = buttons }
    if !preferred.isEmpty { line["default"] = String(preferred.prefix(80)) }
    return line
  }

  // A picture of the dialog for the phone (never of a password dialog).
  func capture(_ id: CGWindowID, then: @escaping (String?) -> Void) {
    SCShareableContent.getExcludingDesktopWindows(false, onScreenWindowsOnly: true) { content, _ in
      guard let window = content?.windows.first(where: { $0.windowID == id }) else { return then(nil) }
      let config = SCStreamConfiguration()
      config.width = Int(window.frame.width * 2)
      config.height = Int(window.frame.height * 2)
      config.showsCursor = false
      SCScreenshotManager.captureImage(contentFilter: SCContentFilter(desktopIndependentWindow: window), configuration: config) { image, _ in
        guard let image, let png = NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:]) else {
          return then(nil)
        }
        then("data:image/png;base64,\(png.base64EncodedString())")
      }
    }
  }

  func emit() {
    let prompts = current.keys.sorted().compactMap { current[$0]?.line }
    guard let data = try? JSONSerialization.data(withJSONObject: ["prompts": prompts], options: [.sortedKeys]),
      let line = String(data: data, encoding: .utf8), line != last
    else { return }
    last = line
    print(line)
    fflush(stdout)
  }

  func check() {
    let now = windows()
    let ids = Set(now.map { $0.0 })
    var changed = false
    for id in current.keys where !ids.contains(id) {
      current[id] = nil
      changed = true
    }
    for (id, kind, pid, owner, place) in now where current[id] == nil {
      current[id] = Seen(kind: kind, owner: owner, pid: pid, line: describe(id, kind, pid, owner, place))
      changed = true
      if kind != "password" {
        // Let the dialog finish drawing, then add its picture.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) {
          self.capture(id) { image in
            DispatchQueue.main.async {
              guard let image, self.current[id] != nil else { return }
              self.current[id]?.line["image"] = image
              self.emit()
            }
          }
        }
      }
    }
    if changed { emit() }
  }
}

@main
struct MacPrompts {
  static func main() {
    let watcher = Watcher()
    watcher.check()
    if CommandLine.arguments.contains("--once") {
      watcher.emit()
      exit(0)
    }
    Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { _ in watcher.check() }
    // Ends with Reach (its stdin closes).
    FileHandle.standardInput.readabilityHandler = { handle in
      if handle.availableData.isEmpty { exit(0) }
    }
    watcher.emit()
    RunLoop.main.run()
  }
}
