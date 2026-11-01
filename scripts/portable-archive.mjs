import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { createGzip } from "node:zlib";
import { pipeline, finished } from "node:stream/promises";
import tar from "tar-stream";

// Native tar records the builder's uid, account/group names and extended
// metadata. Emit only public file names, bytes and executable modes, with
// neutral ownership and timestamps on every release host.
export async function writePortableArchive(source, destination) {
  const root = path.resolve(source), output = path.resolve(destination);
  if (output === root || output.startsWith(root + path.sep)) throw Error("The archive must be outside its source folder.");
  if (!(await fsp.lstat(root)).isDirectory()) throw Error("Portable staging must be a directory, not a link.");
  const temporary = path.join(path.dirname(output), `.reach-archive-${crypto.randomBytes(12).toString("hex")}.tmp`);
  const pack = tar.pack();
  const writing = pipeline(pack, createGzip(), fs.createWriteStream(temporary, { flags: "wx", mode: 0o600 }));
  // Observe errors immediately while entries are still being supplied.
  writing.catch(() => {});
  const header = (name, type, mode, size = 0) => ({ name, type, mode, size, uid: 0, gid: 0, uname: "", gname: "", mtime: new Date(0) });
  const regularFile = async (file, name) => {
    // Open first. The descriptor, not an earlier pathname check, is the read
    // authority. Nonblocking open also refuses a swapped FIFO without hanging.
    const handle = await fsp.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
    try {
      const [opened, linked] = await Promise.all([handle.stat({ bigint: true }), fsp.lstat(file, { bigint: true })]);
      if (!opened.isFile() || !linked.isFile() || opened.dev !== linked.dev || opened.ino !== linked.ino)
        throw Error("A portable input changed during archiving.");
      if (opened.size > BigInt(Number.MAX_SAFE_INTEGER)) throw Error("A portable input is too large.");
      await pipeline(handle.createReadStream({ autoClose: false }),
        pack.entry(header(name, "file", Number(opened.mode & 0o777n), Number(opened.size))));
    } finally { await handle.close(); }
  };
  const directory = async (folder, name) => {
    const entry = pack.entry(header(name + "/", "directory", 0o755));
    entry.end();
    await finished(entry);
    const children = await fsp.readdir(folder, { withFileTypes: true });
    children.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const child of children) {
      const file = path.join(folder, child.name), relative = name + "/" + child.name;
      if (child.isDirectory()) await directory(file, relative);
      else if (child.isSymbolicLink() || child.isFIFO() || child.isSocket() || child.isBlockDevice() || child.isCharacterDevice())
        throw Error("Portable inputs must be regular files and directories.");
      else await regularFile(file, relative);
    }
    if (!(await fsp.lstat(folder)).isDirectory()) throw Error("A portable directory changed during archiving.");
  };
  try {
    await directory(root, "reach");
    pack.finalize();
    await writing;
    await fsp.rename(temporary, output);
  } catch (error) {
    pack.destroy(error);
    await writing.catch(() => {});
    await fsp.rm(temporary, { force: true });
    throw error;
  }
}
