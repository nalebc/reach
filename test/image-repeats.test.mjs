import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAgentImages, imageSize, imageTokens } from "../server/agent-sessions/images.mjs";
import { createImageRepeats, repeatNote } from "../server/agent-sessions/image-repeats.mjs";
import { repeatedImages, visibleUserText } from "../server/agent-sessions/message-text.mjs";
import { createSavings } from "../server/savings.mjs";
import { createReach } from "../server/index.mjs";
import { ALL_SCOPES } from "../server/core.mjs";

// A picture sent again to the same chat goes as a note, not again: the chat
// still holds it from the first time. What that saved is kept, by agent.
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "reach-repeats-"));
const png = (width, height, tail = 0) => {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12, "latin1");
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  b[32] = tail;
  return b;
};

test("the same picture is the same id, kept once; a different one is another", async () => {
  const dir = tmp();
  const images = createAgentImages({ dir });
  const upload = (bytes) => {
    const file = path.join(dir, `up-${Math.random()}.tmp`);
    fs.writeFileSync(file, bytes);
    return images.add(file);
  };
  const a = await upload(png(800, 600));
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.png$/);
  assert.equal(await upload(png(800, 600)), a);
  assert.notEqual(await upload(png(800, 600, 1)), a);
  assert.equal(fs.readdirSync(dir).length, 2, "no temporary files left, one copy each");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("sizes come from the header; tokens follow each provider's published rules", () => {
  assert.deepEqual(imageSize(png(1092, 1092)), { width: 1092, height: 1092 });
  const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x0b, 0xd0, 0x0f, 0xc0, 0x03]);
  assert.deepEqual(imageSize(jpg), { width: 4032, height: 3024 });
  assert.equal(imageSize(Buffer.from("not an image")), null);
  // Claude's table: 1092x1092 and 784x1568 are about 1590; a phone photo is scaled to the same.
  assert.equal(imageTokens({ width: 1092, height: 1092 }, "claude"), 1590);
  assert.equal(imageTokens({ width: 784, height: 1568 }, "claude"), 1590);
  assert.equal(imageTokens({ width: 200, height: 200 }, "claude"), 53);
  // OpenAI: 1024x1024 is 768x768 after scaling, four tiles.
  assert.equal(imageTokens({ width: 1024, height: 1024 }, "codex"), 765);
  assert.equal(imageTokens(null, "claude"), 0);
});

