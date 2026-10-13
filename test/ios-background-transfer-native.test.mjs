import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const sourceURL = new URL(
  "../ios/App/App/BackgroundTransfer.swift",
  import.meta.url,
);

test(
  "iOS background downloads preserve cache boundaries and accept only HTTPS or HTTP loopback",
  {
    skip:
      process.platform !== "darwin" ||
      process.env.REACH_TEST_APP_NATIVE !== "1",
  },
  async (t) => {
    const dir = await fs.mkdtemp(
      path.join(os.tmpdir(), "reach-download-safety-"),
    );
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const source = await fs.readFile(sourceURL, "utf8");
    const policy = source
      .split("// BEGIN BACKGROUND DOWNLOAD SAFETY")[1]
      ?.split("// END BACKGROUND DOWNLOAD SAFETY")[0];
    assert.ok(policy, "compile the production safety helper, not a test copy");
    assert.match(
      source,
      /let url = BackgroundDownloadSafety\.downloadURL\(address\)/,
    );
    assert.match(source, /let target = try BackgroundDownloadSafety\.store\(/);
    const input = path.join(dir, "download.swift"),
      binary = path.join(dir, "download");
    await fs.writeFile(
      input,
      `import Foundation\n${policy}\n${String.raw`
func require(_ value: @autoclosure () throws -> Bool, _ message: String) throws {
    if try !value() { throw NSError(domain: "Test", code: 1, userInfo: [NSLocalizedDescriptionKey: message]) }
}
func refused(_ message: String, _ action: () throws -> Void) throws {
    do { try action() } catch { return }
    throw NSError(domain: "Test", code: 2, userInfo: [NSLocalizedDescriptionKey: message])
}
let files = FileManager.default
let temporary = URL(fileURLWithPath: CommandLine.arguments[2], isDirectory: true)
try files.createDirectory(at: temporary, withIntermediateDirectories: true)
let cache = temporary.appendingPathComponent("cache", isDirectory: true)
let root = cache.appendingPathComponent("ReachDownloads", isDirectory: true)
let bytes = Data("synthetic download bytes".utf8)
func incoming() throws -> URL {
    let url = temporary.appendingPathComponent(UUID().uuidString)
    try bytes.write(to: url)
    return url
}
switch CommandLine.arguments[1] {
case "names":
    try files.createDirectory(at: root, withIntermediateDirectories: true)
    let sibling = root.appendingPathComponent("other-transfer", isDirectory: true)
    try files.createDirectory(at: sibling, withIntermediateDirectories: false)
    let sentinel = sibling.appendingPathComponent("keep.txt")
    try Data("previous completed download".utf8).write(to: sentinel)
    let names = [".", "..", "", "../outside", "../../outside", "/absolute/path", "a:b", "a\\b",
                 "\u{0}", "first\nsecond", "%2e%2e", "%2foutside", "normal.pdf", "Résumé 🧪.txt",
                 String(repeating: "😀", count: 100)]
    for name in names {
        let id = UUID().uuidString
        let source = try incoming()
        let target = try BackgroundDownloadSafety.store(source, id: id, name: name, cache: cache)
        let expected = root.appendingPathComponent(id, isDirectory: true).resolvingSymlinksInPath()
        try require(target.standardizedFileURL.deletingLastPathComponent().path == expected.path, "escaped UUID directory: \(name)")
        try require(try Data(contentsOf: target) == bytes, "changed content")
        try require(!files.fileExists(atPath: source.path), "temporary file was not moved")
        try require(target.lastPathComponent.utf8.count <= 240, "unbounded filename")
        try require(try String(contentsOf: sentinel, encoding: .utf8) == "previous completed download", "deleted another transfer")
        if name == "normal.pdf" || name == "Résumé 🧪.txt" { try require(target.lastPathComponent == name, "ordinary filename changed") }
    }
case "ids":
    for id in [".", "..", "../outside", "/outside", "", "not-a-uuid", UUID().uuidString + "/..", "{" + UUID().uuidString + "}"] {
        let source = try incoming()
        try refused("accepted invalid persisted ID") {
            _ = try BackgroundDownloadSafety.store(source, id: id, name: "name.txt", cache: cache)
        }
        try require(try Data(contentsOf: source) == bytes, "invalid ID moved the source")
        try require(!files.fileExists(atPath: cache.path), "invalid ID mutated cache")
    }
    let id = UUID().uuidString.lowercased()
    let target = try BackgroundDownloadSafety.store(incoming(), id: id, name: "name.txt", cache: cache)
    try require(target.deletingLastPathComponent().lastPathComponent == id, "valid UUID rejected")
case "existing":
    let id = UUID().uuidString
    let first = try BackgroundDownloadSafety.store(incoming(), id: id, name: "same.txt", cache: cache)
    for name in ["same.txt", ".", "..", "another.txt"] {
        let source = try incoming()
        try refused("reused existing transfer directory") {
            _ = try BackgroundDownloadSafety.store(source, id: id, name: name, cache: cache)
        }
        try require(try Data(contentsOf: first) == bytes, "previous result overwritten or removed")
        try require(try Data(contentsOf: source) == bytes, "failed duplicate moved source")
    }
case "symlinks":
    try files.createDirectory(at: cache, withIntermediateDirectories: true)
    let outside = temporary.appendingPathComponent("outside", isDirectory: true)
    try files.createDirectory(at: outside, withIntermediateDirectories: true)
    let sentinel = outside.appendingPathComponent("keep.txt")
    try bytes.write(to: sentinel)
    try files.createSymbolicLink(at: root, withDestinationURL: outside)
    var source = try incoming()
    try refused("followed cache symlink") {
        _ = try BackgroundDownloadSafety.store(source, id: UUID().uuidString, name: "keep.txt", cache: cache)
    }
    try require(try Data(contentsOf: source) == bytes, "symlink refusal moved source")
    try files.removeItem(at: root) // Removes only this test's symlink.
    try files.createDirectory(at: root, withIntermediateDirectories: false)
    for destination in [outside, temporary.appendingPathComponent("missing")] {
        let id = UUID().uuidString
        try files.createSymbolicLink(at: root.appendingPathComponent(id), withDestinationURL: destination)
        source = try incoming()
        try refused("followed transfer symlink") {
            _ = try BackgroundDownloadSafety.store(source, id: id, name: "keep.txt", cache: cache)
        }
        try require(try Data(contentsOf: source) == bytes, "symlink refusal moved source")
    }
    try require(try Data(contentsOf: sentinel) == bytes, "outside sentinel changed")
    try require(try files.contentsOfDirectory(atPath: outside.path) == ["keep.txt"], "created outside file")
case "urls":
    let accepted = ["https://example.invalid/file", "https://100.64.0.1:443/path?x=1", "HTTPS://example.invalid/file",
                    "http://127.0.0.1:4100/file", "http://localhost:4100/file", "http://LOCALHOST/file", "http://[::1]:4100/file"]
    let denied = ["file://localhost/etc/passwd", "file://127.0.0.1/test", "ftp://127.0.0.1/file", "ws://localhost/file",
                  "data:text/plain,hello", "javascript:alert(1)", "http://example.invalid/file", "http://127.0.0.1.example.invalid/file",
                  "http://localhost.example.invalid/file", "http://127.1/file", "http://2130706433/file", "https:/file", "https:///file",
                  "https://", "/file", "https://user:password@example.invalid/file", "http://localhost@example.invalid/file",
                  "https://example.invalid/file#fragment"]
    for address in accepted { try require(BackgroundDownloadSafety.downloadURL(address) != nil, "rejected valid URL: \(address)") }
    for address in denied { try require(BackgroundDownloadSafety.downloadURL(address) == nil, "accepted forbidden URL: \(address)") }
default: fatalError("unknown case")
}
print("OK")
`}`,
    );
    await exec(
      "/usr/bin/xcrun",
      [
        "swiftc",
        "-module-cache-path",
        path.join(dir, "modules"),
        input,
        "-o",
        binary,
      ],
      { timeout: 180000, maxBuffer: 1 << 20 },
    );
    for (const scenario of ["names", "ids", "existing", "symlinks", "urls"]) {
      await t.test(scenario, async () => {
        const result = await exec(
          binary,
          [scenario, path.join(dir, scenario)],
          { timeout: 10000, maxBuffer: 65536 },
        );
        assert.equal(result.stdout.trim(), "OK");
      });
    }
  },
);
