import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { startDom } from "./dom/harness.mjs";

// Chat pictures stay in memory for the 80 most recently shown; a day of
// chats doesn't fill the phone. One shown again is fetched again.
let dom, sessionImage;
before(async () => {
  dom = await startDom();
  ({ sessionImage } = await dom.load("/src/agent-sessions.ts"));
});
after(async () => dom?.close());

test("the 80 most recently shown pictures are kept; the oldest is fetched again", async () => {
  const peer = { id: "mac", name: "Mac", url: "https://mac.test", token: "t" };
  const chat = { agent: "claude", id: "c1" };
  let fetched = 0;
  globalThis.fetch = dom.window.fetch = async () => {
    fetched++;
    return new Response(new Blob(["png"], { type: "image/png" }));
  };
  dom.window.URL.createObjectURL ??= () => "blob:test";
  dom.window.URL.revokeObjectURL ??= () => {};
  globalThis.URL.createObjectURL = dom.window.URL.createObjectURL;
  globalThis.URL.revokeObjectURL = dom.window.URL.revokeObjectURL;
  await sessionImage(peer, chat, "first", 0);
  for (let n = 0; n < 79; n++) await sessionImage(peer, chat, `item${n}`, 0);
  await sessionImage(peer, chat, "first", 0);
  assert.equal(fetched, 80, "within 80, shown again from memory");
  await sessionImage(peer, chat, "one-more", 0);
  // "first" was shown recently, so item0 is the oldest now.
  await sessionImage(peer, chat, "first", 0);
  assert.equal(fetched, 81);
  await sessionImage(peer, chat, "item0", 0);
  assert.equal(fetched, 82, "the oldest was let go and is fetched again");
});
