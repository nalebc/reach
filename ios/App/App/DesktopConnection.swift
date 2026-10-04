import Foundation
import Network
import UIKit

struct DesktopFailure: LocalizedError {
  let message: String
  let terminal: Bool
  var errorDescription: String? { message }
}
/// Credentials never enter URLs; no redirects or insecure transport fallback.
final class DesktopHTTP: NSObject, URLSessionTaskDelegate {
  let origin: URL, token: String
  lazy var session: URLSession = {
    let config = URLSessionConfiguration.ephemeral
    config.timeoutIntervalForRequest = 8
    config.timeoutIntervalForResource = 20
    config.httpMaximumConnectionsPerHost = 6
    config.urlCache = nil
    config.httpCookieStorage = nil
    return URLSession(configuration: config, delegate: self, delegateQueue: nil)
  }()
  init(origin: URL, token: String) {
    self.origin = origin
    self.token = token
  }
  func urlSession(
    _ session: URLSession, task: URLSessionTask,
    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
    completionHandler: @escaping (URLRequest?) -> Void
  ) { completionHandler(nil) }
  func request(_ path: String, _ body: [String: Any]? = nil, method: String? = nil) async throws
    -> [String: Any]
  {
    var r = URLRequest(url: origin.appendingPathComponent(path))
    r.httpMethod = method ?? (body == nil ? "GET" : "POST")
    r.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    if let body {
      r.httpBody = try JSONSerialization.data(withJSONObject: body)
      r.setValue("application/json", forHTTPHeaderField: "Content-Type")
    }
    let (data, response) = try await session.data(for: r)
    let status = (response as? HTTPURLResponse)?.statusCode ?? 0
    let value = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
    guard (200..<300).contains(status) else {
      throw DesktopFailure(
        message: value["error"] as? String ?? "Private connection failed (\(status)).",
        terminal: [400, 401, 403, 404].contains(status))
    }
    return value
  }
  func socket(_ path: String) -> URLSessionWebSocketTask {
    var c = URLComponents(url: origin.appendingPathComponent(path), resolvingAgainstBaseURL: false)!
    c.scheme = "wss"
    let task = session.webSocketTask(with: c.url!)
    task.maximumMessageSize = 8 * 1024 * 1024
    task.resume()
    return task
  }
}
@MainActor final class DesktopConnection {
  let http: DesktopHTTP, video: DesktopVideo
  var sessionID = "", display = "primary", control = false, connected = false, stopped = false
  var onStatus: ((String) -> Void)?, onEnd: ((String) -> Void)?, onControl: ((Bool) -> Void)?
  private var stream: URLSessionWebSocketTask?, input: URLSessionWebSocketTask?
  private var monitor = NWPathMonitor(), generation = 0, sequence = 0
  private var pending = [Int: Date](), actions = [[String: Any]](), sending = false
  private var heartbeat: Timer?, reconnect: Task<Void, Never>?, lastFrame = Date(),
    clipboardBusy = false
  private var qualityBusy = false
  private var clipboardRevision = -1, localClipboardRevision = -1
  var clipboard = false
  var route = "Unknown", metrics = "Connecting…"
  init(http: DesktopHTTP, video: DesktopVideo) {
    self.http = http
    self.video = video
  }
  func start(mode: String, clipboard: Bool, width: Int, height: Int) async throws {
    self.clipboard = clipboard
    let data = try await http.request(
      "api/screen/desktop",
      ["mode": mode, "clipboard": clipboard, "width": width, "height": height])
    guard let id = data["id"] as? String else {
      throw DesktopFailure(message: "Invalid desktop response.", terminal: true)
    }
    sessionID = id
    if stopped {
      _ = try? await http.request("api/screen/desktop/\(id)", method: "DELETE")
      return
    }
    display = data["display"] as? String ?? "primary"
    // Viewing starts independently. Control is only enabled by the toolbar button.
    monitor.pathUpdateHandler = { [weak self] path in
      Task { @MainActor in
        guard let self, self.connected else { return }
        if path.status == .satisfied { self.recover() } else { self.lost("Waiting for Tailscale…") }
      }
    }
    monitor.start(queue: DispatchQueue(label: "reach.desktop.path"))
    await connect()
    heartbeat = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
      Task { @MainActor in await self?.tick() }
    }
  }
  private func send(_ socket: URLSessionWebSocketTask?, _ value: [String: Any]) async throws {
    guard let socket else { throw DesktopFailure(message: "Disconnected", terminal: false) }
    let data = try JSONSerialization.data(withJSONObject: value)
    try await socket.send(.string(String(decoding: data, as: UTF8.self)))
  }
  private func connect() async {
    guard !stopped else { return }
    generation += 1
    let epoch = generation
    video.reset()
    stream?.cancel(with: .goingAway, reason: nil)
    input?.cancel(with: .goingAway, reason: nil)
    input = nil
    pending.removeAll()
    actions.removeAll()
    connected = false
    control = false
    onControl?(false)
    let socket = http.socket("ws/screen")
    stream = socket
    lastFrame = Date()
    do {
      try await send(
        socket, ["type": "auth", "token": http.token, "protocol": 2, "desktopSession": sessionID])
    } catch {
      if epoch == generation { lost("Reconnecting…") }
      return
    }
    guard epoch == generation, !stopped else { return }
    Task { [weak self] in
      guard let self else { return }
      do {
        while !self.stopped && epoch == self.generation {
          let message = try await socket.receive()
          guard epoch == self.generation else { return }
          switch message {
          case .data(let packet):
            self.lastFrame = Date()
            self.connected = true
            let result: (UInt32, Bool) = await withCheckedContinuation { continuation in
              self.video.submit(packet) { continuation.resume(returning: ($0, $1)) }
            }
            guard result.0 > 0 else {
              throw DesktopFailure(message: "Invalid video frame.", terminal: true)
            }
            try await self.send(socket, ["type": "ack", "id": result.0, "keyframe": result.1])
          case .string(let text):
            let value =
              (try? JSONSerialization.jsonObject(with: Data(text.utf8))) as? [String: Any] ?? [:]
            if value["type"] as? String == "error" {
              throw DesktopFailure(
                message: value["error"] as? String ?? "Desktop ended.",
                terminal: value["retryable"] as? Bool != true)
            }
            if value["type"] as? String == "quality" {
              let fps = value["fps"] as? Int ?? 0
              let latency = value["ackLatency"] as? Int ?? 0
              let bitrate = value["bitrate"] as? Double ?? 0
              self.metrics = String(
                format: "%d fps · %.1f Mbps · %d ms ACK", fps, bitrate / 1_000_000, latency)
              self.onStatus?("\(self.route) · \(self.metrics)")
            }
          @unknown default: break
          }
        }
      } catch {
        guard epoch == self.generation, !self.stopped else { return }
        self.failed(error, socket: socket)
      }
    }
  }
  func enableControl() async {
    guard connected, !stopped, input == nil else { return }
    let epoch = generation
    do {
      _ = try await http.request("api/screen/control", ["enabled": true])
      guard connected, !stopped, epoch == generation, input == nil else { return }
      let socket = http.socket("ws/screen-input")
      input = socket
      try await send(socket, ["type": "auth", "token": http.token, "desktopSession": sessionID])
      guard epoch == generation, input === socket, !stopped else { return }
      Task { [weak self] in
        guard let self else { return }
        do {
          while !self.stopped && epoch == self.generation && self.input === socket {
            let message = try await socket.receive()
            guard self.input === socket else { return }
            guard case .string(let text) = message,
              let value = (try? JSONSerialization.jsonObject(with: Data(text.utf8)))
                as? [String: Any]
            else { continue }
            if value["type"] as? String == "error" {
              throw DesktopFailure(
                message: value["error"] as? String ?? "Control ended.", terminal: true)
            }
            if value["type"] as? String == "ready" {
              self.control = true
              self.onControl?(true)
            }
            if let id = value["id"] as? Int {
              self.pending.removeValue(forKey: id)
              self.drain()
            }
          }
        } catch {
          guard epoch == self.generation, self.input === socket else { return }
          self.disableControl()
          self.onStatus?("Control stopped. Tap Control to enable again.")
        }
      }
    } catch { onStatus?(error.localizedDescription) }
  }
  func disableControl() {
    control = false
    onControl?(false)
    actions.removeAll()
    pending.removeAll()
    input?.cancel(with: .normalClosure, reason: nil)
    input = nil
    Task { _ = try? await http.request("api/screen/control", ["enabled": false]) }
  }
  func action(_ action: [String: Any]) {
    guard control, connected, !stopped else { return }
    // Bound unsent work; never replay input after reconnect or silently lose key-up.
    if actions.count >= 24 {
      disableControl()
      onStatus?("Input fell behind. Enable control again.")
      return
    }
    if action["type"] as? String == "mouseMove", action["relative"] as? Bool == true,
      let last = actions.last, last["type"] as? String == "mouseMove",
      last["relative"] as? Bool == true
    {
      var merged = last
      let dx = (last["dx"] as? Double ?? 0) + (action["dx"] as? Double ?? 0)
      let dy = (last["dy"] as? Double ?? 0) + (action["dy"] as? Double ?? 0)
      if abs(dx) <= 2048 && abs(dy) <= 2048 {
        merged["dx"] = dx
        merged["dy"] = dy
        actions[actions.count - 1] = merged
        return
      }
    }
    actions.append(action)
    drain()
  }
  private func drain() {
    guard control, let socket = input, !sending else { return }
    sending = true
    Task {
      defer {
        sending = false
        if control && !actions.isEmpty && pending.count < 4 { drain() }
      }
      while control, input === socket, pending.count < 4, !actions.isEmpty {
        let action = actions.removeFirst()
        sequence += 1
        let id = sequence
        pending[id] = Date()
        do { try await send(socket, ["type": "input", "id": id, "action": action]) } catch {
          if input === socket { disableControl() }
          return
        }
      }
    }
  }
  private func tick() async {
    guard !stopped else { return }
    if reconnect == nil && Date().timeIntervalSince(lastFrame) > 2.5 { lost("Reconnecting…") }
    if control {
      if pending.values.contains(where: { Date().timeIntervalSince($0) > 1.5 }) {
        disableControl()
      } else {
        action(["type": "heartbeat"])
      }
    }
    // Diagnostics and clipboard never delay the lease heartbeat or recovery watchdog.
    if !qualityBusy {
      qualityBusy = true
      Task {
        defer { qualityBusy = false }
        if let info = try? await http.request("api/screen/desktop/\(sessionID)/quality") {
          route = info["route"] as? String ?? "Unknown"
        }
      }
    }
    if clipboard && control && !clipboardBusy { Task { await syncClipboard() } }
  }
  private func failed(_ error: Error, socket: URLSessionWebSocketTask) {
    if (error as? DesktopFailure)?.terminal == true
      || [4001, 4003].contains(socket.closeCode.rawValue)
    {
      finish(error.localizedDescription)
    } else {
      lost("Reconnecting…")
    }
  }
  private func lost(_ text: String) {
    guard !stopped, reconnect == nil else { return }
    connected = false
    control = false
    onControl?(false)
    onStatus?(text)
    // No automatic re-grant of control after a network outage. Release locally first.
    generation += 1
    input?.cancel(with: .goingAway, reason: nil)
    input = nil
    stream?.cancel(with: .goingAway, reason: nil)
    video.reset()
    pending.removeAll()
    actions.removeAll()
    reconnect = Task {
      try? await Task.sleep(nanoseconds: 500_000_000)
      guard !Task.isCancelled else { return }
      self.reconnect = nil
      await self.connect()
    }
  }
  func recover() { lost("Reconnecting…") }
  func finish(_ reason: String? = nil) {
    guard !stopped else { return }
    stopped = true
    generation += 1
    heartbeat?.invalidate()
    monitor.cancel()
    reconnect?.cancel()
    input?.cancel(with: .normalClosure, reason: nil)
    stream?.cancel(with: .normalClosure, reason: nil)
    video.reset()
    Task {
      let tasks = await http.session.allTasks
      for task in tasks { task.cancel() }
      if !sessionID.isEmpty {
        _ = try? await http.request("api/screen/desktop/\(sessionID)", method: "DELETE")
      }
      http.session.invalidateAndCancel()
    }
    onEnd?(reason ?? "")
  }
  private func syncClipboard() async {
    guard !clipboardBusy else { return }
    clipboardBusy = true
    defer { clipboardBusy = false }
    let board = UIPasteboard.general
    // Explicit session opt-in; iPadOS may also prompt for cross-app paste access.
    do {
      if localClipboardRevision < 0 { localClipboardRevision = board.changeCount }
      if board.changeCount != localClipboardRevision {
        var body: [String: Any] = ["session": sessionID, "operation": "write"]
        if let image = board.image, let data = image.pngData(), data.count <= 2 * 1024 * 1024 {
          body["data"] = data.base64EncodedString()
        } else if let text = board.string, text.utf8.count <= 16384 {
          body["text"] = text
        } else {
          localClipboardRevision = board.changeCount
          return
        }
        let sentRevision = board.changeCount
        let result = try await http.request("api/screen/desktop/clipboard", body)
        clipboardRevision = result["revision"] as? Int ?? -1
        localClipboardRevision = sentRevision
      } else {
        let localBefore = board.changeCount
        let result = try await http.request(
          "api/screen/desktop/clipboard",
          ["session": sessionID, "operation": "read", "revision": clipboardRevision])
        guard control, !stopped, board.changeCount == localBefore else { return }
        clipboardRevision = result["revision"] as? Int ?? clipboardRevision
        if let text = result["text"] as? String {
          board.string = text
        } else if let base64 = result["data"] as? String, let data = Data(base64Encoded: base64),
          let image = UIImage(data: data)
        {
          board.image = image
        }
        localClipboardRevision = board.changeCount
      }
    } catch { onStatus?("Clipboard sync paused: \(error.localizedDescription)") }
  }
}
