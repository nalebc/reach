import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { createUploads } from "../server/uploads.mjs";

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "reach-upload-recovery-"));
  const folder = path.join(root, "shared");
  await fs.mkdir(folder);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const client = { id: "phone" };
  const uploads = createUploads({ dir: path.join(root, "private"), freeSpace: async () => 1024 ** 3 });
  const { id } = await uploads.create(client, { folder, name: "photo.jpg", size: 1, root: 0, path: "" });
  return { folder, client, uploads, id };
}

const chunk = () => {
  const body = Readable.from([Buffer.from("x")]);
  body.complete = true;
  return body;
};

test("a chunk already disconnected while waiting to write releases the upload for a retry", async t => {
  const { uploads, id, client, folder } = await fixture(t);
  const body = chunk();
  // A retry can disconnect while write() awaits the previous request closing.
  // Its close event has already happened by the time its turn to write starts.
  const closed = new Promise(resolve => body.once("close", resolve));
  body.destroy();
  await closed;
  const writing = uploads.write(id, client, 0, body).then(value => ({ value }), error => ({ error }));
  let timer;
  const result = await Promise.race([
    writing,
    new Promise(resolve => { timer = setTimeout(() => resolve({ hung: true }), 200); }),
  ]);
  clearTimeout(timer);
  // Release the broken implementation too, keeping this failing test bounded.
  if (result.hung) { body.emit("close"); await writing; }
  assert.equal(result.hung, undefined, "a disconnected body must reject instead of holding the session forever");
  assert.equal(result.error?.status, 400);
  assert.equal(uploads.status(id, client).offset, 0);
  assert.deepEqual(await uploads.write(id, client, 0, chunk()), { offset: 1 });
  assert.deepEqual(await uploads.complete(id, client, folder), { name: "photo.jpg" });
  assert.equal(await fs.readFile(path.join(folder, "photo.jpg"), "utf8"), "x");
});

test("fallback copy completion reports a destination conflict and keeps the upload retryable", async t => {
  const { uploads, id, client, folder } = await fixture(t);
  await uploads.write(id, client, 0, chunk());
  const target = path.join(folder, "photo.jpg");
  await fs.writeFile(target, "existing file");
  // exFAT/removable volumes and filesystems without hard links take this path.
  t.mock.method(fs, "link", async () => { throw Object.assign(Error("cross-device link"), { code: "EXDEV" }); });
  await assert.rejects(uploads.complete(id, client, folder), { status: 409 });
  assert.equal(await fs.readFile(target, "utf8"), "existing file");
  assert.equal(uploads.status(id, client).offset, 1);
  await fs.unlink(target);
  assert.deepEqual(await uploads.complete(id, client, folder), { name: "photo.jpg" });
  assert.equal(await fs.readFile(target, "utf8"), "x");
});
