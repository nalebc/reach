// Frozen read-only benchmark baseline, October 13, 2026.
// These are the production contextLabel, labelName and readScreen functions
// before native within filtering and lazy label fallbacks. Do not update this
// baseline when changing the reader: it supplies paired output and cost checks.
// Source SHA-256: d9f7a60dea77ce7176ec43da59293303ce4335462d2f8aa56d8e888986c473e7

func contextLabel(_ node: AXUIElement, _ role: String, _ children: [AXUIElement]) -> String {
  guard ["AXGroup", "AXRow", "AXCell", "AXToolbar", "AXTable", "AXList", "AXTabGroup", "AXSheet"].contains(role) else { return "" }
  let label = [string(node, kAXTitleAttribute), string(node, kAXDescriptionAttribute)].first { !$0.isEmpty } ?? ""
  if label.isEmpty, ["AXRow", "AXCell"].contains(role) {
    return children.prefix(4).filter { string($0, kAXRoleAttribute) == "AXStaticText" }.map { string($0, kAXValueAttribute) }.joined(separator: " ")
  }
  return label
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
