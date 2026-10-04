import Capacitor
import GameController
import UIKit
import UniformTypeIdentifiers

@objc(ReachDesktopPlugin)
public class ReachDesktopPlugin: CAPPlugin, CAPBridgedPlugin {
  public let identifier = "ReachDesktopPlugin", jsName = "ReachDesktop"
  public let pluginMethods: [CAPPluginMethod] = [
    CAPPluginMethod(name: "open", returnType: CAPPluginReturnPromise)
  ]
  @objc func open(_ call: CAPPluginCall) {
    DispatchQueue.main.async {
      guard UIDevice.current.userInterfaceIdiom == .pad,
        let raw = call.getString("url"), let url = URL(string: raw), url.scheme == "https",
        let host = url.host, host.hasSuffix(".ts.net"), url.user == nil, url.password == nil,
        url.query == nil, url.fragment == nil, ["", "/"].contains(url.path),
        let token = call.getString("token"), !token.isEmpty,
        let presenter = self.bridge?.viewController, presenter.presentedViewController == nil
      else {
        call.reject("Desktop mode requires an iPad and your private HTTPS Tailscale link.")
        return
      }
      let controller = ReachDesktopController(
        http: DesktopHTTP(origin: url, token: token), mode: call.getString("mode") ?? "match",
        clipboard: call.getBool("clipboard") ?? false, uploadRoot: call.getInt("uploadRoot"))
      controller.modalPresentationStyle = .fullScreen
      controller.finished = { call.resolve() }
      presenter.present(controller, animated: true)
    }
  }
}

