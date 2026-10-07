import Foundation
import Darwin

@_silgen_name("sandbox_init")
func installSandbox(_ profile: UnsafePointer<CChar>, _ flags: UInt64, _ error: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>?) -> Int32
func confine(_ input: [String: Any]) throws {
    guard let profile = input["sandbox"] as? String, !profile.isEmpty, profile.utf8.count < 49152 else { try deny("The file sandbox is unavailable.") }
    var error: UnsafeMutablePointer<CChar>?
    let result = profile.withCString { installSandbox($0, 0, &error) }
    guard result == 0 else { try deny("The file sandbox could not be installed. Nothing was changed.") }
}

struct BoundaryError: Error { let message: String; let status: Int }
func deny(_ text: String = "This path is not available inside the shared folder.", status: Int = 403) throws -> Never { throw BoundaryError(message: text, status: status) }
final class Descriptor {
    let value: Int32
    init(_ value: Int32) throws { if value < 0 { try deny() }; self.value = value }
    deinit { Darwin.close(value) }
}
func info(_ fd: Int32) throws -> stat {
    var value = stat()
    guard fstat(fd, &value) == 0 else { try deny() }
    return value
}
func isDirectory(_ s: stat) -> Bool { (s.st_mode & S_IFMT) == S_IFDIR }
func isRegular(_ s: stat) -> Bool { (s.st_mode & S_IFMT) == S_IFREG && s.st_nlink == 1 }
func components(_ value: String, absolute: Bool = false) throws -> [String] {
    guard value.utf8.count <= 4096, !value.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 }), !value.contains("\\"), absolute == value.hasPrefix("/") else { try deny() }
    let parts = value.split(separator: "/").map(String.init)
    guard !parts.contains("..") else { try deny() }
    return parts.filter { $0 != "." }
}
func pathOf(_ fd: Int32) throws -> String {
    var bytes = [CChar](repeating: 0, count: Int(MAXPATHLEN))
    guard fcntl(fd, F_GETPATH, &bytes) == 0 else { try deny() }
    return String(cString: bytes)
}
func metadata(_ s: stat) -> [String: Any] {
    ["type": isDirectory(s) ? "directory" : "file", "size": Int64(s.st_size), "modified": Double(s.st_mtimespec.tv_sec) * 1000 + Double(s.st_mtimespec.tv_nsec) / 1e6]
}
final class Boundary {
    let rootPath: String
    let root: Descriptor
    let privatePaths: [String]
    let privateNames: Set<String>
    let maxBytes: Int
    init(_ input: [String: Any]) throws {
        guard let supplied = input["root"] as? String, supplied != "/", let dev = input["rootDev"] as? String, let ino = input["rootIno"] as? String else { try deny() }
        let parts = try components(supplied, absolute: true)
        rootPath = "/" + parts.joined(separator: "/")
        privatePaths = (input["privatePaths"] as? [String] ?? []).map { $0.precomposedStringWithCompatibilityMapping.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: "/")) }
        privateNames = Set([".reach", ".ssh", ".aws", ".codex"] + (input["privateNames"] as? [String] ?? []))
        maxBytes = min(max((input["maxBytes"] as? Int) ?? 1048576, 1), 25 * 1024 * 1024)
        var current = try Descriptor(Darwin.open("/", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC))
        for part in parts { current = try Descriptor(openat(current.value, part, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)) }
        root = current
        let s = try info(root.value)
        guard String(s.st_dev) == dev, String(s.st_ino) == ino, isDirectory(s), try pathOf(root.value) == rootPath else { try deny("The shared folder changed. Request it again.") }
        try protect(rootPath)
    }
    func protect(_ candidate: String) throws {
        let normalized = candidate.precomposedStringWithCompatibilityMapping.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        guard !normalized.split(separator: "/").contains(where: { privateNames.contains(String($0)) }), !privatePaths.contains(where: { normalized == $0 || normalized.hasPrefix($0 + "/") }) else { try deny("Reach, credentials, and private application data are not shared.") }
    }
    func verify(_ fd: Int32) throws {
        guard try pathOf(root.value) == rootPath else { try deny("The shared folder moved. Request it again.") }
        let actual = try pathOf(fd)
        guard actual == rootPath || actual.hasPrefix(rootPath + "/") else { try deny() }
        try protect(actual)
    }
    func directory(_ parts: [String]) throws -> Descriptor {
        var current = try Descriptor(dup(root.value))
        try verify(current.value)
        for part in parts {
            current = try Descriptor(openat(current.value, part, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC))
            try verify(current.value)
        }
        return current
    }
    func parent(_ value: String) throws -> (Descriptor, String, String) {
        let parts = try components(value)
        guard let leaf = parts.last else { try deny("Choose a file inside the shared folder.", status: 400) }
        let relative = parts.joined(separator: "/")
        try protect(rootPath + "/" + relative)
        return (try directory(Array(parts.dropLast())), leaf, relative)
    }
    func file(_ value: String, write: Bool = false, create: Bool = false) throws -> Descriptor {
        let (parent, leaf, _) = try parent(value)
        try verify(parent.value)
        let fd = try Descriptor(openat(parent.value, leaf, (write ? O_WRONLY : O_RDONLY) | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC | (create ? O_CREAT | O_EXCL : 0), mode_t(0o600)))
        guard isRegular(try info(fd.value)) else { try deny("Choose a regular file with no extra hard links.", status: 400) }
        try verify(fd.value)
        return fd
    }
    func read(_ value: String) throws -> (Data, stat) {
        let fd = try file(value)
        let before = try info(fd.value)
        guard before.st_size <= maxBytes else { try deny("Read a regular file no larger than the operation’s size limit.", status: 400) }
        var data = Data(), bytes = [UInt8](repeating: 0, count: 65536)
        while data.count <= maxBytes {
            let count = Darwin.read(fd.value, &bytes, min(bytes.count, maxBytes + 1 - data.count))
            if count < 0 { if errno == EINTR { continue }; try deny() }
            if count == 0 { break }
            data.append(contentsOf: bytes.prefix(count))
        }
        guard data.count <= maxBytes, isRegular(try info(fd.value)) else { try deny("The file changed or exceeds this operation’s size limit.") }
        try verify(fd.value)
        return (data, before)
    }
    func run(_ input: [String: Any]) throws -> [String: Any] {
        let relative = input["path"] as? String ?? ""
        switch input["op"] as? String ?? "" {
        case "read":
            let (data, s) = try read(relative)
            return ["data": data.base64EncodedString(), "stat": metadata(s)]
        case "stat":
            let parts = try components(relative)
            let fd: Descriptor
            if parts.isEmpty { fd = try directory([]) }
            else {
                let (parent, leaf, _) = try parent(relative)
                fd = try Descriptor(openat(parent.value, leaf, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC))
                let s = try info(fd.value)
                guard isDirectory(s) || isRegular(s) else { try deny() }
                try verify(fd.value)
            }
            return ["stat": metadata(try info(fd.value))]
        case "list":
            let parts = try components(relative), fd = try directory(parts)
            let copy = dup(fd.value)
            guard copy >= 0, let stream = fdopendir(copy) else { if copy >= 0 { close(copy) }; try deny() }
            defer { closedir(stream) }
            let maximum = min(max((input["maxEntries"] as? Int) ?? 2000, 1), 2000)
            var entries = [[String: Any]](), inspected = 0, truncated = false
            while let entry = readdir(stream) {
                let name = withUnsafePointer(to: &entry.pointee.d_name) { pointer in pointer.withMemoryRebound(to: CChar.self, capacity: Int(entry.pointee.d_namlen) + 1) { String(cString: $0) } }
                if name == "." || name == ".." { continue }
                inspected += 1
                if inspected > maximum { truncated = true; break }
                let child = (parts + [name]).joined(separator: "/")
                do {
                    try protect(rootPath + "/" + child)
                    let opened = try Descriptor(openat(fd.value, name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC))
                    let s = try info(opened.value)
                    guard isDirectory(s) || isRegular(s) else { continue }
                    try verify(opened.value)
                    var record = metadata(s); record["name"] = name; record["path"] = child; entries.append(record)
                } catch { continue }
            }
            try verify(fd.value)
            return ["items": entries, "truncated": truncated]
        case "mkdir":
            let (parent, leaf, _) = try parent(relative)
            try verify(parent.value)
            guard mkdirat(parent.value, leaf, mode_t(0o700)) == 0 else { try deny("The folder could not be created. Its name may already exist.", status: errno == EEXIST ? 409 : 403) }
        case "touch":
            let fd: Descriptor
            do { fd = try file(relative, write: true) }
            catch { fd = try file(relative, write: true, create: true) }
            guard (try info(fd.value)).st_size <= 1048576 else { try deny("Choose a file no larger than 1 MiB.") }
            try verify(fd.value)
            guard futimes(fd.value, nil) == 0, fsync(fd.value) == 0 else { try deny() }
        case "rm":
            let fd = try file(relative)
            guard (try info(fd.value)).st_size <= 1048576 else { try deny("Choose a file no larger than 1 MiB.") }
            let (parent, leaf, _) = try parent(relative)
            try verify(fd.value); try verify(parent.value)
            var current = stat(); let opened = try info(fd.value)
            guard fstatat(parent.value, leaf, &current, AT_SYMLINK_NOFOLLOW) == 0, current.st_dev == opened.st_dev, current.st_ino == opened.st_ino, isRegular(current), unlinkat(parent.value, leaf, 0) == 0 else { try deny("The file changed. Request it again.") }
        case "cp":
            guard let to = input["to"] as? String else { try deny() }
            let (data, _) = try read(relative), destination = try file(to, write: true, create: true)
            try verify(destination.value)
            try data.withUnsafeBytes { bytes in
                var offset = 0
                while offset < data.count {
                    let count = Darwin.write(destination.value, bytes.baseAddress!.advanced(by: offset), data.count - offset)
                    if count < 0 { if errno == EINTR { continue }; try deny() }; guard count > 0 else { try deny() }; offset += count
                }
            }
            guard fsync(destination.value) == 0 else { try deny() }
        case "write":
            // Whole-file content from the agent (base64, at most 1 MiB), to a new or existing regular file inside the root.
            guard let encoded = input["data"] as? String, let data = Data(base64Encoded: encoded), data.count <= 1048576 else { try deny("Write up to 1 MiB of content.", status: 413) }
            // An existing regular file is replaced; a new one is created. Never through a link.
            let destination: Descriptor
            do { destination = try file(relative, write: true) }
            catch { destination = try file(relative, write: true, create: true) }
            try verify(destination.value)
            guard ftruncate(destination.value, 0) == 0 else { try deny() }
            try data.withUnsafeBytes { bytes in
                var offset = 0
                while offset < data.count {
                    let count = Darwin.write(destination.value, bytes.baseAddress!.advanced(by: offset), data.count - offset)
                    if count < 0 { if errno == EINTR { continue }; try deny() }; guard count > 0 else { try deny() }; offset += count
                }
            }
            guard fsync(destination.value) == 0 else { try deny() }
        default: try deny("Unsupported file operation.")
        }
        return ["ok": true]
    }
}
@main struct BrowserFiles {
    static func main() {
        do {
            let maximum = 2 * 1048576
            var data = Data()
            while data.count <= maximum {
                let chunk = FileHandle.standardInput.readData(ofLength: min(65536, maximum + 1 - data.count))
                if chunk.isEmpty { break }
                data.append(chunk)
            }
            guard data.count <= maximum, let input = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { try deny() }
            let boundary = try Boundary(input)
            try confine(input)
            let result = try boundary.run(input)
            FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: result))
        } catch {
            let message = (error as? BoundaryError)?.message ?? "The protected file operation could not be completed."
            FileHandle.standardOutput.write((try? JSONSerialization.data(withJSONObject: ["error": message, "status": (error as? BoundaryError)?.status ?? 403])) ?? Data())
            exit(1)
        }
    }
}
