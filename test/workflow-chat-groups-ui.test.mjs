import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { startDom, settle, typeInto } from "./dom/harness.mjs";

const localPeer = { id: "local", name: "Local Mac", url: "https://reach.test", token: "local-token", platform: "darwin" };
const peer = localPeer;
const remote = { ...localPeer, id: "remote", name: "Remote Mac", url: "https://remote.test", token: "remote-token" };
const now = Date.now();
const chat = (id, extra = {}) => ({
  agent: "codex", id, title: `Chat ${id}`, cwd: "/work/reach", branch: "", origin: "reach", inApp: false,
  createdAt: now - 100000, updatedAt: now - 1000, status: "idle", archived: false, preview: "", ...extra,
});
const workflow = (chats) => ({
  id: "workflow", title: "Release checks", cwd: "/work/reach", state: "running", problem: "",
  createdAt: now - 100000, updatedAt: now,
  tasks: chats.map((s, i) => ({ id: `task-${i}`, title: s.title, agent: s.agent, kind: "build", together: false, state: "working", chat: { agent: s.agent, id: s.id } })),
});
let dom, ChatList, ChatHub, remoteChats = [];
before(async () => {
  dom = await startDom({ routes: {
    "/api/sessions": () => ({ sessions: remoteChats, errors: {} }),
    "/api/sessions/health": () => ({ agents: [] }),
    "/api/sessions/overlaps": () => ({ chats: [], overlaps: [] }),
  } });
  ({ default: ChatList } = await dom.load("/src/ChatList.tsx"));
  ({ default: ChatHub } = await dom.load("/src/ChatHub.tsx"));
});
after(() => dom?.close());

// Each mount is a fresh tab: the chat list remembers its search and folders
// for the tab (src/view-memory.ts), and one test's search must not filter the
// next test's list (Oct 25: "Unique release" left 0 chats in the next two).
let tabs = 0;
async function mount(t, kind, sessions, flows, extra = {}) {
  const peer = { ...localPeer, workspaceKey: `tab-${++tabs}` };
  const props = {
    peer, sessions, logos: {}, agent: "codex", apps: [], appPending: {}, pending: 0, relays: [],
    onOpen() {}, onNew() {}, onAgentChange() {},
    workflows: { active: flows.length, paused: 0, list: flows, onOpen() {}, onOpenFlow() {} }, ...extra,
  };
  const view = await dom.render(dom.React.createElement(kind === "agent" ? ChatList : ChatHub, props));
  t.after(async () => { await view.unmount(); assert.deepEqual(dom.errors, []); });
  return { ...view, props };
}
const visible = (container) => [...container.querySelectorAll(".chat-card")].map((b) => b.getAttribute("aria-label"));

for (const kind of ["agent", "all"]) {
  for (const status of ["waiting", "running"]) test(`${kind}: grouping idle workflow siblings keeps another ${status} chat visible`, async (t) => {
    const tasks = Array.from({ length: 9 }, (_, i) => chat(`flow-${i}`, {
      updatedAt: now - i * 1000,
      ...(i === 0 ? { status, ...(status === "waiting" ? { prompts: [{ id: "first", kind: "tool", title: "First approval" }] } : {}) } : {}),
    }));
    const other = chat("other-active", { updatedAt: now - 500, status, ...(status === "waiting" ? { prompts: [{ id: "second", kind: "tool", title: "Second approval" }] } : {}) });
    const view = await mount(t, kind, [...tasks, other], [workflow(tasks)]);
    assert.ok(visible(view.container).includes("Chat other-active, Codex"), "the second active chat must remain visible before expanding the folder");
  });

  test(`${kind}: an idle workflow folds into one line that unfolds without losing or duplicating chats`, async (t) => {
    const tasks = Array.from({ length: 10 }, (_, i) => chat(`flow-${i}`, { updatedAt: now - i * 1000 }));
    const other = chat("outside", { updatedAt: now - 20000 });
    const view = await mount(t, kind, [...tasks, other], [workflow(tasks)]);
    const first = visible(view.container);
    assert.deepEqual(first, ["Chat flow-0, Codex", "Chat outside, Codex"]);
    assert.equal(view.container.querySelectorAll(".chat-flow").length, 1);
    assert.equal(view.container.querySelector(".chat-list-more"), null, "nothing else to show");
    const more = view.container.querySelector(".chat-flow-more");
    assert.equal(more.textContent, "9 more chats");
    more.click(); await settle();
    assert.equal(visible(view.container).length, 11);
    assert.equal(new Set(visible(view.container)).size, 11);
    more.click(); await settle();
    assert.deepEqual(visible(view.container), first);
  });

  test(`${kind}: one working chat brings its whole workflow together, idle ones folded`, async (t) => {
    const tasks = Array.from({ length: 6 }, (_, i) => chat(`flow-${i}`, { updatedAt: now - (i + 1) * 60000 }));
    tasks[3].status = "running";
    const between = chat("between", { updatedAt: now - 90000 });
    const view = await mount(t, kind, [...tasks, between], [workflow(tasks)]);
    assert.equal(view.container.querySelectorAll(".chat-flow").length, 1, "never split by time");
    assert.deepEqual(visible(view.container), ["Chat flow-3, Codex", "Chat between, Codex"]);
    assert.equal(view.container.querySelector(".chat-flow-more").textContent, "5 more chats");
  });

  test(`${kind}: the folder's Show all leaves its workflows folded`, async (t) => {
    const tasks = Array.from({ length: 4 }, (_, i) => chat(`flow-${i}`, { updatedAt: now - i * 1000 }));
    const others = Array.from({ length: 5 }, (_, i) => chat(`other-${i}`, { updatedAt: now - (10 + i) * 1000 }));
    const view = await mount(t, kind, [...tasks, ...others], [workflow(tasks)]);
    // Four lines: the workflow's latest, its "3 more chats", two others.
    assert.deepEqual(visible(view.container), ["Chat flow-0, Codex", "Chat other-0, Codex", "Chat other-1, Codex"]);
    const more = view.container.querySelector(".chat-list-more");
    assert.equal(more.textContent, "Show all 6", "counts only the chats it brings");
    more.click(); await settle();
    assert.equal(visible(view.container).length, 6);
    assert.equal(view.container.querySelector(".chat-flow-more").textContent, "3 more chats");
  });
}

