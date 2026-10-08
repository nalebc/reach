import test from "node:test";
import assert from "node:assert/strict";
import { createTerminalCards, parseTerminalMenu } from "../server/agent-sessions/terminal-cards.mjs";
import { createAgentSessions } from "../server/agent-sessions/index.mjs";
import { createClaudeHost } from "../server/agent-sessions/claude-host.mjs";
import { DesktopTerminals } from "../server/desktop-terminals.mjs";

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

for (const phase of ["list", "read"]) test(`terminal approval ownership change during ${phase} prevents dispatch and remains retryable`, async () => {
  let active = true, waitHere = true, sends = 0, waiting = true, entered;
  const started = new Promise(resolve => { entered = resolve; });
  let release;
  const ready = new Promise(resolve => { release = resolve; });
  const guard = () => { if (!active) throw Object.assign(Error("Desktop changed"), { status: 409 }); };
  const terminals = {
    list: async authorize => {
      authorize();
      if (phase === "list" && waitHere) { entered(); await ready; }
      authorize();
      return { sessions: [{ id: "tab", tty: "ttys001" }] };
    },
    action: async (_id, action, _body, authorize) => {
      authorize();
      if (action === "read") {
        if (phase === "read" && waitHere) { entered(); await ready; }
        authorize();
        return { text: screen(waiting) };
      }
      sends++; waiting = false; return {};
    },
  };
  const cards = createTerminalCards({ terminals, wait: async () => {} });
  const answer = cards.press("ttys001", "No", ["hello.txt"], guard);
  await started; active = false; release();
  await assert.rejects(answer, e => e.status === 409 && e.notDispatched === true);
  assert.equal(sends, 0);
  active = true; waitHere = false;
  assert.deepEqual(await cards.press("ttys001", "No", ["hello.txt"], guard), { pressed: "No" });
  assert.equal(sends, 1);
});

test("terminal send failure after dispatch is never marked not-dispatched", async () => {
  const cards = createTerminalCards({ terminals: {
    list: async authorize => { authorize(); return { sessions: [{ id: "tab", tty: "ttys001" }] }; },
    action: async (_id, action, _body, authorize) => {
      authorize(); if (action === "read") return { text: screen() };
      throw Error("Synthetic send acknowledgement lost");
    },
  } });
  await assert.rejects(cards.press("ttys001", "No", ["hello.txt"], () => {}), e => /acknowledgement lost/.test(e.message) && e.notDispatched !== true);
});

test("actual terminal queue rechecks ownership before dispatch and keeps authority checks after acknowledgement", async () => {
  let active = true, authorized = true, sends = 0, invalidateAuthority = false;
  const guard = () => { if (!active) throw Object.assign(Error("Desktop changed"), { status: 409 }); };
  const authorize = () => { if (!authorized) throw Object.assign(Error("Access revoked"), { status: 401 }); };
  const terminals = new DesktopTerminals({ platform: "darwin", run: async () => {
    sends++; active = false;
    if (invalidateAuthority) authorized = false;
    return { ok: true };
  } });
  terminals.targets.set("one", { provider: "terminal", target: { session: "one" } });
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const background = terminals.exclusive(authorize, () => blocked, true);
  const pending = terminals.action("one", "send", { text: "1" }, authorize, { beforeDispatch: guard });
  active = false; release(); await background;
  await assert.rejects(pending, e => e.status === 409 && e.notDispatched === true);
  assert.equal(sends, 0);
  active = true;
  assert.deepEqual(await terminals.action("one", "send", { text: "1" }, authorize, { beforeDispatch: guard }), { ok: true });
  assert.equal(sends, 1, "ownership changes after acknowledged dispatch do not erase the receipt");
  active = true; invalidateAuthority = true;
  await assert.rejects(terminals.action("one", "send", { text: "1" }, authorize, { beforeDispatch: guard }), e => e.status === 401 && e.notDispatched !== true);
  assert.equal(sends, 2, "existing post-dispatch authorization still refuses a revoked caller");
});

test("terminal card keeps an acknowledged answer when foreground ownership changes during native send", async () => {
  let active = true, waiting = true, sends = 0;
  const guard = () => { if (!active) throw Object.assign(Error("Desktop changed"), { status: 409 }); };
  const terminals = new DesktopTerminals({ platform: "darwin", run: async payload => {
    if (payload.action === "list") return { running: payload.provider === "terminal", sessions: payload.provider === "terminal" ? [{ name: "Test", tty: "ttys001", target: { session: "one" } }] : [] };
    if (payload.action === "read") return { text: screen(waiting) };
    assert.equal(payload.action, "send"); assert.equal(payload.text, "3");
    sends++; waiting = false; active = false;
    return { ok: true };
  } });
  const cards = createTerminalCards({ terminals, wait: async () => {} });
  assert.deepEqual(await cards.press("ttys001", "No", ["hello.txt"], guard), { pressed: "No" });
  assert.equal(sends, 1);
  active = true;
  await assert.rejects(cards.press("ttys001", "No", ["hello.txt"], guard), /already answered/);
  assert.equal(sends, 1, "a confirmed answer is never repeated");
});

test("guarded terminal busy or stale-target refusal remains explicitly retryable before any native dispatch", async () => {
  let sends = 0;
  const terminals = new DesktopTerminals({ platform: "darwin", run: async () => { sends++; return { ok: true }; } });
  terminals.targets.set("one", { provider: "terminal", target: { session: "one" } });
  const authorize = () => {}, beforeDispatch = () => {};
  terminals.busy = "user";
  await assert.rejects(terminals.action("one", "send", { text: "1" }, authorize, { beforeDispatch }), e => e.status === 409 && e.notDispatched === true);
  assert.equal(sends, 0);
  terminals.busy = false;
  await assert.rejects(terminals.action("missing", "send", { text: "1" }, authorize, { beforeDispatch }), e => e.status === 404 && e.notDispatched === true);
  assert.equal(sends, 0);
  assert.deepEqual(await terminals.action("one", "send", { text: "1" }, authorize, { beforeDispatch }), { ok: true });
  assert.equal(sends, 1);
  terminals.run = () => { sends++; throw Error("Synthetic acknowledgement unknown"); };
  await assert.rejects(terminals.action("one", "send", { text: "1" }, authorize, { beforeDispatch }), e => /unknown/.test(e.message) && e.notDispatched !== true);
  assert.equal(sends, 2, "a synchronous injected run failure is conservatively treated as dispatched");
});
