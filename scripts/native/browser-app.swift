import AppKit
import ApplicationServices
import CryptoKit
import Darwin
import Foundation
import ScreenCaptureKit
import Security

// Agent app control never uses CGEvent, the clipboard, AppleScript or desktop capture.
// Every operation stays attached to one signed process and one AX window subtree.
struct GuardError: Error { let message: String }
func reject(_ message: String) throws -> Never { throw GuardError(message: message) }
func digest(_ value: String) -> String { SHA256.hash(data: Data(value.utf8)).map { String(format: "%02x", $0) }.joined() }
func canonical(_ url: URL) -> String { url.resolvingSymlinksInPath().standardizedFileURL.path }
func attr(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
  AXUIElementSetMessagingTimeout(element, 0.3)
  var value: CFTypeRef?
  guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else { return nil }
  return value
}
func elementAttr(_ element: AXUIElement, _ name: String) -> AXUIElement? {
  guard let value = attr(element, name), CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
  return (value as! AXUIElement)
}
func frame(_ element: AXUIElement) -> CGRect? {
  guard let origin = attr(element, kAXPositionAttribute), let extent = attr(element, kAXSizeAttribute),
    CFGetTypeID(origin) == AXValueGetTypeID(), CFGetTypeID(extent) == AXValueGetTypeID() else { return nil }
  var point = CGPoint.zero, size = CGSize.zero
  guard AXValueGetValue(origin as! AXValue, .cgPoint, &point), AXValueGetValue(extent as! AXValue, .cgSize, &size),
    point.x.isFinite, point.y.isFinite, size.width.isFinite, size.height.isFinite else { return nil }
  return CGRect(origin: point, size: size)
}
func actions(_ element: AXUIElement) -> [String] {
  var names: CFArray?
  guard AXUIElementCopyActionNames(element, &names) == .success else { return [] }
  return names as? [String] ?? []
}
func settable(_ element: AXUIElement, _ name: String) -> Bool {
  var value: DarwinBoolean = false
  return AXUIElementIsAttributeSettable(element, name as CFString, &value) == .success && value.boolValue
}
// BEGIN PURE CONTROL POLICY — compiled directly by policy tests without macOS UI.
let ownerControlsReason = "Reach and Tailscale controls are owner-only and cannot be shared with an agent."
func appReason(_ bundleId: String, _ name: String, _ path: String) -> String? {
  let id = bundleId.lowercased()
  let value = "\(id) \(name) \(path)".lowercased()
  if ["io.tailscale", "com.tailscale"].contains(where: { id == $0 || id.hasPrefix($0+".") }) ||
    ["tailscale", "tailnet", "reach"].contains(where: value.contains) { return ownerControlsReason }
  let protected = ["terminal", "iterm", "warp", "ghostty", "alacritty", "kitty", "wezterm", "hyper.app",
    "visualstudio", "visual studio", "vscode", "vscodium", "cursor", "windsurf", "xcode", "jetbrains", "zed.app",
    "codex", "claude", "password", "1password", "bitwarden", "lastpass", "dashlane", "keychain",
    "systempreferences", "system settings", "system preferences", "securityagent", "loginwindow", "finder",
    "automator", "script editor", "scripteditor", "shortcuts", "activity monitor", "activitymonitor", "console.app",
    "screen sharing", "screensharing", "remote desktop", "anydesk", "teamviewer", "parallels", "vmware", "virtualbox", "utm.app"]
  return protected.contains(where: value.contains) ? "This app can expose credentials, change system access, or run commands." : nil
}
func protectedWindow(_ title: String) -> Bool {
  let value = title.lowercased()
  return ["devtools", "developer tools", "web inspector", "javascript console", "terminal", "reach", "tailscale", "tailnet", "passwords", "keychain"].contains(where: value.contains)
}
func browserApp(_ id: String) -> Bool {
  let id = id.lowercased()
  return ["com.apple.safari", "com.apple.safaritechnologypreview", "com.google.chrome", "org.chromium.chromium", "org.mozilla.firefox", "com.microsoft.edgemac",
    "com.brave.browser", "company.thebrowser.browser", "com.operasoftware.opera", "com.vivaldi.vivaldi",
    "com.duckduckgo.macos.browser", "com.kagi.kagimac"].contains { id == $0 || id.hasPrefix($0+".") }
}
func normalizedHost(_ source: String) -> String? {
  guard let decoded = source.removingPercentEncoding, !decoded.contains("%"),
    !decoded.unicodeScalars.contains(where: { $0.value <= 32 || $0.value == 127 }),
    !decoded.contains("/"), !decoded.contains("\\"), !decoded.contains("@") else { return nil }
  var value = decoded.lowercased()
  while value.hasSuffix(".") { value.removeLast() }
  if value.hasPrefix("[") && value.hasSuffix("]") { value = String(value.dropFirst().dropLast()) }
  return value.isEmpty ? nil : value
}
func protectedHost(_ source: String, _ hosts: [String]) -> Bool {
  guard let host = normalizedHost(source) else { return true }
  if ["tailscale.com", "tailscale.io", "ts.net", "localhost", "local", "localdomain", "internal", "home.arpa"].contains(where: { host == $0 || host.hasSuffix("."+$0) }) { return true }
  if hosts.contains(where: { normalizedHost($0).map { host == $0 || host.hasSuffix("."+$0) } ?? true }) { return true }
  // Reject local/single-label names and numeric hosts, including the non-canonical
  // IPv4 forms browsers accept (integer, octal, hex) and all IPv6 literals. Public
  // literal addresses are also unavailable; this avoids inconsistent URL parsers.
  var ipv4 = in_addr()
  if host.contains(":") || inet_aton(host, &ipv4) != 0 || !host.contains(".") { return true }
  if let last = host.split(separator:".").last, UInt64(last) != nil || last.hasPrefix("0x") { return true }
  return false
}
func protectedURL(_ source: String, _ hosts: [String], requireAddress: Bool = true) -> Bool {
  let value = source.trimmingCharacters(in:.whitespacesAndNewlines)
  guard !value.isEmpty else { return requireAddress }
  // Ambiguous separators/controls must not acquire a different meaning inside a browser.
  if value.contains("\\") || value.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 }) { return true }
  let hasScheme = value.range(of:"^[A-Za-z][A-Za-z0-9+.-]*:", options:.regularExpression) != nil
  if !requireAddress && !hasScheme && !value.hasPrefix("//") && !value.contains(".") && !value.contains(":") && !value.contains("/") {
    return value.lowercased() == "localhost"
  }
  // Address-bar values may omit the scheme. Active page URLs must include it.
  if requireAddress && !hasScheme { return true }
  let address = hasScheme ? value : "https://" + (value.hasPrefix("//") ? String(value.dropFirst(2)) : value)
  guard let url = URLComponents(string:address), let scheme = url.scheme?.lowercased(), ["http", "https"].contains(scheme),
    url.user == nil, url.password == nil, let host = url.host, !host.isEmpty else { return true }
  return protectedHost(host,hosts)
}
func browserPageAllowed(_ urls: [String], _ hosts: [String]) -> Bool {
  !urls.isEmpty && urls.allSatisfy { !protectedURL($0,hosts) }
}
func webAreaAllowed(hidden: Bool, intersects: Bool?, address: String?, hosts: [String]) -> Bool {
  if hidden || intersects == false { return true }
  guard intersects == true, let address = address, !address.isEmpty else { return false }
  return !protectedURL(address,hosts)
}
func insertedValue(_ old: String, _ location: Int, _ length: Int, _ text: String) -> String? {
  guard location >= 0, length >= 0, location <= (old as NSString).length,
    length <= (old as NSString).length-location else { return nil }
  return (old as NSString).replacingCharacters(in:NSRange(location:location,length:length),with:text)
}
// END PURE CONTROL POLICY
struct Signature {
  let id: String
  let identity: String
}
func requirement() throws -> SecRequirement {
  var result: SecRequirement?
  guard SecRequirementCreateWithString("anchor apple generic" as CFString, [], &result) == errSecSuccess, let value = result else {
    try reject("Code signature validation is unavailable.")
  }
  return value
}
func signature(_ path: String, pid: pid_t? = nil, catalogOnly: Bool = false) throws -> Signature {
  var staticCode: SecStaticCode?
  if let pid = pid {
    var live: SecCode?
    guard SecCodeCopyGuestWithAttributes(nil, [kSecGuestAttributePid as String: pid] as CFDictionary, [], &live) == errSecSuccess,
      let live = live, SecCodeCheckValidity(live, [], try requirement()) == errSecSuccess,
      SecCodeCopyStaticCode(live, [], &staticCode) == errSecSuccess else { try reject("The app's running identity could not be verified.") }
  } else {
    guard SecStaticCodeCreateWithPath(URL(fileURLWithPath: path) as CFURL, [], &staticCode) == errSecSuccess else {
      try reject("The app is not signed by a verified developer.")
    }
  }
  // Catalog discovery reads trusted signing metadata cheaply. It grants no
  // access. Actual windows/capture/input always validate executable + resources.
  let flags = catalogOnly ? SecCSFlags(rawValue:kSecCSBasicValidateOnly) : SecCSFlags()
  guard let code = staticCode, SecStaticCodeCheckValidity(code, flags, try requirement()) == errSecSuccess else {
    try reject("The app signature is invalid. Ask the owner to check this app.")
  }
  var info: CFDictionary?, rule: SecRequirement?, ruleText: CFString?
  guard SecCodeCopySigningInformation(code, SecCSFlags(rawValue: kSecCSSigningInformation), &info) == errSecSuccess,
    let data = info as? [String: Any], let id = data[kSecCodeInfoIdentifier as String] as? String,
    let location = data[kSecCodeInfoMainExecutable as String] as? URL,
    canonical(location).hasPrefix(path + "/"),
    SecCodeCopyDesignatedRequirement(code, [], &rule) == errSecSuccess, let rule = rule,
    SecRequirementCopyString(rule, [], &ruleText) == errSecSuccess, let ruleText = ruleText else {
    try reject("The app has no verifiable signing identity.")
  }
  return Signature(id: id, identity: digest(id + "\n" + (ruleText as String)))
}
struct Identity {
  let app: NSRunningApplication
  let path: String
  let signature: Signature
  let instance: String
}
func identity(_ path: String, _ pid: pid_t, expected: String? = nil) throws -> Identity {
  guard path.hasSuffix(".app"), let app = NSRunningApplication(processIdentifier: pid), !app.isTerminated,
    let url = app.bundleURL, canonical(url) == path, let launched = app.launchDate else {
    try reject("This app process has changed. Choose its window again.")
  }
  let signed = try signature(path, pid: pid)
  guard app.bundleIdentifier == signed.id else { try reject("The app identity does not match its signature.") }
  if let reason = appReason(signed.id, app.localizedName ?? "", path) { try reject(reason) }
  if let expected = expected, expected != signed.identity { try reject("This app's signing identity changed. Request access again.") }
  return Identity(app: app, path: path, signature: signed,
    instance: digest("\(pid)\n\(launched.timeIntervalSince1970)\n\(path)\n\(signed.identity)"))
}
func own(_ element: AXUIElement, _ pid: pid_t) -> Bool {
  var owner: pid_t = 0
  return AXUIElementGetPid(element, &owner) == .success && owner == pid
}
func sameRect(_ a: CGRect, _ b: CGRect) -> Bool {
  abs(a.minX-b.minX) < 1 && abs(a.minY-b.minY) < 1 && abs(a.width-b.width) < 1 && abs(a.height-b.height) < 1
}
func axWindow(_ window: SCWindow, _ pid: pid_t) throws -> AXUIElement {
  guard AXIsProcessTrusted() else { try reject("Enable Accessibility for Reach before sharing an app window.") }
  let app = AXUIElementCreateApplication(pid)
  AXUIElementSetMessagingTimeout(app, 0.3)
  // Chromium exposes web controls only when accessibility is enabled. This flag
  // asks for semantics; it cannot inject user input or change another app.
  AXUIElementSetAttributeValue(app, "AXManualAccessibility" as CFString, kCFBooleanTrue)
  guard let windows = attr(app, kAXWindowsAttribute) as? [AXUIElement] else { try reject("This app does not expose safe window controls.") }
  let matched = windows.filter { element in
    guard own(element, pid), let bounds = frame(element), sameRect(bounds, window.frame),
      attr(element, kAXRoleAttribute) as? String == "AXWindow" else { return false }
    if let number = attr(element, "AXWindowNumber") as? NSNumber { return number.uint32Value == window.windowID }
    // Some apps omit AXWindowNumber. Require a unique exact geometry AND title;
    // never use the focused window or nearest window as an alternative target.
    return (attr(element, kAXTitleAttribute) as? String ?? "") == (window.title ?? "")
  }
  guard matched.count == 1 else { try reject("The app window cannot be identified unambiguously. Refresh the app view.") }
  let value = matched[0]
  guard attr(value, kAXSubroleAttribute) as? String == "AXStandardWindow",
    attr(value, kAXModalAttribute) as? Bool != true,
    (attr(value, "AXSheets") as? [AXUIElement] ?? []).isEmpty,
    !protectedWindow(window.title ?? "") else { try reject("Dialogs and protected app windows cannot be shared with an agent.") }
  // AX sheets can belong to the application rather than the selected window.
  if windows.contains(where: { (attr($0, kAXRoleAttribute) as? String) == "AXSheet" ||
    (attr($0, kAXSubroleAttribute) as? String) == "AXDialog" || (attr($0, kAXModalAttribute) as? Bool) == true }) {
    try reject("Close the app's protected dialog before continuing.")
  }
  return value
}
func inWindow(_ element: AXUIElement, _ window: AXUIElement, _ pid: pid_t) -> Bool {
  guard own(element, pid) else { return false }
  var current = element
  for _ in 0..<80 {
    if CFEqual(current, window) { return true }
    let role = attr(current, kAXRoleAttribute) as? String ?? ""
    let subrole = attr(current, kAXSubroleAttribute) as? String ?? ""
    if ["AXSheet", "AXDialog", "AXMenu", "AXMenuBar"].contains(role) ||
      ["AXSecureTextField", "AXDialog", "AXSystemDialog"].contains(subrole) ||
      attr(current, "AXProtectedContent") as? Bool == true || attr(current, kAXModalAttribute) as? Bool == true { return false }
    guard let parent = elementAttr(current, kAXParentAttribute), own(parent, pid) else { return false }
    current = parent
  }
  return false
}
func nodes(_ root: AXUIElement, _ pid: pid_t) throws -> [AXUIElement] {
  var result = [AXUIElement](), stack = [root]
  let deadline = Date().addingTimeInterval(2)
  while let value = stack.popLast() {
    guard Date() < deadline, result.count < 6000 else { try reject("This app's controls could not be checked safely. Try a simpler window.") }
    guard own(value, pid) else { try reject("This window contains controls owned by another process.") }
    let role = attr(value, kAXRoleAttribute) as? String ?? ""
    let subrole = attr(value, kAXSubroleAttribute) as? String ?? ""
    if ["AXSheet", "AXDialog"].contains(role) || ["AXDialog", "AXSystemDialog"].contains(subrole) ||
      attr(value, kAXModalAttribute) as? Bool == true { try reject("A protected dialog is open in this app.") }
    if ["AXWindow", "AXToolbar", "AXSplitGroup", "AXTextArea", "AXGroup"].contains(role) {
      let label = [kAXTitleAttribute, kAXDescriptionAttribute].compactMap { attr(value, $0) as? String }.joined(separator: " ").lowercased()
      if ["devtools", "developer tools", "web inspector", "javascript console", "terminal emulator"].contains(where: label.contains) {
        try reject("Developer tools and embedded terminals are protected.")
      }
    }
    result.append(value)
    let children = attr(value, kAXChildrenAttribute) as? [AXUIElement] ?? []
    if children.count > 6000 { try reject("This app exposes too many controls to check safely.") }
    stack.append(contentsOf: children.reversed())
  }
  return result
}
func urlAttribute(_ element: AXUIElement, _ name: String) -> String? {
  if let value = attr(element,name) as? URL { return value.absoluteString }
  if let value = attr(element,name) as? String, !value.isEmpty { return value }
  return nil
}
func insideWebArea(_ element: AXUIElement, _ window: AXUIElement) -> Bool {
  var current = element
  for _ in 0..<80 {
    if attr(current,kAXRoleAttribute) as? String == "AXWebArea" { return true }
    if CFEqual(current,window) { return false }
    guard let parent = elementAttr(current,kAXParentAttribute) else { return true }
    current = parent
  }
  return true
}
func browserAddressField(_ element: AXUIElement, _ window: AXUIElement) -> Bool {
  let role = attr(element,kAXRoleAttribute) as? String ?? ""
  return ["AXTextField", "AXComboBox", "AXSearchField"].contains(role) && !insideWebArea(element,window)
}
func hasBrowserContent(_ bundleId: String, _ controls: [AXUIElement]) -> Bool {
  browserApp(bundleId) || controls.contains { attr($0,kAXRoleAttribute) as? String == "AXWebArea" }
}
func validateBrowserPage(_ bundleId: String, _ window: AXUIElement, _ controls: [AXUIElement], _ hosts: [String]) throws {
  guard hasBrowserContent(bundleId,controls) else { return }
  var addresses = [String]()
  if let document = urlAttribute(window,kAXDocumentAttribute) { addresses.append(document) }
  for node in controls {
    if attr(node,kAXHiddenAttribute) as? Bool == true { continue }
    if attr(node,kAXRoleAttribute) as? String == "AXWebArea" {
      let address = urlAttribute(node,"AXURL")
      var intersects: Bool? = nil
      if let bounds = frame(node), let windowBounds = frame(window), bounds.width > 0, bounds.height > 0,
        windowBounds.width > 0, windowBounds.height > 0 { intersects = bounds.intersects(windowBounds) }
      // Only definitely hidden/offscreen web areas may be ignored. An allowed
      // document URL cannot vouch for an opaque embedded page's URL or geometry.
      guard webAreaAllowed(hidden:false,intersects:intersects,address:address,hosts:hosts) else {
        try reject(address == nil || intersects == nil ? "An embedded browser page cannot be verified. This window is protected." : ownerControlsReason)
      }
      if intersects == true, let address = address,
        let parent = elementAttr(node,kAXParentAttribute), !insideWebArea(parent,window) { addresses.append(address) }
    }
    if browserAddressField(node,window), let address = attr(node,kAXValueAttribute) as? String,
      protectedURL(address,hosts,requireAddress:false) { try reject(ownerControlsReason) }
  }
  // A toolbar alone is insufficient: its text may be an uncommitted edit. At
  // least one actual top-level page/document URL must be independently visible.
  guard browserPageAllowed(addresses,hosts) else {
    try reject(addresses.isEmpty ? "This browser's active page address cannot be verified. Open an ordinary website before sharing it." : ownerControlsReason)
  }
}
func protectedHosts(_ request: [String:Any]) throws -> [String] {
  guard let hosts = request["protectedHosts"] as? [String], hosts.count <= 64,
    hosts.allSatisfy({ $0.count <= 253 && normalizedHost($0) != nil }) else { try reject("Protected Reach origins are unavailable.") }
  return hosts
}
@available(macOS 14.0, *)
struct Target {
  let running: Identity
  let window: SCWindow
  let ax: AXUIElement
  let controls: [AXUIElement]
  let protectedHosts: [String]
  let webContent: Bool
}
@available(macOS 14.0, *)
func target(_ request: [String: Any]) async throws -> Target {
  guard let path = request["appId"] as? String, let pidNumber = request["pid"] as? Int, pidNumber > 0, pidNumber <= Int(Int32.max),
    let number = request["windowId"] as? UInt32, let token = request["instance"] as? String,
    let width = request["width"] as? Double, let height = request["height"] as? Double,
    let expected = request["identity"] as? String else { try reject("Choose a current app window.") }
  let pid = pid_t(pidNumber)
  let running = try identity(path, pid, expected: expected)
  guard running.instance == token else { try reject("The app restarted. Choose its window again.") }
  let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
  guard let window = content.windows.first(where: { $0.windowID == number }), window.owningApplication?.processID == pid,
    window.owningApplication?.bundleIdentifier == running.signature.id, window.windowLayer == 0,
    window.frame.width >= 16, window.frame.height >= 16,
    abs(window.frame.width-width) < 1, abs(window.frame.height-height) < 1 else {
    try reject("The app window moved, resized or closed. Refresh it before continuing.")
  }
  let ax = try axWindow(window, pid)
  let controls = try nodes(ax, pid)
  let hosts = try protectedHosts(request)
  try validateBrowserPage(running.signature.id,ax,controls,hosts)
  return Target(running: running, window: window, ax: ax, controls: controls, protectedHosts: hosts, webContent: hasBrowserContent(running.signature.id,controls))
}
@available(macOS 14.0, *)
func fresh(_ value: Target) throws {
  let id = try identity(value.running.path, value.running.app.processIdentifier, expected: value.running.signature.identity)
  guard id.instance == value.running.instance, let currentFrame = frame(value.ax), sameRect(currentFrame, value.window.frame),
    !protectedWindow(attr(value.ax, kAXTitleAttribute) as? String ?? ""),
    (attr(value.ax, "AXSheets") as? [AXUIElement] ?? []).isEmpty,
    attr(value.ax, kAXModalAttribute) as? Bool != true else { try reject("The app window changed. Refresh it before continuing.") }
  let controls = try nodes(value.ax,value.running.app.processIdentifier)
  try validateBrowserPage(id.signature.id,value.ax,controls,value.protectedHosts)
}
@available(macOS 14.0, *)
func navigationTarget(_ element: AXUIElement, _ value: Target) throws {
  guard value.webContent else { return }
  var current = element
  for _ in 0..<80 {
    guard inWindow(current,value.ax,value.running.app.processIdentifier) else { try reject("This browser control is outside the shared window.") }
    let address = urlAttribute(current,"AXURL")
    if let address = address, protectedURL(address,value.protectedHosts) { try reject(ownerControlsReason) }
    let role = attr(current,kAXRoleAttribute) as? String ?? ""
    if role == "AXWebArea" && address == nil { try reject("This browser page cannot be verified. This control is protected.") }
    if ["AXTab", "AXRadioButton"].contains(role) {
      let label = [kAXTitleAttribute,kAXDescriptionAttribute].compactMap { attr(current,$0) as? String }.joined(separator:" ")
      if protectedWindow(label) { try reject(ownerControlsReason) }
    }
    if browserAddressField(current,value.ax), let address = attr(current,kAXValueAttribute) as? String,
      protectedURL(address,value.protectedHosts,requireAddress:false) { try reject(ownerControlsReason) }
    if CFEqual(current,value.ax) { return }
    guard let parent = elementAttr(current,kAXParentAttribute) else { try reject("The browser control could not be verified.") }
    current = parent
  }
  try reject("The browser control could not be verified.")
}
@available(macOS 14.0, *)
func validateBrowserText(_ element: AXUIElement, _ attribute: String, _ contents: CFTypeRef, _ value: Target) throws {
  guard value.webContent, browserAddressField(element,value.ax),
    [kAXValueAttribute,kAXSelectedTextAttribute].contains(attribute) else { return }
  guard let text = contents as? String else { try reject("The browser address could not be verified.") }
  var result = text
  if attribute == kAXSelectedTextAttribute {
    guard let old = attr(element,kAXValueAttribute) as? String, let range = selection(element),
      let inserted = insertedValue(old,range.location,range.length,text) else { try reject("The complete browser address could not be verified.") }
    result = inserted
  }
  if protectedURL(result,value.protectedHosts,requireAddress:false) { try reject(ownerControlsReason) }
}
@available(macOS 14.0, *)
func perform(_ element: AXUIElement, _ action: String, _ value: Target) throws {
  try fresh(value)
  try navigationTarget(element,value)
  guard inWindow(element, value.ax, value.running.app.processIdentifier), actions(element).contains(action),
    attr(element, kAXEnabledAttribute) as? Bool != false else { try reject("This control is protected or does not support safe input.") }
  guard AXUIElementPerformAction(element, action as CFString) == .success else {
    // A timeout can mean an app performed the action but did not reply. Never retry it.
    try reject("The app did not confirm this action. Refresh the window before trying anything else.")
  }
  // Post-action observation hides/rejects a protected destination. It cannot
  // prevent the browser's network request on a redirect or JavaScript handler;
  // URL/AX policy is not a network firewall or a browser navigation interceptor.
  try fresh(value)
}
@available(macOS 14.0, *)
func set(_ element: AXUIElement, _ attribute: String, _ contents: CFTypeRef, _ value: Target) throws {
  try fresh(value)
  try navigationTarget(element,value)
  try validateBrowserText(element,attribute,contents,value)
  guard inWindow(element, value.ax, value.running.app.processIdentifier), settable(element, attribute),
    attr(element, kAXEnabledAttribute) as? Bool != false else { try reject("This field is protected or does not support safe input.") }
  guard AXUIElementSetAttributeValue(element, attribute as CFString, contents) == .success else {
    try reject("The app did not confirm this input. Refresh its window.")
  }
  try fresh(value)
}
@available(macOS 14.0, *)
func input(_ request: [String: Any], _ value: Target) throws -> [String: Any] {
  guard let action = request["action"] as? [String: Any], let kind = action["type"] as? String else { try reject("Invalid app input.") }
  let pid = value.running.app.processIdentifier
  switch kind {
  case "click":
    guard let x = action["x"] as? Double, let y = action["y"] as? Double, x.isFinite, y.isFinite,
      (0...1).contains(x), (0...1).contains(y) else { try reject("Choose a point inside the shared app window.") }
    let point = CGPoint(x: value.window.frame.minX+x*(value.window.frame.width-1), y: value.window.frame.minY+y*(value.window.frame.height-1))
    // Native app-scoped hit testing respects window z-order and hidden controls.
    // If another window of this same app covers the approved target, reject it.
    // Never ask the system-wide AX object, or pick a smaller overlapping node.
    let application = AXUIElementCreateApplication(pid)
    AXUIElementSetMessagingTimeout(application, 0.3)
    var leaf: AXUIElement?
    guard AXUIElementCopyElementAtPosition(application, Float(point.x), Float(point.y), &leaf) == .success,
      let leaf = leaf, inWindow(leaf, value.ax, pid) else {
      try reject("This point is obscured or not in the shared window. Refresh the app view.")
    }
    try navigationTarget(leaf,value)
    var candidate = leaf, hit: AXUIElement? = nil
    for _ in 0..<60 {
      guard inWindow(candidate, value.ax, pid), let bounds = frame(candidate), bounds.contains(point) else { break }
      if actions(candidate).contains(kAXPressAction) || settable(candidate,kAXFocusedAttribute) { hit = candidate; break }
      guard let parent = elementAttr(candidate,kAXParentAttribute), !CFEqual(parent,value.ax) else { break }
      candidate = parent
    }
    guard let hit = hit else { try reject("This part of the app has no safe clickable control. Canvas and raw mouse input are unavailable.") }
    // Re-hit-test after validation; moving page content must not retarget the action.
    var current: AXUIElement?
    guard AXUIElementCopyElementAtPosition(application, Float(point.x), Float(point.y), &current) == .success,
      let current = current, CFEqual(current,leaf), inWindow(current,value.ax,pid) else {
      try reject("The control moved. Refresh the window before clicking again.")
    }
    if actions(hit).contains(kAXPressAction) { try perform(hit, kAXPressAction, value) }
    else { try set(hit, kAXFocusedAttribute, kCFBooleanTrue, value) }
  case "text", "key":
    let app = AXUIElementCreateApplication(pid)
    guard let focus = elementAttr(app, kAXFocusedUIElementAttribute), inWindow(focus, value.ax, pid) else {
      try reject("Focus a supported field inside this shared window first.")
    }
    if kind == "text" {
      guard let text = action["text"] as? String, !text.isEmpty, text.utf8.count <= 32768,
        !text.unicodeScalars.contains(where: { $0.value < 32 && ![9,10,13].contains($0.value) || $0.value == 127 }) else { try reject("Invalid text input.") }
      let role = attr(focus, kAXRoleAttribute) as? String ?? ""
      guard ["AXTextField", "AXTextArea", "AXSearchField", "AXComboBox"].contains(role) else { try reject("This control does not expose safe text input.") }
      if settable(focus, kAXSelectedTextAttribute) { try set(focus, kAXSelectedTextAttribute, text as CFString, value) }
      else {
        // Without a selected-text setter, update only the reported selection.
        guard let old = attr(focus, kAXValueAttribute) as? String, let range = selection(focus),
          range.location >= 0, range.length >= 0, range.location+range.length <= (old as NSString).length else {
          try reject("The field does not expose a safe insertion point.")
        }
        let changed = (old as NSString).replacingCharacters(in: NSRange(location: range.location, length: range.length), with: text)
        try set(focus, kAXValueAttribute, changed as CFString, value)
        var next = CFRange(location: range.location+(text as NSString).length, length: 0)
        if let rangeValue = AXValueCreate(.cfRange, &next), settable(focus, kAXSelectedTextRangeAttribute) {
          try set(focus, kAXSelectedTextRangeAttribute, rangeValue, value)
        }
      }
    } else {
      guard let key = action["key"] as? String else { try reject("Invalid key.") }
      switch key {
      case "enter":
        if actions(focus).contains(kAXConfirmAction) { try perform(focus, kAXConfirmAction, value) }
        else if actions(focus).contains(kAXPressAction) { try perform(focus, kAXPressAction, value) }
        else { try reject("This field does not expose a safe Enter action. Click its submit button instead.") }
      case "escape": try perform(focus, kAXCancelAction, value)
      case "tab":
        let fields = value.controls.filter { inWindow($0, value.ax, pid) && settable($0, kAXFocusedAttribute) && attr($0, kAXEnabledAttribute) as? Bool != false }
        guard let current = fields.firstIndex(where: { CFEqual($0, focus) }), !fields.isEmpty else { try reject("This app does not expose safe focus navigation.") }
        try set(fields[(current+1)%fields.count], kAXFocusedAttribute, kCFBooleanTrue, value)
      case "left", "right", "backspace":
        guard let old = attr(focus, kAXValueAttribute) as? String, var range = selection(focus), range.location >= 0,
          range.length >= 0, range.location+range.length <= (old as NSString).length else { try reject("This field does not expose safe cursor navigation.") }
        if key == "backspace" {
          if range.length == 0 && range.location > 0 { range.location -= 1; range.length = 1 }
          let changed = (old as NSString).replacingCharacters(in: NSRange(location: range.location, length: range.length), with: "")
          try set(focus, kAXValueAttribute, changed as CFString, value)
        } else { range.location = key == "left" ? max(0, range.location-1) : min((old as NSString).length, range.location+max(1,range.length)) }
        range.length = 0
        guard let encoded = AXValueCreate(.cfRange, &range) else { try reject("Could not set the text selection.") }
        try set(focus, kAXSelectedTextRangeAttribute, encoded, value)
      default: try reject("This key is unavailable for protected app control.")
      }
    }
  case "scroll":
    guard let direction = action["direction"] as? String, ["up", "down"].contains(direction),
      let amount = action["amount"] as? Int, (1...5).contains(amount) else { try reject("Invalid app scroll.") }
    let candidates = value.controls.filter { attr($0, kAXRoleAttribute) as? String == "AXScrollArea" && inWindow($0,value.ax,pid) }
    guard let area = candidates.max(by: { (frame($0)?.width ?? 0)*(frame($0)?.height ?? 0) < (frame($1)?.width ?? 0)*(frame($1)?.height ?? 0) }) else {
      try reject("This app does not expose safe scrolling.")
    }
    let scrollAction = direction == "up" ? "AXScrollUpByPage" : "AXScrollDownByPage"
    if actions(area).contains(scrollAction) { for _ in 0..<amount { try perform(area,scrollAction,value) } }
    else if let bar = elementAttr(area, kAXVerticalScrollBarAttribute) {
      for _ in 0..<amount { try perform(bar,direction == "up" ? kAXDecrementAction : kAXIncrementAction,value) }
    } else { try reject("This app does not expose safe scrolling.") }
  default: try reject("This input is not supported for app sharing.")
  }
  return ["done": true]
}
func selection(_ element: AXUIElement) -> CFRange? {
  guard let value = attr(element, kAXSelectedTextRangeAttribute), CFGetTypeID(value) == AXValueGetTypeID() else { return nil }
  var range = CFRange()
  return AXValueGetValue(value as! AXValue, .cfRange, &range) ? range : nil
}
func catalog() -> [String: Any] {
  var paths = Set(NSWorkspace.shared.runningApplications.filter { $0.activationPolicy == .regular }.compactMap { $0.bundleURL.map(canonical) }.filter { $0.hasSuffix(".app") })
  let fm = FileManager.default
  for root in ["/Applications", "/System/Applications", NSHomeDirectory()+"/Applications"] {
    guard let entries = try? fm.contentsOfDirectory(atPath: root) else { continue }
    for entry in entries.prefix(500) {
      let full = root+"/"+entry
      if entry.hasSuffix(".app") { paths.insert(canonical(URL(fileURLWithPath: full))) }
      else if let nested = try? fm.contentsOfDirectory(atPath: full) {
        for child in nested.prefix(100) where child.hasSuffix(".app") { paths.insert(canonical(URL(fileURLWithPath: full+"/"+child))) }
      }
    }
  }
  let apps: [[String: Any]] = paths.sorted().prefix(1024).compactMap { path in
    guard let bundle = Bundle(path: path), let bundleId = bundle.bundleIdentifier else { return nil }
    let name = bundle.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String ?? bundle.object(forInfoDictionaryKey: "CFBundleName") as? String ?? URL(fileURLWithPath:path).deletingPathExtension().lastPathComponent
    var row: [String: Any] = ["id":path, "name":String(name.prefix(100)), "bundleId":bundleId, "protected":true]
    if let reason = appReason(bundleId,name,path) { row["reason"] = reason }
    else if let signed = try? signature(path,catalogOnly:true), signed.id == bundleId { row["identity"] = signed.identity; row["protected"] = false }
    else { row["reason"] = "This app has no verified signing identity." }
    return row
  }
  return ["apps":apps]
}
@available(macOS 14.0, *)
func handle(_ request: [String: Any]) async throws -> [String: Any] {
  guard let operation = request["op"] as? String else { try reject("Missing app operation.") }
  if operation == "list" { return catalog() }
  if operation == "windows" {
    guard let path = request["appId"] as? String, let expected = request["identity"] as? String else { try reject("Choose an approved signed app.") }
    let hosts = try protectedHosts(request)
    let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly:true)
    var windows = [[String: Any]]()
    for window in content.windows where window.windowLayer == 0 && window.frame.width >= 16 && window.frame.height >= 16 {
      guard let pid = window.owningApplication?.processID, let app = NSRunningApplication(processIdentifier:pid),
        app.bundleURL.map(canonical) == path else { continue }
      let id = try identity(path,pid,expected:expected)
      guard !protectedWindow(window.title ?? ""), let ax = try? axWindow(window,pid), let controls = try? nodes(ax,pid),
        (try? validateBrowserPage(id.signature.id,ax,controls,hosts)) != nil else { continue }
      windows.append(["id":window.windowID,"title":String((window.title ?? "Window").prefix(300)),
        "width":window.frame.width,"height":window.frame.height,"pid":pid,"instance":id.instance,"identity":id.signature.identity])
      if windows.count >= 100 { break }
    }
    return ["windows":windows]
  }
  let value = try await target(request)
  if operation == "input" { return try input(request,value) }
  guard operation == "capture" else { try reject("Unknown app operation.") }
  let filter = SCContentFilter(desktopIndependentWindow:value.window)
  let config = SCStreamConfiguration()
  let scale = min(1,1600/max(value.window.frame.width,value.window.frame.height))
  config.width = max(1,Int(value.window.frame.width*scale)); config.height = max(1,Int(value.window.frame.height*scale))
  config.showsCursor = false
  config.capturesAudio = false
  config.ignoreShadowsSingleWindow = true
  if #available(macOS 14.2, *) { config.includeChildWindows = false }
  try fresh(value)
  let image = try await SCScreenshotManager.captureImage(contentFilter:filter,configuration:config)
  try fresh(value)
  _ = try nodes(value.ax,value.running.app.processIdentifier)
  let bitmap = NSBitmapImageRep(cgImage:image)
  guard let data = bitmap.representation(using:.jpeg,properties:[.compressionFactor:0.8]), data.count < 5*1024*1024 else {
    try reject("The app window could not be encoded safely.")
  }
  return ["jpeg":data.base64EncodedString(),"width":image.width,"height":image.height]
}
@main struct Main {
  static func main() async {
    do {
      let data = FileHandle.standardInput.readDataToEndOfFile()
      guard data.count <= 65536, let request = try JSONSerialization.jsonObject(with:data) as? [String: Any] else { try reject("Invalid app request.") }
      guard #available(macOS 14.0, *) else { try reject("Protected app sharing requires macOS 14 or later.") }
      let result = try await handle(request)
      let encoded = try JSONSerialization.data(withJSONObject:result,options:[.sortedKeys])
      FileHandle.standardOutput.write(encoded+Data([10]))
    } catch {
      let message = (error as? GuardError)?.message ?? "The protected app operation failed. Check Screen Recording and Accessibility permissions."
      if let data = try? JSONSerialization.data(withJSONObject:["error":message]) { FileHandle.standardOutput.write(data+Data([10])) }
      exit(1)
    }
  }
}
