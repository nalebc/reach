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
