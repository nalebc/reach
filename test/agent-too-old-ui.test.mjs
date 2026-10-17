import test, { before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { startDom, settle, typeInto } from "./dom/harness.mjs";

// An agent older than Reach works with (server: agent-sessions/compatibility.mjs,
// health's tooOld): one short line naming the version to update to, Update
// when Reach can run one (agent-updates.mjs, OpenClaw's own update), and it
// isn't offered for new work: no new chat, not picked from All, never a
// move's or a relay's target. Its chats still list.
const peer = { id: "mac", name: "Mac", url: "https://reach.test", token: "t", platform: "darwin" };
const ok = (agent) => ({ agent, installed: true, signedIn: true, usable: true, supported: true });
const aged = (agent, version, to) => ({ ...ok(agent), tooOld: { version, to }, needs: ["update"] });
const claudeOld = aged("claude", "2.1.200", "2.1.259");
const codexOld = aged("codex", "0.147.0", "0.148.0");
const chats = [
  { agent: "claude", id: "11111111-2222-4333-8444-555555555555", title: "Old Claude chat", cwd: "/work", branch: "", origin: "app", inApp: false, updatedAt: Date.now(), createdAt: Date.now(), status: "idle", preview: "", archived: false },
];
const CODEX = "0199aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee";
const codexChat = { agent: "codex", id: CODEX, title: "Old Codex chat", cwd: "/work", branch: "main", origin: "app", inApp: true, updatedAt: Date.now(), createdAt: Date.now(), status: "idle", preview: "", archived: false, model: "gpt-6-astra", effort: "medium", mode: "auto", held: null };
const said = [
  { id: "u1", role: "user", kind: "text", text: "Build the login page", at: Date.now() - 9000 },
  { id: "a1", role: "assistant", kind: "text", text: "Built it.", at: Date.now() - 8000 },
];
const messages = [];
let updates = [];
let updateGate = null, releaseUpdates = null;
const views = new Set();
let terminal = null;
let overview = null;
const sent = [];
const clawPosts = [];
let dom, React, EverythingChat, MoveChat, Relays, AgentSessionView;
before(async () => {
  dom = await startDom({
    mobile: true,
    routes: {
      "/api/sessions/logos": () => ({ version: "v1", logos: {} }),
      "/api/sessions/commands": () => ({ commands: [] }),
      "/api/sessions/models": () => ({ models: [], modes: [], mode: null }),
      "/api/sessions/agent-updates": async () => {
        await updateGate;
        return { agents: updates };
      },
      "/api/sessions/agent-update/claude": async (init) => {
        const body = JSON.parse(init.body || "{}");
        sent.push(body);
        const plan = { agent: "claude", name: "Claude Code", command: "'/Users/me/.local/bin/claude' update", from: "2.1.200", to: "2.1.296" };
        return body.confirm ? { ...plan, terminal } : plan;
      },
      "/api/terminals": () => (terminal ? [terminal] : []),
      "/api/sessions/openclaw/overview": () => overview,
      [`/api/sessions/codex/${CODEX}`]: () => ({ session: codexChat, items: said, before: null }),
      // A Mac's live view answers after a while when nothing changes.
      [`/api/sessions/codex/${CODEX}/live`]: async () => (await settle(60), { version: 1, status: "idle", error: null, prompts: [], streaming: "", activity: null, items: 0 }),
      [`/api/sessions/codex/${CODEX}/messages`]: (init) => {
        messages.push(JSON.parse(init.body || "{}"));
        return Response.json({ error: "Codex 0.147.0 is older than Reach works with. Update it to 0.148.0 or newer to use it here." }, { status: 409 });
      },
      "/api/sessions/openclaw/health/maintenance": () => ({ job: null }),
      "/api/sessions/openclaw/health/update": (init) => {
        clawPosts.push(JSON.parse(init.body || "{}"));
        return { job: { id: "j1", action: "update", status: "running", lines: [], startedAt: Date.now() } };
      },
    },
  });
  React = dom.React;
  // jsdom has no modal dialogs (OpenClaw's update opens in one).
  dom.window.HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  dom.window.HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  ({ default: EverythingChat } = await dom.load("/src/EverythingChat.tsx"));
  MoveChat = await dom.load("/src/MoveChat.tsx");
  Relays = await dom.load("/src/Relays.tsx");
  ({ default: AgentSessionView } = await dom.load("/src/AgentSession.tsx"));
});
afterEach(async () => {
  releaseUpdates?.();
  updateGate = releaseUpdates = null;
  for (const view of views) await view.unmount();
  views.clear();
});
after(() => dom?.close());
const mount = async (element) => {
  const view = await dom.render(element);
  views.add(view);
  return { ...view, unmount: async () => { views.delete(view); await view.unmount(); } };
};
const $$ = (s) => [...dom.document.querySelectorAll(s)];
const button = (text) => $$("button").find((b) => b.textContent.trim() === text || b.getAttribute("aria-label") === text);
const text = () => dom.document.body.textContent;
const click = async (target) => {
  const el = typeof target === "function" ? await dom.waitFor(target) : target;
  assert.ok(el, "button exists");
  el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  await settle();
};
let rechecks = 0;
const render = (health, app, sessions = chats) => {
  dom.window.localStorage.setItem("reach.chatAgent", app);
  return mount(
    React.createElement(EverythingChat, {
      peer,
      feed: {
        sessions,
        // A too-old Codex's own refusal, as the list would carry it.
        errors: { codex: "Codex 0.147.0 is older than Reach works with. Update it to 0.148.0 or newer to use it here." },
        health,
        failure: "",
        reload: async () => {},
        recheck: () => rechecks++,
      },
    }),
  );
};

test("a Claude Code too old: one line with the version, Update runs its update, then the agents are read again", async () => {
  updates = [{ agent: "claude", name: "Claude Code", state: "available", installed: "2.1.200", latest: "2.1.296" }];
  terminal = { id: "u1", status: "running", preview: ["Updating…"] };
  sent.length = 0;
  rechecks = 0;
  // The version warning precedes the update plan. Hold that real API
  // response so this race is exercised on every host, not only a busy one.
  updateGate = new Promise(resolve => { releaseUpdates = resolve; });
  const view = await render([ok("codex"), claudeOld], "claude");
  const line = await dom.waitFor(() => dom.document.querySelector(".agent-update.too-old"));
  assert.equal(line.querySelector("span").textContent, "Update Claude Code to 2.1.259 or newer to use it here.");
  // Its chats still list; no new chat is offered in it.
  assert.ok(/Old Claude chat/.test(text()));
  assert.equal(button("New chat"), undefined);
  assert.equal(button("New Claude Code chat"), undefined);
  assert.equal(/Update Reach/.test(text()), false);
  assert.equal(button("Update"), undefined, "the update plan is still pending");
  releaseUpdates();
  await click(() => button("Update"));
  await dom.waitFor(() => dom.document.querySelector(".agent-update .chat-setup-command"));
  await click(() => button("Update"));
  assert.deepEqual(sent, [{ confirm: false }, { confirm: true }]);
  await dom.waitFor(() => /Updating Claude Code…/.test(text()));
  updates = [{ agent: "claude", name: "Claude Code", state: "current", installed: "2.1.296", latest: "2.1.296" }];
  terminal = { ...terminal, status: "exited", exitCode: 0, preview: ["Updated"] };
  await dom.waitFor(() => rechecks > 0, 5000);
  await view.unmount();
  assert.deepEqual(dom.errors, []);
});

for (const [what, info] of [
  ["can't tell how it was installed", { agent: "claude", name: "Claude Code", state: "unknown", installed: "2.1.200", reason: "Reach can't tell how it was installed." }],
  ["updates with an app", { agent: "claude", name: "Claude Code", state: "app", app: "Claude" }],
  ["isn't answered", null],
])
  test(`too old, and Reach ${what}: the line alone, no Update`, async () => {
    updates = info ? [info] : "not a list";
    const view = await render([ok("codex"), claudeOld], "claude");
    const line = await dom.waitFor(() => dom.document.querySelector(".agent-update.too-old"));
    await settle(50);
    assert.equal(line.textContent, "Update Claude Code to 2.1.259 or newer to use it here.");
    assert.equal(button("Update"), undefined);
    await view.unmount();
    assert.deepEqual(dom.errors, []);
  });

test("a Codex too old: its line, not its refusal twice, not a sign-in", async () => {
  updates = [];
  const view = await render([codexOld, ok("claude")], "codex", []);
  const line = await dom.waitFor(() => dom.document.querySelector(".agent-update.too-old"));
  assert.equal(line.textContent, "Update Codex to 0.148.0 or newer to use it here.");
  assert.equal((text().match(/older than Reach works with/g) || []).length, 0, "the list's error isn't repeated");
  assert.equal(/Sign in/.test(text()), false);
  await view.unmount();
  assert.deepEqual(dom.errors, []);
});

test("New chat from All skips a too-old agent; picked anyway, it says why instead of a message box", async () => {
  updates = [];
  const view = await render([codexOld, ok("claude")], "all", []);
  await click(await dom.waitFor(() => button("New chat")));
  // Opened on the agent that can answer.
  const current = await dom.waitFor(() => button("Change app, Claude Code selected"));
  await click(current);
  const codexRow = await dom.waitFor(() => $$("[role=menuitemradio]").find((b) => b.getAttribute("aria-label") === "Codex"));
  assert.equal(codexRow.querySelector("small")?.textContent, "Update needed");
  await click(codexRow);
  await dom.waitFor(() => button("Change app, Codex selected"));
  const line = await dom.waitFor(() => dom.document.querySelector(".chat-create-sheet .agent-update.too-old"));
  assert.equal(line.textContent, "Update Codex to 0.148.0 or newer to use it here.");
  assert.equal(dom.document.querySelector(".chat-create-sheet textarea"), null, "no message box");
  await view.unmount();
  assert.deepEqual(dom.errors, []);
});

test("never a move's or a relay's target while too old", () => {
  const health = [ok("codex"), claudeOld, { agent: "openclaw", name: "OpenClaw", installed: true, signedIn: false, supported: true, connected: false, tooOld: { to: "2026.2.26" }, needs: ["update"] }];
  assert.equal(MoveChat.moveBlocked("claude", health), "Update Claude Code to 2.1.259 or newer to move chats there.");
  assert.equal(MoveChat.moveBlocked("openclaw", health), "Update OpenClaw to 2026.2.26 or newer to move chats there.");
  assert.deepEqual(
    MoveChat.moveChoices("codex", health).map((c) => [c.to, c.blocked]),
    [
      ["claude", "Update Claude Code to 2.1.259 or newer to move chats there."],
      ["openclaw", "Update OpenClaw to 2026.2.26 or newer to move chats there."],
    ],
  );
  assert.deepEqual(Relays.relayAgents(health), ["codex"]);
  assert.deepEqual(Relays.relayAgents([ok("codex"), ok("claude")]), ["codex", "claude"]);
});

test("an OpenClaw too old: its line and Update (OpenClaw's own, confirmed), not a connection error", async () => {
  overview = {
    connected: false,
    sessions: [],
    approvals: [],
    error: "OpenClaw is older than Reach works with. Update it to 2026.2.26 or newer to use it here.",
    tooOld: { to: "2026.2.26" },
  };
  clawPosts.length = 0;
  const health = [ok("codex"), ok("claude"), { agent: "openclaw", name: "OpenClaw", installed: true, signedIn: false, supported: true, connected: false, tooOld: { to: "2026.2.26" }, needs: ["update"] }];
  const view = await render(health, "openclaw", []);
  const line = await dom.waitFor(() => dom.document.querySelector(".agent-update.too-old"));
  assert.equal(line.querySelector("span").textContent, "Update OpenClaw to 2026.2.26 or newer to use it here.");
  assert.equal(button("Retry connection"), undefined);
  await click(() => button("Update"));
  // OpenClaw's update, asked first.
  await dom.waitFor(() => /Update OpenClaw\?/.test(text()));
  const confirm = await dom.waitFor(() => $$(".claw-confirm-actions button").find((b) => b.textContent.trim() === "Update OpenClaw"));
  await click(confirm);
  await dom.waitFor(() => clawPosts.length > 0);
  assert.deepEqual(clawPosts, [{ confirm: true }]);
  await view.unmount();
  assert.deepEqual(dom.errors, []);
});

test("a chat of a Codex too old: it reads, the box stays, a short line says why, and a refused message says the same", async () => {
  messages.length = 0;
  const health = [{ ...codexOld, signedIn: false }, ok("claude")];
  const view = await mount(
    React.createElement(AgentSessionView, { peer, session: codexChat, siblings: [], health, logos: {}, onSelect() {}, onBack() {} }),
  );
  await dom.waitFor(() => /Built it\./.test(text()));
  const hint = await dom.waitFor(() => dom.document.querySelector(".as-hint"));
  assert.equal(hint.textContent, "Update Codex to 0.148.0 or newer to use it here.");
  assert.equal(/signed out/i.test(text()), false, "not a sign-in");
  const box = dom.document.querySelector(".as-composer textarea");
  assert.ok(box, "writing stays on");
  assert.equal(box.disabled, false);
  await typeInto(box, "Keep going");
  await click(() => button("Send"));
  await dom.waitFor(() => messages.length === 1);
  await dom.waitFor(() => dom.document.querySelector(".as-hint.bad"));
  assert.equal(dom.document.querySelector(".as-hint.bad").textContent, "Codex 0.147.0 is older than Reach works with. Update it to 0.148.0 or newer to use it here.");
  assert.equal(/Update Reach/.test(text()), false);
  await view.unmount();
  assert.deepEqual(dom.errors, []);
});