test("a chat's pictures are remembered across restarts; only Claude Code and Codex skip repeats", () => {
  const dir = tmp();
  const file = path.join(dir, "repeats.json");
  const id = "11111111-2222-4333-8444-555555555555.png";
  const other = "aaaaaaaa-2222-4333-8444-555555555555.jpg";
  const repeats = createImageRepeats({ file });
  assert.deepEqual(repeats.split("claude", "c1", [id, id]), { fresh: [id], repeated: [] }, "twice in one message is once");
  repeats.add("claude", "c1", [id]);
  assert.deepEqual(createImageRepeats({ file }).split("claude", "c1", [id, other]), { fresh: [other], repeated: [id] });
  assert.deepEqual(repeats.split("claude", "c2", [id]), { fresh: [id], repeated: [] }, "another chat gets it");
  assert.deepEqual(repeats.split("gemini", "c1", [id]), { fresh: [id], repeated: [] });
  repeats.add("gemini", "c1", [id]);
  assert.equal(fs.readFileSync(file, "utf8").includes("gemini"), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the note names the files for the agent and shows on the phone as a tag, not text", () => {
  const note = repeatNote(["/data/agent-images/a.png"]);
  assert.match(note, /\/data\/agent-images\/a\.png/);
  assert.match(note, /open that file/);
  assert.equal(visibleUserText(`${note}\n\nWhat about this part?`), "What about this part?");
  assert.equal(repeatedImages(`${note}\n\nWhat about this part?`), 1);
  assert.equal(repeatedImages(repeatNote(["/a.png", "/b.png"])), 2);
  assert.equal(repeatedImages("Just words"), 0);
});

test("savings add up by agent and kind and survive a restart", () => {
  const dir = tmp();
  const file = path.join(dir, "savings.json");
  const savings = createSavings({ file, now: () => 1 });
  savings.record({ agent: "claude", kind: "image-repeat", tokens: 1590 });
  savings.record({ agent: "claude", kind: "image-repeat", tokens: 800, count: 2 });
  savings.record({ agent: "../x", kind: "image-repeat", tokens: 5 });
  const again = createSavings({ file });
  assert.deepEqual(again.totals("claude"), { tokens: 2390, kinds: { "image-repeat": { tokens: 2390, count: 3 } } });
  assert.deepEqual(again.totals("codex"), { tokens: 0, kinds: {} });
  assert.equal(again.events().length, 2);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("savings names are only keys: 'constructor' and 'prototype' never touch Object or its prototype", (t) => {
  const dir = tmp();
  t.after(() => {
    delete Object.prototype.tokens;
    delete Object.prototype.count;
    delete Object["image-repeat"];
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const file = path.join(dir, "savings.json");
  const savings = createSavings({ file, now: () => 1 });
  savings.record({ agent: "constructor", kind: "prototype", tokens: 7 });
  savings.record({ agent: "constructor", kind: "image-repeat", tokens: 3 });
  assert.equal(Object.hasOwn(Object.prototype, "tokens"), false);
  assert.equal(Object.hasOwn(Object.prototype, "count"), false);
  assert.equal(Object.hasOwn(Object, "image-repeat"), false);
  assert.equal({}.tokens, undefined);
  const expected = { tokens: 10, kinds: { prototype: { tokens: 7, count: 1 }, "image-repeat": { tokens: 3, count: 1 } } };
  assert.deepEqual(savings.totals("constructor"), expected);
  assert.deepEqual(savings.totals("hasownproperty"), { tokens: 0, kinds: {} });
  // Saved and read back the same; a hand-edited file can't plant either.
  assert.deepEqual(createSavings({ file }).totals("constructor"), expected);
  fs.writeFileSync(file, '{"totals":{"__proto__":{"x":{"tokens":1,"count":1}},"claude":{"__proto__":{"tokens":1},"image-repeat":{"tokens":"5","count":2}}},"events":[]}');
  const read = createSavings({ file });
  assert.deepEqual(read.totals("claude"), { tokens: 5, kinds: { "image-repeat": { tokens: 5, count: 2 } } });
  assert.equal({}.x, undefined);
});

test("sent again to the same chat, a picture goes as a note; the saving shows in health", async () => {
  const root = tmp();
  const sent = [];
  const reach = await createReach({
    roots: [root],
    dataDir: path.join(root, ".reach"),
    agentSessions: {
      list: async () => ({ sessions: [], errors: {} }),
      health: async () => [{ agent: "claude", installed: true, signedIn: true }],
      send: async (agent, id, body) => {
        if (body.text === "fail") throw Object.assign(new Error("Not now"), { status: 409 });
        sent.push({ agent, id, text: body.text, images: body.images.length });
        return visibleUserText(body.text) === "Busy" ? { queued: true, delivered: false } : { turnId: "t" };
      },
      read: async () => ({ session: { title: "Other chat", cwd: root }, items: [{ role: "user", text: "Earlier" }] }),
    },
  });
  await new Promise((r) => reach.server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${reach.server.address().port}`;
  const owner = reach.auth.issue("owner", ALL_SCOPES);
  const auth = { Authorization: `Bearer ${owner.token}` };
  try {
    const form = new FormData();
    form.append("file", new Blob([png(1092, 1092)]), "shot.png");
    const { id } = await (await fetch(`${url}/api/sessions/images`, { method: "POST", headers: auth, body: form })).json();
    const post = (chat, body) =>
      fetch(`${url}/api/sessions/claude/${chat}/messages`, { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    // A send that fails, or one only queued, doesn't count as the chat having it.
    assert.equal((await post("chat-1", { text: "fail", images: [id] })).status, 409);
    await post("chat-1", { text: "Busy", images: [id] });
    await post("chat-1", { text: "Look", images: [id] });
    await post("chat-1", { text: "And again", images: [id] });
    await post("chat-2", { text: "Look", images: [id] });
    // With a chat mentioned, the note still comes first, so it's stripped.
    await post("chat-1", { text: "Compare", images: [id], chats: [{ agent: "codex", id: "other-chat" }] });
    assert.deepEqual(sent.map((s) => [s.id, s.images]), [["chat-1", 1], ["chat-1", 1], ["chat-1", 0], ["chat-2", 1], ["chat-1", 0]]);
    assert.equal(sent[1].text, "Look");
    assert.equal(visibleUserText(sent[2].text), "And again");
    assert.equal(repeatedImages(sent[2].text), 1);
    assert.ok(sent[2].text.includes(path.join(root, ".reach", "agent-images", id)));
    assert.equal(visibleUserText(sent[4].text), "Compare");
    assert.equal(repeatedImages(sent[4].text), 1);
    const { agents } = await (await fetch(`${url}/api/sessions/health`, { headers: auth })).json();
    const saving = agents[0].savings;
    assert.equal(saving.kinds["image-repeat"].count, 2);
    assert.ok(saving.tokens > 2 * 1500 && saving.tokens < 2 * 1590, "both pictures, less the notes");
  } finally {
    reach.server.close();
    await reach.close?.();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
