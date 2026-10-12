import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { codexImageData, createCodexSessions } from "../server/agent-sessions/codex.mjs";

// A picture sent in a Codex chat showed on the phone as "1 image". Codex keeps
// it inline (a data URL) or as a file on the Mac; the phone gets the image's
// own bytes, and never another file a message's path might name.
const ID = "0199aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee";
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201a5f6a3a80000000049454e44ae426082", "hex");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-codex-images-"));
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
const file = (name, data) => {
  const where = path.join(dir, name);
  fs.writeFileSync(where, data);
  return where;
};

test("an inline picture or a picture file comes back as the image it is", async () => {
  const inline = await codexImageData({ type: "image", url: `data:image/png;base64,${PNG.toString("base64")}` });
  assert.equal(inline.type, "image/png");
  assert.ok(inline.data.equals(PNG));
  const onDisk = await codexImageData({ type: "localImage", path: file("shot.png", PNG) });
  assert.equal(onDisk.type, "image/png");
  // Named like a picture, but not one: nothing.
  assert.equal(await codexImageData({ type: "localImage", path: file("notes.png", "my secret notes") }), null);
  assert.equal(await codexImageData({ type: "localImage", path: path.join(dir, "gone.png") }), null);
  assert.equal(await codexImageData({ type: "localImage", path: "relative/shot.png" }), null);
  assert.equal(await codexImageData({ type: "image", url: "https://example.com/a.png" }), null, "nothing fetched");
  assert.equal(await codexImageData({ type: "image", url: "data:text/html;base64,PGgxPg==" }), null);
  assert.equal(await codexImageData({ type: "localImage", path: file("big.png", PNG) }, { maxBytes: 10 }), null);
});

// CodeQL #163: a picture file was measured by its path, then read by its path
// again: swapped for a pipe in between, the read waited for a writer forever.
// Now one open file is measured and read, never past the limit.
test("a picture file swapped for a pipe once it's measured is still read at once, as the picture it was", { skip: process.platform === "win32" }, async (t) => {
  const pic = file("swapped.png", PNG);
  const pipe = path.join(dir, "pipe");
  const { execFileSync } = await import("node:child_process");
  execFileSync("mkfifo", [pipe]);
  const handle = await fs.promises.open(pic);
  const FileHandle = Object.getPrototypeOf(handle);
  await handle.close();
  // Whichever way it's measured (by its path, or once open), the pipe takes its name right after.
  for (const owner of [fs.promises, FileHandle]) {
    const measure = owner.stat;
    t.mock.method(owner, "stat", async function (...args) {
      const info = await measure.apply(this, args);
      if (info.isFile?.() && fs.existsSync(pipe)) fs.renameSync(pipe, pic);
      return info;
    });
  }
  // A read left waiting on the pipe is let go at the end (a writer opens and closes it).
  t.after(() => { try { fs.closeSync(fs.openSync(pic, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK)); } catch {} });
  const read = codexImageData({ type: "localImage", path: pic });
  const image = await Promise.race([read, new Promise((resolve) => setTimeout(resolve, 2000, "waiting"))]);
  assert.notEqual(image, "waiting", "the read waited on a pipe");
  assert.ok(image?.data.equals(PNG));
});

test("a chat's picture is found by its message, read lately or a page back", async () => {
  const pic = file("flower.png", PNG);
  const items = [
    { item: { type: "userMessage", id: "u2", content: [{ type: "text", text: "and this" }, { type: "localImage", path: pic }] } },
    { item: { type: "agentMessage", id: "a1", text: "Ice plants." } },
    { item: { type: "userMessage", id: "u1", content: [{ type: "image", url: `data:image/png;base64,${PNG.toString("base64")}` }] } },
  ];
  const calls = [];
  const daemon = {
    onNotification() {},
    rpc: async (method, params) => {
      calls.push(method);
      if (method === "thread/items/list") return params.cursor ? { data: items.slice(1) } : { data: items.slice(0, 1), nextCursor: "page-2" };
      return {};
    },
  };
  const codex = createCodexSessions({ daemon, holder: async () => null, appState: () => ({ threads: {} }), runningElsewhere: (s) => s });
  assert.equal((await codex.image(ID, "u1", 0)).type, "image/png", "found a page back");
  assert.ok((await codex.image(ID, "u2", 0)).data.equals(PNG));
  await assert.rejects(codex.image(ID, "u2", 1), (e) => e.status === 404);
  await assert.rejects(codex.image(ID, "a1", 0), (e) => e.status === 404);
  await assert.rejects(codex.image("not-a-thread", "u1", 0), (e) => e.status === 404);
});

test("pictures kept from a read stay within 32 MB; one left out is found again in the thread", async () => {
  // 60 messages, each with a ~1 MB pasted picture (base64, as the Codex app keeps them).
  const big = `data:image/png;base64,${PNG.toString("base64")}${"A".repeat(1024 * 1024)}`;
  const items = Array.from({ length: 60 }, (_, n) => ({ item: { type: "userMessage", id: `u${n}`, content: [{ type: "text", text: `shot ${n}` }, { type: "image", url: big }] } }));
  const calls = [];
  const daemon = {
    onNotification() {},
    rpc: async (method) => {
      calls.push(method);
      if (method === "thread/read") return { thread: { id: ID } };
      if (method === "thread/items/list") return { data: items };
      return { data: [] };
    },
  };
  const codex = createCodexSessions({ daemon, holder: async () => null, appState: () => ({ threads: {} }), runningElsewhere: (s) => s });
  await codex.read(ID, { limit: 200 });
  const listed = () => calls.filter((m) => m === "thread/items/list").length;
  const before = listed();
  // The newest are kept: asked for, no new look in the thread.
  await codex.image(ID, "u59", 0).catch(() => null);
  assert.equal(listed(), before, "kept from the read");
  // The oldest went past 32 MB: looked up in the thread again.
  await codex.image(ID, "u0", 0).catch(() => null);
  assert.equal(listed(), before + 1, "found again in the thread");
});
