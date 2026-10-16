import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { downloadConfined } from "../server/file-download.mjs";

// No server, native app or private files: an interrupted destination makes
// pipeline destroy its source. The OS can immediately reuse that source fd.
test("interrupted download cleanup leaves an unrelated file using the recycled descriptor open", async t => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "reach-download-cleanup-")));
  const file = path.join(dir, "download.txt");
  const other = path.join(dir, "other.txt");
  fs.writeFileSync(file, Buffer.alloc(1024 * 1024));
  fs.writeFileSync(other, "independent file");
  let independent = -1, sourceFd = -1;
  t.after(() => {
    if (independent >= 0) try { fs.closeSync(independent); } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const read = fs.createReadStream;
  t.mock.method(fs, "createReadStream", (requested, options) => {
    const source = read(requested, options);
    if (requested === file) {
      sourceFd = typeof options.fd === "number" ? options.fd : options.fd.fd;
      // This event works for numeric descriptors and FileHandles alike.
      // Run before pipeline returns and downloadConfined's finally closes
      // its handle, exposing a second owner of a raw numeric descriptor.
      source.prependOnceListener("close", () => {
        independent = fs.openSync(other, "r");
      });
    }
    return source;
  });
  const disconnected = new Error("Fixture client disconnected");
  const response = new Writable({
    write(_chunk, _encoding, callback) { callback(disconnected); },
  });
  response.set = response.attachment = response.status = () => response;
  response.hasHeader = () => false;
  await assert.rejects(downloadConfined(
    { headers: {}, method: "GET", fresh: false }, response, file, dir, () => file,
  ));
  assert.ok(sourceFd >= 0, "the confined source was opened");
  assert.equal(independent, sourceFd, "the OS recycled the closed stream descriptor for an independent open");
  assert.equal(fs.fstatSync(independent).isFile(), true, "the download must not close the independently opened file");
  const bytes = Buffer.alloc(11);
  assert.equal(fs.readSync(independent, bytes, 0, bytes.length, 0), bytes.length);
  assert.equal(bytes.toString(), "independent");
});
