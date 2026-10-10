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

// As the Claude app files them: a worktree chat under its repo, by the app's
// own project (originCwd) or the worktree's path.
for (const kind of ["agent", "all"]) {
  test(`${kind} list groups Claude worktree chats under their repo`, async () => {
    const chat = (id, cwd, extra = {}) => ({
      agent: "claude", id, title: `Chat ${id}`, cwd, branch: "", origin: "app", inApp: true,
      updatedAt: Date.now(), createdAt: Date.now() - 1000, status: "idle", preview: "", archived: false, ...extra,
    });
    const view = await dom.render(dom.React.createElement(kind === "agent" ? ChatList : ChatHub, {
      peer, logos: {}, agent: "claude", apps: [], appPending: {}, pending: 0,
      sessions: [chat("a", "/r"), chat("b", "/r/.claude/worktrees/x"), chat("c", "/elsewhere/w", { project: "/r" })],
      relays: [], onOpen: () => {}, onNew: () => {}, onAgentChange: () => {},
    }));
    await settle();
    const groups = [...dom.document.querySelectorAll(".chat-project-group")];
    assert.equal(groups.length, 1);
    assert.equal(groups[0].querySelectorAll(".chat-card").length, 3);
    await view.unmount();
    assert.deepEqual(dom.errors, []);
  });
}

test("Codex chats group as the Codex app's projects: by its name, its subfolders included", async () => {
  const chat = (id, cwd, ago) => ({ ...sessions[0], id, title: `Chat ${id}`, cwd, updatedAt: Date.now() - ago });
  const view = await dom.render(dom.React.createElement(ChatList, {
    peer, logos: {}, agent: "codex", apps: [], appPending: {}, pending: 0,
    onOpen: () => {}, onNew: () => {}, onAgentChange: () => {},
    sessions: [chat("a", "/work/durable", 1), chat("b", "/work/durable/api", 2), chat("c", "/work/durable-old", 3), chat("d", "/work/other", 4)],
    projects: [{ id: "p1", name: "durable-session", roots: ["/work/durable"] }],
  }));
  await settle();
  const groups = [...dom.document.querySelectorAll(".chat-project-group")].map((g) => [
    g.querySelector(".chat-project-name").textContent,
    g.querySelectorAll(".chat-card").length,
  ]);
  assert.deepEqual(groups, [["durable-session", 2], ["durable-old", 1], ["other", 1]]);
  await view.unmount();
  assert.deepEqual(dom.errors, []);
});

test("on a Windows PC, Codex chats in a project's subfolder group under it too", async () => {
  const chat = (id, cwd, ago) => ({ ...sessions[0], id, title: `Chat ${id}`, cwd, updatedAt: Date.now() - ago });
  const view = await dom.render(dom.React.createElement(ChatList, {
    peer: { ...peer, platform: "win32" }, logos: {}, agent: "codex", apps: [], appPending: {}, pending: 0,
    onOpen: () => {}, onNew: () => {}, onAgentChange: () => {},
    sessions: [chat("a", "C:\\work\\durable", 1), chat("b", "C:\\work\\durable\\api", 2), chat("c", "C:\\work\\durable-old", 3)],
    projects: [{ id: "p1", name: "durable-session", roots: ["C:\\work\\durable\\"] }],
  }));
  await settle();
  const groups = [...dom.document.querySelectorAll(".chat-project-group")].map((g) => [
    g.querySelector(".chat-project-name").textContent,
    g.querySelectorAll(".chat-card").length,
  ]);
  assert.deepEqual(groups, [["durable-session", 2], ["durable-old", 1]]);
  await view.unmount();
  assert.deepEqual(dom.errors, []);
});
