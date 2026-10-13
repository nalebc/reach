import Capacitor
import Foundation

// BEGIN BACKGROUND DOWNLOAD SAFETY
enum BackgroundDownloadSafety {
    static func downloadURL(_ address: String) -> URL? {
        guard let parts = URLComponents(string: address),
            let scheme = parts.scheme?.lowercased(), ["http", "https"].contains(scheme),
            let host = parts.host?.lowercased(), !host.isEmpty,
            parts.user == nil, parts.password == nil, parts.fragment == nil,
            scheme == "https" || ["localhost", "127.0.0.1", "[::1]", "::1"].contains(host)
        else { return nil }
        return parts.url
    }

    static func fileName(_ name: String) -> String {
        var safe = ""
        for scalar in name.unicodeScalars {
            let part = CharacterSet.controlCharacters.contains(scalar)
                || "/:\\".unicodeScalars.contains(scalar) ? "_" : String(scalar)
            if safe.utf8.count + part.utf8.count > 240 { break }
            safe += part
        }
        return safe.isEmpty || safe == "." || safe == ".." ? "download" : safe
    }

    private static func invalidDestination() -> NSError {
        NSError(
            domain: "ReachDownloads", code: 1,
            userInfo: [NSLocalizedDescriptionKey: "The download destination is not safe."])
    }

    static func store(_ source: URL, id: String, name: String, cache: URL) throws -> URL {
        // Task descriptions survive app relaunches; validate their ID too.
        guard cache.isFileURL, let uuid = UUID(uuidString: id), uuid.uuidString == id.uppercased()
        else { throw invalidDestination() }
        let files = FileManager.default
        let root = cache.resolvingSymlinksInPath().appendingPathComponent(
            "ReachDownloads", isDirectory: true)
        try files.createDirectory(at: root, withIntermediateDirectories: true)
        let rootValues = try root.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
        guard rootValues.isDirectory == true, rootValues.isSymbolicLink != true,
            root.resolvingSymlinksInPath().standardizedFileURL.path == root.standardizedFileURL.path
        else { throw invalidDestination() }

        let folder = root.appendingPathComponent(id, isDirectory: true)
        // Each transfer owns a new directory. Never reuse a symlink or delete a
        // previous result (including a directory named by a dot component).
        guard (try? files.attributesOfItem(atPath: folder.path)) == nil
        else { throw invalidDestination() }
        try files.createDirectory(at: folder, withIntermediateDirectories: false)
        let folderValues = try folder.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
        guard folderValues.isDirectory == true, folderValues.isSymbolicLink != true,
            folder.resolvingSymlinksInPath().standardizedFileURL.path == folder.standardizedFileURL.path
        else { throw invalidDestination() }

        let target = folder.appendingPathComponent(fileName(name), isDirectory: false)
        guard target.standardizedFileURL.deletingLastPathComponent().path == folder.standardizedFileURL.path
        else { throw invalidDestination() }
        // Foundation refuses an existing destination. No recursive removal or
        // overwrite is needed because the transfer ID is unique.
        try files.moveItem(at: source, to: target)
        return target
    }
}
// END BACKGROUND DOWNLOAD SAFETY

/// Downloads that keep going when Reach is in the background or closed: an iOS
/// background URLSession runs them. Finished files land in
/// Caches/ReachDownloads/<id>/ and are offered to save or share. Files that
/// finish while the app is away are remembered until the web side asks.
final class BackgroundDownloads: NSObject, URLSessionDownloadDelegate {
    static let shared = BackgroundDownloads()
    static let identifier = "com.reach.downloads"
    private static let pendingKey = "ReachFinishedDownloads"

    /// Set by AppDelegate when iOS wakes the app for finished downloads.
    var systemCompletion: (() -> Void)?
    weak var plugin: BackgroundTransferPlugin?

    private let lock = NSLock()
    private var lastProgress: [Int: Date] = [:]

    lazy var session: URLSession = {
        let config = URLSessionConfiguration.background(withIdentifier: Self.identifier)
        config.sessionSendsLaunchEvents = true
        config.isDiscretionary = false
        return URLSession(configuration: config, delegate: self, delegateQueue: nil)
    }()

    struct Info: Codable {
        let id: String
        let name: String
    }
    static func describe(_ info: Info) -> String? {
        (try? JSONEncoder().encode(info)).flatMap { String(data: $0, encoding: .utf8) }
    }
    static func info(of task: URLSessionTask) -> Info? {
        task.taskDescription
            .flatMap { $0.data(using: .utf8) }
            .flatMap { try? JSONDecoder().decode(Info.self, from: $0) }
    }

