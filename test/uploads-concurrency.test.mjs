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
