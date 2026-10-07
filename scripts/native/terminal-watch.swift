import AppKit
import Darwin

// Tells Reach when the Mac's Terminal or iTerm2 windows change, so the phone
// is told instead of asking. No Accessibility or Automation is needed:
//   - a new tab or window is the app forking a process for it ("opened");
//   - a closed one is that process exiting ("closed");
//   - output is a write to the tab's tty ("output", at most every 50 ms each);
//   - the apps starting or quitting ("app").
// Reach sends {"ttys":[…]} with the ttys of the tabs it lists ("watching"
// confirms); a tty no longer listed is let go at once, so a closed tab's tty
// is never held open.
let bundles: Set<String> = ["com.apple.Terminal", "com.googlecode.iterm2"]

final class Watch {
  let queue = DispatchQueue(label: "reach.terminal-watch")
  var apps: [pid_t: DispatchSourceProcess] = [:]
  var children: [pid_t: DispatchSourceProcess] = [:]
  var ttys: [String: DispatchSourceFileSystemObject] = [:]
  var lastOutput: [String: TimeInterval] = [:]
  var pendingOutput: Set<String> = []

  func emit(_ object: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: object) else { return }
    FileHandle.standardOutput.write(data + Data("\n".utf8))
  }

  func watchApp(_ pid: pid_t) {
    guard apps[pid] == nil, pid > 0 else { return }
    let source = DispatchSource.makeProcessSource(
      identifier: pid, eventMask: [.fork, .exit], queue: queue)
    source.setEventHandler { [weak self, weak source] in
      guard let self, let source else { return }
      if source.data.contains(.exit) {
        source.cancel()
        self.apps[pid] = nil
        self.emit(["type": "app"])
        return
      }
      if source.data.contains(.fork) {
        self.adoptChildren(of: pid)
        self.emit(["type": "opened"])
      }
    }
    apps[pid] = source
    source.resume()
    adoptChildren(of: pid)
  }

  // Each tab's process (login, or iTerm2's session server) is a direct child.
  func adoptChildren(of pid: pid_t) {
    var buffer = [pid_t](repeating: 0, count: 2048)
    let bytes = buffer.withUnsafeMutableBytes {
      proc_listpids(UInt32(PROC_PPID_ONLY), UInt32(pid), $0.baseAddress, Int32($0.count))
    }
    guard bytes > 0 else { return }
    for child in buffer.prefix(Int(bytes) / MemoryLayout<pid_t>.size) where child > 0 {
      guard children[child] == nil else { continue }
      let source = DispatchSource.makeProcessSource(
        identifier: child, eventMask: .exit, queue: queue)
      source.setEventHandler { [weak self, weak source] in
        source?.cancel()
        self?.children[child] = nil
        self?.emit(["type": "closed"])
      }
      children[child] = source
      source.resume()
    }
  }

  func setTtys(_ wanted: [String]) {
    let valid = Set(wanted.filter { $0.range(of: #"^/dev/ttys[0-9]{1,4}$"#, options: .regularExpression) != nil })
    for (tty, source) in ttys where !valid.contains(tty) {
      source.cancel()
      ttys[tty] = nil
      lastOutput[tty] = nil
      pendingOutput.remove(tty)
    }
    for tty in valid where ttys[tty] == nil {
      let fd = open(tty, O_EVTONLY | O_NONBLOCK | O_NOCTTY)
      guard fd >= 0 else { continue }
      let source = DispatchSource.makeFileSystemObjectSource(
        fileDescriptor: fd, eventMask: [.write, .delete, .revoke], queue: queue)
      source.setEventHandler { [weak self] in self?.output(tty) }
      source.setCancelHandler { close(fd) }
      ttys[tty] = source
      source.resume()
    }
    emit(["type": "watching", "ttys": ttys.count])
  }

  // At most one event per tty every 50 ms, plus one after a burst ends.
  func output(_ tty: String) {
    let now = Date().timeIntervalSinceReferenceDate
    let wait = 0.05 - (now - (lastOutput[tty] ?? 0))
    if wait <= 0 {
      lastOutput[tty] = now
      emit(["type": "output", "tty": tty])
    } else if !pendingOutput.contains(tty) {
      pendingOutput.insert(tty)
      queue.asyncAfter(deadline: .now() + wait) { [weak self] in
        guard let self, self.pendingOutput.remove(tty) != nil, self.ttys[tty] != nil else { return }
        self.lastOutput[tty] = Date().timeIntervalSinceReferenceDate
        self.emit(["type": "output", "tty": tty])
      }
    }
  }
}

@main
struct TerminalWatch {
  static func main() {
    signal(SIGPIPE, SIG_IGN)
    let watch = Watch()
    let workspace = NSWorkspace.shared
    for app in workspace.runningApplications where bundles.contains(app.bundleIdentifier ?? "") {
      let pid = app.processIdentifier
      watch.queue.async { watch.watchApp(pid) }
    }
    // Tests: watch a process of their own as if it were a terminal app.
    if let pid = Int32(ProcessInfo.processInfo.environment["REACH_TERMINAL_WATCH_PID"] ?? "") {
      watch.queue.async { watch.watchApp(pid) }
    }
    workspace.notificationCenter.addObserver(
      forName: NSWorkspace.didLaunchApplicationNotification, object: nil, queue: nil
    ) { note in
      guard let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication,
        bundles.contains(app.bundleIdentifier ?? "")
      else { return }
      let pid = app.processIdentifier
      watch.queue.async {
        watch.watchApp(pid)
        watch.emit(["type": "app"])
      }
    }
    // Commands from Reach; it closing stdin means Reach is gone.
    Thread.detachNewThread {
      while let line = readLine() {
        guard let data = line.data(using: .utf8),
          let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let wanted = object["ttys"] as? [String]
        else { continue }
        watch.queue.async { watch.setTtys(wanted) }
      }
      exit(0)
    }
    watch.queue.async { watch.emit(["type": "ready"]) }
    RunLoop.main.run()
  }
}
