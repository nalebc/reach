import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fail } from "./core.mjs";

// Resumable uploads: the phone sends a file in chunks at known offsets, asks
// where to continue after a dropped connection, and the file only appears in
// the folder once every byte has arrived. Temp files live in Reach's private
// data folder and are removed when finished, cancelled, or abandoned.
export const CHUNK = 8 * 1024 * 1024;
const MAX_CHUNK = 16 * 1024 * 1024;
const IDLE = 24 * 60 * 60 * 1000;

export function createUploads({
  dir,
  maxBytes = 50 * 1024 ** 3,
  perClient = 8,
  freeSpace = async (folder) => {
    const stats = await fsp.statfs(folder);
    return stats.bavail * stats.bsize;
  },
}) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // Sessions don't survive a restart, so neither do their partial files.
  for (const name of fs.readdirSync(dir))
    if (name.endsWith(".part"))
      fs.rmSync(path.join(dir, name), { force: true });
  const sessions = new Map();
  const creating = new Map();
  // Uploads that landed, for a while: a phone whose answer to "complete" was
  // lost asks again and hears the same success, not that its upload is gone.
  const finished = new Map();
  const DONE_KEEP = 60 * 60 * 1000;
  const own = (id, client) => {
    const session = typeof id === "string" ? sessions.get(id) : undefined;
    if (!session || session.clientId !== client.id)
      throw fail(404, "This upload is no longer available. Start it again.");
    session.touched = Date.now();
    return session;
  };
  const drop = async (session) => {
    sessions.delete(session.id);
    await fsp.rm(session.file, { force: true });
  };
  const sweep = setInterval(
    () => {
      for (const session of sessions.values())
        if (Date.now() - session.touched > IDLE) void drop(session);
      for (const [id, done] of finished)
        if (Date.now() - done.at > DONE_KEEP) finished.delete(id);
    },
    60 * 60 * 1000,
  );
  sweep.unref();
  return {
    async create(client, { folder, name, size, root, path: relative }) {
      if (!Number.isSafeInteger(size) || size < 0)
        throw fail(400, "Send the file size in bytes.");
      if (size > maxBytes)
        throw fail(
          413,
          `Files up to ${Math.floor(maxBytes / 1024 ** 3)} GB can be uploaded.`,
        );
      if (
        [...sessions.values()].filter((s) => s.clientId === client.id).length +
          (creating.get(client.id) || 0) >=
        perClient
      )
        throw fail(429, "Too many uploads at once. Wait for one to finish.");
      // Reserve before the first filesystem await: simultaneous requests must
      // not all observe the same free slot and bypass the upload quota.
      creating.set(client.id, (creating.get(client.id) || 0) + 1);
      try {
        const target = path.join(folder, name);
        if (await exists(target))
          throw fail(
            409,
            "A file with that name already exists. Rename it before uploading.",
          );
        // Room for the partial copy (here) and the finished file (there).
        const margin = 64 * 1024 * 1024;
        for (const where of new Set([dir, folder]))
          if ((await freeSpace(where)) < size + margin)
            throw fail(507, "There isn't enough free space on the computer.");
        const id = crypto.randomBytes(16).toString("hex");
        const file = path.join(dir, `${id}.part`);
        // Normal permissions for the finished file (the folder keeps it private
        // until then).
        await (await fsp.open(file, "wx", 0o666)).close();
        sessions.set(id, {
          id,
          clientId: client.id,
          root,
          path: relative,
          name,
          size,
          received: 0,
          file,
          writing: null,
          touched: Date.now(),
        });
        return { id, offset: 0, chunk: CHUNK };
      } finally {
        const pending = creating.get(client.id) - 1;
        if (pending) creating.set(client.id, pending);
        else creating.delete(client.id);
      }
    },
    status(id, client) {
      const { received, size } = own(id, client);
      return { offset: received, size };
    },
    // Appends one chunk read from `body` (a stream) at `offset`.
    async write(id, client, offset, body) {
      const session = own(id, client);
      // A phone that changed networks mid-chunk sends it again while the
      // computer can still hold the old request, open and silent, for
      // minutes: the newer request replaces it. It starts once the old one's
      // file is closed, so no stale byte lands after it.
      while (session.writing) {
        const previous = session.writing;
        previous.stop();
        await previous.closed;
        if (session.writing === previous) session.writing = null;
      }
      if (sessions.get(session.id) !== session)
        throw fail(404, "This upload is no longer available. Start it again.");
      if (offset !== session.received)
        throw Object.assign(fail(409, "Continue from the offset given."), {
          offset: session.received,
        });
      const room = Math.min(MAX_CHUNK, session.size - session.received);
      const out = fs.createWriteStream(session.file, {
        flags: "r+",
        start: offset,
      });
      const writing = {
        // A chunk that fully arrived is left to finish writing.
        stop: () => {
          if (!body.complete) body.destroy();
        },
        closed: new Promise((resolve) => out.once("close", resolve)),
      };
      session.writing = writing;
      try {
        const written = await new Promise((resolve, reject) => {
          let count = 0;
          const quit = (error) => {
            body.unpipe(out);
            out.destroy();
            reject(error);
          };
          body.on("data", (chunk) => {
            count += chunk.length;
            if (count > room) {
              // Stop writing, discard the rest, and answer before closing.
              quit(fail(413, "This chunk is larger than expected."));
              body.resume();
            }
          });
          body.on("error", quit);
          // Closed before its end reached the file (cut off mid-chunk, or
          // destroyed while bytes still waited): the file is closed too.
          body.on("close", () => {
            if (!body.readableEnded)
              quit(fail(400, "The connection dropped mid-chunk."));
          });
          out.on("error", quit);
          out.on("finish", () => resolve(count));
          body.pipe(out);
        });
        // A partial chunk is simply rewritten by the next attempt.
        session.received += written;
        return { offset: session.received };
      } finally {
        await writing.closed;
        if (session.writing === writing) session.writing = null;
      }
    },
    // Moves the finished file into `folder`, never over an existing file.
    // This device's upload that already landed (see `finished`), or null.
    done(id, client) {
      const done = typeof id === "string" ? finished.get(id) : undefined;
      return done && done.clientId === client.id ? { name: done.name } : null;
    },
    async complete(id, client, folder) {
      const done = this.done(id, client);
      if (done) return done;
      const session = own(id, client);
      // A second complete while the first moves the file: the same answer.
      if (session.completing) return session.completing;
      if (session.writing || session.received !== session.size)
        throw Object.assign(fail(409, "Some of the file hasn't arrived yet."), {
          offset: session.received,
        });
      session.completing = finish(session, folder);
      try {
        return await session.completing;
      } finally {
        session.completing = undefined;
      }
    },
    async cancel(id, client) {
      await drop(own(id, client));
      return { ok: true };
    },
    get(id) {
      return sessions.get(id);
    },
  };
  async function finish(session, folder) {
    const target = path.join(folder, session.name);
    await fsp.truncate(session.file, session.size);
    try {
      // Same disk: instant, and fails if the name is taken.
      await fsp.link(session.file, target);
    } catch (e) {
      if (e.code === "EEXIST")
        throw fail(
          409,
          "A file with that name now exists. Rename it before uploading.",
        );
      if (!["EXDEV", "EPERM", "ENOTSUP", "EOPNOTSUPP"].includes(e.code))
        throw e;
      await fsp.copyFile(
        session.file,
        target,
        fs.constants.COPYFILE_EXCL | fs.constants.COPYFILE_FICLONE,
      );
    }
    finished.set(session.id, {
      clientId: session.clientId,
      name: session.name,
      at: Date.now(),
    });
    await drop(session);
    return { name: session.name };
  }
}
const exists = (file) =>
  fsp.access(file).then(
    () => true,
    () => false,
  );
