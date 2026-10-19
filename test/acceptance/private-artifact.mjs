import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const sha256 = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const relativeName = value => {
  if (typeof value !== "string" || !value || value.includes("\\") || value.includes(":")) throw Error("Invalid artifact member.");
  const parts = value.split("/");
  if (parts.some(part => !part || part === "." || part === ".." || /[\x00-\x1f\x7f]/.test(part))) throw Error("Invalid artifact member.");
  return value;
};

// Fixture only: the caller first creates/checks an empty private Windows
// stage. Create fresh directories/files by bytes, never CopyFile/fs.cp:
// Windows file copying can carry the writable checkout's security metadata.
// No ACL is changed, no existing destination is reused, and links are refused.
export function copyPrivateAcceptanceArtifact({ source, destination, members }) {
  if (fs.readdirSync(destination).length) throw Error("The artifact destination is not empty.");
  const directories = new Set([""]), sourceDirectories = new Set(), names = new Set(), manifest = [];
  const sourceDirectory = relative => {
    if (sourceDirectories.has(relative)) return;
    if (relative) {
      const parent = path.posix.dirname(relative);
      sourceDirectory(parent === "." ? "" : parent);
    }
    const stat = fs.lstatSync(relative ? path.join(source, ...relative.split("/")) : source);
    if (stat.isSymbolicLink()) throw Error("An artifact member is a link.");
    if (!stat.isDirectory()) throw Error("An artifact parent is not a directory.");
    sourceDirectories.add(relative);
  };
  const directory = relative => {
    if (directories.has(relative)) return;
    const parent = path.posix.dirname(relative);
    directory(parent === "." ? "" : parent);
    fs.mkdirSync(path.join(destination, ...relative.split("/")), { mode: 0o700 });
    directories.add(relative);
  };
  const visit = relative => {
    relativeName(relative);
    const parent = path.posix.dirname(relative);
    sourceDirectory(parent === "." ? "" : parent);
    const at = path.join(source, ...relative.split("/")), stat = fs.lstatSync(at, { bigint: true });
    if (stat.isSymbolicLink()) throw Error("An artifact member is a link.");
    if (stat.isDirectory()) {
      directory(relative);
      for (const name of fs.readdirSync(at).sort()) visit(`${relative}/${name}`);
      return;
    }
    if (!stat.isFile()) throw Error("An artifact member is not a regular file.");
    const key = relative.toLowerCase();
    if (names.has(key)) throw Error("An artifact member is repeated.");
    names.add(key);
    directory(parent === "." ? "" : parent);
    // Pin the inspected file before reading. Windows lacks O_NOFOLLOW, so
    // fstat identity is required even when the final link flag is available.
    const fd = fs.openSync(at, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
    let bytes;
    try {
      const unchanged = () => {
        const opened = fs.fstatSync(fd, { bigint: true });
        return opened.isFile() && ["dev", "ino", "size", "mtimeNs", "ctimeNs"].every(key => opened[key] === stat[key]);
      };
      if (!unchanged()) throw Error("An artifact member changed while being copied.");
      bytes = fs.readFileSync(fd);
      if (!unchanged() || BigInt(bytes.length) !== stat.size) throw Error("An artifact member changed while being copied.");
    } finally { fs.closeSync(fd); }
    const hash = sha256(bytes), target = path.join(destination, ...relative.split("/"));
    fs.writeFileSync(target, bytes, { flag: "wx", mode: 0o600 });
    if (sha256(fs.readFileSync(target)) !== hash) throw Error("The copied artifact differs from its source.");
    manifest.push({ file: relative, bytes: bytes.length, sha256: hash });
  };
  for (const member of [...new Set(members)].sort()) visit(member);
  manifest.sort((a, b) => a.file < b.file ? -1 : a.file > b.file ? 1 : 0);
  return { manifest, manifestSha256: sha256(JSON.stringify(manifest)), files: manifest.length,
    bytes: manifest.reduce((sum, entry) => sum + entry.bytes, 0) };
}
