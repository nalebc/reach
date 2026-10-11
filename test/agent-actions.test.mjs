import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { actionWords, createAgentActions } from "../server/agent-actions.mjs";

// The owner's record of what each agent did: plain sentences, never a vault
// value, kept on disk across restarts, read per agent.
test("each action becomes one plain sentence", () => {
  assert.equal(actionWords("click", { x: 0.42, y: 0.18, button: "left", count: 1 }), "Clicked at 42%, 18%");
  assert.equal(actionWords("click", { x: 0.5, y: 0.5, button: "right", count: 2, holdMs: 1500 }), "Clicked the right button twice at 50%, 50% and held 1.5 s");
  assert.equal(actionWords("type", { text: "diapers" }), "Typed “diapers”");
  assert.equal(actionWords("type", { text: "hunter2", secret: true }), "Typed a value from its vault");
  assert.equal(actionWords("type", { text: "x".repeat(300), paste: true }), "Pasted 300 characters");
  assert.equal(actionWords("type", { text: "a".repeat(80) }), `Typed “${"a".repeat(59)}…”`);
  assert.equal(actionWords("key", { key: "s", modifiers: ["cmd", "shift"] }), "Pressed ⌘⇧S");
  assert.equal(actionWords("key", { key: "enter", modifiers: [] }), "Pressed Enter");
  assert.equal(actionWords("element", { snapshot: "a", n: 3 }, { pressed: "Add to cart" }), "Pressed “Add to cart”");
  assert.equal(actionWords("press", { name: "Next" }), "Pressed “Next”");
  assert.equal(actionWords("fill", { fields: [{ label: "Email", secret: true }, { label: "Notes" }], submit: true }), "Filled Email (from its vault), Notes and pressed Enter");
  assert.equal(actionWords("menu", { path: ["File", "Export As", "PDF…"] }), "Chose File › Export As › PDF…");
  assert.equal(actionWords("scroll", { dy: 300 }), "Scrolled down 300 px");
  assert.equal(actionWords("scroll", { dx: -40 }), "Scrolled left 40 px");
  assert.equal(actionWords("drag", { x: 0.1, y: 0.2, toX: 0.3, toY: 0.4 }), "Dragged from 10%, 20% to 30%, 40%");
  assert.equal(actionWords("open", { app: "/Applications/Numbers.app" }, { app: "Numbers" }), "Opened Numbers");
  assert.equal(actionWords("open", { app: "/Applications/Numbers.app" }), "Opened Numbers.app");
  assert.equal(actionWords("open-url", { url: "https://mail.google.com/mail/u/0" }, { app: "Google Chrome" }), "Opened mail.google.com/mail/u/0 in Google Chrome");
  assert.equal(actionWords("focus", { title: "Inbox" }, { title: "Inbox", tab: "Amazon", app: "Google Chrome" }), "Switched to “Inbox”, tab “Amazon” in Google Chrome");
  assert.equal(actionWords("open-file", { path: "/Users/me/Documents/a.pdf" }, { app: "Preview" }), "Opened “a.pdf” in Preview");
  assert.equal(actionWords("open-file", { path: "/Users/me/Documents", reveal: true }), "Showed “Documents” in the Finder");
  assert.equal(actionWords("find", { text: "Order total" }, { found: true, scrolled: true }), "Looked for “Order total” and scrolled to it");
  assert.equal(actionWords("find", { name: "Next" }, { found: false }), "Looked for “Next”: not there");
  assert.equal(actionWords("command", { command: "npm   test\n" }), "Ran: npm test");
  assert.equal(actionWords("file", { op: "write", path: "notes/a.md" }), "Wrote “notes/a.md”");
  assert.equal(actionWords("file", { op: "cp", path: "a", to: "b" }), "Copied “a” to “b”");
  assert.equal(actionWords("tool", { title: "Gmail search" }), "Ran the tool “Gmail search”");
  assert.equal(actionWords("mac-shortcut", { name: "Today's events" }), "Ran the Mac shortcut “Today's events”");
  // Hidden controls never reach the log.
  assert.equal(actionWords("type", { text: "a\u202eb" }), "Typed “ab”");
});

test("the log keeps each agent's actions newest first, on disk, bounded", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "reach-agent-actions-"));
  const file = path.join(directory, "agent-actions.jsonl");
  try {
    let clock = 1_000_000;
    const log = createAgentActions({ file, now: () => clock, max: 5 });
    const muse = { id: "c1", name: "Muse" }, codex = { id: "c2", name: "Codex" };
    for (let i = 1; i <= 7; i++) { clock += 1000; log.add(i % 2 ? muse : codex, { kind: "type", text: `Typed “${i}”`, app: "Notes" }); }
    clock += 1000;
    log.add(muse, { kind: "command", text: "Ran: rm -rf /", ok: false, reason: "That would delete far more than a project." });
    assert.equal(log.add(null, { kind: "x", text: "y" }), null, "no client, no entry");
    const all = log.list({ limit: 10 });
    assert.equal(all.actions.length, 5, "bounded in memory");
    assert.equal(all.more, false);
    assert.deepEqual(all.actions.map((a) => a.text), ["Ran: rm -rf /", "Typed “7”", "Typed “6”", "Typed “5”", "Typed “4”"]);
    assert.deepEqual(all.actions[0], { id: all.actions[0].id, at: 1_008_000, clientId: "c1", name: "Muse", kind: "command", text: "Ran: rm -rf /", ok: false, reason: "That would delete far more than a project." });
    assert.deepEqual(log.list({ clientId: "c2", limit: 1 }), { actions: [all.actions[2]], more: true });
    assert.deepEqual(log.list({ clientId: "c1", before: 1_008_000 }).actions.map((a) => a.text), ["Typed “7”", "Typed “5”"]);
    assert.equal(log.count("c1"), 3);
    for (const bad of [{ limit: 0 }, { limit: 501 }, { clientId: "" }, { before: -1 }]) assert.throws(() => log.list(bad), (error) => error.status === 400);
    // A restart reads it back, newest first, still bounded.
    const again = createAgentActions({ file, now: () => clock, max: 5 });
    assert.deepEqual(again.list({}).actions.map((a) => a.text), all.actions.map((a) => a.text));
    // A torn last line is skipped, nothing else lost.
    fs.appendFileSync(file, "{not json");
    const third = createAgentActions({ file, max: 5 });
    assert.equal(third.list({}).actions.length, 5);
    // No file: memory only.
    const memory = createAgentActions({ now: () => clock });
    memory.add(muse, { kind: "click", text: "Clicked at 1%, 1%" });
    assert.equal(memory.list({ clientId: "c1" }).actions.length, 1);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
