import test from "node:test";
import assert from "node:assert/strict";
import { createTerminalCards, parseTerminalMenu } from "../server/agent-sessions/terminal-cards.mjs";
import { createAgentSessions } from "../server/agent-sessions/index.mjs";
import { createClaudeHost } from "../server/agent-sessions/claude-host.mjs";

// Claude Code in a terminal asking for permission could only be answered in
// that terminal. Its menu (recorded from Claude Code 2.1.291 in a terminal)
// is now shown on the phone as printed there, and the chosen number typed in.
const screen = (menuStillUp = true) =>
  [
    "⏺ Write(hello.txt)",
    "────────────────────────────────────────────────────────────",
    " Create file",
    " hello.txt",
    "╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌",
    "  1 hi",
    "╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌",
    " Do you want to create hello.txt?",
    " ❯ 1. Yes",
    "   2. Yes, and switch to accept edits (auto-approve file edits and common file commands) for this",
    "      session (shift+tab)",
    "   3. No",
    "",
    " Esc to cancel · Tab to amend",
    ...(menuStillUp ? [] : ["", "⏺ Created hello.txt", "", "> "]),
  ].join("\n");

test("a terminal's permission menu is read as printed: question, choices, what it's about", () => {
  const menu = parseTerminalMenu(screen());
  assert.equal(menu.question, "Do you want to create hello.txt?");
  assert.deepEqual(menu.options, [
    { key: "1", label: "Yes" },
    { key: "2", label: "Yes, and switch to accept edits (auto-approve file edits and common file commands) for this session (shift+tab)" },
    { key: "3", label: "No" },
  ]);
  assert.match(menu.about, /hello\.txt/);
  // Answered: more came after it, so nothing is waiting.
  assert.equal(parseTerminalMenu(screen(false)), null);
  assert.equal(parseTerminalMenu("just a prompt\n> "), null);
});

test("only the tab the chat runs in, only the menu about this request, only a choice it shows", async () => {
  let text = screen();
  const sent = [];
  const terminals = {
    list: async () => ({ sessions: [{ id: "tab-a", tty: "/dev/ttys001" }, { id: "tab-b", tty: "/dev/ttys002" }] }),
    action: async (id, action, body) => {
      if (action === "read") return { text: id === "tab-b" ? text : "" };
      sent.push([id, body.text]);
      text = screen(false);
      return {};
    },
  };
  const cards = createTerminalCards({ terminals, wait: async () => {} });
  assert.deepEqual(await cards.read("ttys002", ["hello.txt"]), {
    found: true,
    texts: ["Do you want to create hello.txt?"],
    buttons: [
      { label: "Yes", menu: false },
      { label: "Yes, and switch to accept edits (auto-approve file edits and common file commands) for this session (shift+tab)", menu: false },
      { label: "No", menu: false },
    ],
  });
  // A menu about something else isn't this one.
  assert.deepEqual(await cards.read("ttys002", ["other.txt"]), { found: false });
  await assert.rejects(cards.press("ttys002", "Maybe", ["hello.txt"]), /no longer offers/);
  await assert.rejects(cards.press("ttys009", "No", ["hello.txt"]), /can't find the terminal/);
  assert.deepEqual(sent, []);
  assert.deepEqual(await cards.press("ttys002", "No", ["hello.txt"]), { pressed: "No" });
  assert.deepEqual(sent, [["tab-b", "3"]]);
  await assert.rejects(cards.press("ttys002", "No", ["hello.txt"]), /already answered/);
});

test("a Claude Code chat waiting in a terminal gets the terminal's own choices on the phone", async () => {
  const ID = "11111111-2222-4333-8444-555555555555";
  const items = [{ id: "toolu_w", role: "tool", kind: "file-change", status: "running", text: "hello.txt", detail: "" }];
  let live = { where: "terminal", pid: 17, tty: "ttys002", exact: true, busy: false, waiting: "permission prompt" };
  let text = screen();
  const sent = [];
  const sessions = createAgentSessions({
    daemon: { rpc: async () => ({}), onNotification() {}, onRequest() {}, onClose() {} },
    codex: { list: async () => [], health: async () => ({}), read: async () => ({}) },
    claude: {
      list: async () => [{ agent: "claude", id: ID, updatedAt: Date.now(), status: "idle" }],
      starts: async () => [],
      health: async () => ({ agent: "claude", installed: true, signedIn: true }),
      read: async (id) => ({ session: { agent: "claude", id, cwd: "/w", status: "idle" }, items, before: null }),
    },
    live: async () => new Map([[ID, live]]),
    liveMs: -1,
    claudeHost: createClaudeHost({ locate: async () => null }),
    signIn: {},
    claudeImports: { add: async () => {}, close() {} },
    open: async () => assert.fail("nothing to bring up for a terminal"),
    terminals: {
      list: async () => ({ sessions: [{ id: "tab-b", tty: "/dev/ttys002" }] }),
      action: async (id, action, body) => {
        if (action === "read") return { text };
        sent.push(body.text);
        text = screen(false);
        live = { ...live, busy: true, waiting: null };
        return {};
      },
    },
  });
  assert.deepEqual((await sessions.read("claude", ID)).session.asking, { kind: "permission", text: "hello.txt", command: false, id: "app-permission:toolu_w" });
  const card = await sessions.card("claude", ID);
  assert.deepEqual(card.buttons, [
    "Yes",
    "Yes, and switch to accept edits (auto-approve file edits and common file commands) for this session (shift+tab)",
    "No",
  ]);
  assert.deepEqual(card.texts, ["Do you want to create hello.txt?"]);
  assert.deepEqual(await sessions.respond("claude", ID, "app-permission:toolu_w", { label: "Yes" }), { answered: true });
  assert.deepEqual(sent, ["1"]);
  sessions.close();
});
