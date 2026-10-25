import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import zlib from "node:zlib";
import { execFileSync } from "node:child_process";
import contentDisposition from "content-disposition";
import crc from "buffer-crc32";
import { startDom } from "./dom/harness.mjs";
import { createReach } from "../server/index.mjs";
import { ALL_SCOPES } from "../server/core.mjs";
import { CHUNK } from "../server/uploads.mjs";
import { tarFixture } from "./helpers/archive-fixtures.mjs";
import {
  NodeXHR,
  faultProxy,
  goTailnetNode,
  sha256,
} from "./helpers/transfer-harness.mjs";

// Every way a file crosses between a phone and the computer, run through the
// app's own transfer code (src/transfers.ts, src/api.ts) against a real
// Reach, with the network failing the ways a phone's does. Each file must
// land byte for byte: same SHA-256, same size, same name, nothing left over.

const nodeFetch = globalThis.fetch;
const fake = "test/dom/fakes/native-sharing.mjs";
let dom, transfers, api, tailnetFetch, sharing;
const seenTransfers = new Set();
before(async () => {
  dom = await startDom({
    fakes: {
      "src/tailnet-transport.ts": "test/dom/fakes/tailnet-toggle.mjs",
      "@capacitor/core": fake,
      "@capacitor/app": fake,
      "@capacitor/filesystem": fake,
      "@capacitor/share": fake,
    },
  });
  transfers = await dom.load("/src/transfers.ts");
  api = await dom.load("/src/api.ts");
  // The real node bridge; transfers.ts itself sees the switchable stand-in.
  ({ tailnetFetch } = await dom.load("/src/tailnet-transport.ts?real"));
  sharing = {
    ...(await dom.load("/src/native.ts")),
    ...(await dom.load("/test/dom/fakes/native-sharing.mjs")),
  };
  // The phone's network is real here: the harness's canned answers would
  // never touch a byte.
  globalThis.fetch = nodeFetch;
  globalThis.XMLHttpRequest = NodeXHR;
  function Probe() {
    for (const t of transfers.useTransfers()) seenTransfers.add(t);
    return null;
  }
  await dom.render(dom.React.createElement(Probe));
});
after(async () => {
  delete globalThis.__reachTailnetBrowser;
  await dom?.close();
});

