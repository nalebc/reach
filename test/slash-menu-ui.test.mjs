import test, { before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { startDom, settle, typeInto, press, replaceText } from "./dom/harness.mjs";

// "/" in a chat's composer, as in the agents' own apps: every agent's own
// commands from the Mac (it was Claude Code's only), picked with a tap or the
// keyboard. Codex's own commands run in the chat; its skills go with the
// message; Claude Code's run as the message itself.
const peer = { id: "mac", name: "Mac", url: "https://reach.test", token: "t", platform: "darwin" };
const ID = "0199aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee";
const base = {
  id: ID,
  title: "Fix the build",
  cwd: "/work/app",
  branch: "main",
  origin: "app",
  updatedAt: Date.now(),
  createdAt: Date.now(),
  status: "idle",
  preview: "",
  archived: false,
  live: null,
};
const codexCommands = [
  { name: "status", title: "Status", description: "Show chat ID, model, and rate limits", hint: "", action: "run" },
  { name: "compact", title: "Compact", description: "Compact this chat's context", hint: "", action: "run" },
  { name: "review", title: "Review", description: "Review your uncommitted changes, or against a branch", hint: "[branch]", action: "run" },
  { name: "rename", title: "Rename", description: "Rename the current chat", hint: "<name>", action: "insert" },
  { name: "documents:documents", title: "Documents", description: "Create and edit Word and Google Docs files", hint: "", group: "skills", action: "insert" },
];
const claudeCommands = [
  { name: "compact", description: "Clear conversation history but keep a summary in context", hint: "<optional custom summarization instructions>", action: "insert" },
  { name: "context", description: "Show current context usage", hint: "", action: "insert" },
  { name: "clear", description: "Start a new session with empty context", hint: "", action: "new" },
];
const calls = [];
const items = { codex: [], claude: [] };
const live = { version: 1, status: "idle", error: null, prompts: [], streaming: "", activity: null, items: 0 };
const body = (init) => JSON.parse(init.body || "{}");
let dom, React, AgentSessionView;
before(async () => {
  const routes = {
    "/api/sessions/logos": () => ({ version: "v1", logos: {} }),
    "/api/sessions/models": () => ({ models: [] }),
    "/api/sessions/commands": (init, href) => {
      calls.push(["list", href.searchParams.get("agent"), href.searchParams.get("id")]);
      return { commands: href.searchParams.get("agent") === "codex" ? codexCommands : claudeCommands };
    },
  };
  for (const agent of ["codex", "claude"]) {
    routes[`/api/sessions/${agent}/${ID}`] = () => ({ session: { ...base, agent }, items: items[agent] });
    routes[`/api/sessions/${agent}/${ID}/live`] = async () => (await settle(60), live);
    routes[`/api/sessions/${agent}/${ID}/messages`] = (init) => (calls.push(["message", agent, body(init)]), { turnId: "t1" });
    routes[`/api/sessions/${agent}/${ID}/commands`] = (init) => {
      const b = body(init);
      calls.push(["command", agent, b]);
      return b.name === "status"
        ? { card: { title: "Status", rows: [{ label: "Chat", value: ID }, { label: "5-hour limit", value: "12% used", resetsAt: Date.now() + 3600000 }] } }
        : { ok: true };
    };
  }
  dom = await startDom({ mobile: true, routes });
  React = dom.React;
  ({ default: AgentSessionView } = await dom.load("/src/AgentSession.tsx"));
});
after(() => dom?.close());
beforeEach(() => {
  dom.errors.length = 0;
  calls.length = 0;
});
const views = [];
afterEach(async () => {
  for (const view of views.splice(0)) await view.unmount();
});
const health = [
  { agent: "codex", installed: true, signedIn: true },
  { agent: "claude", installed: true, signedIn: true },
];
let newChats = 0;
const open = async (agent) => {
  const view = await dom.render(
    React.createElement(AgentSessionView, { peer, session: { ...base, agent }, siblings: [], health, logos: {}, onSelect() {}, onBack() {}, onNew: () => newChats++ }),
  );
  views.push(view);
  await dom.waitFor(() => dom.document.querySelector(".as-composer textarea"));
  // The box keeps an unsent draft per chat; each test starts from an empty one.
  const box = dom.document.querySelector(".as-composer textarea");
  if (box.value) await replaceText(box, "");
  return box;
};
const menu = () => dom.document.querySelector(".sm-menu");
const rows = () => [...dom.document.querySelectorAll(".sm-menu [role=option]")];
const sendButton = () => dom.document.querySelector('button[aria-label="Send"]');

test("in a Codex chat, '/' opens Codex's own commands and skills, from the Mac, as the Codex app lists them", async () => {
  const box = await open("codex");
  await typeInto(box, "/");
  await dom.waitFor(() => rows().length);
  assert.deepEqual(calls[0], ["list", "codex", ID], "asked of the Mac for this chat");
  assert.equal(menu().dataset.agent, "codex");
  assert.deepEqual(rows().map((r) => r.querySelector("b").textContent), ["Status", "Compact", "Review", "Rename", "Documents"]);
  assert.equal(dom.document.querySelector(".sm-group").textContent, "Skills");
  // Filtered as you type.
  await typeInto(box, "re");
  assert.deepEqual(rows().map((r) => r.querySelector("b").textContent), ["Review", "Rename"]);
  assert.deepEqual(dom.errors, []);
});

test("picking a Codex command runs it in the chat; what it answers shows above the box; nothing is sent as text", async () => {
  const box = await open("codex");
  await typeInto(box, "/sta");
  await dom.waitFor(() => rows().length);
  rows()[0].click();
  await dom.waitFor(() => dom.document.querySelector(".sm-card"));
  assert.deepEqual(calls.filter((c) => c[0] !== "list"), [["command", "codex", { name: "status", args: "" }]]);
  const card = dom.document.querySelector(".sm-card");
  assert.equal(card.querySelector("b").textContent, "Status");
  assert.match(card.textContent, new RegExp(ID));
  assert.match(card.textContent, /5-hour limit12% used · resets /);
  assert.equal(box.value, "");
  card.querySelector('button[aria-label="Close"]').click();
  await settle();
  assert.equal(dom.document.querySelector(".sm-card"), null);
  assert.deepEqual(dom.errors, []);
});

test("the keyboard: ↓ and Enter pick, Esc closes; a Codex command typed out and sent runs instead of going as text", async () => {
  const box = await open("codex");
  await typeInto(box, "/re");
  await dom.waitFor(() => rows().length === 2);
  assert.equal(await press(box, "ArrowDown"), false, "the menu's key");
  assert.equal(rows()[1].getAttribute("aria-selected"), "true");
  await press(box, "Enter");
  assert.equal(box.value, "/rename ", "a command that takes words goes in the box");
  await typeInto(box, "Build fixes");
  sendButton().click();
  await dom.waitFor(() => calls.some((c) => c[0] === "command"));
  assert.deepEqual(calls.filter((c) => c[0] !== "list"), [["command", "codex", { name: "rename", args: "Build fixes" }]]);
  // Esc closes the menu until the text changes.
  await typeInto(box, "/co");
  await dom.waitFor(() => rows().length);
  await press(box, "Escape");
  assert.equal(menu(), null);
  assert.deepEqual(dom.errors, []);
});

test("a Codex skill goes with the message, as a chip in the box; its name is sent, not a path", async () => {
  const box = await open("codex");
  await typeInto(box, "/doc");
  await dom.waitFor(() => rows().length);
  rows()[0].click();
  await dom.waitFor(() => dom.document.querySelector(".sm-chip"));
  assert.match(dom.document.querySelector(".sm-chip").textContent, /Documents/);
  assert.equal(box.value, "");
  await typeInto(box, "Write the release notes");
  sendButton().click();
  await dom.waitFor(() => calls.some((c) => c[0] === "message"));
  const [, agent, sent] = calls.find((c) => c[0] === "message");
  assert.equal(agent, "codex");
  assert.equal(sent.skill, "documents:documents");
  assert.equal(sent.text, "Write the release notes");
  await dom.waitFor(() => !dom.document.querySelector(".sm-chip"));
  assert.deepEqual(dom.errors, []);
});

test("in a Claude Code chat, its own commands; picked, it goes in the box and is sent as the message", async () => {
  const box = await open("claude");
  await typeInto(box, "/");
  await dom.waitFor(() => rows().length);
  assert.equal(menu().dataset.agent, "claude");
  assert.deepEqual(rows().map((r) => r.querySelector("b").textContent), ["/compact", "/context", "/clear"]);
  rows()[1].click();
  await settle();
  assert.equal(box.value, "/context ");
  sendButton().click();
  await dom.waitFor(() => calls.some((c) => c[0] === "message"));
  assert.deepEqual(calls.filter((c) => c[0] !== "list").map((c) => [c[0], c[2].text]), [["message", "/context "]]);
  assert.deepEqual(dom.errors, []);
});

test("a slash command in the chat shows as typed, and what it printed below it", async () => {
  items.claude = [
    { id: "u1", role: "user", kind: "text", text: "/context", slash: true, at: Date.now() - 2000 },
    { id: "o1", role: "system", kind: "output", text: "## Context Usage\n\n**Tokens:** 26.4k / 200k (13%)", at: Date.now() - 1000 },
  ];
  await open("claude");
  await dom.waitFor(() => dom.document.querySelector(".as-output"));
  assert.equal(dom.document.querySelector(".as-user .as-slash").textContent, "/context");
  assert.match(dom.document.querySelector(".as-output").textContent, /Context Usage/);
  items.claude = [];
  assert.deepEqual(dom.errors, []);
});

test("Claude's /clear opens a new chat, picked or typed out; it's never sent into this one", async () => {
  const box = await open("claude");
  newChats = 0;
  await typeInto(box, "/cle");
  await dom.waitFor(() => rows().length);
  rows()[0].click();
  await settle();
  assert.equal(newChats, 1);
  assert.equal(box.value, "");
  await typeInto(box, "/clear");
  await press(box, "Escape");
  sendButton().click();
  await settle(100);
  assert.equal(newChats, 2);
  assert.ok(!calls.some((c) => c[0] === "message"), "nothing sent");
  assert.deepEqual(dom.errors, []);
});

// A typo'd command ("/contxt") went to Claude as a message and used a turn.
test("a command no agent has is pointed out first; Send again sends it as typed", async () => {
  const box = await open("claude");
  await typeInto(box, "/contxt");
  // The commands are in (the list is kept a minute): no match, no menu.
  await dom.waitFor(() => !dom.document.querySelector(".sm-menu"));
  sendButton().click();
  await dom.waitFor(() => dom.document.querySelector(".sm-error"));
  assert.match(dom.document.querySelector(".sm-error").textContent, /Claude Code has no \/contxt command/);
  assert.equal(box.value, "/contxt");
  assert.ok(!calls.some((c) => c[0] === "message"), "not sent yet");
  sendButton().click();
  await dom.waitFor(() => calls.some((c) => c[0] === "message"));
  assert.deepEqual(calls.filter((c) => c[0] === "message").map((c) => c[2].text), ["/contxt"]);
  // A path is words, not a command; an MCP server's prompt goes as typed.
  await typeInto(box, "/Users/me/notes.txt is empty");
  await settle();
  sendButton().click();
  await dom.waitFor(() => calls.filter((c) => c[0] === "message").length === 2);
  await typeInto(box, "/mcp__github__list_prs");
  await settle();
  sendButton().click();
  await dom.waitFor(() => calls.filter((c) => c[0] === "message").length === 3);
  assert.deepEqual(dom.errors, []);
});
