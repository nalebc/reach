import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createReach } from "../server/index.mjs";
import { ALL_SCOPES } from "../server/core.mjs";

async function fixture(t, overrides = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "reach-file-access-"));
  const shared = path.join(root, "shared");
  for (const name of ["before", "after"]) await fs.mkdir(path.join(shared, name), { recursive: true });
  const reach = await createReach({ roots: [shared], dataDir: path.join(root, "private"), screen: false, ...overrides });
  await new Promise(resolve => reach.server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    reach.server.closeAllConnections();
    await reach.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const url = `http://127.0.0.1:${reach.server.address().port}`;
  const owner = reach.auth.issue("Owner", ALL_SCOPES);
  const invite = reach.auth.inviteGuest({ name: "Visitor", ttlSeconds: 3600, folders: [{ root: 0, path: "before" }], write: true });
  const guest = reach.auth.redeemGuest(invite.invitation);
  const call = (route, { token = guest.token, method = "GET", body, headers = {}, signal } = {}) => fetch(url + route, {
    method, signal,
    headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...headers },
    ...(body === undefined ? {} : { body: body instanceof Uint8Array ? body : JSON.stringify(body) }),
  });
  const change = async (folder = "after") => {
    const response = await call(`/api/guests/${invite.clientId}/access`, { token: owner.token, method: "POST", body: { folders: [{ root: 0, path: folder }], write: true } });
    assert.equal(response.status, 200);
    await response.json();
  };
  return { shared, call, change };
}

test("a delayed file preview cannot disclose the old folder after the guest's folders change", async t => {
  let entered, release;
  const reading = new Promise(resolve => { entered = resolve; });
  const waiting = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  const f = await fixture(t, { documentText: async () => { entered(); await waiting; return "OLD-FOLDER-PRIVATE-TEXT"; } });
  await fs.writeFile(path.join(f.shared, "before", "report.docx"), "fixture");
  const pending = f.call("/api/files/document-text?root=0&path=report.docx");
  await reading;
  await f.change();
  release();
  const response = await pending;
  assert.equal(response.status, 401);
  assert.ok(!(await response.text()).includes("OLD-FOLDER-PRIVATE-TEXT"));
});

test("an upload cannot move to a different folder when the guest's root index is reassigned", async t => {
  const f = await fixture(t);
  const made = await f.call("/api/files/uploads", { method: "POST", body: { root: 0, path: "", name: "notes.txt", size: 0 } });
  assert.equal(made.status, 200);
  const { id } = await made.json();
  await f.change();
  const response = await f.call(`/api/files/uploads/${id}/complete`, { method: "POST" });
  assert.equal(response.status, 409);
  assert.deepEqual(await fs.readdir(path.join(f.shared, "after")), []);
  assert.deepEqual(await fs.readdir(path.join(f.shared, "before")), []);
  assert.equal((await f.call(`/api/files/uploads/${id}`, { method: "DELETE" })).status, 200);
});

test("a download link stays bound to its original file even if a replacement has the same timestamp", async t => {
  const f = await fixture(t);
  const when = new Date("2026-01-01T00:00:00.000Z");
  for (const name of ["before", "after"]) {
    const file = path.join(f.shared, name, "notes.txt");
    await fs.writeFile(file, `${name}-contents`);
    await fs.utimes(file, when, when);
  }
  const made = await f.call("/api/files/download-link?root=0&path=notes.txt");
  assert.equal(made.status, 200);
  const { url } = await made.json();
  await f.change();
  const response = await f.call(url);
  assert.equal(response.status, 403);
  assert.ok(!(await response.text()).includes("after-contents"));
});

test("an empty JSON chunk is rejected instead of being accepted as zero bytes", async t => {
  const f = await fixture(t);
  const made = await f.call("/api/files/uploads", { method: "POST", body: { root: 0, path: "", name: "notes.txt", size: 2 } });
  const { id } = await made.json();
  const response = await f.call(`/api/files/uploads/${id}?offset=0`, { method: "PUT", body: {}, signal: AbortSignal.timeout(2000) });
  assert.equal(response.status, 415);
  assert.equal((await (await f.call(`/api/files/uploads/${id}`)).json()).offset, 0);
});