    // Finished while nobody was listening; kept across relaunches.
    func takePending() -> [[String: Any]] {
        lock.lock()
        defer { lock.unlock() }
        let files = UserDefaults.standard.array(forKey: Self.pendingKey) as? [[String: Any]] ?? []
        UserDefaults.standard.removeObject(forKey: Self.pendingKey)
        return files
    }
    private func remember(_ file: [String: Any]) {
        lock.lock()
        defer { lock.unlock() }
        var files = UserDefaults.standard.array(forKey: Self.pendingKey) as? [[String: Any]] ?? []
        files.append(file)
        UserDefaults.standard.set(files, forKey: Self.pendingKey)
    }

    func urlSession(
        _ session: URLSession, downloadTask: URLSessionDownloadTask, didWriteData _: Int64,
        totalBytesWritten: Int64, totalBytesExpectedToWrite: Int64
    ) {
        guard let info = Self.info(of: downloadTask) else { return }
        // At most four updates a second.
        let now = Date()
        lock.lock()
        let last = lastProgress[downloadTask.taskIdentifier]
        if let last, now.timeIntervalSince(last) < 0.25 {
            lock.unlock()
            return
        }
        lastProgress[downloadTask.taskIdentifier] = now
        lock.unlock()
        plugin?.notifyListeners(
            "progress",
            data: ["id": info.id, "done": totalBytesWritten, "total": totalBytesExpectedToWrite])
    }

    func urlSession(
        _ session: URLSession, downloadTask: URLSessionDownloadTask,
        didFinishDownloadingTo location: URL
    ) {
        guard let info = Self.info(of: downloadTask) else { return }
        // An error response (expired access, file gone) also "finishes".
        guard let response = downloadTask.response as? HTTPURLResponse else {
            plugin?.notifyListeners("failed", data: ["id": info.id, "error": "The download did not return an HTTP response."])
            return
        }
        if !(200..<300).contains(response.statusCode) {
            plugin?.notifyListeners("failed", data: ["id": info.id, "status": response.statusCode])
            return
        }
        do {
            // iOS deletes `location` when this returns: move it now.
            let target = try BackgroundDownloadSafety.store(
                location, id: info.id, name: info.name,
                cache: FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0])
            let file: [String: Any] = ["id": info.id, "name": info.name, "uri": target.absoluteString]
            if let plugin, plugin.hasListeners("done") {
                plugin.notifyListeners("done", data: file)
            } else {
                remember(file)
            }
        } catch {
            plugin?.notifyListeners(
                "failed", data: ["id": info.id, "error": error.localizedDescription])
        }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        lock.lock()
        lastProgress[task.taskIdentifier] = nil
        lock.unlock()
        guard let error, let info = Self.info(of: task) else { return }
        plugin?.notifyListeners(
            "failed",
            data: [
                "id": info.id, "error": error.localizedDescription,
                "canceled": (error as NSError).code == NSURLErrorCancelled,
            ])
    }

    func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
        DispatchQueue.main.async {
            self.systemCompletion?()
            self.systemCompletion = nil
        }
    }
}

@objc(BackgroundTransferPlugin)
public class BackgroundTransferPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "BackgroundTransferPlugin"
    public let jsName = "BackgroundTransfer"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "download", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cancel", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "finished", returnType: CAPPluginReturnPromise),
    ]

    override public func load() {
        BackgroundDownloads.shared.plugin = self
        // Reconnects to downloads started before the app was closed.
        _ = BackgroundDownloads.shared.session
    }

    @objc func download(_ call: CAPPluginCall) {
        guard let address = call.getString("url"), let url = BackgroundDownloadSafety.downloadURL(address),
            let name = call.getString("name"), !name.isEmpty
        else { return call.reject("Choose a file to download.") }
        var request = URLRequest(url: url)
        for (key, value) in call.getObject("headers") ?? [:] {
            if let value = value as? String { request.setValue(value, forHTTPHeaderField: key) }
        }
        let id = UUID().uuidString
        let task = BackgroundDownloads.shared.session.downloadTask(with: request)
        task.taskDescription = BackgroundDownloads.describe(.init(id: id, name: name))
        task.resume()
        call.resolve(["id": id])
    }

    @objc func cancel(_ call: CAPPluginCall) {
        let id = call.getString("id") ?? ""
        BackgroundDownloads.shared.session.getAllTasks { tasks in
            tasks.filter { BackgroundDownloads.info(of: $0)?.id == id }.forEach { $0.cancel() }
            call.resolve()
        }
    }

    @objc func finished(_ call: CAPPluginCall) {
        call.resolve(["files": BackgroundDownloads.shared.takePending()])
    }
}
