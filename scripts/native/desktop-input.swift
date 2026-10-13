import AppKit
import ApplicationServices
import Foundation

// BEGIN TOUCH GEOMETRY
// Rank the distance to real control edges in the finger's ellipse, rather
// than to control centers (which unfairly favors small controls). A close
// second choice or a disabled closest control leaves the tap alone.
struct TouchCandidate {
  let frame: CGRect
  let enabled: Bool
}
func touchChoice(_ at: CGPoint, _ radius: CGSize, _ candidates: [TouchCandidate]) -> (Int, CGPoint)? {
  guard radius.width > 0, radius.height > 0 else { return nil }
  var ranked: [(Int, Double, CGPoint)] = []
  for (index, candidate) in candidates.enumerated() {
    let r = candidate.frame
    guard !r.isNull, r.width > 0, r.height > 0 else { continue }
    // An exact hit, including a disabled control, is never redirected.
    if r.contains(at) { return nil }
    let dx = max(r.minX - at.x, 0, at.x - r.maxX) / radius.width
    let dy = max(r.minY - at.y, 0, at.y - r.maxY) / radius.height
    let distance = hypot(dx, dy)
    guard distance <= 1 else { continue }
    let inside = r.insetBy(dx: min(2, r.width / 4), dy: min(2, r.height / 4))
    let point = CGPoint(x: max(inside.minX, min(inside.maxX, at.x)),
      y: max(inside.minY, min(inside.maxY, at.y)))
    ranked.append((index, distance, point))
  }
  ranked.sort { $0.1 < $1.1 }
  guard let first = ranked.first, candidates[first.0].enabled,
    ranked.count == 1 || ranked[1].1 - first.1 > 0.2
  else { return nil }
  return (first.0, first.2)
}
// END TOUCH GEOMETRY

// BEGIN DESKTOP MOUSE
// A complete Quartz mouse sequence, including movement before a press and
// relative deltas during a drag. System surfaces such as Mission Control
// must receive the same fields as an ordinary mouse, not just a location.
final class DesktopMouse {
  let source: CGEventSource?
  let emit: (CGEvent) -> Void
  var point: CGPoint
  private(set) var held: CGMouseButton?
  private var number: Int64 = 0
  private var clickState = 1
  init(source: CGEventSource?, point: CGPoint, emit: @escaping (CGEvent) -> Void = {
    $0.post(tap: .cghidEventTap)
  }) {
    self.source = source; self.point = point; self.emit = emit
  }
  private func event(_ kind: CGEventType, _ button: CGMouseButton, from: CGPoint) {
    guard let e = CGEvent(mouseEventSource: source, mouseType: kind,
      mouseCursorPosition: point, mouseButton: button) else { return }
    let moving = kind == .mouseMoved || kind == .leftMouseDragged || kind == .rightMouseDragged
    e.setIntegerValueField(.mouseEventButtonNumber, value: Int64(button.rawValue))
    e.setIntegerValueField(.mouseEventNumber, value: number)
    e.setIntegerValueField(.mouseEventClickState, value: kind == .mouseMoved ? 0 : Int64(clickState))
    e.setIntegerValueField(.mouseEventDeltaX, value: moving ? Int64((point.x - from.x).rounded()) : 0)
    e.setIntegerValueField(.mouseEventDeltaY, value: moving ? Int64((point.y - from.y).rounded()) : 0)
    e.setDoubleValueField(.mouseEventPressure,
      value: kind == .leftMouseUp || kind == .rightMouseUp || kind == .mouseMoved ? 0 : 1)
    emit(e)
  }
  func move(to next: CGPoint) {
    let previous = point
    point = next
    event(held == .left ? .leftMouseDragged : held == .right ? .rightMouseDragged : .mouseMoved,
      held ?? .left, from: previous)
  }
  func down(at next: CGPoint, button: CGMouseButton, count: Int = 1) {
    release()
    // Mission Control's hover/hit state follows pointer movement. A touch
    // never generated a mouseMoved before this down, unlike a real mouse.
    move(to: next)
    number += 1
    clickState = count
    held = button
    event(button == .right ? .rightMouseDown : .leftMouseDown, button, from: point)
  }
  func up(at next: CGPoint) {
    if held != nil, next != point { move(to: next) }
    release()
  }
  func release() {
    guard let button = held else { return }
    event(button == .right ? .rightMouseUp : .leftMouseUp, button, from: point)
    held = nil
  }
}
// END DESKTOP MOUSE

