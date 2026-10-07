import test from "node:test";
import assert from "node:assert/strict";
import { readAttention } from "../server/notifications.mjs";
import {
  createNotificationActions,
  chatNotifications,
  notificationPush,
  publicNotification,
  admissionNotification,
} from "../server/notification-items.mjs";
const session = (prompt = {}) => ({
  agent: "codex",
  id: "chat-1",
  status: "waiting",
  title: "Private project",
  prompts: [
    {
      id: "prompt-1",
      kind: "command",
      title: "Approval",
      command: "npm test",
      cwd: "/workspace/project",
      decisions: ["accept", "decline", "acceptForSession"],
      ...prompt,
    },
  ],
});
test("rich notifications identify the exact request and offer only one-time actions", () => {
  const item = chatNotifications(session())[0];
  assert.equal(item.sender, "Codex");
  assert.equal(item.title, "Run this command?");
  assert.equal(item.target.prompt, "prompt-1");
  assert.deepEqual(
    item.actions.map((a) => a.id),
    ["deny", "approve"],
  );
  assert.equal(item.prompt.command, "npm test");
  assert.equal(publicNotification(item)._binding, undefined);
  const push = notificationPush(item);
  // On an iPhone every notification has Reach's icon: the text tells them
  // apart. The chat's name on top, then the agent and the command itself.
  assert.equal(push.title, "Private project");
  assert.equal(push.body, "Codex wants to run npm test in project");
  assert.equal(
    new URL(push.url, "https://reach.test").searchParams.get("prompt"),
    "prompt-1",
  );
  assert.deepEqual(
    push.actions.map((a) => a.action),
    ["open", "deny"],
  );
});
test("each kind of request reads differently on the phone", () => {
  const push = (prompt, title) =>
    notificationPush(chatNotifications({ ...session(prompt), ...(title !== undefined && { title }) })[0]);
  const ask = push({
    kind: "question",
    command: undefined,
    decisions: [],
    questions: [{ id: "q", question: "Which **branch** should I use?", options: [{ label: "main" }] }],
  });
  assert.equal(ask.body, "Codex asks: Which branch should I use?");
  assert.equal(ask.actions[0].title, "Reply");
  const secret = push({
    kind: "question",
    command: undefined,
    reason: "Enter the token",
    questions: [{ id: "q", question: "Paste the token", secret: true, options: [] }],
  });
  assert.doesNotMatch(JSON.stringify(secret), /Paste the token/);
  const files = push({ kind: "file-change", command: undefined, files: ["/w/src/a.ts", "/w/src/b.ts", "/w/c.ts"] });
  assert.equal(files.body, "Codex wants to change 3 files: a.ts, b.ts +1");
  // A chat with no name of its own: the agent's name on top.
  assert.equal(push({}, "Untitled Codex session").title, "Codex");
  const claude = notificationPush(chatNotifications({ ...session(), agent: "claude" })[0]);
  assert.equal(claude.body, "Claude Code wants to run npm test in project");
  // Hidden characters in a command: nothing of it reaches the phone.
  const hidden = push({ command: "echo safe\u202erm" });
  assert.doesNotMatch(hidden.body, /echo/);
});
test("file changes, oversized commands, hidden controls, and policy approvals require full review", () => {
  for (const prompt of [
    { kind: "file-change", files: ["a.ts"] },
    { kind: "permissions" },
    { command: "x".repeat(8001) },
    { command: "echo safe\u202erm" },
    { command: "pwd", files: ["a.ts"] },
  ]) {
    assert.equal(
      chatNotifications(session(prompt))[0].actions.some(
        (a) => a.id === "approve",
      ),
      false,
    );
  }
});
test("single-choice questions can be answered directly; secret and multi-select questions stay in the chat", () => {
  const prompt = {
    kind: "question",
    command: undefined,
    decisions: [],
    questions: [
      {
        id: "color",
        question: "Which theme?",
        options: [{ label: "Dark" }, { label: "Light" }],
      },
    ],
  };
  const item = chatNotifications(session(prompt))[0];
  assert.deepEqual(
    item.actions.map((a) => a.label),
    ["Dark", "Light"],
  );
  assert.deepEqual(item._binding.choices["answer-1"], {
    answers: { color: ["Light"] },
  });
  prompt.questions[0].secret = true;
  assert.equal(chatNotifications(session(prompt))[0].actions.length, 0);
  assert.doesNotMatch(
    chatNotifications(session(prompt))[0].summary,
    /Which theme/,
  );
});
test("actions are owner-authorized, current, immutable, non-replayable, and never accept substituted commands", async () => {
  let item = chatNotifications(session())[0];
  const sent = [];
  let verified = 0;
  const act = createNotificationActions({
    read: async () => ({ items: [item] }),
    run: async (binding, id, authorize) => {
      authorize();
      sent.push(binding.choices[id]);
    },
  });
  const auth = () => verified++;
  const body = { revision: item.revision, action: "approve" };
  await assert.rejects(act(item.id, { ...body, command: "rm -rf /" }, auth), {
    status: 400,
  });
  await assert.rejects(
    act(item.id, { ...body, action: "acceptForSession" }, auth),
    { status: 400 },
  );
  const id = item.id;
  item = chatNotifications(session({ command: "npm publish" }))[0];
  await assert.rejects(act(id, body, auth), { status: 409 });
  item = chatNotifications(session())[0];
  await assert.rejects(
    act(id, body, () => {
      throw Object.assign(Error("revoked"), { status: 401 });
    }),
    { status: 401 },
  );
  await act(id, body, auth);
  assert.deepEqual(sent, [{ decision: "accept" }]);
  assert.ok(verified >= 3);
  await assert.rejects(act(id, body, auth), { status: 409 });
});
test("simultaneous clicks dispatch one decision and admission approval always keeps code verification", async () => {
  const item = chatNotifications(session())[0];
  let release;
  const wait = new Promise((r) => (release = r));
  let calls = 0;
  const act = createNotificationActions({
    read: async () => ({ items: [item] }),
    run: async () => {
      calls++;
      await wait;
    },
  });
  const first = act(
    item.id,
    { revision: item.revision, action: "deny" },
    () => {},
  );
  await assert.rejects(
    act(item.id, { revision: item.revision, action: "deny" }, () => {}),
    { status: 409 },
  );
  release();
  await first;
  assert.equal(calls, 1);
  const admission = admissionNotification({
    requestId: "connection",
    name: "Muse",
    verificationCode: "123456",
  });
  assert.deepEqual(
    admission.actions.map((a) => a.id),
    ["deny"],
  );
  assert.equal(admission.target.needs, "agent-admission:connection");
  assert.equal(notificationPush(admission).title, "✦ Muse wants to connect");
  assert.match(notificationPush(admission).body, /Compare the code/);
  assert.doesNotMatch(JSON.stringify(notificationPush(admission)), /123456/);
});
test("resolved browser requests disappear and legacy access never targets the removed Agents page", async () => {
  const value = await readAttention({
    agentSessions: { list: async () => ({ sessions: [] }) },
    openClaw: { overview: async () => ({}) },
    handoffs: () => [],
    browserRequests: () => [{ id: "done", status: "completed" }],
    admissions: () => [],
    accessRequests: () => [
      {
        id: "access1",
        name: "Agent",
        status: "pending",
        scopes: ["files:read"],
      },
    ],
  });
  assert.equal(value.items.length, 1);
  assert.deepEqual(value.items[0].target, {
    page: "overview",
    needs: "device:access1",
  });
});
test("a chat waiting in its own app or terminal says on what", () => {
  const push = (asking) =>
    notificationPush(
      chatNotifications({ agent: "claude", id: "c1", status: "waiting", title: "Fix login", asking })[0],
    );
  assert.equal(push({ kind: "permission", text: "npm run build", command: true }).body, "Claude Code wants to run npm run build");
  assert.equal(push({ kind: "permission", text: "Edit src/app.ts" }).body, "Claude Code needs permission: Edit src/app.ts");
  assert.equal(push({ kind: "question", questions: [{ question: "Ship it?", options: [] }] }).body, "Claude Code asks: Ship it?");
  assert.equal(
    push({ kind: "dialog", text: "Claude Code has something open for you to answer." }).body,
    "Claude Code has something open for you to answer.",
  );
  // Nothing known: never a stock sentence passed off as its question.
  assert.equal(push(undefined).body, "Claude Code is waiting for you");
  assert.equal(push({ kind: "permission", text: "echo safe‮rm", command: true }).body, "Claude Code needs your permission");
});
test("Mac prompts and OpenClaw approvals read as themselves", async () => {
  const { items } = await readAttention({
    agentSessions: {
      list: async () => ({
        sessions: [],
        macPrompts: [{ id: "m1", title: "“Terminal” would like to access files in your Documents folder.", detail: "Keeping access off may stop it." }],
      }),
    },
    openClaw: {
      overview: async () => ({
        connected: true,
        sessions: [{ key: "s1", title: "Trip planning" }],
        approvals: [
          { id: "o1", sessionKey: "s1", command: "ls ~/Trips", cwd: "/Users/me" },
          { id: "o2", sessionKey: "s1", command: "echo safe‮rm" },
        ],
      }),
    },
    handoffs: () => [],
    browserRequests: () => [],
    admissions: () => [],
    accessRequests: () => [],
  });
  const [mac, claw, hidden] = items.map(notificationPush);
  assert.equal(mac.title, "“Terminal” would like to access files in your Documents folder.");
  assert.equal(mac.body, "Keeping access off may stop it.");
  assert.equal(claw.title, "Trip planning");
  assert.equal(claw.body, "OpenClaw wants to run ls ~/Trips in me");
  assert.doesNotMatch(hidden.body, /echo/);
});
