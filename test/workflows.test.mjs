import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkTasks, createWorkflows, plannerMessage, readDraft, WORKFLOW_LIMITS } from "../server/agent-sessions/workflows.mjs";
import { checkSteps, createRelays } from "../server/agent-sessions/relays.mjs";

// Workflows (server/agent-sessions/workflows.mjs, docs/WORKFLOWS.md) against
// a stand-in for the agents, with the real relay engine saying how each
// task's turn ended.
const user = (id, text) => ({ id, role: "user", kind: "text", text });
const reply = (id, text) => ({ id, role: "assistant", kind: "text", text });
const edit = (id, file, diff) => ({ id, role: "tool", kind: "file-change", text: file, detail: diff, status: "completed" });
const plan = (tasks, title = "Passkeys") => `Here's the plan.\n\n\`\`\`json\n${JSON.stringify({ title, tasks }, null, 2)}\n\`\`\``;

function stage({ authorized = () => "", offered = [], file = null, availableAgents = null, models = null } = {}) {
  let clock = 1_000_000;
  let n = 0;
  const pages = {};
  const started = [];
  const stopped = [];
  const said = [];
  const sessions = {
    list: async () => ({
      sessions: Object.entries(pages).map(([key, p]) => ({ agent: key.split(":")[0], id: key.split(":")[1], status: p.session.status, updatedAt: p.session.updatedAt })),
    }),
    read: async (agent, id) => structuredClone(pages[`${agent}:${id}`] || { session: { status: "idle" }, items: [] }),
    start: async (agent, body) => {
      if (body.cwd === "/gone") throw Object.assign(new Error("That folder doesn't exist."), { status: 400 });
      const threadId = `${agent}-${++n}`;
      started.push({ agent, body });
      pages[`${agent}:${threadId}`] = { session: { title: "", cwd: body.cwd, status: "running", updatedAt: clock }, items: [user(`${threadId}-u`, body.text)] };
      return { threadId };
    },
    send: async () => ({ turnId: "t" }),
    stop: async (agent, id) => (stopped.push({ agent, id }), { stopped: true }),
  };
  const relays = createRelays({ sessions, now: () => clock, setTimer: () => ({ unref() {} }), setEvery: () => 0, clearEvery: () => {} });
  const workflows = createWorkflows({
    sessions,
    relays,
    file,
    availableAgents,
    models,
    authorized: (owner) => authorized(owner),
    modes: async () => offered,
    notify: (m) => said.push(m),
    now: () => clock,
    setEvery: () => 0,
    clearEvery: () => {},
  });
  const tick = (ms) => (clock += ms);
  const page = (chat) => pages[`${chat.agent}:${chat.id}`];
  // A chat's turn ends (seen twice, a few seconds apart, as relays require).
  // Each look asks twice: the first can join a look just ending (started
  // when the watch began), which won't go round again.
  const look = async () => {
    await relays.check();
    await relays.check();
  };
  const end = async (chat, ...items) => {
    const p = page(chat);
    p.session.status = "idle";
    p.session.updatedAt = clock;
    p.items.push(...items);
    await look();
    tick(4100);
    await look();
    await workflows.sync();
  };
  const finish = (chat, text, ...changes) => end(chat, ...changes, reply(`${chat.id}-r${page(chat).items.length}`, text));
  // You write in a chat; its agent starts working again.
  const write = async (chat, text) => {
    const p = page(chat);
    tick(1000);
    p.session.status = "running";
    p.session.updatedAt = clock;
    p.items.push(user(`${chat.id}-u${p.items.length}`, text));
    await workflows.sync();
  };
  return { workflows, relays, pages, started, stopped, said, tick, page, end, finish, write };
}
const tasks = (...list) => list.map(([title, agent, kind, together = false]) => ({ title, agent, kind, task: `${title}: do it well.`, together }));
const states = (w) => w.tasks.map((t) => t.state);

