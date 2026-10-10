import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createUploads } from "../server/uploads.mjs";

async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "reach-upload-quota-"));
  const folder = path.join(root, "shared");
  await fs.mkdir(folder);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const uploads = createUploads({
    dir: path.join(root, "private"),
    perClient: 1,
    freeSpace: async () => 1024 ** 3,
    ...options,
  });
  const create = (clientId, name) =>
    uploads.create(
      { id: clientId },
      {
        folder,
        name,
        size: 1,
        root: 0,
        path: "",
      },
    );
  return { uploads, create };
}

test("concurrent upload creation cannot exceed the per-client quota", async (t) => {
  const { uploads, create } = await fixture(t);
  const attempts = await Promise.allSettled(
    Array.from({ length: 16 }, (_, index) =>
      create("first-device", `upload-${index}.txt`),
    ),
  );
  assert.equal(
    attempts.filter((result) => result.status === "fulfilled").length,
    1,
  );
  const denied = attempts.filter((result) => result.status === "rejected");
  assert.equal(denied.length, 15);
  assert.ok(denied.every((result) => result.reason.status === 429));
  const other = await create("other-device", "other.txt");
  assert.ok(
    other.id,
    "one client's quota does not consume another client's slot",
  );
  const accepted = attempts.find(
    (result) => result.status === "fulfilled",
  ).value;
  await uploads.cancel(accepted.id, { id: "first-device" });
  assert.ok((await create("first-device", "replacement.txt")).id);
});

test("failed upload creation releases the reserved quota", async (t) => {
  let available = false;
  const { create } = await fixture(t, {
    freeSpace: async () => (available ? 1024 ** 3 : 0),
  });
  await assert.rejects(create("device", "no-room.txt"), { status: 507 });
  available = true;
  assert.ok((await create("device", "after-failure.txt")).id);
});

test("completing an upload again, after its answer was lost, reports the same success", async (t) => {
  const { uploads, create } = await fixture(t);
  const { Readable } = await import("node:stream");
  const { id } = await create("phone", "photo.jpg");
  const body = Readable.from([Buffer.from("x")]);
  body.complete = true;
  await uploads.write(id, { id: "phone" }, 0, body);
  const folder = path.join(path.dirname(uploads.get(id).file), "..", "shared");
  // Two completes at once (a retry racing the first), then one more later.
  const both = await Promise.all([
    uploads.complete(id, { id: "phone" }, folder),
    uploads.complete(id, { id: "phone" }, folder),
  ]);
  assert.deepEqual(both, [{ name: "photo.jpg" }, { name: "photo.jpg" }]);
  assert.deepEqual(await uploads.complete(id, { id: "phone" }, folder), { name: "photo.jpg" });
  assert.equal(await fs.readFile(path.join(folder, "photo.jpg"), "utf8"), "x");
  // Another device can't learn about it.
  await assert.rejects(uploads.complete(id, { id: "other" }, folder), { status: 404 });
});

// A request body as the server holds it: `complete` once every byte arrived.
const held = async (bytes, complete) => {
  const { PassThrough } = await import("node:stream");
  const body = new PassThrough();
  body.complete = complete;
  body.write(bytes);
  return body;
};
const within = (promise, ms = 2000) =>
  Promise.race([
    promise.then(() => "settled", () => "settled"),
    new Promise((resolve) => setTimeout(() => resolve("hung"), ms)),
  ]);

test("a newer chunk replaces a silent one still open, and lands alone", async (t) => {
  const { uploads, create } = await fixture(t);
  const { id } = await create("phone", "clip.mov");
  uploads.get(id).size = 10;
  // The phone changed networks mid-chunk: the old request stays open, silent.
  const silent = await held(Buffer.from("stale"), false);
  const old = uploads.write(id, { id: "phone" }, 0, silent).catch((e) => e);
  await new Promise((resolve) => setImmediate(resolve));
  const { Readable } = await import("node:stream");
  const again = Readable.from([Buffer.from("0123456789")]);
  again.complete = true;
  assert.deepEqual(await uploads.write(id, { id: "phone" }, 0, again), { offset: 10 });
  assert.equal((await old).status, 400);
  assert.equal(await fs.readFile(uploads.get(id).file, "utf8"), "0123456789");
});

test("a chunk whose connection is destroyed before its bytes reach the file never holds the upload", async (t) => {
  const { uploads, create } = await fixture(t);
  const { id } = await create("phone", "clip.mov");
  uploads.get(id).size = 10;
  // Every byte arrived, but the request is torn down (an expired identity,
  // say) before it drained into the file.
  const body = await held(Buffer.from("01234"), true);
  const first = uploads.write(id, { id: "phone" }, 0, body);
  body.destroy();
  assert.equal(await within(first), "settled");
  await assert.rejects(first, { status: 400 });
  const { Readable } = await import("node:stream");
  const again = Readable.from([Buffer.from("0123456789")]);
  again.complete = true;
  assert.equal(await within(uploads.write(id, { id: "phone" }, 0, again)), "settled");
  assert.equal(uploads.status(id, { id: "phone" }).offset, 10);
});
