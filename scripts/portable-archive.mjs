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
  const directory = async (folder, name) => {
    const entry = pack.entry(header(name + "/", "directory", 0o755));
    entry.end();
    await finished(entry);
    for (const child of (await fsp.readdir(folder)).sort()) {
      const file = path.join(folder, child), relative = name + "/" + child;
      const stat = await fsp.lstat(file);
      if (stat.isDirectory()) await directory(file, relative);
      else if (stat.isFile()) {
        const handle = await fsp.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
        try {
          const opened = await handle.stat();
          if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino)
            throw Error("A portable input changed during archiving.");
          await pipeline(handle.createReadStream({ autoClose: false }),
            pack.entry(header(relative, "file", opened.mode & 0o777, opened.size)));
        } finally { await handle.close(); }
      } else throw Error("Portable inputs must be regular files and directories.");
    }
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