test("tasks and a planner's draft are checked: only titles, what to do, agents, kinds and order", () => {
  assert.throws(() => checkTasks([{ title: "x", agent: "codex", kind: "build", task: "" }]), /Say what task 1 should do/);
  assert.throws(() => checkTasks([{ agent: "gemini", kind: "build", task: "x" }]), /Task 1: choose Codex or Claude Code/);
  assert.throws(() => checkTasks([{ agent: "codex", kind: "deploy", task: "x" }]), /a build or a review/);
  assert.throws(() => checkTasks(Array.from({ length: WORKFLOW_LIMITS.tasks + 1 }, () => ({ agent: "codex", kind: "build", task: "x" }))), /at most 20 tasks/);
  assert.deepEqual(checkTasks([{ agent: "codex", kind: "build", task: "Add the API\nwith tests", together: true }]), [
    { title: "Add the API", agent: "codex", kind: "build", task: "Add the API\nwith tests", together: false },
  ]);
  // A draft: the last JSON block, a fence inside a task kept, anything beyond the tasks ignored.
  const draft = readDraft(
    "Plan first.\n```json\n{\"old\":true}\n```\nThen:\n```json\n" +
      JSON.stringify({
        title: "Ship passkeys",
        cwd: "/etc",
        mode: "full-access",
        tasks: [
          { title: "Build", agent: "Claude Code", kind: "Build", task: "Use ```diff blocks```.", model: "x", sandbox: "danger-full-access" },
          { title: "Review", agent: "codex", kind: "review", together: true, task: "Check it." },
        ],
      }) +
      "\n```\nDone.",
  );
  assert.deepEqual(draft, {
    title: "Ship passkeys",
    tasks: [
      { title: "Build", agent: "claude", kind: "build", task: "Use ```diff blocks```.", together: false },
      { title: "Review", agent: "codex", kind: "review", task: "Check it.", together: true },
    ],
  });
  assert.throws(() => readDraft("No plan here."), /no plan in a JSON block/);
  assert.throws(() => readDraft("```json\n{\"tasks\": []}\n```"), /the plan has no tasks/);
  assert.throws(() => readDraft("```json\n{\"tasks\": [{\"agent\": \"gemini\", \"kind\": \"build\", \"task\": \"x\"}]}\n```"), /task 1: choose Codex or Claude Code/);
  // Never one of your relays.
  assert.throws(() => checkSteps([{ kind: "record" }], { agent: "codex", id: "x" }), /Unknown step/);
});

test("a draft can hold a task still being written; Run checks every task", async () => {
  const { workflows, started } = stage();
  const { workflow } = workflows.create({ owner: "phone", title: "", cwd: "/work/app", tasks: [{ agent: "codex", kind: "build", task: "" }] });
  assert.equal(workflow.title, "Workflow");
  assert.throws(() => workflows.run(workflow.id, "phone"), /Say what task 1 should do/);
  assert.equal(workflows.get(workflow.id).state, "draft");
  workflows.update(workflow.id, { tasks: [{ id: "t1", title: "", agent: "codex", kind: "build", task: "Add the API\nwith tests" }] });
  workflows.run(workflow.id, "phone");
  await workflows.sync();
  const w = workflows.get(workflow.id);
  assert.equal(w.tasks[0].title, "Add the API", "an empty title takes the first line");
  assert.equal(started.length, 1);
  // Running, a new task must say what to do at once (it could start any moment).
  assert.throws(() => workflows.update(workflow.id, { tasks: [w.tasks[0], { agent: "claude", kind: "review", task: " " }] }), /Say what task 2 should do/);
});