test("all: running workflow siblings cannot displace a chat awaiting approval", async (t) => {
  const tasks = Array.from({ length: 9 }, (_, i) => chat(`flow-${i}`, { updatedAt: now - i * 1000, status: i === 0 ? "waiting" : "running" }));
  const other = chat("approval", { updatedAt: now - 500, status: "waiting" });
  const view = await mount(t, "all", [...tasks, other], [workflow(tasks)]);
  assert.ok(visible(view.container).includes("Chat approval, Codex"), "the approval stays in view");
  assert.equal(view.container.querySelector(".chat-flow-more").textContent, "6 more chats", "past three at work, the rest fold");
});

test("agent: workflow grouping preserves chat search and excludes archived members", async (t) => {
  const tasks = [chat("matching", { title: "Unique release fix" }), chat("unrelated"), chat("archived", { archived: true })];
  const view = await mount(t, "agent", tasks, [workflow(tasks)]);
  assert.equal(visible(view.container).length, 2);
  view.container.querySelector('button[aria-label="Search chats"]').click();
  await settle();
  const input = view.container.querySelector('input[aria-label="Search chats"]');
  await typeInto(input, "Unique release");
  await settle();
  assert.deepEqual(visible(view.container), ["Unique release fix, Codex"]);
  assert.equal(view.container.querySelectorAll(".chat-flow").length, 1);
});

test("all: matching chat IDs on another computer cannot open the local workflow", async (t) => {
  const localChat = chat("shared-id");
  remoteChats = [chat("shared-id", { title: "Remote chat" })];
  t.after(() => { remoteChats = []; });
  const opened = [];
  const view = await mount(t, "all", [localChat], [workflow([localChat])], {
    computers: [peer, remote], onOpenOn: (computer, selected) => opened.push([computer.id, selected.id]),
  });
  await dom.waitFor(() => view.container.querySelectorAll(".chat-project-group").length === 2);
  const remoteGroup = [...view.container.querySelectorAll(".chat-project-group")].find((g) => g.getAttribute("aria-label").endsWith("on Remote Mac"));
  assert.ok(remoteGroup, "the remote computer's project is present");
  assert.equal(remoteGroup.querySelector(".chat-flow"), null);
  remoteGroup.querySelector(".chat-card").click(); await settle();
  assert.deepEqual(opened, [["remote", "shared-id"]]);
  assert.equal(view.container.querySelectorAll(".chat-flow-head").length, 1);
});

test("agent: a task's earlier chat (tried again) still sits with its workflow, by its name and folder", async (t) => {
  const tasks = [chat("current", { title: "Verify everyday use", status: "running" })];
  const earlier = chat("earlier", { title: "Workflow · Verify everyday use", createdAt: now - 50000, updatedAt: now - 40000 });
  const elsewhere = chat("elsewhere", { title: "Workflow · Verify everyday use", cwd: "/work/other", updatedAt: now - 30000 });
  const view = await mount(t, "agent", [...tasks, earlier, elsewhere], [workflow(tasks)]);
  const group = view.container.querySelector(".chat-flow");
  assert.deepEqual([...group.querySelectorAll(".chat-card")].map((b) => b.getAttribute("aria-label")), ["Verify everyday use, Codex", "Workflow · Verify everyday use, Codex"]);
  assert.equal(view.container.querySelectorAll(".chat-flow").length, 1, "another folder's chat of that name stays out");
});

test("agent: a task's earlier tries sit with its workflow by id, whatever their name", async (t) => {
  const tasks = [chat("current", { status: "running" })];
  const earlier = chat("earlier-try", { title: "Some other name", updatedAt: now - 40000 });
  const flow = workflow(tasks);
  flow.tasks[0].tries = [{ agent: "codex", id: "earlier-try" }];
  const view = await mount(t, "agent", [...tasks, earlier], [flow]);
  assert.equal(view.container.querySelectorAll(".chat-flow .chat-card").length, 2);
});
