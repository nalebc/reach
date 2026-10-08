import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { startDom, settle } from "./dom/harness.mjs";

const peer = { id: "mac", name: "Mac", url: "https://reach.test", token: "t", platform: "darwin" };
const sessions = Array.from({ length: 10 }, (_, folder) =>
  Array.from({ length: folder < 2 ? 15 : 1 }, (_, chat) => ({
    agent: "codex", id: `${folder}-${chat}`, title: `Chat ${folder}-${chat}`,
    cwd: `/work/folder-${folder}`, branch: "", origin: "reach", inApp: false,
    updatedAt: Date.now() - folder * 100000 - chat * 1000,
    createdAt: Date.now() - 1000000, status: "idle", preview: "", archived: false,
  })),
).flat();
let dom, ChatList, ChatHub;
before(async () => {
  dom = await startDom();
  ({ default: ChatList } = await dom.load("/src/ChatList.tsx"));
  ({ default: ChatHub } = await dom.load("/src/ChatHub.tsx"));
});
after(() => dom?.close());

for (const kind of ["agent", "all"]) {
  test(`${kind} list shows every folder and expands each folder independently`, async () => {
    const view = await dom.render(dom.React.createElement(kind === "agent" ? ChatList : ChatHub, {
      peer, sessions, logos: {}, agent: "codex", apps: [], appPending: {}, pending: 0,
      relays: [], onOpen: () => {}, onNew: () => {}, onAgentChange: () => {},
    }));
    await settle();
    const groups = () => [...dom.document.querySelectorAll(".chat-project-group")];
    assert.equal(groups().length, 10, "even folders beyond the former global cutoff are visible");
    const first = groups()[0];
    const second = groups()[1];
    const cards = (group) => group.querySelectorAll(".chat-card").length;
    assert.equal(cards(first), 4);
    assert.equal(cards(second), 4);
    const more = first.querySelector(".chat-list-more");
    assert.equal(more.textContent, "Show all 15");
    more.click();
    await settle();
    assert.equal(cards(first), 15);
    assert.equal(cards(second), 4);
    assert.equal(groups().length, 10);
    more.click();
    await settle();
    assert.equal(cards(first), 4);
    assert.equal(cards(second), 4);
    await view.unmount();
    assert.deepEqual(dom.errors, []);
  });
}
