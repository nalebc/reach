import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { createReach } from "../server/index.mjs";
import { ALL_SCOPES } from "../server/core.mjs";
import { createLinks } from "../server/links.mjs";

async function setup(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-transfers-"));
  const shared = path.join(dir, "shared");
  fs.mkdirSync(path.join(shared, "Inbox"), { recursive: true });
  const reach = await createReach({
    roots: [shared],
    dataDir: path.join(dir, "private"),
    ...overrides,
  });
  await new Promise((r) => reach.server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${reach.server.address().port}`;
  const owner = reach.auth.issue("owner", ALL_SCOPES);
  const call = (token, route, { method = "GET", body, headers = {} } = {}) =>
    fetch(base + route, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body && !(body instanceof Uint8Array)
          ? { "Content-Type": "application/json" }
          : {}),
        ...headers,
      },
      body:
        body instanceof Uint8Array
          ? body
          : body
            ? JSON.stringify(body)
            : undefined,
    });
  const put = (token, id, offset, bytes, type = "application/octet-stream") =>
    call(token, `/api/files/uploads/${id}?offset=${offset}`, {
      method: "PUT",
      body: bytes,
      headers: { "Content-Type": type },
    });
  return {
    dir,
    shared,
    reach,
    base,
    owner,
    call,
    put,
    async close() {
      await reach.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("a large file uploads in chunks, resumes at the right offset, and appears only when complete", async () => {
  const t = await setup();
  try {
    const file = crypto.randomBytes(3 * 1024 * 1024 + 123);
    const start = await t.call(t.owner.token, "/api/files/uploads", {
      method: "POST",
      body: { root: 0, path: "Inbox", name: "video.mov", size: file.length },
    });
    assert.equal(start.status, 200);
    const { id, offset, chunk } = await start.json();
    assert.equal(offset, 0);
    assert.ok(chunk >= 1024 * 1024);
    const half = 2 * 1024 * 1024;
    assert.equal(
      (await (await t.put(t.owner.token, id, 0, file.subarray(0, half))).json())
        .offset,
      half,
    );
    // Nothing visible in the folder until every byte has arrived.
    assert.equal(
      fs.existsSync(path.join(t.shared, "Inbox", "video.mov")),
      false,
    );
    // A retry from the wrong place is told where to continue.
    const wrong = await t.put(t.owner.token, id, 0, file.subarray(0, 10));
    assert.equal(wrong.status, 409);
    assert.equal((await wrong.json()).offset, half);
    // After a dropped connection the app asks, then sends the rest.
    const status = await (
      await t.call(t.owner.token, `/api/files/uploads/${id}`)
    ).json();
    assert.deepEqual(status, { offset: half, size: file.length });
    await t.put(t.owner.token, id, half, file.subarray(half));
    const done = await t.call(
      t.owner.token,
      `/api/files/uploads/${id}/complete`,
      {
        method: "POST",
      },
    );
    assert.equal(done.status, 200);
    assert.deepEqual(await done.json(), { name: "video.mov" });
    assert.ok(
      fs.readFileSync(path.join(t.shared, "Inbox", "video.mov")).equals(file),
    );
    // The answer was lost and the app asks again: the same success.
    const again = await t.call(t.owner.token, `/api/files/uploads/${id}/complete`, { method: "POST" });
    assert.equal(again.status, 200);
    assert.deepEqual(await again.json(), { name: "video.mov" });
    // The session and its temp file are gone.
    assert.equal(
      (await t.call(t.owner.token, `/api/files/uploads/${id}`)).status,
      404,
    );
    assert.deepEqual(
      fs.readdirSync(path.join(t.reach.config.dataDir, "uploads-resumable")),
      [],
    );
  } finally {
    await t.close();
  }
});

test("uploads stay private to their device and never overwrite or outlive their folder", async () => {
  const t = await setup({ freeSpace: async () => 10 * 1024 ** 3 });
  try {
    const other = t.reach.auth.issue("other phone", ALL_SCOPES);
    const create = (name, size = 5, folder = "Inbox") =>
      t.call(t.owner.token, "/api/files/uploads", {
        method: "POST",
        body: { root: 0, path: folder, name, size },
      });
    const { id } = await (await create("notes.txt")).json();
    // Another credential can't see, extend, finish or cancel it.
    assert.equal(
      (await t.call(other.token, `/api/files/uploads/${id}`)).status,
      404,
    );
    assert.equal(
      (await t.put(other.token, id, 0, Buffer.from("hello"))).status,
      404,
    );
    // A chunk sent as JSON is refused rather than silently lost.
    assert.equal(
      (
        await t.put(
          t.owner.token,
          id,
          0,
          Buffer.from('{"a":1}'),
          "application/json",
        )
      ).status,
      415,
    );
    // Too big for the session.
    assert.equal(
      (await t.put(t.owner.token, id, 0, Buffer.from("hello world"))).status,
      413,
    );
    await t.put(t.owner.token, id, 0, Buffer.from("hello"));
    // Someone created a file with that name meanwhile: no overwrite.
    fs.writeFileSync(path.join(t.shared, "Inbox", "notes.txt"), "mine");
    const clash = await t.call(
      t.owner.token,
      `/api/files/uploads/${id}/complete`,
      {
        method: "POST",
      },
    );
    assert.equal(clash.status, 409);
    assert.equal(
      fs.readFileSync(path.join(t.shared, "Inbox", "notes.txt"), "utf8"),
      "mine",
    );
    // Existing names are refused up front, and so are bad names.
    assert.equal((await create("notes.txt")).status, 409);
    assert.equal((await create("../escape.txt")).status, 400);
    // The folder disappears before the upload finishes.
    const { id: second } = await (await create("late.txt")).json();
    await t.put(t.owner.token, second, 0, Buffer.from("hello"));
    fs.rmSync(path.join(t.shared, "Inbox"), { recursive: true });
    const gone = await t.call(
      t.owner.token,
      `/api/files/uploads/${second}/complete`,
      {
        method: "POST",
      },
    );
    assert.equal(gone.status, 404);
    // Not enough room on the computer.
    assert.equal((await create("huge.bin", 20 * 1024 ** 3, "")).status, 507);
    // Cancel removes it.
    const { id: third } = await (await create("cancel.txt", 5, "")).json();
    assert.equal(
      (
        await t.call(t.owner.token, `/api/files/uploads/${third}`, {
          method: "DELETE",
        })
      ).status,
      200,
    );
    assert.equal(
      (await t.call(t.owner.token, `/api/files/uploads/${third}`)).status,
      404,
    );
  } finally {
    await t.close();
  }
});

test("read-only guests can't upload", async () => {
  const t = await setup();
  try {
    const guest = t.reach.auth.redeemGuest(
      t.reach.auth.inviteGuest({ name: "guest", roots: [0], ttlSeconds: 60 })
        .invitation,
    );
    const response = await t.call(guest.token, "/api/files/uploads", {
      method: "POST",
      body: { root: 0, path: "", name: "a.txt", size: 1 },
    });
    assert.equal(response.status, 403);
  } finally {
    await t.close();
  }
});

test("downloads resume with Range, and one-time links hand files to the browser safely", async () => {
  const t = await setup();
  try {
    const data = crypto.randomBytes(200_000);
    fs.writeFileSync(path.join(t.shared, "Inbox", "photo.jpg"), data);
    const route = `/api/files/content?root=0&path=${encodeURIComponent("Inbox/photo.jpg")}`;
    const partial = await t.call(t.owner.token, route, {
      headers: { Range: "bytes=100000-" },
    });
    assert.equal(partial.status, 206);
    // Resuming only if the file is unchanged (the app sends If-Range).
    const etag = partial.headers.get("etag");
    const same = await t.call(t.owner.token, route, {
      headers: { Range: "bytes=100000-", "If-Range": etag },
    });
    assert.equal(same.status, 206);
    const changed = await t.call(t.owner.token, route, {
      headers: { Range: "bytes=100000-", "If-Range": 'W/"something-else"' },
    });
    assert.equal(changed.status, 200);
    assert.equal(Number(changed.headers.get("content-length")), data.length);
    assert.ok(
      Buffer.from(await partial.arrayBuffer()).equals(data.subarray(100000)),
    );
    const link = await (
      await t.call(
        t.owner.token,
        `/api/files/download-link?root=0&path=Inbox/photo.jpg`,
      )
    ).json();
    assert.match(link.url, /^\/download\/[\w-]{40,}$/);
    // No credential needed on the link itself; it names one file.
    const download = await fetch(t.base + link.url);
    assert.equal(download.status, 200);
    assert.match(
      download.headers.get("content-disposition"),
      /attachment.*photo\.jpg/,
    );
    assert.equal(download.headers.get("cache-control"), "no-store");
    assert.ok(Buffer.from(await download.arrayBuffer()).equals(data));
    const resumed = await fetch(t.base + link.url, {
      headers: { Range: "bytes=199990-" },
    });
    assert.equal(resumed.status, 206);
    // Unknown tokens.
    assert.equal(
      (await fetch(`${t.base}/download/not-a-real-token`)).status,
      410,
    );
    // The file changed after the link was made.
    const second = await (
      await t.call(
        t.owner.token,
        `/api/files/download-link?root=0&path=Inbox/photo.jpg`,
      )
    ).json();
    fs.utimesSync(
      path.join(t.shared, "Inbox", "photo.jpg"),
      new Date(),
      new Date(Date.now() + 5000),
    );
    assert.equal((await fetch(t.base + second.url)).status, 410);
    // Revoking the pairing kills its links at once.
    const fresh = await (
      await t.call(
        t.owner.token,
        `/api/files/download-link?root=0&path=Inbox/photo.jpg`,
      )
    ).json();
    const ownerId = t.reach.auth.verify(t.owner.token).id;
    const other = t.reach.auth.issue("admin phone", ALL_SCOPES);
    assert.equal(
      (
        await t.call(other.token, `/api/clients/${ownerId}`, {
          method: "DELETE",
        })
      ).status,
      200,
    );
    assert.equal((await fetch(t.base + fresh.url)).status, 403);
  } finally {
    await t.close();
  }
});

test("links expire", () => {
  const links = createLinks({ ttl: -1 });
  assert.equal(links.find(links.issue({ digest: "x" })), null);
  const live = createLinks();
  const token = live.issue({ digest: "x", root: 0, path: "a" });
  assert.equal(live.find(token).path, "a");
  assert.equal(live.find("nope"), null);
});
