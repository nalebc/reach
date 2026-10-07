import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createReach } from "../server/index.mjs";
import { ALL_SCOPES } from "../server/core.mjs";

async function fixture() {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "reach-hidden-downloads-"));
  const parent = await fs.realpath(temporary);
  const shared = path.join(parent, ".checkout", "shared");
  const dataDir = path.join(shared, "private-data");
  await fs.mkdir(path.join(shared, ".hidden"), { recursive: true });
  await fs.mkdir(path.join(shared, "nested"));
  await fs.mkdir(dataDir);
  await fs.writeFile(path.join(shared, "nested", "ordinary.txt"), "shared fixture bytes");
  await fs.writeFile(path.join(shared, ".env"), "PRIVATE-FIXTURE-BYTES");
  await fs.writeFile(path.join(shared, ".hidden", "ordinary.txt"), "PRIVATE-FIXTURE-BYTES");
  await fs.writeFile(path.join(dataDir, "ordinary.txt"), "PRIVATE-FIXTURE-BYTES");
  await fs.writeFile(path.join(parent, ".checkout", "outside.txt"), "PRIVATE-FIXTURE-BYTES");
  const reach = await createReach({ roots: [shared], dataDir, port: 0 });
  await new Promise((resolve) => reach.server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${reach.server.address().port}`;
  const owner = reach.auth.issue("fixture owner", ALL_SCOPES);
  const call = (route, token = owner.token, headers = {}) => fetch(url + route, {
    headers: { Authorization: `Bearer ${token}`, ...headers },
  });
  const fileRoute = (endpoint, file) => `/api/files/${endpoint}?${new URLSearchParams({ root: "0", path: file })}`;
  return { reach, owner, call, fileRoute, async close() {
    await reach.close();
    await fs.rm(parent, { recursive: true, force: true });
  } };
}

test("ordinary downloads under a hidden shared-root ancestor retain contents and range delivery", async () => {
  const f = await fixture();
  try {
    const route = f.fileRoute("content", "nested/ordinary.txt");
    const response = await f.call(route);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "shared fixture bytes");
    assert.match(response.headers.get("content-disposition"), /attachment; filename="ordinary.txt"/);
    const range = await f.call(route, f.owner.token, { Range: "bytes=0-5" });
    assert.equal(range.status, 206);
    assert.equal(await range.text(), "shared");
    assert.equal(range.headers.get("content-range"), "bytes 0-5/20");
    const linkResponse = await f.call(f.fileRoute("download-link", "nested/ordinary.txt"));
    assert.equal(linkResponse.status, 200);
    const { url } = await linkResponse.json();
    const linked = await f.call(url);
    assert.equal(linked.status, 200);
    assert.equal(await linked.text(), "shared fixture bytes");
    assert.equal(linked.headers.get("cache-control"), "no-store");
    f.reach.auth.revoke(f.owner.clientId);
    assert.equal((await f.call(route)).status, 401);
    assert.equal((await f.call(url)).status, 403);
  } finally { await f.close(); }
});

test("rooted downloads still refuse hidden descendants, private data, traversal and missing authority", async () => {
  const f = await fixture();
  try {
    for (const [file, expected] of [[".env", 404], [".hidden/ordinary.txt", 404], ["private-data/ordinary.txt", 403], ["../outside.txt", 403]]) {
      const direct = await f.call(f.fileRoute("content", file));
      assert.equal(direct.status, expected, file);
      assert.ok(!(await direct.text()).includes("PRIVATE-FIXTURE-BYTES"));
      const linkResponse = await f.call(f.fileRoute("download-link", file));
      if (expected === 403) {
        assert.equal(linkResponse.status, 403, file);
      } else {
        assert.equal(linkResponse.status, 200, file);
        const linked = await f.call((await linkResponse.json()).url);
        assert.equal(linked.status, 404, file);
        assert.ok(!(await linked.text()).includes("PRIVATE-FIXTURE-BYTES"));
      }
    }
    const route = f.fileRoute("content", "nested/ordinary.txt");
    assert.equal((await f.call(route, "invalid")).status, 401);
    const limited = f.reach.auth.issue("fixture no files", ["screen"]);
    assert.equal((await f.call(route, limited.token)).status, 403);
  } finally { await f.close(); }
});
