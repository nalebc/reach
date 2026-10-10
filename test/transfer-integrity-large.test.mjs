import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { startDom } from "./dom/harness.mjs";
import { createReach } from "../server/index.mjs";
import { ALL_SCOPES } from "../server/core.mjs";
import { CHUNK } from "../server/uploads.mjs";
import { NodeXHR, faultProxy, seeded } from "./helpers/transfer-harness.mjs";

// Multi-gigabyte files, phone to computer and back, through the app's own
// transfer code. Opt-in (it writes the file once to disk and takes a while):
//   REACH_TEST_LARGE_TRANSFERS=1 npm run test:file -- test/transfer-integrity-large.test.mjs
// REACH_TEST_LARGE_BYTES sets the size (default 1.5 GiB; above 4 GiB checks
// offsets past 32 bits). The source is generated as it's sent, never stored,
// and the run is skipped without the file's size plus 6 GiB free.
const enabled = process.env.REACH_TEST_LARGE_TRANSFERS === "1";
const size = Number(process.env.REACH_TEST_LARGE_BYTES) || 1.5 * 1024 ** 3 + 12345;
const GiB = 1024 ** 3;

const streamHash = async (stream) => {
  const h = crypto.createHash("sha256");
  let bytes = 0;
  for await (const chunk of stream) {
    h.update(chunk);
    bytes += chunk.length;
  }
  return { hash: h.digest("hex"), bytes };
};

test(`a ${(size / GiB).toFixed(2)} GiB file crosses both ways byte for byte, through a cut each way`, {
  skip: !enabled && "set REACH_TEST_LARGE_TRANSFERS=1 to run",
  timeout: 30 * 60 * 1000,
}, async (t) => {
  const { bavail, bsize } = fs.statfsSync(os.tmpdir());
  if (bavail * bsize < size + 6 * GiB)
    return t.skip(`needs ${((size + 6 * GiB) / GiB).toFixed(1)} GiB free, has ${((bavail * bsize) / GiB).toFixed(1)}`);

  const nodeFetch = globalThis.fetch;
  const dom = await startDom({ fakes: { "src/tailnet-transport.ts": "test/dom/fakes/tailnet-toggle.mjs" } });
  const transfers = await dom.load("/src/transfers.ts");
  globalThis.fetch = nodeFetch;
  globalThis.XMLHttpRequest = NodeXHR;
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "reach-integrity-large-")));
  const shared = path.join(dir, "shared");
  fs.mkdirSync(shared);
  const reach = await createReach({ roots: [shared], dataDir: path.join(dir, "private"), screen: false, agentDesktop: null });
  await new Promise((r) => reach.server.listen(0, "127.0.0.1", r));
  const owner = reach.auth.issue("Owner", ALL_SCOPES, "device");
  const proxy = await faultProxy(reach.server.address().port);
  const peer = { id: "mac", name: "Mac", url: proxy.url, token: owner.token, platform: "darwin" };
  const auth = { Authorization: `Bearer ${owner.token}` };
  t.after(async () => {
    await proxy.close();
    await reach.close();
    await dom.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const seen = new Set();
  function Probe() {
    for (const job of transfers.useTransfers()) seen.add(job);
    return null;
  }
  await dom.render(dom.React.createElement(Probe));
  const upload = async (source, name) => {
    const before = new Set(seen);
    transfers.uploadFiles(peer, 0, "", [source.file(name)], () => {});
    const job = () => [...seen].find((j) => !before.has(j) && j.name === name);
    await dom.waitFor(() => ["done", "failed", "canceled"].includes(job()?.state), 25 * 60 * 1000);
    assert.equal(job().state, "done", job().error);
  };

  // Up: one chunk is cut mid-way, past 4 GiB when the file is that large.
  const large = seeded("reach-large", size);
  const expected = await large.hash();
  const cutAt = Math.floor((size > 2 ** 32 ? 2 ** 32 + CHUNK : size / 2) / CHUNK) * CHUNK;
  proxy.next((req) => req.method === "PUT" && req.url.includes(`offset=${cutAt}`), { cutRequestAfter: 3 * 1024 * 1024 });
  await upload(large, "large.bin");
  assert.equal(proxy.pending(), 0, "the upload was cut and resumed");
  const landed = await streamHash(fs.createReadStream(path.join(shared, "large.bin")));
  assert.equal(landed.bytes, size);
  assert.equal(landed.hash, expected, "landed byte for byte");

  // Down, as a browser's download manager takes it.
  const qs = new URLSearchParams({ root: "0", path: "large.bin" });
  const { url } = await (await nodeFetch(`${proxy.url}/api/files/download-link?${qs}`, { headers: auth })).json();
  const viaLink = await nodeFetch(proxy.url + url);
  assert.equal(viaLink.headers.get("content-encoding"), null);
  assert.equal(Number(viaLink.headers.get("content-length")), size);
  assert.deepEqual(await streamHash(viaLink.body), { hash: expected, bytes: size });

  // Down, as the iPhone app's background download takes it, cut past the
  // cut point above and resumed with Range + If-Range.
  const content = `${proxy.url}/api/files/content?${qs}`;
  const first = await nodeFetch(content, { headers: auth });
  const etag = first.headers.get("etag");
  const h = crypto.createHash("sha256");
  let got = 0;
  const reader = first.body.getReader();
  while (got < cutAt + 12345) {
    const { value, done } = await reader.read();
    if (done) break;
    const take = Math.min(value.length, cutAt + 12345 - got);
    h.update(value.subarray(0, take));
    got += take;
  }
  await reader.cancel();
  const rest = await nodeFetch(content, { headers: { ...auth, Range: `bytes=${got}-`, "If-Range": etag } });
  assert.equal(rest.status, 206);
  assert.equal(rest.headers.get("content-range"), `bytes ${got}-${size - 1}/${size}`);
  for await (const chunk of rest.body) {
    h.update(chunk);
    got += chunk.length;
  }
  assert.equal(got, size);
  assert.equal(h.digest("hex"), expected, "resumed download byte for byte");

  // Into the app's memory (the iPhone app's fallback, phones without the
  // Tailscale app), at a size a phone can hold.
  const medium = seeded("reach-medium", 256 * 1024 * 1024 + 3);
  await upload(medium, "medium.bin");
  const entry = { name: "medium.bin", path: "medium.bin", size: medium.size, type: "file" };
  proxy.next(/^GET \/api\/files\/content$/, { cutResponseAfter: 100 * 1024 * 1024 });
  const blob = await transfers.downloadWithProgress(peer, 0, entry);
  assert.equal(blob.size, medium.size);
  assert.equal(crypto.createHash("sha256").update(Buffer.from(await blob.arrayBuffer())).digest("hex"), await medium.hash());
});
