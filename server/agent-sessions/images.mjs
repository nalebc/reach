// Images attached to agent messages from the phone. They are kept privately
// and referenced by an id Reach made, never by a path the phone chose. The
// file's own bytes decide the type; HEIC (iPhone photos) is converted by
// macOS because the models take PNG, JPEG, GIF and WebP. The id comes from
// the bytes, so the same picture sent twice is the same id (image-repeats.mjs).
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
      const id = contentId(fs.readFileSync(temporary));
      const ext = kind === "heic" ? "jpg" : kind;
      if (fs.existsSync(path.join(dir, `${id}.${ext}`))) {
        fs.rmSync(temporary, { force: true });
        return `${id}.${ext}`;
      }
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

// A UUID-shaped id from the image's bytes (ids are UUID-shaped, as before).
const contentId = (bytes) => {
  const h = crypto.createHash("sha256").update(bytes).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
};

// Width and height from the image's header, or null.
export function imageSize(bytes) {
  const b = bytes;
  const text = (start, end) => b.subarray(start, end).toString("latin1");
  const kind = imageKind(b.subarray(0, 16));
  if (kind === "png" && b.length >= 24) return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  if (kind === "gif" && b.length >= 10) return { width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
  if (kind === "webp" && b.length >= 30) {
    const chunk = text(12, 16);
    if (chunk === "VP8X") return { width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
    if (chunk === "VP8 ") return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
    if (chunk === "VP8L")
      return { width: 1 + (b[21] | ((b[22] & 0x3f) << 8)), height: 1 + ((b[22] >> 6) | (b[23] << 2) | ((b[24] & 0x0f) << 10)) };
  }
  if (kind === "jpg") {
    // The first start-of-frame marker holds the size.
    for (let i = 2; i + 9 < b.length; ) {
      if (b[i] !== 0xff) return null;
      const marker = b[i + 1];
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker))
        return { width: b.readUInt16BE(i + 7), height: b.readUInt16BE(i + 5) };
      i += 2 + b.readUInt16BE(i + 2);
    }
  }
  return null;
}

// About how many input tokens a model spends on an image this size, in each
// provider's published terms: Claude scales it to fit 1568px and about 1.19
// megapixels (1092 x 1092), then counts a token per 750 pixels; OpenAI (Codex) fits it in
// 2048px with its short side at most 768px, then counts 170 per 512px tile
// plus 85. An estimate: the models' own counts may differ a little.
export function imageTokens(size, agent) {
  if (!size?.width || !size?.height) return 0;
  let { width: w, height: h } = size;
  if (agent === "codex") {
    const fit = Math.min(1, 2048 / Math.max(w, h));
    w *= fit;
    h *= fit;
    const short = Math.min(1, 768 / Math.min(w, h));
    w *= short;
    h *= short;
    return 85 + 170 * Math.ceil(w / 512) * Math.ceil(h / 512);
  }
  const fit = Math.min(1, 1568 / Math.max(w, h), Math.sqrt((1092 * 1092) / (w * h)));
  return Math.round((w * fit * (h * fit)) / 750);
}

// Any file attached to a message from the phone (a PDF, a log, a zip): kept
// privately under an id Reach made, with its own name, and handed to the
// agent as a path, as each agent's composer references a file.
const FILE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[^/\\\0]{1,120}$/;
export const safeFileName = (name) =>
  String(name || "file")
    .replace(/[\x00-\x1f\x7f/\\:]+/g, "-")
    .replace(/^\.+/, "")
    .trim()
    .slice(0, 120) || "file";
export function createAgentFiles({ dir }) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return {
    add(temporary, name) {
      const id = `${crypto.randomUUID()}/${safeFileName(name)}`;
      fs.mkdirSync(path.join(dir, path.dirname(id)), { recursive: true, mode: 0o700 });
      fs.renameSync(temporary, path.join(dir, id));
      return id;
    },
    paths(ids) {
      if (ids === undefined || ids === null) return [];
      if (!Array.isArray(ids) || ids.length > 10) throw bad("Attach up to 10 files.");
      return ids.map((id) => {
        if (typeof id !== "string" || !FILE_ID.test(id)) throw bad("Unknown file.");
        const file = path.join(dir, id);
        if (!fs.existsSync(file)) throw bad("That file is gone. Attach it again.");
        return file;
      });
    },
  };
}
