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
  const uploads = createUploads({ dir: path.join(root, "private"), perClient: 1,
    freeSpace: async () => 1024 ** 3, ...options });
  const create = (clientId, name) => uploads.create({ id: clientId }, {
    folder, name, size: 1, root: 0, path: "",
  });
  return { uploads, create };
}

test("concurrent upload creation cannot exceed the per-client quota", async t => {
  const { uploads, create } = await fixture(t);
  const attempts = await Promise.allSettled(Array.from({ length: 16 }, (_, index) =>
    create("first-device", `upload-${index}.txt`)));
  assert.equal(attempts.filter(result => result.status === "fulfilled").length, 1);
  const denied = attempts.filter(result => result.status === "rejected");
  assert.equal(denied.length, 15);
  assert.ok(denied.every(result => result.reason.status === 429));
  const other = await create("other-device", "other.txt");
  assert.ok(other.id, "one client's quota does not consume another client's slot");
  const accepted = attempts.find(result => result.status === "fulfilled").value;
  await uploads.cancel(accepted.id, { id: "first-device" });
  assert.ok((await create("first-device", "replacement.txt")).id);
});

test("failed upload creation releases the reserved quota", async t => {
  let available = false;
  const { create } = await fixture(t, { freeSpace: async () => available ? 1024 ** 3 : 0 });
  await assert.rejects(create("device", "no-room.txt"), { status: 507 });
  available = true;
  assert.ok((await create("device", "after-failure.txt")).id);
});
