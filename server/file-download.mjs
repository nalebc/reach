import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { fail } from "./core.mjs";
import { openConfined } from "./confined-file.mjs";

// Downloads use the descriptor that passed confinement, including when a host
// process replaces the pathname after the check. Reopening it through sendFile
// could follow a newly inserted symlink outside the shared folders.
export async function downloadConfined(req, res, file, root, confine, validate = () => {}) {
  const relative = path.relative(root, file);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
    throw fail(403, "This file is outside your shared folders.");
  // Keep the download routes' existing hidden-descendant policy.
  if (relative.split(path.sep).some(part => part.startsWith(".")))
    throw fail(404, "This file is no longer available.");
  const { handle } = await openConfined(file, fs.constants.O_RDONLY, confine);
  try {
    const stat = await handle.stat();
    if (confine() !== file) throw fail(409, "This file changed. Try again.");
    validate(stat);
    const modified = stat.mtime.toUTCString();
    const etag = `W/"${stat.size.toString(16)}-${stat.mtimeMs.toString(16)}-${stat.ctimeMs.toString(16)}"`;
    res.set({ "Accept-Ranges": "bytes", "Last-Modified": modified, ETag: etag });
    if (!res.hasHeader("Cache-Control")) res.set("Cache-Control", "no-store");
    const matches = value => value === "*" || value.split(",").some(tag =>
      tag.trim().replace(/^W\//, "") === etag.replace(/^W\//, ""));
    if (req.headers["if-match"] && !matches(req.headers["if-match"]))
      throw fail(412, "This file changed. Start the download again.");
    const unmodified = Date.parse(req.headers["if-unmodified-since"]);
    if (!req.headers["if-match"] && Number.isFinite(unmodified) && Date.parse(modified) > unmodified)
      throw fail(412, "This file changed. Start the download again.");
    if (req.fresh) return res.status(304).end();
    let start = 0, end = stat.size - 1;
    const ifRange = req.headers["if-range"];
    const rangeFresh = !ifRange || (ifRange.includes('"')
      ? ifRange === etag : Date.parse(ifRange) >= Date.parse(modified));
    if (/^ *bytes=/.test(req.headers.range || "") && rangeFresh) {
      const ranges = req.range(stat.size, { combine: true });
      if (ranges === -1) {
        res.set("Content-Range", `bytes */${stat.size}`);
        throw fail(416, "This byte range is outside the file.");
      }
      // Malformed, unknown-unit or multiple disjoint ranges can use the full
      // response. A single range (including a suffix) supports resuming files.
      if (Array.isArray(ranges) && ranges.type === "bytes" && ranges.length === 1) {
        ({ start, end } = ranges[0]);
        res.status(206).set("Content-Range", `bytes ${start}-${end}/${stat.size}`);
      }
    }
    res.attachment(path.basename(file));
    res.set("Content-Length", String(end - start + 1));
    if (req.method === "HEAD" || stat.size === 0) return res.end();
    await pipeline(fs.createReadStream(file, {
      fd: handle, autoClose: false, start, end,
    }), res);
  } finally {
    await handle.close();
  }
}
