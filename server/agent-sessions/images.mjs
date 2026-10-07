// Images attached to agent messages from the phone. They are kept privately
// and referenced by an id Reach made, never by a path the phone chose. The
// file's own bytes decide the type; HEIC (iPhone photos) is converted by
// macOS because the models take PNG, JPEG, GIF and WebP.
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|gif|webp)$/;
const bad = (message) => Object.assign(new Error(message), { status: 400 });

export function imageKind(head) {
  const text = (start, end) => head.subarray(start, end).toString("latin1");
  if (head.length >= 8 && head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
    return "png";
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "jpg";
  if (text(0, 4) === "GIF8") return "gif";
  if (text(0, 4) === "RIFF" && text(8, 12) === "WEBP") return "webp";
  if (text(4, 8) === "ftyp" && /^(heic|heix|hevc|heim|heis|mif1|msf1)$/.test(text(8, 12))) return "heic";
  return null;
}

export function createAgentImages({ dir, run = exec }) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return {
    // Takes an uploaded temporary file; returns the id the phone sends back.
    async add(temporary) {
      const head = Buffer.alloc(16);
      const fd = fs.openSync(temporary, "r");
      try {
        fs.readSync(fd, head, 0, 16, 0);
      } finally {
        fs.closeSync(fd);
      }
      const kind = imageKind(head);
      if (!kind) {
        fs.rmSync(temporary, { force: true });
        throw bad("Send a PNG, JPEG, GIF, WebP or HEIC image.");
      }
      const id = crypto.randomUUID();
      if (kind !== "heic") {
        fs.renameSync(temporary, path.join(dir, `${id}.${kind}`));
        return `${id}.${kind}`;
      }
      try {
        await run("/usr/bin/sips", ["-s", "format", "jpeg", temporary, "--out", path.join(dir, `${id}.jpg`)], {
          timeout: 30000,
        });
      } catch {
        throw bad("This photo couldn't be converted. Try a screenshot or a JPEG.");
      } finally {
        fs.rmSync(temporary, { force: true });
      }
      return `${id}.jpg`;
    },
    paths(ids) {
      if (ids === undefined || ids === null) return [];
      if (!Array.isArray(ids) || ids.length > 8) throw bad("Attach up to 8 images.");
      return ids.map((id) => {
        if (typeof id !== "string" || !ID.test(id)) throw bad("Unknown image.");
        const file = path.join(dir, id);
        if (!fs.existsSync(file)) throw bad("That image is gone. Attach it again.");
        return file;
      });
    },
  };
}