async function computer(t, name = "Mac") {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "reach-integrity-")));
  const shared = path.join(dir, "shared");
  const dataDir = path.join(dir, "private");
  fs.mkdirSync(shared, { recursive: true });
  const options = { roots: [shared], dataDir, screen: false, agentDesktop: null };
  let reach = await createReach(options);
  await new Promise((r) => reach.server.listen(0, "127.0.0.1", r));
  const owner = reach.auth.issue("Owner", ALL_SCOPES, "device");
  const proxy = await faultProxy(reach.server.address().port);
  const peer = { id: name, name, url: proxy.url, token: owner.token, platform: "darwin" };
  t.after(async () => {
    await proxy.close();
    await reach.close();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return {
    dir,
    shared,
    dataDir,
    peer,
    proxy,
    owner,
    // The computer restarts: in-flight requests drop, upload sessions end.
    async restart() {
      await reach.close();
      reach = await createReach(options);
      await new Promise((r) => reach.server.listen(0, "127.0.0.1", r));
      proxy.retarget(reach.server.address().port);
    },
    // Straight to the server, as a browser's download manager goes.
    direct: (route, init = {}) =>
      nodeFetch(proxy.url + route, {
        ...init,
        headers: { Authorization: `Bearer ${owner.token}`, ...init.headers },
      }),
  };
}

const done = (t) => ["done", "failed", "canceled"].includes(t.state);
// Uploads through the app's own code; resolves once every file has landed or failed.
async function upload(mac, dir, files, timeout = 45000) {
  const before = new Set(seenTransfers);
  const landed = [];
  transfers.uploadFiles(mac.peer, 0, dir, files, (n) => landed.push(n));
  const mine = () => [...seenTransfers].filter((t) => !before.has(t) && t.kind === "upload");
  await dom.waitFor(() => mine().length === files.length && mine().every(done), timeout);
  return { landed, jobs: mine() };
}
const uploaded = async (mac, dir, files, timeout) => {
  const { landed, jobs } = await upload(mac, dir, files, timeout);
  for (const job of jobs) assert.equal(job.state, "done", `${job.name}: ${job.error}`);
  assert.deepEqual(landed, files.map((f) => f.name));
};
const file = (bytes, name) => new File([bytes], name);
const random = (n) => crypto.randomBytes(n);

// The landed file is the sent file, and no partial copy stays behind.
function assertLanded(mac, relative, bytes) {
  const landed = fs.readFileSync(path.join(mac.shared, relative));
  assert.equal(landed.length, bytes.length, `${relative}: size`);
  assert.equal(sha256(landed), sha256(bytes), `${relative}: contents`);
  const partial = path.join(mac.dataDir, "uploads-resumable");
  assert.deepEqual(
    fs.existsSync(partial) ? fs.readdirSync(partial).filter((n) => n.endsWith(".part")) : [],
    [],
    "no partial upload left behind",
  );
}

const entryOf = (mac, relative) => {
  const s = fs.statSync(path.join(mac.shared, relative));
  return { name: path.basename(relative), path: relative, size: s.size, type: "file" };
};
// What a phone gets: through the app (the iPhone app without background
// downloads, phones without the Tailscale app, Send to computer), the
// browser's download manager (/download/:token) and the iPhone app's
// background download (/api/files/content, read as iOS reads it).
async function assertDownloads(mac, relative, bytes) {
  const name = path.basename(relative);
  const blob = await transfers.downloadWithProgress(mac.peer, 0, entryOf(mac, relative));
  const viaApp = Buffer.from(await blob.arrayBuffer());
  assert.equal(viaApp.length, bytes.length, `${relative}: app download size`);
  assert.equal(sha256(viaApp), sha256(bytes), `${relative}: app download contents`);
  const qs = new URLSearchParams({ root: "0", path: relative });
  const { url } = await api.request(mac.peer, `/api/files/download-link?${qs}`);
  for (const [how, response] of [
    ["browser link", await nodeFetch(mac.peer.url + url, { headers: { "Accept-Encoding": "br, gzip, deflate" } })],
    ["background download", await mac.direct(`/api/files/content?${qs}`, { headers: { "Accept-Encoding": "br, gzip, deflate" } })],
  ]) {
    assert.equal(response.status, 200, `${relative}: ${how}`);
    // Never re-encoded on the way: what's counted is what's saved.
    assert.equal(response.headers.get("content-encoding"), null, `${relative}: ${how} encoding`);
    assert.equal(Number(response.headers.get("content-length")), bytes.length, `${relative}: ${how} length`);
    assert.equal(
      contentDisposition.parse(response.headers.get("content-disposition")).parameters.filename,
      name,
      `${relative}: ${how} saves under its own name`,
    );
    const got = Buffer.from(await response.arrayBuffer());
    assert.equal(sha256(got), sha256(bytes), `${relative}: ${how} contents`);
  }
}

test("files of every boundary size upload and download byte for byte", { timeout: 120000 }, async (t) => {
  const mac = await computer(t);
  const sizes = [0, 1, 2, CHUNK - 1, CHUNK, CHUNK + 1, 2 * CHUNK, 3 * CHUNK + 12345];
  const files = sizes.map((size, i) => ({ name: `size-${size}-${i}.bin`, bytes: random(size) }));
  await uploaded(mac, "", files.map((f) => file(f.bytes, f.name)), 90000);
  for (const f of files) {
    assertLanded(mac, f.name, f.bytes);
    await assertDownloads(mac, f.name, f.bytes);
  }
});

// Real files, as the phone and the Mac make them.
function png(width, height) {
  const row = width * 4 + 1;
  const raw = Buffer.alloc(row * height);
  const pixels = random(width * 4 * height);
  for (let y = 0; y < height; y++) pixels.copy(raw, y * row + 1, y * width * 4, (y + 1) * width * 4);
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc.unsigned(body));
    return Buffer.concat([length, body, sum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
const darwin = process.platform === "darwin";
function convert(source, format, out) {
  try {
    execFileSync("/usr/bin/sips", ["-s", "format", format, source, "--out", out], { stdio: "ignore" });
    return fs.readFileSync(out);
  } catch {
    return null;
  }
}
// A folder of everyday files, then zipped the ways people zip.
async function makeTrip(where) {
  const trip = path.join(where, "Trip");
  const put = (relative, bytes) => {
    fs.mkdirSync(path.dirname(path.join(trip, relative)), { recursive: true });
    fs.writeFileSync(path.join(trip, relative), bytes);
  };
  const picture = png(256, 256);
  fs.mkdirSync(trip);
  fs.writeFileSync(path.join(where, "picture.png"), picture);
  put("Photos/diagram.png", picture);
  const jpeg = darwin && convert(path.join(where, "picture.png"), "jpeg", path.join(where, "picture.jpg"));
  const heic = darwin && convert(path.join(where, "picture.png"), "heic", path.join(where, "picture.heic"));
  put("Photos/IMG_0001.JPG", jpeg || random(200000));
  put("Photos/📷 Beach 🎉.heic", heic || random(300000));
  put("Docs/Résumé final.pdf", Buffer.from("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n", "latin1"));
  put("Docs/notes & plans #1 (100%).txt", Buffer.from("﻿line one\r\nligne deux é\r\n行三\r\n", "utf8"));
  put("Docs/data.json", Buffer.from(JSON.stringify({ a: 1, list: [1, 2, 3], text: "x".repeat(5000) })));
  put("Docs/logo.svg", Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>'));
  put("Docs/empty.txt", Buffer.alloc(0));
  put("Docs/archive.gz", zlib.gzipSync(random(100000)));
  put("big.bin", random(3 * 1024 * 1024 + 7));
  fs.mkdirSync(path.join(trip, "Empty folder"));
  const zips = {};
  if (darwin) {
    // Finder's Compress.
    execFileSync("/usr/bin/ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", trip, path.join(where, "Trip finder.zip")]);
    zips.finder = "Trip finder.zip";
  }
  try {
    execFileSync("zip", ["-r", "-X", "-q", "Trip zip.zip", "Trip"], { cwd: where });
    zips.zip = "Trip zip.zip";
  } catch {}
  // Windows' own tar.exe crashed making this one (0xC0000005, nothing said;
  // Windows Server 2025, validation run 40220974633). Reach opens archives
  // itself (tar-stream, server/archives.mjs), whatever tar a computer has:
  // there it's made as archive-fixtures makes one, every entry included.
  if (process.platform === "win32") fs.writeFileSync(path.join(where, "Trip.tar.gz"), await tarFixture(tarEntries(where, "Trip"), true));
  else execFileSync("tar", ["-czf", "Trip.tar.gz", "Trip"], { cwd: where, env: { ...process.env, COPYFILE_DISABLE: "1" } });
  zips.tar = "Trip.tar.gz";
  return { trip, zips, jpeg, heic };
}
// A folder's tar entries, folders included, named from `where`.
function tarEntries(where, top) {
  const entries = [];
  const walk = (relative) => {
    entries.push({ name: `${relative}/`, type: "directory" });
    for (const entry of fs.readdirSync(path.join(where, relative), { withFileTypes: true })) {
      const inside = `${relative}/${entry.name}`;
      if (entry.isDirectory()) walk(inside);
      else entries.push({ name: inside, data: fs.readFileSync(path.join(where, inside)) });
    }
  };
  walk(top);
  return entries;
}
// Path (NFC) → contents hash, folders included.
function tree(dir, base = dir, out = {}) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const key = path.relative(base, full).normalize("NFC");
    if (entry.isDirectory()) {
      out[`${key}/`] = "folder";
      tree(full, base, out);
    } else out[key] = sha256(fs.readFileSync(full));
  }
  return out;
}

test("photos, documents and archives cross both ways unchanged, names included", { timeout: 120000 }, async (t) => {
  const mac = await computer(t);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "reach-integrity-src-"));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const { trip, zips } = await makeTrip(work);
  const sources = [
    ...Object.entries(tree(trip))
      .filter(([, v]) => v !== "folder")
      .map(([relative]) => ({ name: path.basename(relative), bytes: fs.readFileSync(path.join(trip, relative)) })),
    ...Object.values(zips).map((n) => ({ name: n, bytes: fs.readFileSync(path.join(work, n)) })),
  ];
  fs.mkdirSync(path.join(mac.shared, "From phone"));
  await uploaded(mac, "From phone", sources.map((s) => file(s.bytes, s.name)));
  const listing = await api.request(mac.peer, `/api/files?${new URLSearchParams({ root: "0", path: "From phone" })}`);
  assert.deepEqual(listing.items.map((i) => i.name).sort(), sources.map((s) => s.name).sort(), "listed under the names sent");
  for (const s of sources) {
    assertLanded(mac, `From phone/${s.name}`, s.bytes);
    await assertDownloads(mac, `From phone/${s.name}`, s.bytes);
  }
});

