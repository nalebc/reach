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
  assert.equal(push.title, "Codex · Command approval");
  assert.equal(push.body, "Tap to review the command and allow or deny it.");
  assert.equal(
    new URL(push.url, "https://reach.test").searchParams.get("prompt"),
    "prompt-1",
  );
  assert.deepEqual(
    push.actions.map((a) => a.action),
    ["open", "deny"],
  );
  assert.doesNotMatch(
    JSON.stringify(push),
    /npm test|workspace|Private project/,
  );
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
  assert.equal(notificationPush(admission).title, "✦ Muse · Connection request");
  assert.match(notificationPush(admission).body, /Tap to compare/);
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