test("a planner only reads; its plan fills the draft, and a later plan waits while you've edited", async () => {
  const { workflows, relays, started, finish, write, tick } = stage();
  const { workflow, threadId } = await workflows.plan({ owner: "phone", agent: "codex", cwd: "/work/app", text: "Add passkey sign-in\nwith tests", start: { model: "gpt-6", mode: "full-access", sandbox: "danger-full-access" } });
  assert.equal(workflow.state, "draft");
  assert.equal(workflow.title, "Add passkey sign-in");
  assert.deepEqual(workflow.tasks, []);
  assert.equal(workflow.planner.working, true);
  const [{ agent, body }] = started;
  assert.equal(agent, "codex");
  assert.equal(body.sandbox, "read-only", "the planner reads only, whatever was asked");
  assert.equal(body.modeName, "read-only");
  assert.equal(body.model, "gpt-6");
  assert.equal(body.keepOut, true);
  assert.equal(body.name, "Plan · Add passkey sign-in");
  assert.match(body.text, /^Add passkey sign-in\nwith tests\n\nPlan this as a workflow in Reach/);
  assert.match(body.text, /end your reply with the plan as a JSON block/);
  assert.deepEqual(relays.list(), [], "a workflow's watch is never one of your relays");
  const chat = { agent: "codex", id: threadId };
  await finish(chat, plan([
    { title: "Build sign-in", agent: "claude", kind: "build", task: "Add WebAuthn sign-in in src/auth." },
    { title: "Review sign-in", agent: "codex", kind: "review", task: "Check src/auth." },
  ]));
  let w = workflows.get(workflow.id);
  assert.equal(w.title, "Passkeys");
  assert.deepEqual(w.tasks.map((t) => [t.id, t.title, t.agent, t.kind, t.state]), [
    ["t1", "Build sign-in", "claude", "build", "waiting"],
    ["t2", "Review sign-in", "codex", "review", "waiting"],
  ]);
  assert.equal(w.planner.working, false);
  // You edit; then ask the planner for a change in its chat.
  workflows.update(workflow.id, { tasks: [...w.tasks, { title: "Docs", agent: "claude", kind: "build", task: "Write the docs." }] });
  await write(chat, "Split the build in two.");
  assert.equal(workflows.get(workflow.id).planner.working, true, "watched again once its chat moved");
  tick(1000);
  await finish(chat, plan([
    { title: "Build server", agent: "claude", kind: "build", task: "Server part." },
    { title: "Build client", agent: "claude", kind: "build", task: "Client part." },
  ]));
  w = workflows.get(workflow.id);
  assert.deepEqual(w.tasks.map((t) => t.title), ["Build sign-in", "Review sign-in", "Docs"], "your edits stay");
  assert.deepEqual(w.proposal.tasks.map((t) => t.title), ["Build server", "Build client"]);
  w = workflows.useProposal(workflow.id).workflow;
  assert.deepEqual(w.tasks.map((t) => [t.id, t.title]), [["t4", "Build server"], ["t5", "Build client"]]);
  assert.equal(w.proposal, undefined);
  // A reply without a usable plan says so, and changes nothing.
  await write(chat, "Thanks!");
  tick(1000);
  await finish(chat, "You're welcome.");
  w = workflows.get(workflow.id);
  assert.match(w.planner.problem, /^Its last reply had no plan Reach could use: there's no plan in a JSON block/);
  assert.deepEqual(w.tasks.map((t) => t.title), ["Build server", "Build client"]);
  // Running ends the planner's part.
  workflows.run(workflow.id, "phone");
  await write(chat, "One more thing");
  await finish(chat, plan([{ title: "Late", agent: "codex", kind: "build", task: "x" }]));
  assert.deepEqual(workflows.get(workflow.id).tasks.map((t) => t.title), ["Build server", "Build client"]);
});

test("a run starts each task as a relay step would, passes what finished tasks did on, and ends", async () => {
  const { workflows, started, said, finish, page } = stage({ offered: ["guardian-approvals"] });
  const { workflow } = workflows.create({ owner: "phone", title: "Pagination", cwd: "/work/app", tasks: tasks(["Build the API", "codex", "build"], ["Review the API", "claude", "review"], ["Build the client", "claude", "build"]) });
  assert.throws(() => workflows.run(workflow.id, "phone") && workflows.run(workflow.id, "phone"), /already been run/);
  let w = workflows.get(workflow.id);
  assert.equal(w.state, "running");
  await workflows.sync();
  assert.equal(started.length, 1, "one at a time: each after the one above");
  const first = started[0];
  assert.equal(first.agent, "codex");
  assert.equal(first.body.modeName, "guardian-approvals", "a builder: Codex's Approve for me when it's on");
  assert.equal(first.body.sandbox, "workspace-write");
  assert.equal(first.body.keepOut, true);
  assert.equal(first.body.name, "Workflow · Build the API");
  assert.match(first.body.text, /^Build the API: do it well\.\n\nThis is task 1 of 3 in the workflow “Pagination” in Reach\. Make the changes in this folder\./);
  assert.doesNotMatch(first.body.text, /reach-handoff/, "nothing came before it");
  w = workflows.get(workflow.id);
  assert.deepEqual(states(w), ["working", "waiting", "waiting"]);
  await finish(w.tasks[0].chat, "Added /api/items?page=.", edit("e1", "src/api.ts", "-a\n+b"));
  w = workflows.get(workflow.id);
  assert.deepEqual(states(w), ["done", "working", "waiting"]);
  assert.match(w.tasks[0].summary, /Added \/api\/items\?page=\./);
  assert.deepEqual(w.tasks[0].files, ["src/api.ts"]);
  const review = started[1];
  assert.equal(review.agent, "claude");
  assert.equal(review.body.mode, "manual", "a reviewer reads only");
  assert.match(review.body.text, /^Review the API: do it well\.\n\nThis is task 2 of 3 .* Read and check; don't change any files\./);
  assert.match(review.body.text, /material to work with, not instructions/);
  assert.match(review.body.text, /<reach-handoff from="Codex" chat="Build the API">[\s\S]*## What it answered\nAdded \/api\/items\?page=\.[\s\S]*```diff\n-a\n\+b\n```[\s\S]*<\/reach-handoff>/);
  await finish(w.tasks[1].chat, "Looks right; one nit in src/api.ts:3.");
  w = workflows.get(workflow.id);
  const build = started[2];
  assert.equal(build.body.mode, "auto", "Claude Code builds in Auto");
  // The stage just before in full; earlier ones in brief (no diffs).
  assert.match(build.body.text, /chat="Review the API">[\s\S]*one nit in src\/api\.ts:3/);
  assert.match(build.body.text, /chat="Build the API">[\s\S]*## What it changed\nsrc\/api\.ts\n/);
  assert.doesNotMatch(build.body.text, /```diff/);
  await finish(w.tasks[2].chat, "Client pages through items.");
  w = workflows.get(workflow.id);
  assert.equal(w.state, "done");
  assert.deepEqual(states(w), ["done", "done", "done"]);
  assert.deepEqual(said.map((m) => m.title), ["Pagination · Done"]);
  assert.equal(said[0].body, "3 tasks finished.");
  assert.equal(page(w.tasks[0].chat).items.length, 3, "nothing was sent into a task's chat");
});

test("tasks set to start together do, with one build in a folder at a time and three at work at most", async () => {
  const { workflows, started, finish } = stage();
  const { workflow } = workflows.create({
    owner: "phone",
    title: "Audit",
    cwd: "/work/app",
    tasks: tasks(
      ["Review auth", "claude", "review"],
      ["Review billing", "codex", "review", true],
      ["Fix auth", "claude", "build", true],
      ["Fix billing", "codex", "build", true],
      ["Review docs", "claude", "review", true],
    ),
  });
  workflows.run(workflow.id, "phone");
  await workflows.sync();
  let w = workflows.get(workflow.id);
  assert.deepEqual(states(w), ["working", "working", "working", "waiting", "waiting"], "three at work at most");
  await finish(w.tasks[0].chat, "Auth reviewed.");
  w = workflows.get(workflow.id);
  assert.deepEqual(states(w), ["done", "working", "working", "waiting", "working"], "the second build waits for the first");
  await finish(w.tasks[2].chat, "Auth fixed.");
  w = workflows.get(workflow.id);
  assert.deepEqual(states(w), ["done", "working", "done", "working", "working"]);
  // Tasks of one stage don't get each other's work.
  assert.doesNotMatch(started[3].body.text, /reach-handoff/);
  // Another workflow in the same folder can't build while this one does.
  const other = workflows.create({ owner: "phone", title: "Other", cwd: "/work/app", tasks: tasks(["Build more", "claude", "build"]) }).workflow;
  workflows.run(other.id, "phone");
  await workflows.sync();
  assert.deepEqual(states(workflows.get(other.id)), ["waiting"]);
  for (const t of workflows.get(workflow.id).tasks.filter((x) => x.state === "working")) await finish(t.chat, "Done.");
  assert.equal(workflows.get(workflow.id).state, "done");
  assert.deepEqual(states(workflows.get(other.id)), ["working"]);
});

test("a problem pauses the workflow; Retry starts a new chat, Skip goes on, Done takes what its chat ends on", async () => {
  const { workflows, started, said, end, finish, write } = stage();
  const { workflow } = workflows.create({ owner: "phone", title: "Ship", cwd: "/work/app", tasks: tasks(["One", "codex", "build"], ["Two", "claude", "build"], ["Three", "claude", "build"], ["Four", "codex", "review"]) });
  workflows.run(workflow.id, "phone");
  await workflows.sync();
  let w = workflows.get(workflow.id);
  await end(w.tasks[0].chat, { id: "err", role: "system", kind: "error", text: "You’ve hit your usage limit.", detail: "usageLimitExceeded" });
  w = workflows.get(workflow.id);
  assert.equal(w.state, "paused");
  assert.equal(w.tasks[0].state, "stopped");
  assert.equal(w.tasks[0].problem, "Codex ran out of usage.");
  assert.equal(w.problem, "“One”: Codex ran out of usage.");
  assert.deepEqual(said.at(-1), { workflow: said.at(-1).workflow, title: "Ship · Paused", body: "“One”: Codex ran out of usage." });
  assert.throws(() => workflows.resume(workflow.id, "phone"), /Retry, skip or finish the stopped task first/);
  const firstChat = w.tasks[0].chat;
  w = workflows.retry(workflow.id, "t1", "phone").workflow;
  await workflows.sync();
  w = workflows.get(workflow.id);
  assert.equal(w.state, "running");
  assert.equal(started.length, 2, "a new chat");
  assert.notDeepEqual(w.tasks[0].chat, firstChat);
  await finish(w.tasks[0].chat, "One done.");
  // Two is stopped from its chat: skipped.
  w = workflows.get(workflow.id);
  await end(w.tasks[1].chat, { id: "stop", role: "system", kind: "notice", text: "Stopped" });
  w = workflows.get(workflow.id);
  assert.equal(w.tasks[1].problem, "Its chat was stopped.");
  workflows.skip(workflow.id, "t2", "phone");
  await workflows.sync();
  w = workflows.get(workflow.id);
  assert.deepEqual(states(w), ["done", "skipped", "working", "waiting"]);
  // Three fails; you sort it out in its chat and say it's done.
  await end(w.tasks[2].chat, { id: "err3", role: "system", kind: "error", text: "Tool failed: npm test" });
  w = workflows.get(workflow.id);
  assert.equal(w.tasks[2].problem, "It ended on an error: Tool failed: npm test");
  await assert.rejects(workflows.done(workflow.id, "t3", "phone"), /doesn't end with a reply yet/);
  await write(w.tasks[2].chat, "Try again with the fixture.");
  await finish(w.tasks[2].chat, "Fixed with the fixture.");
  assert.equal(workflows.get(workflow.id).state, "paused", "a reply after a problem doesn't go on by itself");
  w = (await workflows.done(workflow.id, "t3", "phone")).workflow;
  await workflows.sync();
  w = workflows.get(workflow.id);
  assert.deepEqual(states(w), ["done", "skipped", "done", "working"]);
  assert.match(started.at(-1).body.text, /chat="Three">[\s\S]*Fixed with the fixture\./, "the next task gets what Done took");
  assert.doesNotMatch(started.at(-1).body.text, /chat="Two"/, "a skipped task passes nothing on");
});

test("each start checks the phone still may and Reach isn't paused; a task that can't start pauses it", async () => {
  let reason = "";
  const { workflows, started, finish } = stage({ authorized: () => reason });
  const { workflow } = workflows.create({ owner: "phone", title: "Two steps", cwd: "/work/app", tasks: tasks(["One", "codex", "build"], ["Two", "claude", "review"]) });
  reason = "Reach is paused.";
  assert.throws(() => workflows.run(workflow.id, "phone"), (e) => e.status === 403 && /Reach is paused/.test(e.message));
  reason = "";
  workflows.run(workflow.id, "phone");
  await workflows.sync();
  let w = workflows.get(workflow.id);
  reason = "The phone that ran this workflow no longer has access.";
  await finish(w.tasks[0].chat, "One done.");
  w = workflows.get(workflow.id);
  assert.equal(w.state, "paused");
  assert.equal(w.problem, "The phone that ran this workflow no longer has access.");
  assert.deepEqual(states(w), ["done", "waiting"]);
  assert.equal(started.length, 1);
  assert.throws(() => workflows.resume(workflow.id, "other-phone"), /no longer has access/);
  reason = "";
  workflows.resume(workflow.id, "other-phone");
  await workflows.sync();
  assert.deepEqual(states(workflows.get(workflow.id)), ["done", "working"]);
  // A folder that's gone: the task can't start, and says why.
  const gone = workflows.create({ owner: "phone", title: "Gone", cwd: "/gone", tasks: tasks(["One", "codex", "build"]) }).workflow;
  workflows.run(gone.id, "phone");
  await workflows.sync();
  w = workflows.get(gone.id);
  assert.equal(w.state, "paused");
  assert.equal(w.tasks[0].state, "stopped");
  assert.equal(w.problem, "“One” couldn't start: That folder doesn't exist.");
});

test("Retry keeps the earlier chat in tries, saved and in the list the phone gets", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-workflows-"));
  const file = path.join(dir, "agent-workflows.json");
  const first = stage({ file });
  const { workflow } = first.workflows.create({ owner: "phone", title: "Again", cwd: "/work/app", tasks: tasks(["One", "claude", "build"]) });
  first.workflows.run(workflow.id, "phone");
  await first.workflows.sync();
  const earlier = first.workflows.get(workflow.id).tasks[0].chat;
  assert.equal(first.workflows.list()[0].tasks[0].tries, undefined, "none before a retry");
  await first.end(earlier, { id: "err", role: "system", kind: "error", text: "Tool failed" });
  first.workflows.retry(workflow.id, "t1", "phone");
  await first.workflows.sync();
  const w = first.workflows.get(workflow.id);
  assert.notDeepEqual(w.tasks[0].chat, earlier);
  assert.deepEqual(w.tasks[0].tries, [earlier]);
  assert.deepEqual(first.workflows.list().find((x) => x.id === workflow.id).tasks[0].tries, [earlier]);
  // After a restart too.
  const again = stage({ file });
  assert.deepEqual(again.workflows.list().find((x) => x.id === workflow.id).tasks[0].tries, [earlier]);
});

test("a task starting when Reach stopped comes back uncertain and is never started again", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-workflows-"));
  const file = path.join(dir, "agent-workflows.json");
  const first = stage({ file });
  const { workflow } = first.workflows.create({ owner: "phone", title: "Once", cwd: "/work/app", tasks: tasks(["One", "codex", "build"]) });
  first.workflows.run(workflow.id, "phone");
  // Reach stops between "starting" and the chat beginning.
  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  saved[0].tasks[0].state = "starting";
  delete saved[0].tasks[0].chat;
  delete saved[0].tasks[0].relay;
  fs.writeFileSync(file, JSON.stringify(saved));
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const again = stage({ file });
  await again.workflows.sync();
  const w = again.workflows.get(workflow.id);
  assert.equal(w.state, "paused");
  assert.equal(w.tasks[0].state, "uncertain");
  assert.match(w.tasks[0].problem, /Reach restarted while this task was starting/);
  assert.equal(again.started.length, 0, "never started again by itself");
  again.workflows.retry(workflow.id, "t1", "phone");
  await again.workflows.sync();
  assert.equal(again.started.length, 1, "Retry is your tap");
});

test("while it runs only tasks after the last started one change; Stop stops the tasks at work", async () => {
  const { workflows, relays, started, stopped, finish } = stage();
  const { workflow } = workflows.create({ owner: "phone", title: "Edit me", cwd: "/work/app", tasks: tasks(["One", "codex", "build"], ["Two", "claude", "review"], ["Three", "codex", "build"]) });
  assert.throws(() => workflows.remove("nope"), /That workflow is gone/);
  workflows.run(workflow.id, "phone");
  await workflows.sync();
  let w = workflows.get(workflow.id);
  // The started task stays as it is, first.
  assert.throws(() => workflows.update(workflow.id, { tasks: [w.tasks[1], w.tasks[0], w.tasks[2]] }), /Tasks that have started stay as they are/);
  assert.throws(() => workflows.update(workflow.id, { cwd: "/elsewhere" }), /stays in its folder/);
  w = workflows.update(workflow.id, {
    tasks: [{ ...w.tasks[0], task: "Changed after it started" }, { ...w.tasks[2], task: "Three, sooner." }, { title: "Four", agent: "claude", kind: "review", task: "Check all." }],
  }).workflow;
  assert.deepEqual(w.tasks.map((t) => [t.id, t.title, t.state]), [["t1", "One", "working"], ["t3", "Three", "waiting"], ["t4", "Four", "waiting"]], "Two removed, Three moved up, Four added");
  assert.equal(w.tasks[0].task, "One: do it well.", "a started task keeps its text");
  assert.equal(w.tasks[1].task, "Three, sooner.");
  await finish(w.tasks[0].chat, "One done.");
  w = workflows.get(workflow.id);
  assert.match(started.at(-1).body.text, /^Three, sooner\.\n\nThis is task 2 of 3/);
  assert.throws(() => workflows.remove(workflow.id), /Stop it first/);
  const { stopped: did } = await workflows.stop(workflow.id);
  assert.equal(did, true);
  w = workflows.get(workflow.id);
  assert.equal(w.state, "stopped");
  assert.deepEqual(states(w), ["done", "stopped", "waiting"]);
  assert.deepEqual(stopped, [{ agent: w.tasks[1].chat.agent, id: w.tasks[1].chat.id }], "its chat stopped, and stays");
  await workflows.sync();
  assert.equal(started.length, 2, "nothing more starts");
  assert.deepEqual(relays.list(), []);
  // Run again: a copy to edit.
  const copy = workflows.again(workflow.id, "phone").workflow;
  assert.equal(copy.state, "draft");
  assert.deepEqual(copy.tasks.map((t) => [t.id, t.title, t.state]), [["t1", "One", "waiting"], ["t2", "Three", "waiting"], ["t3", "Four", "waiting"]]);
  assert.deepEqual(workflows.remove(workflow.id), { removed: true });
  assert.deepEqual(workflows.list().map((x) => x.id), [copy.id]);
});


test("workflow prompts name and demonstrate only currently available agents", () => {
  for (const agent of ["codex", "claude"]) {
    const text = plannerMessage({ text: "Ship it", agents: [agent] });
    const draft = readDraft(text, [agent]);
    assert.deepEqual(draft.tasks.map((t) => t.agent), [agent, agent]);
    assert.doesNotMatch(text, agent === "codex" ? /claude|openclaw/i : /codex|openclaw/i);
    assert.match(text, /configured default model/);
  }
  assert.throws(() => plannerMessage({ agents: [] }), /No workflow agents/);
});

test("planning checks live agents and confirmed models before creating a chat", async () => {
  const s = stage({ availableAgents: async () => ["claude"], models: async () => [{ id: "available" }, { id: "preview", unconfirmed: true }] });
  const input = { owner: "phone", cwd: "/work/app", text: "Ship it" };
  await assert.rejects(s.workflows.plan({ ...input, agent: "codex" }), /unavailable/);
  for (const model of ["missing", "preview"])
    await assert.rejects(s.workflows.plan({ ...input, agent: "claude", start: { model } }), /model is unavailable/);
  assert.equal(s.started.length, 0);
  await s.workflows.plan({ ...input, agent: "claude", start: { model: "available" } });
  assert.equal(s.started[0].body.model, "available");
  assert.doesNotMatch(s.started[0].body.text, /codex|openclaw/i);
});

test("the planner picks each task's model and effort from what the agents offer, checked again at start", async () => {
  let catalog = {
    claude: [
      { id: "default", name: "Default", isDefault: true, efforts: ["max", "low", "high", "medium", "xhigh"] },
      { id: "haiku", name: "Haiku", efforts: ["low", "medium"] },
      { id: "preview", unconfirmed: true, efforts: ["high"] },
    ],
    codex: [{ id: "gpt-6", name: "GPT-6", isDefault: true, efforts: ["low", "medium", "high"] }],
  };
  const s = stage({ models: async (agent) => catalog[agent] || [] });
  const { workflow, threadId } = await s.workflows.plan({ owner: "phone", agent: "claude", cwd: "/work/app", text: "Ship passkeys" });
  const text = s.started[0].body.text;
  // The catalog and the rules: real ids, levels lowest first, nothing unconfirmed.
  assert.match(text, /"haiku" \(Haiku\)\. Effort: low, medium\./);
  assert.match(text, /"default" \(Default\), its default\. Effort: low, medium, high, xhigh, max\./);
  assert.doesNotMatch(text, /preview/);
  assert.match(text, /Highest effort its model lists/);
  assert.match(text, /mechanical work/);
  assert.match(text, /When unsure, take the middle/);
  await s.finish({ agent: "claude", id: threadId }, plan([
    { title: "Design", agent: "claude", kind: "build", model: "default", effort: "max", task: "Design the auth flow." },
    { title: "Docs", agent: "claude", kind: "build", model: "haiku", effort: "max", task: "Update the docs." },
    { title: "Made up", agent: "codex", kind: "review", model: "gpt-9", effort: "high", task: "Check it." },
    { title: "Preview", agent: "claude", kind: "review", model: "preview", task: "Check it." },
  ]));
  const drafted = s.workflows.get(workflow.id).tasks;
  assert.deepEqual(drafted.map((t) => [t.model, t.effort]), [["default", "max"], ["haiku", undefined], [undefined, undefined], [undefined, undefined]],
    "an effort its model doesn't list, or a model the agent doesn't offer, is left out");
  // Taken off on the phone, it stays off; the rest start with theirs.
  s.workflows.update(workflow.id, { tasks: drafted.map((t, n) => (n === 1 ? { ...t, model: "" } : t)) });
  assert.equal(s.workflows.get(workflow.id).tasks[1].model, undefined);
  catalog = { ...catalog };
  s.workflows.run(workflow.id, "phone");
  await s.workflows.sync();
  assert.equal(s.started[1].body.model, undefined, "Claude's default entry runs without --model");
  assert.equal(s.started[1].body.effort, "max");
  // Gone from the catalog by its turn: it stops and says why, never runs on another.
  const second = s.workflows.create({ owner: "phone", cwd: "/work/app", tasks: [{ agent: "claude", kind: "review", model: "haiku", effort: "medium", task: "Check." }] });
  catalog = { ...catalog, claude: catalog.claude.filter((m) => m.id !== "haiku") };
  s.workflows.run(second.workflow.id, "phone");
  await s.workflows.sync();
  const stopped = s.workflows.get(second.workflow.id);
  assert.equal(stopped.state, "paused");
  assert.match(stopped.tasks[0].problem, /doesn't offer the model haiku/);
  assert.equal(s.workflows.again(second.workflow.id, "phone").workflow.tasks[0].model, "haiku", "Run again keeps the pick");
  // Shapes no agent writes are refused when the phone sends them.
  assert.throws(() => checkTasks([{ agent: "claude", kind: "build", task: "x", model: "--dangerously" }]), /choose a model/);
  assert.throws(() => checkTasks([{ agent: "claude", kind: "build", task: "x", effort: "High Max" }]), /choose an effort/);
  assert.deepEqual(checkTasks([{ agent: "openclaw", kind: "build", task: "x", model: "gpt-6" }], { agents: ["openclaw"] })[0].model, undefined);
});

test("a saved task cannot launch an agent that is no longer available", async () => {
  const s = stage({ availableAgents: async () => ["claude"] });
  const { workflow } = s.workflows.create({ owner: "phone", cwd: "/work/app", tasks: tasks(["Build", "codex", "build"]) });
  s.workflows.run(workflow.id, "phone");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(s.started.length, 0);
  assert.equal(s.workflows.get(workflow.id).state, "paused");
});

for (const action of ["stop", "revoke"]) test(`task must not launch if ${action} happens during catalog lookup`, async () => {
  let enter, release, denied = false;
  const entered = new Promise(r => enter = r);
  const held = new Promise(r => release = r);
  const s = stage({ authorized: () => denied ? "Access ended" : "", models: async () => { enter(); await held; return [{id:"chosen",efforts:["high"]}]; } });
  const {workflow} = s.workflows.create({owner:"phone",cwd:"/work/app",tasks:[{agent:"codex",kind:"build",task:"Run no real commands",model:"chosen",effort:"high"}]});
  s.workflows.run(workflow.id,"phone");
  await entered;
  if (action === "stop") await s.workflows.stop(workflow.id); else denied = true;
  release();
  await s.workflows.sync();
  assert.equal(s.started.length,0,JSON.stringify({action,launched:s.started.length,stopped:s.stopped.length,workflow:s.workflows.get(workflow.id).state}));
});

test("a revoked planner never starts after catalog discovery", async () => {
  const entered = Promise.withResolvers(), held = Promise.withResolvers();
  let denied = false;
  const s = stage({ authorized: () => denied ? "Access ended" : "",
    models: async () => { entered.resolve(); await held.promise; return []; } });
  const planning = s.workflows.plan({ owner: "phone", agent: "codex", cwd: "/work/app", text: "Plan synthetic work" });
  const refused = assert.rejects(planning, { status: 403 });
  await entered.promise;
  denied = true;
  held.resolve();
  await refused;
  assert.equal(s.started.length, 0);
  assert.equal(s.workflows.list().length, 0);
});