test("zips from Finder, zip and tar open on the computer with every file intact", { timeout: 120000 }, async (t) => {
  const mac = await computer(t);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "reach-integrity-src-"));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const { trip, zips } = await makeTrip(work);
  const expected = tree(trip);
  for (const [kind, name] of Object.entries(zips)) {
    fs.mkdirSync(path.join(mac.shared, kind));
    await uploaded(mac, kind, [file(fs.readFileSync(path.join(work, name)), name)]);
    const opened = await api.post(mac.peer, "/api/files/extract", { root: 0, path: `${kind}/${name}` });
    // One folder inside: it is kept, named as it was.
    assert.equal(opened.name, "Trip", `${kind}: opened folder name`);
    assert.deepEqual(tree(path.join(mac.shared, kind, "Trip")), expected, `${kind}: every file and folder, byte for byte`);
  }
});

test("Mac files with names a phone can't type still download whole, under their own name", async (t) => {
  const mac = await computer(t);
  const names = [
    "what?.txt",
    "star*.txt",
    "pipe|name.txt",
    'quote"d.txt',
    "trailing dot.",
    "100% done #1 & more.txt",
    "Résumé NFD.txt",
    "日本語ファイル.txt",
    "emoji 🎉.txt",
    `${"long ".repeat(48)}name.txt`,
    // Windows can't hold ? * | " in a name, nor keep its trailing dot: those
    // are a Mac's files only.
  ].filter((name) => process.platform !== "win32" || !/[?*|"]|\.$/.test(name));
  for (const name of names) {
    const bytes = random(1000 + name.length);
    fs.writeFileSync(path.join(mac.shared, name), bytes);
    await assertDownloads(mac, name, bytes);
  }
});

test("a chunk cut mid-way, a lost answer, and a lost completion still land the exact file", { timeout: 90000 }, async (t) => {
  const mac = await computer(t);
  const bytes = random(2 * CHUNK + 4321);
  // The second chunk is cut after 3 MB; the first chunk's answer never arrives;
  // the answer to "complete" is lost.
  let puts = 0;
  mac.proxy.next((req) => req.method === "PUT" && ++puts === 1, { dropResponse: true });
  mac.proxy.next((req) => req.method === "PUT" && req.url.includes(`offset=${CHUNK}`), { cutRequestAfter: 3 * 1024 * 1024 });
  mac.proxy.next(/^POST \/api\/files\/uploads\/\w+\/complete$/, { dropResponse: true });
  await uploaded(mac, "", [file(bytes, "faults.mov")], 80000);
  assert.equal(mac.proxy.pending(), 0, "every fault happened");
  assertLanded(mac, "faults.mov", bytes);
});

test("a phone switching networks mid-chunk (the computer's side left open) still finishes the upload", { timeout: 90000 }, async (t) => {
  const mac = await computer(t);
  const bytes = random(2 * CHUNK + 99);
  mac.proxy.next((req) => req.method === "PUT" && req.url.includes(`offset=${CHUNK}`), {
    cutRequestAfter: 2 * 1024 * 1024,
    half: true,
  });
  const { jobs } = await upload(mac, "", [file(bytes, "switch.mov")], 80000);
  assert.equal(mac.proxy.held().size, 1, "the old connection is still open on the computer");
  assert.equal(jobs[0].state, "done", jobs[0].error);
  assertLanded(mac, "switch.mov", bytes);
});

test("an upload keeps retrying while the network is still down when it asks where to resume", { timeout: 90000 }, async (t) => {
  const mac = await computer(t);
  const bytes = random(2 * CHUNK + 4242);
  // The chunk is cut, and the outage outlasts the first retries: both
  // "where was I?" checks and the chunk sent again in between find no network.
  const resend = (req) => req.method === "PUT" && req.url.includes(`offset=${CHUNK}`);
  mac.proxy.next(resend, { cutRequestAfter: 1024 * 1024 });
  mac.proxy.next(/^GET \/api\/files\/uploads\/\w+$/, { drop: true });
  mac.proxy.next(resend, { drop: true });
  mac.proxy.next(/^GET \/api\/files\/uploads\/\w+$/, { drop: true });
  await uploaded(mac, "", [file(bytes, "tunnel.mov")], 80000);
  assert.equal(mac.proxy.pending(), 0, "every fault happened");
  assertLanded(mac, "tunnel.mov", bytes);
});

test("a computer restarting mid-upload starts the file again and lands it exactly once", { timeout: 90000 }, async (t) => {
  const mac = await computer(t);
  const bytes = random(2 * CHUNK + 777);
  mac.proxy.next((req) => req.method === "PUT" && req.url.includes(`offset=${CHUNK}`), {
    cutRequestAfter: 1024 * 1024,
    then: () => mac.restart(),
  });
  await uploaded(mac, "", [file(bytes, "restart.mov")], 80000);
  assert.equal(mac.proxy.pending(), 0);
  assert.equal(mac.proxy.seen.filter((s) => s.route === "POST /api/files/uploads").length, 2, "started again after the restart");
  assertLanded(mac, "restart.mov", bytes);
  assert.deepEqual(fs.readdirSync(mac.shared), ["restart.mov"]);
});

test("a download cut mid-way resumes where it stopped; a file changed meanwhile starts over, never spliced", { timeout: 60000 }, async (t) => {
  const mac = await computer(t);
  const original = random(5 * 1024 * 1024 + 3);
  fs.writeFileSync(path.join(mac.shared, "clip.mov"), original);
  mac.proxy.next(/^GET \/api\/files\/content$/, { cutResponseAfter: 2 * 1024 * 1024 + 11 });
  let got = Buffer.from(await (await transfers.downloadWithProgress(mac.peer, 0, entryOf(mac, "clip.mov"))).arrayBuffer());
  assert.equal(sha256(got), sha256(original));
  const resumed = mac.proxy.seen.filter((s) => s.route === "GET /api/files/content");
  assert.equal(resumed.length, 2);
  const from = Number(/^bytes=(\d+)-$/.exec(resumed[1].range || "")?.[1]);
  assert.ok(from > 0 && from <= 2 * 1024 * 1024 + 11, `asked only for the rest (${resumed[1].range})`);

  // Cut again, and the file is replaced (same size) before the phone resumes.
  const replaced = random(original.length);
  mac.proxy.next(/^GET \/api\/files\/content$/, {
    cutResponseAfter: 1024 * 1024,
    then: () => {
      fs.writeFileSync(path.join(mac.shared, "clip.mov"), replaced);
      const later = new Date(Date.now() + 5000);
      fs.utimesSync(path.join(mac.shared, "clip.mov"), later, later);
    },
  });
  got = Buffer.from(await (await transfers.downloadWithProgress(mac.peer, 0, entryOf(mac, "clip.mov"))).arrayBuffer());
  assert.equal(sha256(got), sha256(replaced), "the whole new file, not the old start with the new end");
});

test("phones without the Tailscale app (the page's own tailnet node) upload and download exactly", { timeout: 120000 }, async (t) => {
  const mac = await computer(t);
  const node = goTailnetNode();
  globalThis.__reachTailnetBrowser = true;
  globalThis.fetch = (input, init) => tailnetFetch(node, input, init);
  t.after(() => {
    globalThis.__reachTailnetBrowser = false;
    globalThis.fetch = nodeFetch;
  });
  const files = [0, 1, CHUNK + 1, 2 * CHUNK + 7].map((size) => ({ name: `tailnet-${size}.bin`, bytes: random(size) }));
  // The largest file's second chunk is cut on the way up, and its download on
  // the way down (which the node reports as a clean, short end).
  const largest = files.at(-1).name;
  mac.proxy.next((req) => req.method === "PUT" && req.url.includes(`offset=${CHUNK}`) && Number(req.headers["content-length"]) > 4 * 1024 * 1024, { cutRequestAfter: 4 * 1024 * 1024 });
  await uploaded(mac, "", files.map((f) => file(f.bytes, f.name)), 100000);
  assert.equal(mac.proxy.pending(), 0, "the upload was cut");
  mac.proxy.next((req) => req.url.startsWith("/api/files/content?") && req.url.includes(`path=${largest}`), { cutResponseAfter: 3 * 1024 * 1024 });
  for (const f of files) {
    assertLanded(mac, f.name, f.bytes);
    const blob = await transfers.downloadWithProgress(mac.peer, 0, entryOf(mac, f.name));
    assert.equal(sha256(Buffer.from(await blob.arrayBuffer())), sha256(f.bytes), `${f.name}: download`);
  }
  assert.equal(mac.proxy.pending(), 0, "the download was cut");
  const reads = mac.proxy.seen.filter((s) => s.url.startsWith("/api/files/content?") && s.url.includes(`path=${largest}`));
  assert.equal(reads.length, 2);
  assert.match(reads[1].range || "", /^bytes=[1-9]\d*-$/, "resumed after the short end, not taken as complete");
  assert.equal(await transfers.downloadThroughBrowser(mac.peer, 0, entryOf(mac, files[1].name)), false, "never handed to a download manager that can't reach the computer");
});

test("a computer running an older Reach takes the one-request upload, names and bytes intact", { timeout: 60000 }, async (t) => {
  const mac = await computer(t);
  const files = [
    { name: "Résumé 📄 final.pdf", bytes: random(5 * 1024 * 1024 + 3) },
    { name: "empty.txt", bytes: Buffer.alloc(0) },
  ];
  for (const _ of files)
    mac.proxy.next(/^POST \/api\/files\/uploads$/, { answer: [404, { error: "This action does not exist." }] });
  await uploaded(mac, "", files.map((f) => file(f.bytes, f.name)));
  assert.equal(mac.proxy.seen.filter((s) => s.route === "POST /api/files/upload").length, files.length, "sent in one request each");
  for (const f of files) assertLanded(mac, f.name, f.bytes);
});

test("Send to another computer copies the exact file", { timeout: 60000 }, async (t) => {
  const from = await computer(t, "Studio");
  const to = await computer(t, "MacBook");
  const bytes = random(CHUNK + 5555);
  fs.writeFileSync(path.join(from.shared, "render.mp4"), bytes);
  await transfers.sendToComputer(from.peer, 0, entryOf(from, "render.mp4"), to.peer);
  assertLanded(to, "render.mp4", bytes);
});

test("a name already on the Mac is never overwritten, even spelled with other accents or case", { timeout: 60000 }, async (t) => {
  const mac = await computer(t);
  const kept = random(4096);
  fs.writeFileSync(path.join(mac.shared, "Résumé.txt"), kept);
  fs.writeFileSync(path.join(mac.shared, "photo.jpg"), kept);
  const sameNameOnDisk = (a, b) => fs.existsSync(path.join(mac.shared, b)) && fs.statSync(path.join(mac.shared, a)).ino === fs.statSync(path.join(mac.shared, b)).ino;
  const clashes = ["Résumé.txt", "Résumé.txt", "PHOTO.JPG"].filter((n) =>
    sameNameOnDisk(n === "PHOTO.JPG" ? "photo.jpg" : "Résumé.txt", n),
  );
  const { jobs } = await upload(mac, "", clashes.map((n) => file(random(10), n)));
  for (const job of jobs) {
    assert.equal(job.state, "failed", job.name);
    assert.match(job.error, /already exists/);
  }
  assert.equal(sha256(fs.readFileSync(path.join(mac.shared, "Résumé.txt"))), sha256(kept));
  assert.equal(sha256(fs.readFileSync(path.join(mac.shared, "photo.jpg"))), sha256(kept));
});

test("the iPhone app's Save step writes the exact bytes it downloaded", async () => {
  for (const size of [0, 1, 2, 3, 4, 65537, 1024 * 1024 + 1]) {
    sharing.reset();
    const bytes = random(size);
    await sharing.shareNativeFile(new dom.window.Blob([bytes], { type: "application/octet-stream" }), "photo.heic");
    const written = Buffer.from(sharing.state.writes[0].data, "base64");
    assert.equal(sha256(written), sha256(bytes), `${size} bytes`);
  }
});
