import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createReach } from "../server/index.mjs";

for (const linked of [false, true]) for (const attack of ["replacement", "symlink"]) {
  test(`${linked ? "download link" : "authenticated download"} reads only the checked file across a ${attack} swap`,
    { skip: attack === "symlink" && process.platform === "win32" }, async t => {
      const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "reach-download-swap-")));
      const shared = path.join(temporary, "shared");
      fs.mkdirSync(shared);
      const file = path.join(shared, "report.txt");
      const outside = path.join(temporary, "outside.txt");
      const allowed = "Shared report bytes";
      const forbidden = "Outside the shared folder";
      fs.writeFileSync(file, allowed);
      fs.writeFileSync(outside, forbidden);
      const reach = await createReach({ roots: [shared], dataDir: path.join(temporary, "private"), screen: false });
      await new Promise(resolve => reach.server.listen(0, "127.0.0.1", resolve));
      t.after(async () => { await reach.close(); fs.rmSync(temporary, { recursive: true, force: true }); });
      const client = reach.auth.issue("files only", ["files:read"], "agent");
      const base = `http://127.0.0.1:${reach.server.address().port}`;
      const headers = { Authorization: `Bearer ${client.token}` };
      let route = "/api/files/content?root=0&path=report.txt";
      if (linked) {
        const response = await fetch(base + "/api/files/download-link?root=0&path=report.txt", { headers });
        assert.equal(response.status, 200);
        route = (await response.json()).url;
      }
      let swapped = false;
      const read = fs.createReadStream;
      t.mock.method(fs, "createReadStream", (requested, options) => {
        if (requested === file && !swapped) {
          swapped = true;
          fs.renameSync(file, path.join(shared, "original.txt"));
          if (attack === "symlink") fs.symlinkSync(outside, file);
          else fs.copyFileSync(outside, file);
        }
        return read(requested, options);
      });
      const response = await fetch(base + route, { headers });
      const body = await response.text();
      assert.equal(swapped, true, "the file changed immediately before streaming");
      assert.equal(body.includes(forbidden.slice(0, 8)), false, "a re-opened path must never disclose replacement bytes");
      assert.equal(response.status, 200);
      assert.equal(body, allowed, "an already-open descriptor keeps serving the checked file");
    });
}

test("confined downloads retain HTTP resume, conditional and empty-file behavior", async t => {
  const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "reach-download-http-")));
  const shared = path.join(temporary, "shared");
  fs.mkdirSync(shared);
  fs.writeFileSync(path.join(shared, "report.txt"), "0123456789");
  fs.writeFileSync(path.join(shared, "empty.txt"), "");
  const reach = await createReach({ roots: [shared], dataDir: path.join(temporary, "private"), screen: false });
  await new Promise(resolve => reach.server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { await reach.close(); fs.rmSync(temporary, { recursive: true, force: true }); });
  const client = reach.auth.issue("files only", ["files:read"], "agent");
  const base = `http://127.0.0.1:${reach.server.address().port}`;
  const call = (file = "report.txt", headers = {}, method = "GET") => fetch(
    base + `/api/files/content?root=0&path=${file}`,
    { method, headers: { Authorization: `Bearer ${client.token}`, ...headers } },
  );
  const first = await call();
  assert.equal(first.status, 200);
  assert.equal(await first.text(), "0123456789");
  const etag = first.headers.get("etag");
  assert.ok(etag);
  for (const [range, status, body, contentRange] of [
    ["bytes=2-5", 206, "2345", "bytes 2-5/10"],
    ["bytes=-3", 206, "789", "bytes 7-9/10"],
    ["bytes=8-100", 206, "89", "bytes 8-9/10"],
    ["bytes=0-1,2-3", 206, "0123", "bytes 0-3/10"],
    ["bytes=0-1,8-9", 200, "0123456789", null],
    ["bytes=invalid", 200, "0123456789", null],
    ["items=100-200", 200, "0123456789", null],
  ]) {
    const response = await call("report.txt", { Range: range, "If-Range": etag });
    assert.equal(response.status, status, range);
    assert.equal(await response.text(), body, range);
    assert.equal(response.headers.get("content-range"), contentRange, range);
  }
  const invalid = await call("report.txt", { Range: "bytes=10-" });
  assert.equal(invalid.status, 416);
  assert.equal(invalid.headers.get("content-range"), "bytes */10");
  await invalid.arrayBuffer();
  const changed = await call("report.txt", { Range: "bytes=2-", "If-Range": 'W/"old"' });
  assert.equal(changed.status, 200);
  assert.equal(await changed.text(), "0123456789");
  const head = await call("report.txt", {}, "HEAD");
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("content-length"), "10");
  assert.equal(await head.text(), "");
  const precondition = await call("report.txt", { "If-Match": '"old"' });
  assert.equal(precondition.status, 412);
  await precondition.arrayBuffer();
  const empty = await call("empty.txt");
  assert.equal(empty.status, 200);
  assert.equal(empty.headers.get("content-length"), "0");
  assert.equal(await empty.text(), "");
});
