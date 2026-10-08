import test, { before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { startDom, settle, typeInto, replaceText } from "./dom/harness.mjs";

// Workflows on the phone (src/Workflows.tsx, docs/WORKFLOWS.md) through the
// real components: planned from New chat, written by hand, run, and listed
// on the All page. The computer is a stand-in that records what was sent.

const peer = { id: "mac", name: "Mac", url: "https://reach.test", token: "test-token", platform: "darwin" };
const LOGO = "data:image/png;base64,iVBORw0KGgo=";
const WF = "wf-1";
const both = [
  { agent: "codex", installed: true, signedIn: true, usable: true },
  { agent: "claude", installed: true, signedIn: true, usable: true },
];
const session = (extra = {}) => ({
  agent: "codex",
  id: "0199aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee",
  title: "Fix login",
  cwd: "/work/app",
  branch: "main",
  origin: "app",
  inApp: true,
  updatedAt: Date.now(),
  createdAt: Date.now(),
  status: "idle",
  preview: "",
  archived: false,
  ...extra,
});
const task = (id, extra = {}) => ({ id, title: "", agent: "codex", kind: "build", together: false, task: "", state: "waiting", updatedAt: 1, ...extra });
const workflow = (extra = {}) => ({ id: WF, state: "draft", title: "Passkeys", cwd: "/work/app", problem: "", createdAt: 1, updatedAt: 1, tasks: [], ...extra });

// The stand-in computer: the workflow it holds, and what the phone sent.
const mac = {
  sent: [],
  held: {},
  clock: 10,
  reset() {
    this.sent = [];
    this.held = {};
    this.clock = 10;
  },
};
const sent = (route) => mac.sent.filter((s) => s.route === route);
const json = (init) => (init?.body ? JSON.parse(init.body) : null);
const hold = (w) => (mac.held[w.id] = { ...w, updatedAt: ++mac.clock });
const routes = {
  "/api/sessions/models": () => ({ models: [], modes: [], mode: null }),
  "/api/sessions/health": () => ({ agents: both }),
  "/api/sessions/logos": () => ({ version: "v1", logos: { codex: LOGO, claude: LOGO } }),
  "/api/sessions/commands": () => ({ commands: [] }),
  "/api/sessions": () => ({ sessions: [], errors: {} }),
  "/api/sessions/workflows/plan": (init) => {
    mac.sent.push({ route: "plan", body: json(init) });
    const w = hold(workflow({ title: "Add passkey sign-in", planner: { agent: "codex", id: "codex-plan", title: "Plan · Add passkey sign-in", working: true } }));
    return { workflow: w, threadId: "codex-plan" };
  },
  "/api/sessions/workflows": (init) => {
    if (init?.method !== "POST") return { workflows: Object.values(mac.held) };
    mac.sent.push({ route: "create", body: json(init) });
    return { workflow: hold(workflow({ title: json(init).title || "Workflow" })) };
  },
};
// One workflow's own routes: read, edit, and each action.
for (const id of [WF, "wf-2"]) {
  routes[`/api/sessions/workflows/${id}`] = (init) => {
    if (init?.method !== "POST") return { ...mac.held[id], version: `v${mac.held[id]?.updatedAt}` };
    const body = json(init);
    mac.sent.push({ route: "edit", body });
    let n = Math.max(0, ...(mac.held[id].tasks || []).map((t) => Number(t.id.slice(1)) || 0));
    const tasks = body.tasks.map((t) => ({ ...task(t.id || `t${++n}`), ...t, id: t.id || `t${n}` }));
    return { workflow: hold({ ...mac.held[id], title: body.title ?? mac.held[id].title, tasks }) };
  };
  for (const action of ["run", "stop", "resume", "proposal", "again", "remove"])
    routes[`/api/sessions/workflows/${id}/${action}`] = (init) => {
      mac.sent.push({ route: action, body: json(init) });
      return mac.answers?.[action]?.() ?? { workflow: mac.held[id] };
    };
  for (const t of ["t1", "t2", "t3"])
    for (const action of ["retry", "skip", "done"])
      routes[`/api/sessions/workflows/${id}/tasks/${t}/${action}`] = (init) => {
        mac.sent.push({ route: `${t}/${action}`, body: json(init) });
        return mac.answers?.[action]?.() ?? { workflow: mac.held[id] };
      };
}

let dom, React, EverythingChat, WorkflowSheet;
before(async () => {
  dom = await startDom({ mobile: true, routes });
  React = dom.React;
  ({ default: EverythingChat } = await dom.load("/src/EverythingChat.tsx"));
  ({ WorkflowSheet } = await dom.load("/src/Workflows.tsx"));
});
after(() => dom?.close());
beforeEach(() => {
  dom.errors.length = 0;
  mac.reset();
  mac.answers = {};
  dom.window.localStorage.clear();
  dom.window.sessionStorage.clear();
});
const views = [];
afterEach(async () => {
  for (const view of views.splice(0)) await view.unmount();
});
const mount = async (element) => {
  const view = await dom.render(element);
  views.push(view);
  return view;
};
const $ = (selector) => dom.document.querySelector(selector);
const $$ = (selector) => [...dom.document.querySelectorAll(selector)];
const button = (label, within = dom.document) =>
  [...within.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === label || b.textContent.trim() === label);
const click = async (element) => {
  assert.ok(element, "button exists");
  element.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  await settle();
};
const rows = () => $$(".workflow-sheet .wf-item > button.wf-item-main").map((b) => b.getAttribute("aria-label"));
const steps = () => $$(".workflow-sheet .wf-step:not(.wf-skeleton)").map((s) => [s.querySelector(".wf-label").textContent, s.querySelectorAll(".wf-item").length]);
const home = (extra = {}) =>
  mount(
    React.createElement(EverythingChat, {
      peer,
      feed: { sessions: [session()], errors: {}, health: both, failure: "", relays: [], workflows: [], reload: async () => {}, recheck: () => {}, ...extra },
    }),
  );
// Read again now (the page polls every few seconds).
const look = async () => {
  dom.document.dispatchEvent(new dom.window.Event("visibilitychange"));
  await settle(30);
};

test("New chat → Workflow: the planner drafts the tasks, you edit one, and Run runs it", async () => {
  dom.window.localStorage.setItem("reach.chatAgent", "all");
  await home();
  assert.ok(button("Workflows"), "an icon at the top of Chat");
  await click(await dom.waitFor(() => button("New chat")));
  const sheet = await dom.waitFor(() => $(".chat-create-sheet"));
  assert.ok(sheet.querySelector(".as-mode-pick"), "a chat picks its permissions");
  await click(button("Workflow", sheet));
  assert.equal(button("Workflow", sheet).getAttribute("aria-pressed"), "true");
  assert.equal(sheet.querySelector(".as-mode-pick"), null, "the planner only reads: no permission to pick");
  assert.match(sheet.querySelector(".wf-intro").textContent, /Codex drafts the tasks · you review first/);
  await typeInto(sheet.querySelector('textarea[aria-label="Workflow planned by Codex"]'), "Add passkey sign-in, with tests");
  await click(button("Plan workflow", sheet));
  await dom.waitFor(() => sent("plan").length === 1);
  assert.deepEqual(sent("plan")[0].body, { cwd: "/work/app", text: "Add passkey sign-in, with tests", images: [], agent: "codex" });
  // Its page: planning, a tap from the planner's chat.
  const page = await dom.waitFor(() => $(".workflow-sheet"));
  assert.equal($(".chat-create-sheet"), null);
  assert.equal(page.querySelector("h2").textContent, "Add passkey sign-in");
  assert.match(page.querySelector(".wf-planner").textContent, /Planning…/);
  assert.ok(page.querySelector(".wf-skeleton"), "rows to come while it plans");
  // The plan arrives.
  hold({
    ...mac.held[WF],
    title: "Passkeys",
    planner: { ...mac.held[WF].planner, working: false },
    tasks: [
      task("t1", { title: "Build sign-in", task: "Add WebAuthn in src/auth." }),
      task("t2", { title: "Review it", agent: "claude", kind: "review", together: false, task: "Check src/auth." }),
    ],
  });
  await look();
  await dom.waitFor(() => rows().length === 2);
  assert.deepEqual(rows(), ["Task 1: Build sign-in, Codex · Make changes", "Task 2: Review it, Claude Code · Review only"]);
  assert.match(page.querySelector(".wf-planner").textContent, /Planned by Codex/);
  assert.match(page.querySelector(".wf-meta").textContent, /app·2 tasks/);
  // A tap opens a task; its name changes and is saved a moment later, ids kept.
  await click($$(".wf-item > button.wf-item-main")[1]);
  await replaceText($('input[aria-label="Task 2 title"]'), "Review sign-in");
  await dom.waitFor(() => sent("edit").length === 1, 3000);
  assert.deepEqual(
    sent("edit")[0].body.tasks.map((t) => [t.id, t.title, t.agent, t.kind]),
    [
      ["t1", "Build sign-in", "codex", "build"],
      ["t2", "Review sign-in", "claude", "review"],
    ],
  );
  mac.answers.run = () => ({ workflow: hold({ ...mac.held[WF], state: "running", tasks: mac.held[WF].tasks.map((t, i) => ({ ...t, state: i ? "waiting" : "working" })) }) });
  await click(button("Run workflow", page));
  await dom.waitFor(() => sent("run").length === 1);
  await dom.waitFor(() => /Running · 0 of 2/.test(page.querySelector(".wf-meta").textContent));
  assert.deepEqual(rows(), ["Task 1: Build sign-in, Working…", "Task 2: Review sign-in, Codex · Waiting".replace("Codex", "Claude Code")]);
  assert.ok(button("Edit", page) && button("Stop", page));
  assert.deepEqual(dom.errors, []);
});

test("writing the tasks yourself: add, choose agent, build or review, with previous, move and remove", async () => {
  dom.window.localStorage.setItem("reach.chatAgent", "all");
  await home();
  await click(await dom.waitFor(() => button("New chat")));
  const sheet = await dom.waitFor(() => $(".chat-create-sheet"));
  await click(button("Workflow", sheet));
  await typeInto(sheet.querySelector("textarea"), "Pagination");
  await click(button("Write tasks myself", sheet));
  await dom.waitFor(() => sent("create").length === 1);
  assert.deepEqual(sent("create")[0].body, { cwd: "/work/app", title: "Pagination" });
  const page = await dom.waitFor(() => $(".workflow-sheet"));
  assert.equal(button("Run workflow", page).disabled, true, "a task first");
  assert.deepEqual(
    $$(".wf-dashed strong").map((s) => s.textContent),
    ["Build, then review", "Build, review, fix", "Two reviews", "Empty task"],
    "starting points, then a blank task",
  );
  await click(button("Empty task", page));
  await typeInto($('textarea[aria-label="Task 1: what to do"]'), "Add ?page= to /api/items.");
  await click(button("Add task", page));
  // The new task opens; it's Codex's (as the one before), switched to Claude Code.
  const agent = $('select[aria-label="Task 2 agent"]');
  agent.value = "claude";
  agent.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  await settle();
  await click(button("Review only", page));
  await click($('input[aria-label="Start task 2 with the one above"]'));
  await typeInto($('textarea[aria-label="Task 2: what to do"]'), "Check the paging.");
  await dom.waitFor(() => sent("edit").at(-1)?.body.tasks[1]?.task === "Check the paging.", 3000);
  assert.deepEqual(
    sent("edit").at(-1).body.tasks.map(({ agent, kind, together, task }) => ({ agent, kind, together, task })),
    [
      { agent: "codex", kind: "build", together: false, task: "Add ?page= to /api/items." },
      { agent: "claude", kind: "review", together: true, task: "Check the paging." },
    ],
  );
  // Starting with the one above: the same step.
  await dom.waitFor(() => JSON.stringify(steps()) === JSON.stringify([["Step 1 · together", 2]]));
  // Moved up, then removed.
  await click(button("Move task 2 up", page));
  await dom.waitFor(() => sent("edit").at(-1)?.body.tasks[0]?.task === "Check the paging.", 3000);
  await click(button("Remove task 1", page));
  await dom.waitFor(() => sent("edit").at(-1)?.body.tasks.length === 1, 3000);
  assert.equal(sent("edit").at(-1).body.tasks[0].task, "Add ?page= to /api/items.");
  assert.deepEqual(dom.errors, []);
});

test("a run that paused: each row says how it stands, the stopped one offers Retry, Skip or Mark done, Stop asks first", async () => {
  const opened = [];
  hold(
    workflow({
      state: "paused",
      problem: "“Two”: Codex ran out of usage.",
      tasks: [
        task("t1", { title: "One", state: "done", summary: "Added the API.", files: ["src/api.ts", "src/db.ts"], chat: { agent: "codex", id: "c1", title: "Workflow · One" } }),
        task("t2", { title: "Two", state: "stopped", problem: "Codex ran out of usage.", chat: { agent: "codex", id: "c2", title: "Workflow · Two" } }),
        task("t3", { title: "Three", agent: "claude", kind: "review", together: true }),
      ],
    }),
  );
  await mount(React.createElement(WorkflowSheet, { peer, id: WF, logos: { codex: LOGO, claude: LOGO }, onOpenChat: (c) => opened.push(c), onClose() {} }));
  const page = await dom.waitFor(() => $(".workflow-sheet .wf-step") && $(".workflow-sheet"));
  assert.deepEqual(rows(), ["Task 1: One, Done · 2 files", "Task 2: Two, Stopped", "Task 3: Three, Claude Code · Waiting"]);
  assert.equal(page.querySelector(".wf-paused"), null, "the stopped task's row says why");
  assert.deepEqual(steps(), [["Step 1", 1], ["Step 2 · together", 2]], "Three starts with Two");
  assert.deepEqual($$(".wf-item-value").map((v) => v.textContent), ["Done", "Stopped", "Waiting"]);
  // The stopped task is open: why, and what you can do.
  const open = $(".wf-item.open");
  assert.match(open.textContent, /Codex ran out of usage\./);
  assert.equal(button("Continue", page), undefined, "a stopped task first");
  await click(button("Open chat", open));
  assert.deepEqual(opened, [{ agent: "codex", id: "c2", title: "Workflow · Two" }]);
  mac.answers.retry = () => ({ workflow: hold({ ...mac.held[WF], state: "running", problem: "", tasks: mac.held[WF].tasks.map((t) => (t.id === "t2" ? { ...t, state: "working", problem: undefined } : t)) }) });
  await click(button("Retry", open));
  await dom.waitFor(() => sent("t2/retry").length === 1);
  await dom.waitFor(() => /Running · 1 of 3/.test(page.querySelector(".wf-meta").textContent));
  // Stop asks first.
  await click(button("Stop", page));
  const ask = await dom.waitFor(() => $('[aria-label="Stop all tasks?"]'));
  assert.equal(sent("stop").length, 0);
  mac.answers.stop = () => (hold({ ...mac.held[WF], state: "stopped" }), { stopped: true });
  await click(button("Stop", ask));
  await dom.waitFor(() => sent("stop").length === 1);
  await look();
  await dom.waitFor(() => /Stopped/.test(page.querySelector(".wf-meta").textContent));
  // Run again: a copy to edit, on this page.
  mac.answers.again = () => ({ workflow: hold(workflow({ id: "wf-2", title: "Passkeys", tasks: [task("t1", { title: "One", task: "x" })] })) });
  await click(button("Run again", page));
  await dom.waitFor(() => /1 task/.test(page.querySelector(".wf-meta")?.textContent || "") && button("Run workflow", $(".workflow-sheet")));
  assert.deepEqual(dom.errors, []);
});

test("the Workflows icon opens them all: Active (waiting on you first), Drafts and Done, each opening its page", async () => {
  dom.window.localStorage.setItem("reach.chatAgent", "all");
  const now = Date.now();
  const listed = [
    workflow({ id: WF, state: "running", title: "Pagination", updatedAt: now, tasks: [task("t1", { state: "done" }), task("t2", { state: "working" })] }),
    workflow({ id: "wf-2", state: "paused", title: "Passkeys", problem: "x", updatedAt: now - 1000, tasks: [task("t1", { state: "stopped" })] }),
    workflow({ id: "wf-3", state: "draft", title: "Dark mode", updatedAt: now - 2000, tasks: [task("t1")] }),
    workflow({ id: "wf-4", state: "done", title: "Old", updatedAt: now - 3000, tasks: [task("t1", { state: "done" })] }),
  ];
  hold(listed[0]);
  await home({ workflows: listed });
  assert.equal($(".hub-workflows"), null, "no card on the All page");
  const icon = await dom.waitFor(() => button("Workflows, 2 active, 1 paused"));
  assert.equal(icon.querySelector(".chat-workflows-count").textContent, "2");
  await click(icon);
  let page = await dom.waitFor(() => $(".workflows-page"));
  const tabs = () => [...page.querySelectorAll('[role="tab"]')].map((b) => `${b.textContent}${b.getAttribute("aria-selected") === "true" ? "*" : ""}`);
  const lines = () => [...page.querySelectorAll(".wf-flow")].map((b) => b.getAttribute("aria-label"));
  assert.deepEqual(tabs(), ["Active*", "Drafts", "Done"]);
  assert.deepEqual(lines(), ["Passkeys, Paused", "Pagination, 1 of 2"], "the one waiting on you first");
  await click(button("Drafts", page));
  assert.deepEqual(lines(), ["Dark mode, 1 task"]);
  await click(button("Done", page));
  assert.deepEqual(lines(), ["Old, Done"]);
  // A row opens its page; closing it comes back to the list.
  await click(button("Active", page));
  await click([...page.querySelectorAll(".wf-flow")][1]);
  const sheet = await dom.waitFor(() => $(".workflow-sheet:not(.workflows-page) .wf-step") && $(".workflow-sheet:not(.workflows-page)"));
  assert.equal(sheet.querySelector("h2").textContent, "Pagination");
  assert.equal($(".workflows-page"), null);
  await click(button("Close pagination", sheet));
  page = await dom.waitFor(() => $(".workflows-page"));
  // New workflow: New chat, on Workflow; once closed, New chat is a chat again.
  await click(button("New workflow", page));
  let newChat = await dom.waitFor(() => $(".chat-create-sheet"));
  assert.equal(button("Workflow", newChat).getAttribute("aria-pressed"), "true");
  await click(button("Close new conversation", newChat));
  await click(button("New chat"));
  newChat = await dom.waitFor(() => $(".chat-create-sheet"));
  assert.equal(button("Solo", newChat).getAttribute("aria-pressed"), "true");
  assert.deepEqual(dom.errors, []);
});

test("every agent's list has the icon too; with none yet, its page says how to start", async () => {
  dom.window.localStorage.setItem("reach.chatAgent", "codex");
  // One agent: no All page, the icon is still there.
  await home({ workflows: [], health: [both[0]] });
  const icon = await dom.waitFor(() => button("Workflows"));
  assert.equal(icon.querySelector(".chat-workflows-count"), null, "nothing running: no count");
  await click(icon);
  const page = await dom.waitFor(() => $(".workflows-page"));
  assert.match(page.textContent, /Start your first workflow/);
  await click(button("New workflow", page));
  const newChat = await dom.waitFor(() => $(".chat-create-sheet"));
  assert.equal(button("Workflow", newChat).getAttribute("aria-pressed"), "true");
  // Only the icon: the ≡ menu doesn't repeat it.
  await click(button("Close new conversation", newChat));
  await click(button("Chat list menu"));
  assert.ok($$('[role="menuitem"]').length > 0);
  assert.ok(!$$('[role="menuitem"]').some((b) => b.textContent.trim() === "Workflows"));
  assert.deepEqual(dom.errors, []);
});

test("an empty draft starts from a starting point: the agents placed, what to build left to you", async () => {
  dom.window.localStorage.setItem("reach.chatAgent", "all");
  await home();
  await click(await dom.waitFor(() => button("New chat")));
  const sheet = await dom.waitFor(() => $(".chat-create-sheet"));
  await click(button("Workflow", sheet));
  await click(button("Write tasks myself", sheet));
  const page = await dom.waitFor(() => $(".workflow-sheet"));
  await click(button("Build, then reviewCodex builds · Claude Code reviews", page) || [...page.querySelectorAll(".wf-dashed")][0]);
  // The build is open for its words; the review says what to check already.
  const text = await dom.waitFor(() => $('textarea[aria-label="Task 1: what to do"]'));
  await typeInto(text, "Add dark mode to the settings page.");
  await dom.waitFor(() => sent("edit").at(-1)?.body.tasks[0]?.task === "Add dark mode to the settings page.", 3000);
  assert.deepEqual(
    sent("edit").at(-1).body.tasks.map(({ title, agent, kind, task }) => ({ title, agent, kind, task })),
    [
      { title: "Build", agent: "codex", kind: "build", task: "Add dark mode to the settings page." },
      { title: "Review", agent: "claude", kind: "review", task: "Review what the build changed." },
    ],
  );
  assert.equal($$(".wf-dashed strong").map((s) => s.textContent).join(), "Add task", "starting points only while it's empty");
  assert.deepEqual(dom.errors, []);
});
