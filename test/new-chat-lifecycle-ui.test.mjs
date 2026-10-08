import test, { before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { startDom, settle, replaceText } from "./dom/harness.mjs";

const peer = { id: "mac", name: "Mac", url: "https://reach.test", token: "t", platform: "darwin" };
const draftKey = "reach-new-chat-draft:mac";
let dom, NewChat, finish;
const views = [];
const opened = [];
before(async () => {
  dom = await startDom({ routes: {
    "/api/sessions/models": () => ({ models: [], modes: [] }),
    "/api/sessions": () => new Promise((resolve) => { finish = resolve; }),
    "/api/sessions/images": () => ({ id: "image-1" }),
  } });
  ({ NewChat } = await dom.load("/src/EverythingChat.tsx"));
});
after(() => dom?.close());
afterEach(async () => {
  finish?.({ threadId: "created", turnId: null });
  await settle();
  for (const view of views.splice(0)) await view.unmount();
  finish = undefined;
  opened.length = 0;
  dom.window.sessionStorage.clear();
});
async function open() {
  const view = await dom.render(dom.React.createElement(NewChat, {
    peer, agent: "codex", sessions: [], folder: "/work", onStarted: (chat) => opened.push(chat),
  }));
  views.push(view);
  return view;
}

test("a new-chat response after closing cannot erase a newer draft or reopen the old chat", async () => {
  const old = await open();
  await replaceText(dom.document.querySelector("textarea"), "First request");
  dom.document.querySelector('[aria-label="Start"]').click();
  await dom.waitFor(() => finish);
  await old.unmount();
  views.splice(views.indexOf(old), 1);
  await open();
  await replaceText(dom.document.querySelector("textarea"), "A different draft");
  finish({ threadId: "created", turnId: null });
  await settle();
  assert.equal(dom.window.sessionStorage.getItem(draftKey), "A different draft");
  assert.equal(dom.document.querySelector("textarea").value, "A different draft");
  assert.deepEqual(opened, []);
});

test("closing an image draft releases the attachment preview", async (t) => {
  const revoked = [];
  t.mock.method(URL, "createObjectURL", () => "blob:chat-preview");
  t.mock.method(URL, "revokeObjectURL", (url) => revoked.push(url));
  const view = await open();
  const field = dom.document.querySelector('input[type="file"]');
  Object.defineProperty(field, "files", { configurable: true, value: [new File(["image"], "photo.png", { type: "image/png" })] });
  field.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  await dom.waitFor(() => dom.document.querySelector('img[src="blob:chat-preview"]'));
  await view.unmount();
  views.splice(views.indexOf(view), 1);
  assert.deepEqual(revoked, ["blob:chat-preview"]);
});

test("a chat created after its composer closed doesn't come back as a draft to send twice", async () => {
  const old = await open();
  await replaceText(dom.document.querySelector("textarea"), "Only once");
  dom.document.querySelector('[aria-label="Start"]').click();
  await dom.waitFor(() => finish);
  await old.unmount();
  views.splice(views.indexOf(old), 1);
  finish({ threadId: "created", turnId: null });
  await settle();
  assert.equal(dom.window.sessionStorage.getItem(draftKey), null);
  await open();
  assert.equal(dom.document.querySelector("textarea").value, "");
});
