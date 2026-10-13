import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { startDom } from "./dom/harness.mjs";

const peer = { id: "local", name: "Local Mac", url: "https://reach.test", token: "fixture", platform: "darwin" };
const now = Date.now();
const chat = (id, extra = {}) => ({
  agent: "codex", id, title: `Chat ${id}`, cwd: "/work/reach", branch: "", origin: "reach", inApp: false,
  createdAt: now - 1000, updatedAt: now - 1000, status: "idle", archived: false, preview: "", ...extra,
});
const flow = (id, chats = [], extra = {}) => ({
  id, title: `Workflow ${id}`, cwd: "/work/reach", state: "running", problem: "",
  createdAt: now - 10000, updatedAt: now,
  tasks: chats.map((s, i) => ({ id: `task-${i}`, title: s.title, agent: s.agent, kind: "build", together: false, state: "working", chat: { agent: s.agent, id: s.id } })),
  ...extra,
});
let dom, ChatList, ChatHub, flowFinder;
before(async () => {
  dom = await startDom();
  ({ default: ChatList, flowFinder } = await dom.load("/src/ChatList.tsx"));
  ({ default: ChatHub } = await dom.load("/src/ChatHub.tsx"));
});
after(() => dom?.close());

async function mount(t, kind, sessions, workflows) {
  const view = await dom.render(dom.React.createElement(kind === "agent" ? ChatList : ChatHub, {
    peer, sessions, logos: {}, agent: "codex", apps: [], appPending: {}, pending: 0, relays: [],
    onOpen() {}, onNew() {}, onAgentChange() {},
    workflows: { active: workflows.length, paused: 0, list: workflows, onOpen() {}, onOpenFlow() {} },
  }));
  t.after(async () => { await view.unmount(); assert.deepEqual(dom.errors, []); });
  return view;
}
const visibleChats = (view) => [...view.container.querySelectorAll(".chat-card")].map((b) => b.getAttribute("aria-label"));

for (const kind of ["agent", "all"]) test(`${kind}: a large workflow cannot hide an unrelated approval originally second in the folder`, async (t) => {
  const tasks = Array.from({ length: 9 }, (_, i) => chat(`flow-${i}`, { status: "waiting", updatedAt: now - i * 1000 }));
  const other = chat("other-approval", { status: "waiting", updatedAt: now - 500 });
  const view = await mount(t, kind, [...tasks, other], [flow("large", tasks)]);
  assert.ok(visibleChats(view).includes("Chat other-approval, Codex"), "grouping must not push a previously visible approval behind Show all");
});

for (const kind of ["agent", "all"]) {
  test(`${kind}: approvals across workflows stay ahead of newer running chats`, async (t) => {
    const first = Array.from({ length: 9 }, (_, i) => chat(`first-${i}`, { status: "waiting", updatedAt: now - i * 1000 }));
    const second = Array.from({ length: 3 }, (_, i) => chat(`second-${i}`, { status: "waiting", updatedAt: now - (i + 10) * 1000 }));
    const running = Array.from({ length: 9 }, (_, i) => chat(`running-${i}`, { status: "running", updatedAt: now + (10 - i) * 1000 }));
    const other = chat("other-approval", { status: "waiting", updatedAt: now - 20000 });
    const view = await mount(t, kind, [...first, ...running, ...second, other], [flow("first", first), flow("second", second), flow("running", running)]);
    const visible = visibleChats(view);
    for (const s of [...first, ...second, other]) assert.ok(visible.includes(`${s.title}, Codex`), `${s.id} approval stays visible`);
    assert.equal(visible.some((label) => label.startsWith("Chat running-")), false, "running-only work cannot consume the approval preview");
  });

  test(`${kind}: ordinary running chats retain a bounded folder preview`, async (t) => {
    const sessions = Array.from({ length: 12 }, (_, i) => chat(`running-${i}`, { status: "running", updatedAt: now - i * 1000 }));
    const view = await mount(t, kind, sessions, []);
    assert.equal(visibleChats(view).length, 8);
    assert.equal(view.container.querySelector(".chat-list-more").textContent, "Show all 12");
  });
}

const reviewFlow = (id, agent = "codex", extra = {}) => flow(id, [chat(`${id}-latest`, { agent, title: "Review" })], extra);
const retry = (extra = {}) => chat("earlier-attempt", { title: "Workflow · Review", ...extra });

test("workflow title fallback never claims a Claude chat", () => {
  assert.equal(flowFinder([reviewFlow("codex")])(retry({ agent: "claude" })), undefined);
});

test("workflow title fallback cannot match a task assigned to a different agent", () => {
  assert.equal(flowFinder([reviewFlow("claude", "claude")])(retry()), undefined);
});

test("workflow title fallback rejects ambiguous same-folder task names", () => {
  const older = reviewFlow("older");
  const newer = reviewFlow("newer", "codex", { createdAt: now - 5000 });
  assert.equal(flowFinder([older, newer])(retry()), undefined, "a shared title cannot identify which workflow started a retry");
});

test("workflow title fallback keeps an unambiguous earlier Codex attempt", () => {
  const only = reviewFlow("only");
  assert.equal(flowFinder([only])(retry()), only);
});

test("explicit workflow chat identity wins over ambiguous fallback names", () => {
  const owner = reviewFlow("owner");
  const other = reviewFlow("other", "codex", { createdAt: now - 5000 });
  assert.equal(flowFinder([owner, other])(retry({ id: "owner-latest" })), owner);
});
