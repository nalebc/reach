import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createReach } from "../server/index.mjs";

test("upload completion rechecks its destination after asynchronous preparation", async t => {
  const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "reach-upload-folder-swap-")));
  const shared = path.join(temporary, "shared");
  const folder = path.join(shared, "incoming");
  const saved = path.join(shared, "original");
  const outside = path.join(temporary, "outside");
  await fs.mkdir(folder, { recursive: true });
  await fs.mkdir(outside);
  const reach = await createReach({ roots: [shared], dataDir: path.join(temporary, "private"), screen: false });
  t.after(async () => { await reach.close(); await fs.rm(temporary, { recursive: true, force: true }); });
  await new Promise(resolve => reach.server.listen(0, "127.0.0.1", resolve));
  const client = reach.auth.issue("file writer", ["files:write"], "agent");
  const origin = `http://127.0.0.1:${reach.server.address().port}`;
  const call = (route, body) => fetch(origin + route, {
    method: "POST",
    headers: { Authorization: `Bearer ${client.token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const made = await call("/api/files/uploads", { root: 0, path: "incoming", name: "notes.txt", size: 0 });
  assert.equal(made.status, 200);
  const { id } = await made.json();
  const truncate = fs.truncate;
  let swapped = false;
  t.mock.method(fs, "truncate", async (file, size) => {
    if (!swapped && file.endsWith(".part") && file.startsWith(temporary + path.sep)) {
      swapped = true;
      await fs.rename(folder, saved);
      // A junction exercises Windows' directory-redirection path without
      // requiring the symlink privilege. POSIX uses a real directory symlink.
      await fs.symlink(outside, folder, process.platform === "win32" ? "junction" : "dir");
    }
    return truncate(file, size);
  });
  const response = await call(`/api/files/uploads/${id}/complete`, {});
  const answer = await response.json();
  const outsideEntries = await fs.readdir(outside);
  assert.equal(swapped, true, "the destination changed while the upload prepared its private file");
  assert.deepEqual(outsideEntries, [], "completion must not follow the replacement folder outside the share");
  assert.ok([403, 409].includes(response.status), JSON.stringify({ status: response.status, answer }));
  // Restoring the original folder makes a rejected completion retryable.
  await fs.unlink(folder);
  await fs.rename(saved, folder);
  const retry = await call(`/api/files/uploads/${id}/complete`, {});
  assert.equal(retry.status, 200, JSON.stringify(await retry.json()));
  assert.equal(await fs.readFile(path.join(folder, "notes.txt"), "utf8"), "");
});
