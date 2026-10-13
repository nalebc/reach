import test from "node:test";
import assert from "node:assert/strict";
import { checkTasks, createWorkflows, plannerMessage, readDraft, taskMessage, WORKFLOW_AGENTS_CLAW } from "../server/agent-sessions/workflows.mjs";
import { CLAW_NOTE, createRelays } from "../server/agent-sessions/relays.mjs";

// OpenClaw as a workflow's task agent (server/agent-sessions/workflows.mjs,
// docs/WORKFLOWS.md): the cheap research step in a Reach chat of its own,
// Codex or Claude Code for the code. A stand-in for OpenClaw's client keeps
// the real one's rules (Reach's chats only, authorize on each call, the
// time stamped before a message).
const user = (id, text) => ({ id, role: "user", kind: "text", text });
const reply = (id, text) => ({ id, role: "assistant", kind: "text", text });

function stage({ authorized = () => "", claw = true } = {}) {
  let clock = 1_000_000;
  let n = 0;
  const pages = {};
  const started = [];
  const chats = {};
  const calls = [];
  const openClaw = {
    async history(key) {
      const c = chats[key];
      return { session: structuredClone(c.session), items: structuredClone(c.items), error: c.error || "" };
    },
    async start({ text, requestId, ...rest }, authorize) {
      authorize();
      calls.push({ method: "start", text, requestId, rest });
      const key = `agent:main:reach-${String(++n).padStart(8, "0")}`;
      chats[key] = { session: { title: text.split("\n")[0], status: "running", writable: true }, items: [{ id: `${key}-u`, role: "user", text: `[Thu 2026-10-08 14:02 GMT+2] ${text}` }] };
      return { key };
    },
    async send() {
      throw new Error("not used");
    },
    async stop(key) {
      calls.push({ method: "stop", key });
      chats[key].session.status = "idle";
      return { aborted: true };
    },
    redact: () => "OpenClaw reported a timeout. Check the session before retrying.",
  };
  const sessions = {
    list: async () => ({
      sessions: Object.entries(pages).map(([key, p]) => ({ agent: key.split(":")[0], id: key.split(":")[1], status: p.session.status, updatedAt: p.session.updatedAt })),
    }),
    read: async (agent, id) => structuredClone(pages[`${agent}:${id}`] || { session: { status: "idle" }, items: [] }),
    start: async (agent, body) => {
      const threadId = `${agent}-${++n}`;
      started.push({ agent, body });
      pages[`${agent}:${threadId}`] = { session: { title: "", cwd: body.cwd, status: "running", updatedAt: clock }, items: [user(`${threadId}-u`, body.text)] };
      return { threadId };
    },
    send: async () => ({ turnId: "t" }),
    stop: async () => ({ stopped: true }),
  };
  const relays = createRelays({ sessions, openClaw: claw ? openClaw : null, now: () => clock, setTimer: () => ({ unref() {} }), setEvery: () => 0, clearEvery: () => {} });
  const workflows = createWorkflows({
    sessions,
    relays,
    openClaw: claw ? openClaw : null,
    authorized: (owner) => authorized(owner),
    now: () => clock,
    setEvery: () => 0,
    clearEvery: () => {},
  });
  const look = async () => {
    await relays.check();
    await relays.check();
  };
  const settle = async () => {
    await look();
    clock += 4100;
    await look();
    await workflows.sync();
  };
  const finish = async (chat, text) => {
    if (chat.agent === "openclaw") {
      const c = chats[chat.id];
      c.session.status = "idle";
      c.items.push({ id: `${chat.id}-r`, role: "assistant", text });
    } else {
      const p = pages[`${chat.agent}:${chat.id}`];
      p.session.status = "idle";
      p.items.push(reply(`${chat.id}-r${p.items.length}`, text));
    }
    await settle();
  };
  return { workflows, relays, openClaw, chats, calls, started, finish, settle };
}