final class Input: @unchecked Sendable {
  let lock = NSLock()
  let source = CGEventSource(stateID: .hidSystemState)
  lazy var mouse = DesktopMouse(source: source, point: CGEvent(source: nil)?.location ?? .zero)
  var currentFlags: CGEventFlags = []
  var last = Date()
  let display: CGDirectDisplayID
  init(_ display: CGDirectDisplayID) { self.display = display }
  var typingElement: AXUIElement?
  var typingToken = ""
  var probedField: AXUIElement?
  var probedPoint = CGPoint.zero
  var probedAt = Date.distantPast
  // The field typed into, as it was when tapped: its app, place and kind.
  var typingPid: pid_t = 0
  var typingFrame: CGRect?
  var typingSecure = false
  func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?
    AXUIElementSetMessagingTimeout(element, 0.15)
    guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else {
      return nil
    }
    return value
  }
  func focused() -> AXUIElement? {
    guard let value = attribute(AXUIElementCreateSystemWide(), kAXFocusedUIElementAttribute),
      CFGetTypeID(value) == AXUIElementGetTypeID()
    else { return nil }
    return (value as! AXUIElement)
  }
  // Web editors can focus a descendant of the editable element. Resolve it
  // the same way when identifying the field and before every guarded edit.
  func editableElement(_ element: AXUIElement) -> AXUIElement? {
    let role = attribute(element, kAXRoleAttribute) as? String ?? ""
    if ["AXTextField", "AXTextArea", "AXSearchField", "AXComboBox"].contains(role) {
      return element
    }
    if let ancestor = attribute(element, "AXEditableAncestor"),
      CFGetTypeID(ancestor) == AXUIElementGetTypeID()
    { return (ancestor as! AXUIElement) }
    var settable: DarwinBoolean = false
    AXUIElementIsAttributeSettable(element, kAXValueAttribute as CFString, &settable)
    return role == "AXUnknown" && settable.boolValue ? element : nil
  }
  func textTarget(_ p: [String: Any]) -> [String: Any] {
    guard let focus = focused(), let element = editableElement(focus) else {
      typingElement = nil
      typingToken = ""
      return ["editable": false]
    }
    let subrole = attribute(element, kAXSubroleAttribute) as? String ?? ""
    let enabled = attribute(element, kAXEnabledAttribute) as? Bool ?? true
    var editable = enabled
    if let x = p["x"] as? Double, let y = p["y"] as? Double {
      let bounds = CGDisplayBounds(display)
      let click = CGPoint(
        x: bounds.minX + x * max(0, bounds.width - 1),
        y: bounds.minY + y * max(0, bounds.height - 1))
      // Opening suggestions can move a web field after the click. Its exact
      // probed identity still proves which field was tapped; another focused
      // field elsewhere never qualifies through this exception.
      let sameProbedField = probedField.map { CFEqual($0, element) } == true
        && Date().timeIntervalSince(probedAt) < 2
        && hypot(click.x - probedPoint.x, click.y - probedPoint.y) <= 2
      editable = editable && (sameProbedField || frameOf(element)?.insetBy(dx: -2, dy: -2).contains(click) == true)
    }
    guard editable else {
      typingElement = nil
      typingToken = ""
      return ["editable": false]
    }
    if typingElement == nil || !CFEqual(typingElement!, element) {
      typingElement = element
      typingToken = UUID().uuidString
      var pid: pid_t = 0
      typingPid = AXUIElementGetPid(element, &pid) == .success ? pid : 0
      typingFrame = frameOf(element)
      typingSecure = subrole == "AXSecureTextField"
    }
    // Never read the value, label, selected text or surrounding document.
    return ["editable": true, "focus": typingToken, "secure": subrole == "AXSecureTextField"]
  }
  // Apps whose web content (Chrome, Electron apps such as Claude) was asked
  // to describe itself: they only list their text fields once asked.
  var describing = Set<pid_t>()
  // Electron listens to AXManualAccessibility; browsers don't (Chrome says
  // it's unsupported and kept its pages' fields hidden, so a tap on one never
  // opened the phone's keyboard). They listen to what VoiceOver sets.
  static let browsers: Set<String> = [
    "com.google.Chrome", "com.google.Chrome.beta", "com.google.Chrome.dev",
    "com.google.Chrome.canary", "org.chromium.Chromium", "com.microsoft.edgemac",
    "com.microsoft.edgemac.Beta", "com.microsoft.edgemac.Dev", "com.brave.Browser",
    "company.thebrowser.Browser", "com.vivaldi.Vivaldi", "com.operasoftware.Opera",
    "org.mozilla.firefox", "org.mozilla.firefoxdeveloperedition", "org.mozilla.nightly",
    "company.thebrowser.dia", "ai.perplexity.comet", "com.openai.atlas",
  ]
  func describe(_ pid: pid_t) {
    guard !describing.contains(pid) else { return }
    describing.insert(pid)
    let app = AXUIElementCreateApplication(pid)
    AXUIElementSetMessagingTimeout(app, 0.1)
    _ = AXUIElementSetAttributeValue(app, "AXManualAccessibility" as CFString, kCFBooleanTrue)
    if let id = NSRunningApplication(processIdentifier: pid)?.bundleIdentifier,
      Input.browsers.contains(id)
    {
      _ = AXUIElementSetAttributeValue(app, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue)
    }
  }
  // Is there a text field at this point? Asked when a finger touches down,
  // so the phone can open its keyboard on the same tap. Nothing is clicked,
  // focused or read: only the kind of element under the finger.
  func probe(_ p: [String: Any]) -> [String: Any] {
    probedField = nil
    // The whole look is bounded: it runs on the same helper as the tap's
    // click, so a slow app answering never holds that click up. Out of time,
    // it says "no field" (not "blind": the keyboard button isn't offered).
    let until = Date().addingTimeInterval(0.3)
    guard let x = p["x"] as? Double, let y = p["y"] as? Double else { return ["field": false] }
    let bounds = CGDisplayBounds(display)
    let at = CGPoint(
      x: bounds.minX + x * max(0, bounds.width - 1),
      y: bounds.minY + y * max(0, bounds.height - 1))
    let system = AXUIElementCreateSystemWide()
    AXUIElementSetMessagingTimeout(system, 0.1)
    var hit: AXUIElement?
    // Web content asked for the first time can answer nothing while it wakes
    // its accessibility (a page's first tap said "no field"): ask again, briefly.
    var found = AXUIElementCopyElementAtPosition(system, Float(at.x), Float(at.y), &hit)
    for _ in 0..<2 where found != .success {
      usleep(40_000)
      found = AXUIElementCopyElementAtPosition(system, Float(at.x), Float(at.y), &hit)
    }
    // Nothing answers there: an app macOS can't see into. The phone offers its
    // keyboard button instead.
    guard found == .success, var element = hit else { return ["field": false, "blind": true] }
    var pid: pid_t = 0
    if AXUIElementGetPid(element, &pid) == .success, pid > 0, !describing.contains(pid) {
      describe(pid)
      if AXUIElementCopyElementAtPosition(system, Float(at.x), Float(at.y), &hit) == .success,
        let again = hit
      {
        element = again
      }
    }
    // The field itself, or what's drawn inside it (its text, a placeholder).
    for _ in 0..<4 where Date() < until {
      if let field = editableElement(element) {
        return rememberField(field, at)
      }
      guard let parent = attribute(element, kAXParentAttribute),
        CFGetTypeID(parent) == AXUIElementGetTypeID()
      else { break }
      element = parent as! AXUIElement
    }
    // What macOS hits can be a layer drawn over the field, not inside it (the
    // ChatGPT app's composer, SwiftUI overlays, web views): the walk up never
    // meets the field. Look in the window under the finger for a field whose
    // frame holds the point, skipping branches that don't; bounded in time so
    // the tap's click is never held up.
    if Date() < until, let window = windowOf(hit ?? element, until: until),
      let field = fieldAt(window, at, until: until)
    {
      return rememberField(field, at)
    }
    guard Date() < until else { return ["field": false] }
    return ["field": false, "blind": opaque(hit ?? element)]
  }
  func rememberField(_ field: AXUIElement, _ at: CGPoint) -> [String: Any] {
    let enabled = attribute(field, kAXEnabledAttribute) as? Bool ?? true
    if enabled { probedField = field; probedPoint = at; probedAt = Date() }
    let subrole = attribute(field, kAXSubroleAttribute) as? String ?? ""
    return ["field": enabled, "secure": subrole == "AXSecureTextField"]
  }
  // Where the text fields of the front window are, so the phone opens its
  // keyboard on the tap itself instead of waiting for a probe's answer. Run by
  // a second helper, so a scan never delays a click. Only places and kinds:
  // never a value, label or title.
  var scanned = (signature: "", at: Date.distantPast)
  // The front app and the windows on screen, cheap to read: when it's the
  // same as last scan, nothing moved.
  func screenSignature() -> String {
    let list =
      CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID)
      as? [[String: Any]] ?? []
    var parts = ["\(NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0)"]
    for window in list where window[kCGWindowLayer as String] as? Int == 0 {
      guard let rect = window[kCGWindowBounds as String] as? NSDictionary,
        let bounds = CGRect(dictionaryRepresentation: rect)
      else { continue }
      parts.append("\(window[kCGWindowNumber as String] ?? 0):\(bounds)")
    }
    return parts.joined(separator: ";")
  }
  func fields(_ p: [String: Any]) -> [String: Any] {
    let signature = screenSignature()
    // The idle check: nothing moved, and the last full look is recent.
    if p["cheap"] as? Bool == true, signature == scanned.signature,
      Date().timeIntervalSince(scanned.at) < 4
    { return ["same": true] }
    scanned = (signature, Date())
    let bounds = CGDisplayBounds(display)
    guard let front = NSWorkspace.shared.frontmostApplication else { return ["fields": []] }
    let pid = front.processIdentifier
    let app = AXUIElementCreateApplication(pid)
    AXUIElementSetMessagingTimeout(app, 0.1)
    describe(pid)
    guard let value = attribute(app, kAXFocusedWindowAttribute),
      CFGetTypeID(value) == AXUIElementGetTypeID(),
      let windowFrame = frameOf(value as! AXUIElement), windowFrame.intersects(bounds)
    else { return ["fields": []] }
    let visible = windowFrame.intersection(bounds)
    // Walk the window, skipping branches outside what's on screen.
    let names = [kAXRoleAttribute, kAXPositionAttribute, kAXSizeAttribute, kAXChildrenAttribute]
      as CFArray
    var found: [(AXUIElement, CGRect)] = []
    var queue: [(AXUIElement, Int)] = [(value as! AXUIElement, 0)]
    var head = 0
    let walkUntil = Date().addingTimeInterval(0.12)
    while head < queue.count, found.count < 64, Date() < walkUntil {
      let (element, depth) = queue[head]
      head += 1
      AXUIElementSetMessagingTimeout(element, 0.05)
      var values: CFArray?
      guard
        AXUIElementCopyMultipleAttributeValues(element, names, AXCopyMultipleAttributeOptions(), &values)
          == .success, let v = values as? [AnyObject], v.count == 4
      else { continue }
      let role = v[0] as? String ?? ""
      var frame: CGRect?
      if CFGetTypeID(v[1]) == AXValueGetTypeID(), CFGetTypeID(v[2]) == AXValueGetTypeID(),
        AXValueGetType(v[1] as! AXValue) == .cgPoint, AXValueGetType(v[2] as! AXValue) == .cgSize
      {
        var origin = CGPoint.zero
        var size = CGSize.zero
        AXValueGetValue(v[1] as! AXValue, .cgPoint, &origin)
        AXValueGetValue(v[2] as! AXValue, .cgSize, &size)
        frame = CGRect(origin: origin, size: size)
      }
      if let frame, frame.width > 0, frame.height > 0, !frame.intersects(visible) { continue }
      if ["AXTextField", "AXTextArea", "AXSearchField", "AXComboBox"].contains(role) {
        if let frame { found.append((element, frame)) }
        continue
      }
      if depth < 48, let children = v[3] as? [AXUIElement] {
        queue.append(contentsOf: children.map { ($0, depth + 1) })
      }
    }
    // Keep a field only if it's what's really there: a popover, a sheet or a
    // scrolled-away row hides fields the tree still lists.
    let system = AXUIElementCreateSystemWide()
    AXUIElementSetMessagingTimeout(system, 0.05)
    let checkUntil = Date().addingTimeInterval(0.08)
    var out: [[String: Any]] = []
    for (field, frame) in found where Date() < checkUntil {
      let shown = frame.intersection(visible)
      guard !shown.isNull, shown.width >= 8, shown.height >= 8 else { continue }
      var hit: AXUIElement?
      guard
        AXUIElementCopyElementAtPosition(system, Float(shown.midX), Float(shown.midY), &hit)
          == .success, var element = hit
      else { continue }
      var same = false
      for _ in 0..<5 {
        if CFEqual(element, field) || editableElement(element).map({ CFEqual($0, field) }) == true {
          same = true
          break
        }
        guard let parent = attribute(element, kAXParentAttribute),
          CFGetTypeID(parent) == AXUIElementGetTypeID()
        else { break }
        element = parent as! AXUIElement
      }
      guard same, attribute(field, kAXEnabledAttribute) as? Bool ?? true else { continue }
      // A little inside its edges: a tap on the border may land outside.
      let r = shown.insetBy(dx: min(3, shown.width / 4), dy: min(3, shown.height / 4))
      func n(_ v: Double) -> Double { (v * 10000).rounded() / 10000 }
      out.append([
        "x": n((r.minX - bounds.minX) / bounds.width),
        "y": n((r.minY - bounds.minY) / bounds.height),
        "w": n(r.width / bounds.width),
        "h": n(r.height / bounds.height),
        "secure": attribute(field, kAXSubroleAttribute) as? String == "AXSecureTextField",
      ])
    }
    return ["fields": out]
  }
  // Can't see inside: macOS gives only the window (games), nothing it knows
  // (unknown), or a big layer with nothing in it (a canvas, a remote desktop, a
  // video). Text fields there can't be found; the phone shows its keyboard
  // button for them.
  func opaque(_ element: AXUIElement) -> Bool {
    let role = attribute(element, kAXRoleAttribute) as? String ?? ""
    if ["", "AXWindow", "AXApplication", "AXUnknown"].contains(role) { return true }
    guard ["AXGroup", "AXImage", "AXLayoutArea", "AXScrollArea", "AXWebArea"].contains(role),
      (attribute(element, kAXChildrenAttribute) as? [AXUIElement])?.isEmpty ?? true,
      let frame = frameOf(element)
    else { return false }
    return frame.width * frame.height >= 200 * 150
  }
  func frameOf(_ element: AXUIElement) -> CGRect? {
    guard let position = attribute(element, kAXPositionAttribute),
      let size = attribute(element, kAXSizeAttribute),
      CFGetTypeID(position) == AXValueGetTypeID(), CFGetTypeID(size) == AXValueGetTypeID()
    else { return nil }
    var origin = CGPoint.zero
    var extent = CGSize.zero
    AXValueGetValue(position as! AXValue, .cgPoint, &origin)
    AXValueGetValue(size as! AXValue, .cgSize, &extent)
    return CGRect(origin: origin, size: extent)
  }
  // A near miss from a finger only. Read the live window under the tap,
  // bounded to 120 ms and 512 nodes. Incomplete/opaque trees keep the exact
  // point. No labels, text, screenshots, or cached target positions.
  func touchPoint(_ at: CGPoint, _ tolerance: [String: Any]) -> CGPoint {
    guard let x = tolerance["x"] as? Double, let y = tolerance["y"] as? Double,
      x.isFinite, y.isFinite, x > 0, y > 0, x <= 0.1, y <= 0.1
    else { return at }
    let bounds = CGDisplayBounds(display)
    let radius = CGSize(width: min(44, x * max(0, bounds.width - 1)),
      height: min(44, y * max(0, bounds.height - 1)))
    let until = Date().addingTimeInterval(0.12)
    func read(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
      guard Date() < until else { return nil }
      AXUIElementSetMessagingTimeout(element, 0.008)
      var value: CFTypeRef?
      return AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success ? value : nil
    }
    let roles: Set<String> = ["AXButton", "AXCheckBox", "AXRadioButton", "AXPopUpButton",
      "AXMenuButton", "AXLink", "AXMenuItem", "AXTab", "AXDisclosureTriangle",
      "AXTextField", "AXTextArea", "AXSearchField", "AXComboBox"]
    let system = AXUIElementCreateSystemWide()
    AXUIElementSetMessagingTimeout(system, 0.008)
    var hit: AXUIElement?
    guard AXUIElementCopyElementAtPosition(system, Float(at.x), Float(at.y), &hit) == .success,
      let original = hit else { return at }
    var current = original
    // Preserve exact hits on a control or its text/icon descendants.
    for _ in 0..<6 where Date() < until {
      if roles.contains(read(current, kAXRoleAttribute) as? String ?? "") { return at }
      guard let parent = read(current, kAXParentAttribute),
        CFGetTypeID(parent) == AXUIElementGetTypeID() else { break }
      current = parent as! AXUIElement
    }
    let root: AXUIElement
    if read(original, kAXRoleAttribute) as? String == "AXWindow" { root = original }
    else if let window = read(original, kAXWindowAttribute),
      CFGetTypeID(window) == AXUIElementGetTypeID() { root = window as! AXUIElement }
    else { return at }
    let near = CGRect(x: at.x - radius.width, y: at.y - radius.height,
      width: radius.width * 2, height: radius.height * 2).intersection(bounds)
    let names = [kAXRoleAttribute, kAXPositionAttribute, kAXSizeAttribute,
      kAXEnabledAttribute, kAXChildrenAttribute] as CFArray
    var queue: [(AXUIElement, Int)] = [(root, 0)], head = 0
    var candidates: [TouchCandidate] = [], elements: [AXUIElement] = []
    while head < queue.count, Date() < until {
      let (element, depth) = queue[head]; head += 1
      AXUIElementSetMessagingTimeout(element, 0.008)
      var values: CFArray?
      guard AXUIElementCopyMultipleAttributeValues(element, names,
        AXCopyMultipleAttributeOptions(), &values) == .success,
        let v = values as? [AnyObject], v.count == 5 else { return at }
      var frame: CGRect?
      if CFGetTypeID(v[1]) == AXValueGetTypeID(), CFGetTypeID(v[2]) == AXValueGetTypeID(),
        AXValueGetType(v[1] as! AXValue) == .cgPoint, AXValueGetType(v[2] as! AXValue) == .cgSize {
        var origin = CGPoint.zero, size = CGSize.zero
        AXValueGetValue(v[1] as! AXValue, .cgPoint, &origin)
        AXValueGetValue(v[2] as! AXValue, .cgSize, &size)
        frame = CGRect(origin: origin, size: size).intersection(bounds)
      }
      if let frame, frame.width > 0, frame.height > 0, !frame.intersects(near) { continue }
      if roles.contains(v[0] as? String ?? ""), let frame {
        candidates.append(TouchCandidate(frame: frame, enabled: v[3] as? Bool ?? false))
        elements.append(element)
        continue
      }
      if let children = v[4] as? [AXUIElement], !children.isEmpty {
        guard depth < 48, queue.count + children.count <= 512 else { return at }
        queue.append(contentsOf: children.map { ($0, depth + 1) })
      }
    }
    guard head == queue.count, Date() < until,
      let (index, point) = touchChoice(at, radius, candidates) else { return at }
    // Prove the candidate is actually visible here; trees can include
    // covered controls and scrolled-away rows. Never cross into an overlay.
    hit = nil
    guard AXUIElementCopyElementAtPosition(system, Float(point.x), Float(point.y), &hit) == .success,
      var checked = hit else { return at }
    for _ in 0..<6 where Date() < until {
      if CFEqual(checked, elements[index]) { return point }
      guard let parent = read(checked, kAXParentAttribute),
        CFGetTypeID(parent) == AXUIElementGetTypeID() else { break }
      checked = parent as! AXUIElement
    }
    return at
  }
  func windowOf(_ element: AXUIElement, until: Date = .distantFuture) -> AXUIElement? {
    if let window = attribute(element, kAXWindowAttribute),
      CFGetTypeID(window) == AXUIElementGetTypeID()
    {
      return (window as! AXUIElement)
    }
    var current = element
    for _ in 0..<40 where Date() < until {
      if attribute(current, kAXRoleAttribute) as? String == "AXWindow" { return current }
      guard let parent = attribute(current, kAXParentAttribute),
        CFGetTypeID(parent) == AXUIElementGetTypeID()
      else { return nil }
      current = parent as! AXUIElement
    }
    return nil
  }
  func fieldAt(_ root: AXUIElement, _ at: CGPoint, until: Date) -> AXUIElement? {
    let roles: Set<String> = ["AXTextField", "AXTextArea", "AXSearchField", "AXComboBox"]
    var stack = [root]
    var visited = 0
    while let element = stack.popLast(), visited < 4000, Date() < until {
      visited += 1
      let role = attribute(element, kAXRoleAttribute) as? String ?? ""
      if roles.contains(role) {
        if let frame = frameOf(element), frame.insetBy(dx: -2, dy: -2).contains(at) {
          return element
        }
        continue
      }
      guard let children = attribute(element, kAXChildrenAttribute) as? [AXUIElement] else {
        continue
      }
      for child in children {
        if let frame = frameOf(child), frame.width > 0, frame.height > 0,
          !frame.insetBy(dx: -2, dy: -2).contains(at)
        {
          continue
        }
        stack.append(child)
      }
    }
    return nil
  }
  func checkTyping(_ token: String) throws {
    guard !token.isEmpty, token == typingToken, let expected = typingElement,
      let focus = focused(), let current = editableElement(focus),
      CFEqual(expected, current) || sameField(current)
    else {
      typingElement = nil
      typingToken = ""
      throw NSError(domain: "The typing target changed. Tap the text field again.", code: 1)
    }
  }
  // Web editors rebuild the focused field as text goes in (a new element
  // each time): it's still the field tapped when it's in the same app, the
  // same kind (never a password field for a plain one) and mostly where the
  // tapped one was. From then on it's the one typed into.
  func sameField(_ current: AXUIElement) -> Bool {
    var pid: pid_t = 0
    guard typingPid > 0, AXUIElementGetPid(current, &pid) == .success, pid == typingPid,
      let was = typingFrame, was.width > 0, was.height > 0,
      let now = frameOf(current), now.width > 0, now.height > 0,
      ((attribute(current, kAXSubroleAttribute) as? String ?? "") == "AXSecureTextField") == typingSecure
    else { return false }
    let overlap = was.intersection(now)
    guard !overlap.isNull, overlap.width * overlap.height >= 0.5 * min(was.width * was.height, now.width * now.height)
    else { return false }
    typingElement = current
    typingFrame = now
    return true
  }
  func keyPress(_ code: CGKeyCode) {
    for down in [true, false] {
      let e = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: down)
      e?.flags = []
      e?.post(tap: .cghidEventTap)
    }
  }
  func insertText(_ text: String) {
    for scalar in text.unicodeScalars {
      let units = Array(String(scalar).utf16)
      for down in [true, false] {
        let e = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: down)
        e?.keyboardSetUnicodeString(stringLength: units.count, unicodeString: units)
        e?.flags = []
        e?.post(tap: .cghidEventTap)
      }
    }
  }
  func flags(_ p: [String: Any]) -> CGEventFlags {
    var f: CGEventFlags = []
    for m in p["modifiers"] as? [String] ?? [] {
      switch m {
      case "meta": f.insert(.maskCommand)
      case "alt": f.insert(.maskAlternate)
      case "control": f.insert(.maskControl)
      case "shift": f.insert(.maskShift)
      case "caps": f.insert(.maskAlphaShift)
      case "fn": f.insert(.maskSecondaryFn)
      default: break
      }
    }
    return f
  }
  // Physical arrow, navigation and function keys carry these flags. macOS
  // system shortcuts (Mission Control, switching desktops) ignore synthetic
  // key events without them.
  static func keyFlags(_ code: CGKeyCode) -> CGEventFlags {
    switch code {
    case 123, 124, 125, 126: return [.maskSecondaryFn, .maskNumericPad]
    case 114, 115, 116, 117, 119, 121: return .maskSecondaryFn
    case 122, 120, 99, 118, 96, 97, 98, 100, 101, 109, 103, 111, 105, 107, 113, 106, 64, 79, 80,
      90:
      return .maskSecondaryFn
    default: return []
    }
  }
  // Modifier keys pressed around a shortcut, outermost first.
  static let modifierKeys: [(CGKeyCode, CGEventFlags)] = [
    (59, .maskControl), (58, .maskAlternate), (56, .maskShift), (55, .maskCommand),
    (63, .maskSecondaryFn),
  ]
  func release() {
    mouse.release()
    currentFlags = []
  }
  // MARK: Context shortcuts: the frontmost app and its own menu commands.
  // Reads titles and keyboard equivalents only; never window or document content.
  var menuCache: (pid: pid_t, stamp: String, at: Date, items: [[String: Any]])?
  func children(_ element: AXUIElement) -> [AXUIElement] {
    attribute(element, kAXChildrenAttribute) as? [AXUIElement] ?? []
  }
  func menuBar(_ app: NSRunningApplication) -> AXUIElement? {
    let root = AXUIElementCreateApplication(app.processIdentifier)
    guard let bar = attribute(root, kAXMenuBarAttribute), CFGetTypeID(bar) == AXUIElementGetTypeID()
    else { return nil }
    return (bar as! AXUIElement)
  }
  static let glyphs: [String: String] = [
    "\u{F700}": "↑", "\u{F701}": "↓", "\u{F702}": "←", "\u{F703}": "→", "\u{8}": "⌫",
    "\u{7F}": "⌫", "\u{F728}": "⌦", "\u{1B}": "Esc", "\u{9}": "Tab", "\u{D}": "Return",
    " ": "Space",
  ]
  func collectMenu(_ element: AXUIElement, path: [String], depth: Int, into items: inout [[String: Any]]) {
    // Menu bar items and submenu items contain an AXMenu whose children are the items.
    for menu in children(element) {
      for item in children(menu) {
        guard items.count < 300, let title = attribute(item, kAXTitleAttribute) as? String,
          !title.isEmpty
        else { continue }
        let submenu = children(item)
        if !submenu.isEmpty {
          if depth < 1 { collectMenu(item, path: path + [title], depth: depth + 1, into: &items) }
          continue
        }
        guard attribute(item, kAXEnabledAttribute) as? Bool ?? true else { continue }
        var entry: [String: Any] = ["path": path + [title]]
        if let char = attribute(item, kAXMenuItemCmdCharAttribute) as? String, !char.isEmpty {
          let mods = attribute(item, kAXMenuItemCmdModifiersAttribute) as? Int ?? 0
          var names: [String] = []
          if mods & 4 != 0 { names.append("control") }
          if mods & 2 != 0 { names.append("alt") }
          if mods & 1 != 0 { names.append("shift") }
          if mods & 8 == 0 { names.append("meta") }
          entry["shortcut"] = ["key": Input.glyphs[char] ?? char.uppercased(), "modifiers": names]
        }
        items.append(entry)
      }
    }
  }
  func context(since: String?) -> [String: Any] {
    guard let app = NSWorkspace.shared.frontmostApplication else { return ["app": NSNull()] }
    let pid = app.processIdentifier
    if menuCache == nil || menuCache!.pid != pid || Date().timeIntervalSince(menuCache!.at) > 20 {
      var items: [[String: Any]] = []
      if let bar = menuBar(app) {
        // Skip the Apple menu; it is the same in every app.
        for top in children(bar).dropFirst() {
          guard let title = attribute(top, kAXTitleAttribute) as? String, !title.isEmpty else {
            continue
          }
          collectMenu(top, path: [title], depth: 0, into: &items)
        }
      }
      menuCache = (pid, UUID().uuidString, Date(), items)
    }
    let identity: [String: Any] = [
      "name": app.localizedName ?? "", "bundle": app.bundleIdentifier ?? "",
    ]
    if since == menuCache!.stamp {
      return ["app": identity, "stamp": menuCache!.stamp, "unchanged": true]
    }
    return ["app": identity, "stamp": menuCache!.stamp, "items": menuCache!.items]
  }
  func pressMenu(_ path: [String]) throws {
    guard let app = NSWorkspace.shared.frontmostApplication, var current = menuBar(app) else {
      throw NSError(domain: "No app is in front on your laptop.", code: 1)
    }
    for (index, title) in path.enumerated() {
      let candidates =
        index == 0 ? children(current) : children(current).flatMap { children($0) }
      guard
        let next = candidates.first(where: {
          attribute($0, kAXTitleAttribute) as? String == title
        })
      else { throw NSError(domain: "That command is no longer in the app's menu.", code: 1) }
      current = next
    }
    guard AXUIElementPerformAction(current, kAXPressAction as CFString) == .success else {
      throw NSError(domain: "The app did not accept that command.", code: 1)
    }
    menuCache = nil
  }
  func action(_ p: [String: Any]) throws -> [String: Any] {
    lock.lock()
    defer { lock.unlock() }
    last = Date()
    guard AXIsProcessTrusted() else {
      release()
      throw NSError(
        domain: "Allow Accessibility for Reach’s desktop input helper in System Settings.", code: 2)
    }
    guard CGDisplayIsActive(display) != 0 else {
      release()
      throw NSError(domain: "This display disconnected. Select a display again.", code: 2)
    }
    let type = p["type"] as? String ?? ""
    if type == "focus" { return ["target": textTarget(p)] }
    if type == "probe" { return probe(p) }
    if type == "fields" { return fields(p) }
    if type == "context" { return context(since: p["since"] as? String) }
    if type == "menu", let path = p["path"] as? [String] {
      try pressMenu(path)
      return [:]
    }
    if let token = p["focus"] as? String { try checkTyping(token) }
    if type == "type-edit", let text = p["text"] as? String, let count = p["delete"] as? Int {
      guard count >= 0, count <= 256, text.utf8.count <= 8000, p["focus"] is String else {
        throw NSError(domain: "Invalid typing edit.", code: 1)
      }
      for _ in 0..<count { keyPress(51) }
      insertText(text)
      return [:]
    }
    if type == "release" {
      release()
      return [:]
    }
    if type == "heartbeat" {
      let bounds = CGDisplayBounds(display)
      let cursor = CGEvent(source: nil)?.location ?? bounds.origin
      return [
        "cursor": [
          "x": min(1, max(0, (cursor.x - bounds.minX) / max(1, bounds.width - 1))),
          "y": min(1, max(0, (cursor.y - bounds.minY) / max(1, bounds.height - 1))),
        ]
      ]
    }
    if type == "selection-read" {
      guard let element = focused(),
        attribute(element, kAXSubroleAttribute) as? String != "AXSecureTextField"
      else { throw NSError(domain: "Select non-password text on your laptop first.", code: 1) }
      guard let text = attribute(element, kAXSelectedTextAttribute) as? String, !text.isEmpty else {
        throw NSError(
          domain:
            "This app does not expose selected text. Use Command+C on the laptop, then open Clipboard in Screen options.",
          code: 1)
      }
      guard text.utf8.count <= 16384 else {
        throw NSError(domain: "Selected text exceeds 16 KiB.", code: 1)
      }
      return ["text": text]
    }
    if type == "clipboard-read" {
      // A password manager marks what it copies as concealed: only the owner
      // takes that off the Mac.
      let concealed = NSPasteboard.PasteboardType("org.nspasteboard.ConcealedType")
      if NSPasteboard.general.types?.contains(concealed) == true, p["owner"] as? Bool != true {
        throw NSError(domain: "That's a hidden password; only the owner can copy it.", code: 1)
      }
      let text = NSPasteboard.general.string(forType: .string) ?? ""
      guard text.utf8.count <= 16384 else {
        throw NSError(domain: "Clipboard text exceeds 16 KiB.", code: 1)
      }
      return ["text": text]
    }
    if type == "clipboard-write", let text = p["text"] as? String {
      NSPasteboard.general.clearContents()
      NSPasteboard.general.setString(text, forType: .string)
      return [:]
    }
    if ["move", "down", "up", "click"].contains(type), let x = p["x"] as? Double,
      let y = p["y"] as? Double
    {
      let bounds = CGDisplayBounds(display)
      var point = CGPoint(
        x: bounds.minX + x * max(0, bounds.width - 1),
        y: bounds.minY + y * max(0, bounds.height - 1))
      let button: CGMouseButton = p["button"] as? String == "right" ? .right : .left
      if type == "click", button == .left, let tolerance = p["touch"] as? [String: Any] {
        point = touchPoint(point, tolerance)
      }
      // A local mouse may have moved between gestures. Held drags keep
      // their own last point so every delta continues the same press.
      if mouse.held == nil { mouse.point = CGEvent(source: nil)?.location ?? mouse.point }
      if type == "move" {
        mouse.move(to: point)
      }
      if type == "down" {
        release()
        mouse.down(at: point, button: button)
      }
      if type == "up" { mouse.up(at: point); currentFlags = [] }
      if type == "click" {
        release()
        for c in 1...(p["count"] as? Int ?? 1) {
          mouse.down(at: point, button: button, count: c)
          mouse.up(at: point)
        }
        return ["point": [
          "x": min(1, max(0, (point.x - bounds.minX) / max(1, bounds.width - 1))),
          "y": min(1, max(0, (point.y - bounds.minY) / max(1, bounds.height - 1)))]]
      }
    } else if type == "scroll" {
      let dx = p["dx"] as? Double ?? 0
      let dy = p["dy"] as? Double ?? 0
      guard dx.isFinite, dy.isFinite, abs(dx) <= 120, abs(dy) <= 120 else {
        throw NSError(domain: "Invalid scroll", code: 1)
      }
      let e = CGEvent(
        scrollWheelEvent2Source: source, units: .pixel, wheelCount: 2, wheel1: Int32(dy),
        wheel2: Int32(dx), wheel3: 0)
      let phase: [String: Int64] = [
        "none": 0, "began": 1, "changed": 2, "ended": 4, "cancelled": 8,
      ]
      let momentum: [String: Int64] = ["none": 0, "began": 1, "changed": 2, "ended": 3]
      e?.setIntegerValueField(.scrollWheelEventFixedPtDeltaAxis1, value: Int64(dy * 65536))
      e?.setIntegerValueField(.scrollWheelEventFixedPtDeltaAxis2, value: Int64(dx * 65536))
      e?.setIntegerValueField(
        .scrollWheelEventScrollPhase, value: phase[p["phase"] as? String ?? "none"] ?? 0)
      e?.setIntegerValueField(
        .scrollWheelEventMomentumPhase, value: momentum[p["momentum"] as? String ?? "none"] ?? 0)
      e?.flags = currentFlags
      e?.post(tap: .cghidEventTap)
    } else if type == "text", let text = p["text"] as? String {
      insertText(text)
    } else if type == "key", let key = p["key"] as? String {
      let keys: [String: CGKeyCode] = [
        "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9, "b": 11,
        "q": 12, "w": 13, "e": 14, "r": 15, "y": 16, "t": 17, "1": 18, "2": 19, "3": 20, "4": 21,
        "6": 22, "5": 23, "9": 25, "7": 26, "8": 28, "0": 29, "o": 31, "u": 32, "i": 34, "p": 35,
        "l": 37, "j": 38, "k": 40, "n": 45, "m": 46, "enter": 36, "tab": 48, "space": 49,
        "backspace": 51, "escape": 53, "home": 115, "pageup": 116, "delete": 117, "end": 119,
        "pagedown": 121, "left": 123, "right": 124, "down": 125, "up": 126, "f1": 122, "f2": 120,
        "f3": 99, "f4": 118, "f5": 96, "f6": 97, "f7": 98, "f8": 100, "f9": 101, "f10": 109,
        "f11": 103, "f12": 111,
      ]
      guard let code = keys[key] else { throw NSError(domain: "Unsupported key", code: 1) }
      let flags = flags(p)
      // Press modifiers as real keys: system shortcuts (⌘Tab, Mission Control,
      // switching desktops) ignore modifiers carried only as event flags.
      var active: CGEventFlags = []
      var pressed: [(CGKeyCode, CGEventFlags)] = []
      for (modifier, flag) in Input.modifierKeys where flags.contains(flag) {
        active.insert(flag)
        let e = CGEvent(keyboardEventSource: source, virtualKey: modifier, keyDown: true)
        e?.flags = active
        e?.post(tap: .cghidEventTap)
        pressed.append((modifier, flag))
      }
      for down in [true, false] {
        let e = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: down)
        e?.flags = flags.union(Input.keyFlags(code))
        e?.post(tap: .cghidEventTap)
      }
      for (modifier, flag) in pressed.reversed() {
        active.remove(flag)
        let e = CGEvent(keyboardEventSource: source, virtualKey: modifier, keyDown: false)
        e?.flags = active
        e?.post(tap: .cghidEventTap)
      }
    } else {
      throw NSError(domain: "Unsupported input", code: 1)
    }
    return [:]
  }
}
@main struct DesktopInput {
  static func main() {
    let value = CommandLine.arguments.dropFirst().first ?? "primary"
    let display = value == "primary" ? CGMainDisplayID() : UInt32(value) ?? 0
    let input = Input(display)
    // Browsers take a few seconds to list their pages' fields once asked:
    // asked now, they're ready by the first tap.
    if AXIsProcessTrusted() {
      for app in NSWorkspace.shared.runningApplications
      where Input.browsers.contains(app.bundleIdentifier ?? "") {
        input.describe(app.processIdentifier)
      }
    }
    // Independent native failsafe: even a wedged server cannot leave a drag held.
    let timer = DispatchSource.makeTimerSource(queue: .global())
    timer.schedule(deadline: .now() + 1, repeating: 0.5)
    timer.setEventHandler {
      input.lock.lock()
      if Date().timeIntervalSince(input.last) > 2 { input.release() }
      input.lock.unlock()
    }
    timer.resume()
    signal(SIGTERM, SIG_IGN)
    let termination = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .global())
    termination.setEventHandler {
      input.lock.lock()
      input.release()
      exit(0)
    }
    termination.resume()
    while let line = readLine() {
      autoreleasepool {
        var result: [String: Any]
        do {
          guard let data = line.data(using: .utf8),
            let action = try JSONSerialization.jsonObject(with: data) as? [String: Any]
          else { throw NSError(domain: "Invalid input", code: 1) }
          result = try input.action(action)
          result["ok"] = true
        } catch {
          // code 2: control can't go on (no Accessibility, display gone);
          // anything else refuses only this one action.
          let e = error as NSError
          result = ["error": e.domain]
          if e.code == 2 { result["fatal"] = true }
        }
        if let data = try? JSONSerialization.data(withJSONObject: result) {
          FileHandle.standardOutput.write(data)
          FileHandle.standardOutput.write(Data([10]))
        }
      }
    }
    input.lock.lock()
    input.release()
    input.lock.unlock()
    timer.cancel()
    termination.cancel()
  }
}