@MainActor final class ReachDesktopController: UIViewController, UIDropInteractionDelegate {
  let http: DesktopHTTP, mode: String, clipboard: Bool, uploadRoot: Int?
  let video = DesktopVideo(frame: .zero), status = UILabel(),
    controlButton = UIButton(type: .system)
  lazy var connection = DesktopConnection(http: http, video: video)
  var finished: (() -> Void)?
  private var displayLink: CADisplayLink?, delta = CGPoint.zero, pressed = Set<Int>(),
    repeats = [Int: Date]()
  private var modifiers = [String](), scrollEnd: DispatchWorkItem?, scrolling = false,
    scrollDelta = CGPoint.zero
  private var pointerInside = false
  private var hoverPoint: CGPoint?
  private var boundMice = [GCMouse](), observers = [NSObjectProtocol](), closed = false
  private var fnHeld = false
  private var shortcutPrefix =
    UserDefaults.standard.string(forKey: "reach.desktop.shortcuts") ?? "control-alt"
  init(http: DesktopHTTP, mode: String, clipboard: Bool, uploadRoot: Int?) {
    self.http = http
    self.mode = mode
    self.clipboard = clipboard
    self.uploadRoot = uploadRoot
    super.init(nibName: nil, bundle: nil)
  }
  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
  override var canBecomeFirstResponder: Bool { true }
  override var prefersPointerLocked: Bool { connection.control && presentedViewController == nil }
  override var prefersStatusBarHidden: Bool { true }
  override var preferredScreenEdgesDeferringSystemGestures: UIRectEdge { .all }
  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .black
    video.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(video)
    let bar = UIStackView()
    bar.axis = .horizontal
    bar.spacing = 12
    bar.alignment = .center
    bar.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(bar)
    func button(_ title: String, _ action: Selector) -> UIButton {
      let b = UIButton(type: .system)
      b.setTitle(title, for: .normal)
      b.addTarget(self, action: action, for: .touchUpInside)
      bar.addArrangedSubview(b)
      return b
    }
    _ = button("Done", #selector(done))
    controlButton.setTitle("Control", for: .normal)
    controlButton.addTarget(self, action: #selector(toggleControl), for: .touchUpInside)
    bar.addArrangedSubview(controlButton)
    _ = button("Apps", #selector(appSwitcher))
    _ = button("Search", #selector(spotlight))
    _ = button("Spaces", #selector(missionControl))
    _ = button("Options", #selector(options))
    _ = button("fn", #selector(toggleFn))
    status.font = .monospacedDigitSystemFont(ofSize: 11, weight: .regular)
    status.textColor = .lightGray
    status.numberOfLines = 2
    status.text = "Preparing private desktop…"
    status.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(status)
    NSLayoutConstraint.activate([
      bar.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 4),
      bar.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 12),
      bar.heightAnchor.constraint(equalToConstant: 40),
      status.leadingAnchor.constraint(equalTo: bar.trailingAnchor, constant: 12),
      status.trailingAnchor.constraint(
        equalTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -8),
      status.centerYAnchor.constraint(equalTo: bar.centerYAnchor),
      video.topAnchor.constraint(equalTo: bar.bottomAnchor, constant: 4),
      video.leadingAnchor.constraint(equalTo: view.leadingAnchor),
      video.trailingAnchor.constraint(equalTo: view.trailingAnchor),
      video.bottomAnchor.constraint(equalTo: view.bottomAnchor),
    ])
    let tap = UITapGestureRecognizer(target: self, action: #selector(tap(_:)))
    tap.allowedTouchTypes = [NSNumber(value: UITouch.TouchType.direct.rawValue)]
    video.addGestureRecognizer(tap)
    let hover = UIHoverGestureRecognizer(target: self, action: #selector(hover(_:)))
    video.addGestureRecognizer(hover)
    video.addInteraction(UIDropInteraction(delegate: self))
    connection.onStatus = { [weak self] text in
      guard let self else { return }
      let pointer =
        self.connection.control
        ? (self.view.window?.windowScene?.pointerLockState?.isLocked == true
          ? " · Pointer locked" : " · Pointer unlocked") : ""
      self.status.text = text + pointer
    }
    connection.onControl = { [weak self] enabled in
      guard let self else { return }
      self.controlButton.setTitle(enabled ? "Stop control" : "Control", for: .normal)
      self.pressed.removeAll()
      self.repeats.removeAll()
      self.delta = .zero
      self.setNeedsUpdateOfPrefersPointerLocked()
      self.becomeFirstResponder()
    }
    connection.onEnd = { [weak self] reason in self?.ended(reason) }
    observers.append(
      NotificationCenter.default.addObserver(forName: .GCMouseDidConnect, object: nil, queue: .main)
      { [weak self] _ in Task { @MainActor in self?.bindMice() } })
    observers.append(
      NotificationCenter.default.addObserver(
        forName: .GCMouseDidDisconnect, object: nil, queue: .main
      ) { [weak self] _ in
        Task { @MainActor in
          self?.connection.action(["type": "release"])
          self?.bindMice()
        }
      })
    observers.append(
      NotificationCenter.default.addObserver(
        forName: UIApplication.willResignActiveNotification, object: nil, queue: .main
      ) { [weak self] _ in Task { @MainActor in self?.connection.disableControl() } })
    bindMice()
    displayLink = CADisplayLink(target: self, selector: #selector(frame))
    displayLink?.preferredFramesPerSecond = 60
    displayLink?.add(to: .main, forMode: .common)
    Task {
      let pixels = view.window?.screen.nativeBounds.size ?? UIScreen.main.nativeBounds.size
      let landscape = view.bounds.width > view.bounds.height
      let width = Int(
        landscape ? max(pixels.width, pixels.height) : min(pixels.width, pixels.height))
      let height = Int(
        landscape ? min(pixels.width, pixels.height) : max(pixels.width, pixels.height))
      do {
        try await connection.start(mode: mode, clipboard: clipboard, width: width, height: height)
      } catch { connection.finish(error.localizedDescription) }
    }
  }
  override func viewDidAppear(_ animated: Bool) {
    super.viewDidAppear(animated)
    becomeFirstResponder()
  }
  @objc private func done() { connection.finish() }
  private func cleanup() {
    displayLink?.invalidate()
    scrollEnd?.cancel()
    for observer in observers { NotificationCenter.default.removeObserver(observer) }
    observers.removeAll()
    for mouse in boundMice {
      mouse.mouseInput?.mouseMovedHandler = nil
      mouse.mouseInput?.scroll.valueChangedHandler = nil
      mouse.mouseInput?.leftButton.pressedChangedHandler = nil
      mouse.mouseInput?.rightButton?.pressedChangedHandler = nil
      mouse.mouseInput?.middleButton?.pressedChangedHandler = nil
    }
    boundMice.removeAll()
  }
  private func ended(_ reason: String) {
    guard !closed else { return }
    closed = true
    cleanup()
    if reason.isEmpty {
      dismiss(animated: true) { self.finished?() }
    } else {
      status.text = reason
      controlButton.isEnabled = false
      let alert = UIAlertController(
        title: "Desktop disconnected", message: reason, preferredStyle: .alert)
      alert.addAction(
        UIAlertAction(title: "Done", style: .default) { _ in
          self.dismiss(animated: true) { self.finished?() }
        })
      if presentedViewController == nil { present(alert, animated: true) }
    }
  }
  @objc private func toggleControl() {
    if connection.control {
      connection.disableControl()
    } else {
      Task { await connection.enableControl() }
    }
  }
  private func shortcut(_ key: String, _ modifiers: [String]) {
    connection.action(["type": "key", "key": key, "modifiers": modifiers])
  }
  @objc private func appSwitcher() { shortcut("tab", ["meta"]) }
  @objc private func spotlight() { shortcut("space", ["meta"]) }
  @objc private func missionControl() { shortcut("up", ["control"]) }
  @objc private func toggleFn(_ sender: UIButton) {
    fnHeld.toggle()
    sender.setTitle(fnHeld ? "fn ✓" : "fn", for: .normal)
  }
  @objc private func options() {
    let a = UIAlertController(
      title: "Desktop shortcuts",
      message:
        "iPadOS keeps ⌘Tab, ⌘Space, ⌘H and Globe. Use Apps, Search and Spaces above, or choose an alternative prefix. Prefix + Tab opens Apps, Space opens Search, ↑ opens Spaces, Esc releases control. File drops go to the shared folder selected before connecting.",
      preferredStyle: .actionSheet)
    for (title, value) in [("Control + Option", "control-alt"), ("Option + Shift", "alt-shift")] {
      a.addAction(
        UIAlertAction(title: title + (shortcutPrefix == value ? " ✓" : ""), style: .default) { _ in
          self.shortcutPrefix = value
          UserDefaults.standard.set(value, forKey: "reach.desktop.shortcuts")
          self.setNeedsUpdateOfPrefersPointerLocked()
          self.becomeFirstResponder()
        })
    }
    a.addAction(
      UIAlertAction(title: "Cancel", style: .cancel) { _ in
        self.setNeedsUpdateOfPrefersPointerLocked()
        self.becomeFirstResponder()
      })
    a.popoverPresentationController?.sourceView = controlButton
    a.popoverPresentationController?.sourceRect = controlButton.bounds
    present(a, animated: true)
    setNeedsUpdateOfPrefersPointerLocked()
  }
  private func modifierNames(_ flags: UIKeyModifierFlags) -> [String] {
    var result = [String]()
    if flags.contains(.command) { result.append("meta") }
    if flags.contains(.alternate) { result.append("alt") }
    if flags.contains(.control) { result.append("control") }
    if flags.contains(.shift) { result.append("shift") }
    if flags.contains(.alphaShift) { result.append("caps") }
    if fnHeld { result.append("fn") }
    return result
  }
  private func keys(_ events: Set<UIPress>, down: Bool) {
    guard connection.control else { return }
    for press in events {
      guard let key = press.key else { continue }
      let usage = key.keyCode.rawValue
      modifiers = modifierNames(key.modifierFlags)
      let alternative =
        shortcutPrefix == "control-alt"
        ? modifiers.contains("control") && modifiers.contains("alt")
        : modifiers.contains("alt") && modifiers.contains("shift")
      if alternative && [41, 43, 44, 82].contains(usage) {
        if down {
          switch usage {
          case 41: connection.disableControl()
          case 43: appSwitcher()
          case 44: spotlight()
          default: missionControl()
          }
        }
        continue
      }
      // Only keyboard page usages supported by the Mac helper.
      guard
        (4...111).contains(usage) && ![70, 72, 102].contains(usage)
          || (224...231).contains(usage)
      else { continue }
      let repeatKey = pressed.contains(usage)
      if down && repeatKey { continue }
      if down {
        pressed.insert(usage)
        if !repeatKey && usage < 224 && usage != 57 {
          repeats[usage] = Date().addingTimeInterval(0.4)
        }
      } else {
        pressed.remove(usage)
        repeats.removeValue(forKey: usage)
      }
      connection.action([
        "type": down ? "keyDown" : "keyUp", "usage": usage, "modifiers": modifiers,
        "repeat": down && repeatKey,
      ])
    }
  }
  override func pressesBegan(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
    keys(presses, down: true)
  }
  override func pressesEnded(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
    keys(presses, down: false)
  }
  override func pressesCancelled(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
    connection.action(["type": "release"])
    pressed.removeAll()
    repeats.removeAll()
  }
  @objc private func frame() {
    if let p = hoverPoint {
      hoverPoint = nil
      connection.action(["type": "mouseMove", "x": p.x, "y": p.y])
    }
    if delta != .zero {
      let d = delta
      delta = .zero
      connection.action([
        "type": "mouseMove", "relative": true, "dx": Double(max(-2048, min(2048, d.x))),
        "dy": Double(max(-2048, min(2048, d.y))),
      ])
    }
    if scrollDelta != .zero {
      let d = scrollDelta
      scrollDelta = .zero
      connection.action([
        "type": "scroll", "dx": Double(max(-120, min(120, d.x))),
        "dy": Double(max(-120, min(120, d.y))), "phase": scrolling ? "changed" : "began",
      ])
      scrolling = true
    }
    let now = Date()
    if let pair = repeats.max(by: { $0.value < $1.value }), now >= pair.value {
      connection.action([
        "type": "keyDown", "usage": pair.key, "modifiers": modifiers, "repeat": true,
      ])
      repeats[pair.key] = now.addingTimeInterval(1.0 / 30)
    }
  }
  private func point(_ location: CGPoint) -> CGPoint? {
    let r = video.videoRect
    guard r.contains(location), r.width > 0, r.height > 0 else { return nil }
    return CGPoint(x: (location.x - r.minX) / r.width, y: (location.y - r.minY) / r.height)
  }
  @objc private func tap(_ recognizer: UITapGestureRecognizer) {
    guard let p = point(recognizer.location(in: video)) else { return }
    connection.action(["type": "click", "x": p.x, "y": p.y])
    becomeFirstResponder()
  }
  @objc private func hover(_ recognizer: UIHoverGestureRecognizer) {
    pointerInside =
      recognizer.state != .ended && recognizer.state != .cancelled
      && point(recognizer.location(in: video)) != nil
    guard view.window?.windowScene?.pointerLockState?.isLocked != true,
      let p = point(recognizer.location(in: video))
    else { return }
    hoverPoint = p
  }
  private func bindMice() {
    boundMice = GCMouse.mice()
    for mouse in boundMice {
      mouse.handlerQueue = .main
      guard let input = mouse.mouseInput else { continue }
      input.mouseMovedHandler = { [weak self] _, x, y in
        guard let self, self.connection.control,
          self.view.window?.windowScene?.pointerLockState?.isLocked == true
        else { return }
        self.delta.x += CGFloat(x)
        self.delta.y -= CGFloat(y)
      }
      for (button, name) in [
        (input.leftButton, "left"), (input.rightButton, "right"), (input.middleButton, "middle"),
      ] {
        button?.pressedChangedHandler = { [weak self] _, _, down in
          guard let self, self.connection.control, self.presentedViewController == nil,
            self.view.window?.windowScene?.pointerLockState?.isLocked == true || self.pointerInside
          else { return }
          self.frame()
          self.connection.action([
            "type": down ? "mouseDown" : "mouseUp", "button": name, "relative": true, "dx": 0.0,
            "dy": 0.0,
          ])
        }
      }
      input.scroll.valueChangedHandler = { [weak self] _, x, y in
        guard let self, self.connection.control else { return }
        self.scrollDelta.x += CGFloat(x)
        self.scrollDelta.y += CGFloat(y)
        self.scrollEnd?.cancel()
        let end = DispatchWorkItem { [weak self] in
          guard let self else { return }
          self.frame()
          self.connection.action(["type": "scroll", "dx": 0, "dy": 0, "phase": "ended"])
          self.scrolling = false
        }
        self.scrollEnd = end
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.12, execute: end)
      }
    }
  }
  func dropInteraction(_ interaction: UIDropInteraction, canHandle session: UIDropSession) -> Bool {
    uploadRoot != nil && connection.control && session.items.count == 1
      && session.hasItemsConforming(toTypeIdentifiers: [UTType.data.identifier])
  }
  func dropInteraction(_ interaction: UIDropInteraction, sessionDidUpdate session: UIDropSession)
    -> UIDropProposal
  { UIDropProposal(operation: .copy) }
  func dropInteraction(_ interaction: UIDropInteraction, performDrop session: UIDropSession) {
    guard let root = uploadRoot, connection.control,
      let provider = session.items.first?.itemProvider
    else { return }
    let suggestedName = provider.suggestedName
    provider.loadFileRepresentation(forTypeIdentifier: UTType.data.identifier) {
      [weak self] url, error in
      guard let url, let self else { return }
      let temp = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
      do {
        let size = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
        guard size <= 100 * 1024 * 1024 else {
          throw DesktopFailure(message: "Files must be under 100 MiB.", terminal: false)
        }
        try FileManager.default.copyItem(at: url, to: temp)
        Task { @MainActor in
          defer { try? FileManager.default.removeItem(at: temp) }
          guard self.connection.control, !self.connection.stopped else { return }
          do {
            try await self.upload(temp, name: suggestedName ?? url.lastPathComponent, root: root)
            self.status.text = "File uploaded to your shared folder."
          } catch { self.status.text = error.localizedDescription }
        }
      } catch { Task { @MainActor in self.status.text = error.localizedDescription } }
    }
  }
  private func upload(_ file: URL, name: String, root: Int) async throws {
    // Disk-backed multipart upload; never load a 100 MiB file into the JS bridge.
    let boundary = UUID().uuidString
    let tmp = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: tmp) }
    try await Task.detached(priority: .utility) {
      let safe = String(name.filter { !"\r\n\"\\/".contains($0) }.prefix(240))
      FileManager.default.createFile(
        atPath: tmp.path,
        contents: Data(
          "--\(boundary)\r\nContent-Disposition: form-data; name=\"file\"; filename=\"\(safe)\"\r\nContent-Type: application/octet-stream\r\n\r\n"
            .utf8))
      let out = try FileHandle(forWritingTo: tmp)
      defer { try? out.close() }
      try out.seekToEnd()
      let source = try FileHandle(forReadingFrom: file)
      defer { try? source.close() }
      while let block = try source.read(upToCount: 65536), !block.isEmpty {
        try out.write(contentsOf: block)
      }
      try out.write(contentsOf: Data("\r\n--\(boundary)--\r\n".utf8))
    }.value
    guard connection.control, !connection.stopped else {
      throw DesktopFailure(message: "Desktop control ended before upload.", terminal: true)
    }
    var components = URLComponents(
      url: http.origin.appendingPathComponent("api/files/upload"), resolvingAgainstBaseURL: false)!
    components.queryItems = [
      URLQueryItem(name: "root", value: String(root)), URLQueryItem(name: "path", value: ""),
    ]
    var request = URLRequest(url: components.url!)
    request.httpMethod = "POST"
    request.setValue("Bearer \(http.token)", forHTTPHeaderField: "Authorization")
    request.setValue(
      "multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
    let (data, response) = try await http.session.upload(for: request, fromFile: tmp)
    guard (200..<300).contains((response as? HTTPURLResponse)?.statusCode ?? 0) else {
      let value = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
      throw DesktopFailure(message: value?["error"] as? String ?? "Upload failed", terminal: false)
    }
  }
}
