import Foundation
import Darwin
import CryptoKit

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
func sameFile(_ a: stat, _ b: stat) -> Bool { a.st_dev == b.st_dev && a.st_ino == b.st_ino }
func sameVersion(_ a: stat, _ b: stat) -> Bool {
    sameFile(a, b) && a.st_size == b.st_size && a.st_mtimespec.tv_sec == b.st_mtimespec.tv_sec && a.st_mtimespec.tv_nsec == b.st_mtimespec.tv_nsec && a.st_ctimespec.tv_sec == b.st_ctimespec.tv_sec && a.st_ctimespec.tv_nsec == b.st_ctimespec.tv_nsec
}
func digest(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }
struct ReviewedFile { let descriptor: Descriptor; let metadata: stat; let hash: String }
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
    func reviewedFile(_ parent: Descriptor, _ leaf: String) throws -> ReviewedFile? {
        try verify(parent.value)
        var entry = stat()
        if fstatat(parent.value, leaf, &entry, AT_SYMLINK_NOFOLLOW) != 0 {
            if errno == ENOENT { return nil }
            try deny()
        }
        guard isRegular(entry) else { try deny("Only regular files with no extra hard links can be applied.") }
        let fd = try Descriptor(openat(parent.value, leaf, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC))
        let before = try info(fd.value)
        guard isRegular(before), sameFile(entry, before) else { try deny("The original file changed. Review the changes again.", status: 409) }
        guard before.st_size >= 0, before.st_size <= maxBytes else { try deny("Review files no larger than 1 MiB.", status: 413) }
        try verify(fd.value)
        var data = Data(), bytes = [UInt8](repeating: 0, count: 65536)
        while data.count <= maxBytes {
            let count = Darwin.read(fd.value, &bytes, min(bytes.count, maxBytes + 1 - data.count))
            if count < 0 { if errno == EINTR { continue }; try deny() }
            if count == 0 { break }
            data.append(contentsOf: bytes.prefix(count))
        }
        let after = try info(fd.value)
        guard data.count <= maxBytes, isRegular(after), sameVersion(before, after), Int64(data.count) == after.st_size else { try deny("The original file changed. Review the changes again.", status: 409) }
        try verify(fd.value); try verify(parent.value)
        guard fstatat(parent.value, leaf, &entry, AT_SYMLINK_NOFOLLOW) == 0, isRegular(entry), sameVersion(after, entry) else { try deny("The original file changed. Review the changes again.", status: 409) }
        return ReviewedFile(descriptor: fd, metadata: after, hash: digest(data))
    }
    func reviewRequirements(_ input: [String: Any], _ relative: String) throws -> (String?, [String], Set<String>) {
        guard maxBytes <= 1048576, let supplied = input["expectedHash"], supplied is NSNull || (supplied as? String)?.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil else { try deny("This file needs its exact reviewed hash.", status: 400) }
        let parts = try components(relative)
        guard !parts.isEmpty, parts.joined(separator: "/") == relative else { try deny("Choose an exact relative file path.", status: 400) }
        guard input["requiredParents"] == nil || input["requiredParents"] is [String] else { try deny("Choose the original parent folders.", status: 400) }
        let parents = input["requiredParents"] as? [String] ?? []
        guard parents.count <= 32, Set(parents).count == parents.count else { try deny("Choose the original parent folders.", status: 400) }
        for parent in parents {
            let ancestor = try components(parent)
            guard !ancestor.isEmpty, ancestor.joined(separator: "/") == parent, relative.hasPrefix(parent + "/") else { try deny("Choose only original ancestors of this file.", status: 400) }
        }
        return (supplied as? String, parts, Set(parents))
    }
    // Return nil only for genuinely absent NEW parents. A blocked, moved,
    // symbolic-link or missing original directory is always a conflict.
    func reviewParent(_ parts: [String], required: Set<String>) throws -> Descriptor? {
        try protect(rootPath + "/" + parts.joined(separator: "/"))
        var current = try Descriptor(dup(root.value))
        try verify(current.value)
        for index in 0..<(parts.count - 1) {
            let prefix = parts.prefix(index + 1).joined(separator: "/")
            try verify(current.value)
            var entry = stat()
            if fstatat(current.value, parts[index], &entry, AT_SYMLINK_NOFOLLOW) != 0 {
                if errno != ENOENT { try deny("A destination folder is blocked or unavailable.") }
                if required.contains(where: { $0 == prefix || $0.hasPrefix(prefix + "/") }) { try deny("An original parent folder was removed. Restore it before applying.", status: 409) }
                try verify(current.value)
                return nil
            }
            guard isDirectory(entry) else { try deny("A destination parent is no longer a regular folder.", status: 409) }
            let opened = try Descriptor(openat(current.value, parts[index], O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC))
            guard sameFile(entry, try info(opened.value)) else { try deny("A destination folder changed. Review it again.", status: 409) }
            try verify(opened.value)
            current = opened
        }
        return current
    }
    func checkReviewed(_ input: [String: Any], relative: String) throws -> [String: Any] {
        guard input["data"] == nil else { try deny("A reviewed check cannot include file data.", status: 400) }
        let (expected, parts, required) = try reviewRequirements(input, relative)
        do {
            guard let parent = try reviewParent(parts, required: required) else {
                return expected == nil ? ["matches": true] : ["matches": false, "reason": "The original file or its parent folder was removed."]
            }
            let current = try reviewedFile(parent, parts.last!)
            return current?.hash == expected ? ["matches": true] : ["matches": false, "reason": "The original file changed since this working copy was created."]
        } catch let error as BoundaryError {
            if [403, 409, 413].contains(error.status) { return ["matches": false, "reason": error.message] }
            throw error
        }
    }
    func reviewed(_ input: [String: Any], relative: String, deleting: Bool) throws -> [String: Any] {
        let (expected, parts, required) = try reviewRequirements(input, relative)
        let data: Data
        if deleting {
            guard input["data"] == nil else { try deny("A deletion cannot include file data.", status: 400) }
            data = Data()
        } else {
            guard let encoded = input["data"] as? String, encoded.utf8.count <= ((maxBytes + 2) / 3) * 4, let decoded = Data(base64Encoded: encoded), decoded.count <= maxBytes, decoded.base64EncodedString() == encoded else { try deny("The reviewed file data is invalid or too large.", status: 400) }
            data = decoded
        }
        guard let parent = try reviewParent(parts, required: required) else { try deny("The destination folder is missing. Review it again.", status: 409) }
        let leaf = parts.last!
        let original = try reviewedFile(parent, leaf)
        guard original?.hash == expected else { try deny("The original file changed. Review the changes again.", status: 409) }
        if deleting && original == nil { return ["ok": true, "hash": NSNull()] }

        // The owner may still edit files independently. macOS has no atomic
        // hash-and-replace primitive: recheck immediately before the syscall,
        // while directory descriptors and the kernel sandbox retain confinement.
        func recheck() throws {
            guard let currentParent = try reviewParent(parts, required: required), sameFile(try info(parent.value), try info(currentParent.value)) else { try deny("The destination folder changed. Review it again.", status: 409) }
            let current = try reviewedFile(parent, leaf)
            guard current?.hash == expected else { try deny("The original file changed. Review the changes again.", status: 409) }
            if let first = original, let now = current {
                guard sameVersion(first.metadata, now.metadata) else { try deny("The original file changed. Review the changes again.", status: 409) }
            } else if original != nil || current != nil { try deny("The original file changed. Review the changes again.", status: 409) }
            try verify(parent.value)
        }
        if deleting {
            try recheck()
            guard unlinkat(parent.value, leaf, 0) == 0 else { try deny("The original file changed. Review the changes again.", status: 409) }
            return ["ok": true, "hash": NSNull()]
        }
        let temporary = ".reach-review-" + UUID().uuidString
        let staging = try Descriptor(openat(parent.value, temporary, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, mode_t(0o600)))
        let staged = try info(staging.value)
        defer {
            var leftover = stat()
            if fstatat(parent.value, temporary, &leftover, AT_SYMLINK_NOFOLLOW) == 0, sameFile(staged, leftover) { _ = unlinkat(parent.value, temporary, 0) }
        }
        guard isRegular(staged) else { try deny() }
        try verify(staging.value)
        try data.withUnsafeBytes { bytes in
            var offset = 0
            while offset < data.count {
                let count = Darwin.write(staging.value, bytes.baseAddress!.advanced(by: offset), data.count - offset)
                if count < 0 { if errno == EINTR { continue }; try deny() }
                guard count > 0 else { try deny() }
                offset += count
            }
        }
        guard fsync(staging.value) == 0 else { try deny() }
        try verify(staging.value)
        guard let checkedStage = try reviewedFile(parent, temporary), sameFile(staged, checkedStage.metadata), checkedStage.hash == digest(data) else { try deny("The staged file changed. Nothing was applied.", status: 409) }
        try recheck()
        var namedStage = stat()
        guard fstatat(parent.value, temporary, &namedStage, AT_SYMLINK_NOFOLLOW) == 0, isRegular(namedStage), sameFile(staged, namedStage) else { try deny("The staged file changed. Nothing was applied.", status: 409) }
        let result = expected == nil ? renameatx_np(parent.value, temporary, parent.value, leaf, UInt32(RENAME_EXCL)) : renameat(parent.value, temporary, parent.value, leaf)
        guard result == 0 else { try deny("The original file changed or could not be replaced. Review it again.", status: 409) }
        try verify(staging.value)
        return ["ok": true, "hash": digest(data), "stat": metadata(try info(staging.value))]
    }
    func run(_ input: [String: Any]) throws -> [String: Any] {
        let relative = input["path"] as? String ?? ""
        switch input["op"] as? String ?? "" {
        case "check-reviewed": return try checkReviewed(input, relative: relative)
        case "write-reviewed": return try reviewed(input, relative: relative, deleting: false)
        case "delete-reviewed": return try reviewed(input, relative: relative, deleting: true)
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
        default: try deny("Unsupported file operation.")
        }
        return ["ok": true]
    }
}
@main struct BrowserFiles {
    static func main() {
        do {
            let maximum = ((1048576 + 2) / 3) * 4 + 65536
            var data = Data()
            while data.count <= maximum {
                let chunk = FileHandle.standardInput.readData(ofLength: min(65536, maximum + 1 - data.count))
                if chunk.isEmpty { break }
                data.append(chunk)
            }
            guard data.count <= maximum, let input = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { try deny() }
            guard ["check-reviewed", "write-reviewed", "delete-reviewed"].contains(input["op"] as? String ?? "") || data.count <= 65536 else { try deny() }
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