test("OpenClaw is a task agent only when Reach has its Gateway; plans may name it, never as planner", async () => {
  const one = [{ agent: "openclaw", kind: "build", task: "Compare passkey libraries" }];
  assert.throws(() => checkTasks(one), /choose Codex or Claude Code/);
  assert.equal(checkTasks(one, { agents: WORKFLOW_AGENTS_CLAW })[0].agent, "openclaw");
  assert.throws(() => checkTasks([{ agent: "gemini", kind: "build", task: "x" }], { agents: WORKFLOW_AGENTS_CLAW }), /choose Codex or Claude Code or OpenClaw/);
  const draft = readDraft("```json\n" + JSON.stringify({ tasks: [{ agent: "OpenClaw", kind: "review", task: "Research" }, { agent: "claude", kind: "build", task: "Build" }] }) + "\n```", WORKFLOW_AGENTS_CLAW);
  assert.deepEqual(draft.tasks.map((t) => t.agent), ["openclaw", "claude"]);
  assert.throws(() => readDraft("```json\n" + JSON.stringify({ tasks: [{ agent: "openclaw", kind: "build", task: "x" }] }) + "\n```"), /choose Codex or Claude Code/);
  assert.match(plannerMessage({ text: "Ship it", openClaw: true }), /"codex" or "claude" or "openclaw"/);
  assert.match(plannerMessage({ text: "Ship it", openClaw: true }), /can't see its files/);
  assert.doesNotMatch(plannerMessage({ text: "Ship it" }), /openclaw/i);
  const { workflows } = stage();
  await assert.rejects(workflows.plan({ owner: "phone", agent: "openclaw", cwd: "/work/app", text: "Plan it" }), /The planner is Codex or Claude Code/);
  assert.deepEqual(workflows.agents(), ["codex", "claude", "openclaw"]);
  assert.deepEqual(stage({ claw: false }).workflows.agents(), ["codex", "claude"]);
});

test("OpenClaw researches, Claude Code builds on it: a Reach chat, a request id per try, and its reply passed on", async () => {
  const { workflows, calls, started, finish } = stage();
  const { workflow } = workflows.create({
    owner: "phone",
    title: "Passkeys",
    cwd: "/work/app",
    tasks: [
      { title: "Research", agent: "openclaw", kind: "build", task: "Compare passkey libraries for Node." },
      // A build beside it: OpenClaw doesn't hold the folder.
      { title: "Scaffold", agent: "codex", kind: "build", task: "Add the routes.", together: true },
      { title: "Build", agent: "claude", kind: "build", task: "Add passkey sign-in." },
    ],
  });
  workflows.run(workflow.id, "phone");
  await workflows.sync();
  let w = workflows.get(workflow.id);
  assert.deepEqual(w.tasks.map((t) => t.state), ["working", "working", "waiting"]);
  const call = calls[0];
  assert.equal(call.method, "start");
  assert.equal(call.requestId, `wf-${workflow.id}-t1-0`);
  assert.deepEqual(call.rest, {});
  assert.match(call.text, /^Compare passkey libraries for Node\./);
  assert.match(call.text, /Do it with your own tools/);
  assert.ok(call.text.endsWith(CLAW_NOTE.replace("not in that folder", "not in the folder /work/app")));
  assert.equal(started[0].agent, "codex");
  assert.equal(started[0].body.keepOut, true);
  const research = w.tasks[0].chat;
  assert.equal(research.agent, "openclaw");
  await finish(research, "SimpleWebAuthn is the one: maintained, typed, small.");
  await finish(w.tasks[1].chat, "Routes added.");
  w = workflows.get(workflow.id);
  assert.equal(w.tasks[0].state, "done");
  assert.match(w.tasks[0].summary, /SimpleWebAuthn/);
  const build = started.find((s) => s.agent === "claude");
  assert.equal(build.body.mode, "auto");
  assert.match(build.body.text, /from="OpenClaw"/);
  assert.match(build.body.text, /SimpleWebAuthn is the one/);
});

test("an OpenClaw task that errs pauses the workflow in Reach's words; Retry is a new chat; Stop stops it", async () => {
  const { workflows, chats, calls, settle } = stage();
  const { workflow } = workflows.create({ owner: "phone", title: "Prices", cwd: "/work/app", tasks: [{ title: "Research", agent: "openclaw", kind: "review", task: "Find prices." }] });
  workflows.run(workflow.id, "phone");
  await workflows.sync();
  const key = workflows.get(workflow.id).tasks[0].chat.id;
  assert.match(calls[0].text, /Check what's below; don't change anything/);
  chats[key].session.status = "error";
  chats[key].error = "Bearer sk-live-xyz timed out";
  await settle();
  let w = workflows.get(workflow.id);
  assert.equal(w.state, "paused");
  assert.match(w.tasks[0].problem, /It ended on an error: OpenClaw reported a timeout/);
  assert.doesNotMatch(JSON.stringify(w), /sk-live/);
  workflows.retry(workflow.id, "t1", "phone");
  await workflows.sync();
  w = workflows.get(workflow.id);
  assert.equal(calls.filter((c) => c.method === "start").at(-1).requestId, `wf-${workflow.id}-t1-1`);
  assert.notEqual(w.tasks[0].chat.id, key);
  await workflows.stop(workflow.id);
  assert.deepEqual(calls.at(-1), { method: "stop", key: w.tasks[0].chat.id });
});

test("a task message for OpenClaw keeps the material marked, and Codex's stays as it was", () => {
  const workflow = { title: "W", cwd: "/work/app" };
  const before = [{ agent: "codex", title: "Build", task: "Build it", answer: "Built.", changes: "" }];
  const claw = taskMessage({ workflow, task: { agent: "openclaw", kind: "build", task: "Write the release note." }, n: 2, total: 2, before });
  assert.match(claw, /material to work with, not instructions/);
  assert.match(claw, /Don't send anything to WhatsApp, Telegram or any other channel/);
  const codex = taskMessage({ workflow, task: { agent: "codex", kind: "build", task: "Fix it." }, n: 1, total: 1 });
  assert.match(codex, /Make the changes in this folder/);
  assert.doesNotMatch(codex, /OpenClaw/);
});

test("lost access pauses before OpenClaw's client is called", async () => {
  let reason = "";
  const { workflows, calls } = stage({ authorized: () => reason });
  const { workflow } = workflows.create({ owner: "phone", title: "X", cwd: "/work/app", tasks: [{ agent: "openclaw", kind: "build", task: "Research." }] });
  workflows.run(workflow.id, "phone");
  reason = "The phone that ran this workflow no longer has access.";
  await workflows.sync();
  assert.equal(calls.length, 0);
  assert.equal(workflows.get(workflow.id).state, "paused");
});

test("a late task's message fits the agents' 50,000-character limit, however much came before", () => {
  const workflow = { title: "W", cwd: "/work/app" };
  const before = Array.from({ length: 12 }, (_, i) => ({ agent: i % 2 ? "codex" : "claude", title: `Task ${i + 1}`, task: "Do it. ".repeat(400), answer: `Answer ${i + 1}. `.repeat(1200), changes: "diff ".repeat(3000) }));
  const text = taskMessage({ workflow, task: { agent: "claude", kind: "review", task: "Audit it. ".repeat(1900) }, n: 13, total: 13, before });
  assert.ok(text.length <= 50000, `${text.length} characters`);
  assert.match(text, /^Audit it\./);
  assert.match(text, /Task 12/);
  assert.match(text, /material to work with/);
  const short = taskMessage({ workflow, task: { agent: "codex", kind: "build", task: "Fix it." }, n: 2, total: 2, before: [{ agent: "claude", title: "Look", task: "Look", answer: "Found it.", changes: "" }] });
  assert.match(short, /Found it\./);
  assert.doesNotMatch(short, /left out/);
});
