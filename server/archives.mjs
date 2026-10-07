import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import crc32 from "buffer-crc32";
import yauzl from "yauzl";
import tar from "tar-stream";
import { fail, validLeafName } from "./core.mjs";

const suffixes = [".tar.gz", ".tar.bz2", ".tar.xz", ".zip", ".tar", ".tgz"];
export const archiveBase = (name) => {
  if (typeof name !== "string") return null;
  const suffix = suffixes.find(s => name.toLowerCase().endsWith(s) && name.length > s.length);
  return suffix ? name.slice(0, -suffix.length) : null;
};
export const ARCHIVE_LIMITS = Object.freeze({ inputBytes: 64 << 20, outputBytes: 256 << 20, fileBytes: 64 << 20, entries: 4096, timeoutMs: 60_000 });
const invalid = () => fail(422, "This archive contains invalid, conflicting, or unsafe entries. Nothing was opened.");
const same = (a, b) => a.dev === b.dev && a.ino === b.ino;
const unchanged = (a, b) => same(a, b) && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
const entryParts = (name) => {
  if (typeof name !== "string" || name.length > 2048 || /[\\:\x00-\x1f\x7f-\x9f\u200e\u200f\u2028-\u202e\u2066-\u2069]/u.test(name)) throw invalid();
  // TAR convention permits a leading ./; no other dot/path normalization is accepted.
  const parts = name.replace(/^(?:\.\/)+/, "").replace(/\/$/, "").split("/");
  if (parts.length > 32 || parts.some(p => !p || p === "." || p === ".." || p.length > 255 || /[. ]$/.test(p) || /[<>"|?*]/.test(p) || /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(p))) throw invalid();
  return parts;
};

// Only regular files/directories are materialized. Parsers never receive an
// output path: links, devices, ownership, modes, xattrs and timestamps cannot
// turn archive metadata into host filesystem operations.
export async function extractArchive(file, { authorize = () => {}, stagingRoot = os.tmpdir(), limits: custom = {}, signal } = {}) {
  const limits = { ...ARCHIVE_LIMITS, ...custom };
  for (const [key, value] of Object.entries(limits)) if (!Object.hasOwn(ARCHIVE_LIMITS, key) || !Number.isSafeInteger(value) || value < 1 || value > ARCHIVE_LIMITS[key]) throw fail(400, "Invalid extraction limit.");
  const base = archiveBase(path.basename(file));
  if (!base) throw fail(415, "Only ZIP, TAR and gzip-compressed TAR archives can be opened here.");
  if (/\.tar\.(bz2|xz)$/i.test(file)) throw fail(415, "Bzip2 and XZ archives cannot be opened safely here yet. Download this archive to open it on your computer.");
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason || fail(409, "Extraction was cancelled."));
  if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => controller.abort(fail(408, "This archive took too long to open.")), limits.timeoutMs);
  const check = () => { if (controller.signal.aborted) throw controller.signal.reason; authorize(); };
  let source, staging, destination, destinationStat, published = false;
  const parent = path.dirname(file);
  let parentStat;
  const checkParent = async () => {
    check();
    const now = await fsp.lstat(parent);
    if (!now.isDirectory() || now.isSymbolicLink() || !same(parentStat, now) || await fsp.realpath(parent) !== parent) throw fail(409, "The destination folder changed. Try again.");
    check();
  };
  try {
    check();
    parentStat = await fsp.lstat(parent);
    if (!parentStat.isDirectory() || parentStat.isSymbolicLink() || await fsp.realpath(parent) !== parent) throw fail(409, "Choose an archive in a regular folder.");
    const initial = await fsp.lstat(file);
    if (!initial.isFile() || initial.isSymbolicLink()) throw fail(400, "Choose a regular archive file.");
    if (initial.size > limits.inputBytes) throw fail(413, "Archives must be no larger than 64 MiB.");
    source = await fsp.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    if (!unchanged(initial, await source.stat())) throw fail(409, "The archive changed. Try again.");
    // An immutable bounded snapshot prevents pathname/content changes during decoding.
    const chunks = []; let inputBytes = 0;
    for await (const chunk of source.createReadStream({ autoClose: false })) {
      check(); inputBytes += chunk.length;
      if (inputBytes > limits.inputBytes) throw fail(413, "Archives must be no larger than 64 MiB.");
      chunks.push(chunk);
    }
    if (!unchanged(initial, await source.stat()) || !unchanged(initial, await fsp.lstat(file))) throw fail(409, "The archive changed. Try again.");
    await source.close(); source = null;
    const input = Buffer.concat(chunks); chunks.length = 0;
    staging = await fsp.mkdtemp(path.join(stagingRoot, "reach-archive-"));
    await fsp.chmod(staging, 0o700);
    let entries = 0, declared = 0;
    const names = new Map();
    const consume = async (name, type, size, stream, checksum) => {
      check();
      if (++entries > limits.entries) throw fail(413, "This archive contains too many entries.");
      if (!["file", "directory"].includes(type)) throw invalid();
      if (!Number.isSafeInteger(size) || size < 0 || size > limits.fileBytes || (type === "directory" && size !== 0)) throw fail(413, "An archive entry exceeds the extraction limit.");
      declared += size;
      if (declared > limits.outputBytes) throw fail(413, "The expanded archive exceeds 256 MiB.");
      if (type === "directory" && [".", "./"].includes(name)) { for await (const chunk of stream) { if (chunk.length) throw invalid(); } return; }
      const parts = entryParts(name), relative = parts.join("/");
      const keys = parts.map(p => p.normalize("NFC").toLowerCase());
      for (let i = 1; i <= parts.length; i++) {
        const key = keys.slice(0, i).join("/"), spelling = parts.slice(0, i).join("/"), found = names.get(key);
        const kind = i === parts.length ? type : "directory";
        if (found && (found.spelling !== spelling || found.type !== kind || (i === parts.length && found.explicit))) throw invalid();
        names.set(key, { spelling, type: kind, explicit: i === parts.length || !!found?.explicit });
      }
      const ignored = parts.includes("__MACOSX") || parts.some(p => p.startsWith("._")) || relative === ".DS_Store";
      let actual = 0, crc = 0;
      const bound = new Transform({ transform(chunk, _encoding, done) {
        try { check(); actual += chunk.length; if (actual > size || actual > limits.fileBytes) throw invalid(); if (checksum !== undefined) crc = crc32.unsigned(chunk, crc); done(null, ignored ? undefined : chunk); } catch (error) { done(error); }
      } });
      const target = path.join(staging, ...parts);
      if (!ignored) await fsp.mkdir(type === "directory" ? target : path.dirname(target), { recursive: true, mode: 0o700 });
      if (stream.errored) throw stream.errored;
      if (type === "directory" || ignored) {
        for await (const chunk of stream) { check(); actual += chunk.length; if (actual > size) throw invalid(); if (checksum !== undefined) crc = crc32.unsigned(chunk, crc); }
      } else {
        await pipeline(stream, bound, fs.createWriteStream(target, { flags: "wx", mode: 0o600 }), { signal: controller.signal });
      }
      if (actual !== size || (checksum !== undefined && crc !== checksum)) throw invalid();
    };
    if (/\.zip$/i.test(file)) {
      const zip = await yauzl.fromBufferPromise(input, { strictFileNames: true, validateEntrySizes: true });
      try {
        if (zip.entryCount > limits.entries) throw fail(413, "This archive contains too many entries.");
        for await (const entry of zip.eachEntry()) {
          const kind = (entry.externalFileAttributes >>> 16) & 0xf000;
          const directory = entry.fileName.endsWith("/");
          if (entry.isEncrypted() || !entry.canDecodeFileData() || (kind && kind !== (directory ? 0x4000 : 0x8000))) throw invalid();
          const stream = await zip.openReadStreamPromise(entry);
          // Decompression can fail while asynchronous destination setup is in
          // progress. Observe errors immediately; consume also checks the
          // stored error before piping, so an early failure cannot be lost.
          stream.on("error", () => {});
          try { await consume(entry.fileName, directory ? "directory" : "file", entry.uncompressedSize, stream, entry.crc32); }
          finally { stream.destroy(); }
        }
      } finally { zip.close(); }
    } else {
      const extract = tar.extract();
      let raw = 0;
      const bound = new Transform({ transform(chunk, _encoding, done) {
        try { check(); raw += chunk.length; if (raw > limits.outputBytes + limits.entries * 1024 + (4 << 20)) throw fail(413, "The expanded archive exceeds the extraction limit."); done(null, chunk); } catch (error) { done(error); }
      } });
      const streams = [Readable.from([input]), ...(/\.(?:tgz|tar\.gz)$/i.test(file) ? [createGunzip()] : []), bound, extract];
      const pumping = pipeline(...streams, { signal: controller.signal });
      // Attach immediately: decoding and entry handling run concurrently.
      pumping.catch(() => {});
      try {
        for await (const entry of extract) {
          const h = entry.header;
          if (h.linkname || Object.keys(h.pax || {}).some(key => /sparse|linkpath/i.test(key))) throw invalid();
          await consume(h.name, h.type, h.size, entry);
        }
        await pumping;
      } catch (error) { extract.destroy(error); await pumping.catch(() => {}); throw error; }
    }
    if (!entries) throw invalid();
    const inside = await fsp.readdir(staging);
    const single = inside.length === 1 && (await fsp.lstat(path.join(staging, inside[0]))).isDirectory();
    const preferred = single && validLeafName(inside[0]) ? inside[0] : validLeafName(base) ? base : "Archive";
    const content = single ? path.join(staging, inside[0]) : staging;
    await checkParent();
    // mkdir is an exclusive reservation. Never rename over a path found free
    // earlier: POSIX rename could replace an existing empty directory.
    for (let n = 1; n < 1000; n++) {
      const name = n === 1 ? preferred : `${preferred} ${n}`;
      if (!validLeafName(name)) throw fail(400, "The archive name is too long.");
      const candidate = path.join(parent, name);
      try { await fsp.mkdir(candidate, { mode: 0o700 }); destination = candidate; break; }
      catch (error) { if (error.code !== "EEXIST") throw error; }
    }
    if (!destination) throw fail(409, "Too many items with this name.");
    destinationStat = await fsp.lstat(destination);
    const knownDirectories = new Map([[destination, destinationStat]]);
    const checkDirectory = async directory => {
      await checkParent();
      for (let current = directory; current !== parent; current = path.dirname(current)) {
        const expected = knownDirectories.get(current), actual = await fsp.lstat(current);
        if (!expected || !actual.isDirectory() || actual.isSymbolicLink() || !same(expected, actual)) throw fail(409, "The extraction folder changed. Nothing else was copied.");
      }
      check();
    };
    const copy = async (from, to) => {
      for (const entry of await fsp.readdir(from, { withFileTypes: true })) {
        await checkDirectory(to);
        const sourcePath = path.join(from, entry.name), targetPath = path.join(to, entry.name);
        if (entry.isDirectory()) { await fsp.mkdir(targetPath, { mode: 0o700 }); knownDirectories.set(targetPath, await fsp.lstat(targetPath)); await copy(sourcePath, targetPath); }
        else if (entry.isFile()) {
          const guard = new Transform({ transform(chunk, _encoding, done) { try { check(); done(null, chunk); } catch (error) { done(error); } } });
          await pipeline(fs.createReadStream(sourcePath), guard, fs.createWriteStream(targetPath, { flags: "wx", mode: 0o600 }), { signal: controller.signal });
          await checkDirectory(to);
        } else throw invalid();
      }
    };
    await copy(content, destination);
    await checkDirectory(destination);
    published = true;
    return path.basename(destination);
  } catch (error) {
    if (controller.signal.aborted) throw controller.signal.reason;
    if (Number.isInteger(error.status)) throw error;
    throw invalid();
  } finally {
    clearTimeout(timer); signal?.removeEventListener("abort", abort);
    await source?.close().catch(() => {});
    if (staging) await fsp.rm(staging, { recursive: true, force: true });
    if (destination && !published) {
      // A host process may have replaced the reserved directory: never remove
      // its replacement or follow a redirected parent during error cleanup.
      try {
        if (await fsp.realpath(parent) === parent && same(parentStat, await fsp.lstat(parent)) && same(destinationStat, await fsp.lstat(destination)))
          await fsp.rm(destination, { recursive: true, force: true });
      } catch { /* Leave an uncertain host-modified path untouched. */ }
    }
  }
}
