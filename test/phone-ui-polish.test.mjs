import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { startDom } from "./dom/harness.mjs";

// Small phone UI bugs found testing every page at 375 points (Oct 5).
const css = (name) => fs.readFileSync(new URL(`../src/${name}`, import.meta.url), "utf8");

let dom, React, ChatList;
before(async () => {
  dom = await startDom({ mobile: true });
  React = dom.React;
  ({ default: ChatList } = await dom.load("/src/ChatList.tsx"));
});
after(() => dom?.close());

const session = {
  agent: "codex",
  id: "t1",
  title: "Fix login",
  cwd: "/Users/me/reach",
  branch: "",
  origin: "app",
  inApp: true,
  updatedAt: Date.now() - 60000,
  createdAt: Date.now() - 600000,
  status: "idle",
  preview: "Tests pass now.",
  archived: false,
};

test("Chat: something waiting, nothing at work, is one row to review it, not a heading over empty space", async () => {
  let reviewed = 0;
  const view = await dom.render(
    React.createElement(ChatList, {
      peer: { id: "a", url: "https://reach.test", token: "t" },
      sessions: [session],
      logos: {},
      agent: "codex",
      onOpen() {},
      onNew() {},
      pending: 1,
      onReview: () => reviewed++,
    }),
  );
  const row = dom.document.querySelector(".chat-needs-row");
  assert.ok(row, "a row for what waits");
  assert.match(row.textContent, /1 request needs you/);
  const headings = [...dom.document.querySelectorAll(".chat-group h2")].map((h) => h.textContent);
  assert.ok(!headings.some((h) => /Needs you/.test(h)), "no empty Needs you section");
  row.click();
  assert.equal(reviewed, 1);
  await view.unmount();
  assert.deepEqual(dom.errors, []);
});

// iPhone Safari zooms the whole page into a field under 16px when it's tapped.
test("on touch screens every text field and select is at least 16px", () => {
  const rule = css("identity.css").match(/@media \(pointer: coarse\) \{\s*input:not\(([^)]*)\),\s*textarea,\s*select \{\s*font-size: 16px !important;/);
  assert.ok(rule, "the 16px floor for fields");
  assert.match(rule[1], /\[type="checkbox"\]/);
});

// The composer's settings row (+, permissions, model, settings, send) wrapped
// and left the send button alone on a second line.
test("the chat composer's tools stay on one row; the model's name gives way first", () => {
  const sheet = css("chat-workspace.css");
  assert.match(sheet, /\.chat-redesign \.as-tools \{\s*flex-wrap: nowrap;/);
  assert.match(sheet, /\.chat-redesign \.as-tools > \.as-model,[^{]*\{\s*flex-shrink: 1;\s*min-width: 0;/);
});

// A long folder name was cut mid-word with no "…" (a flex title drops it).
test("Files' title ends a long folder name with an ellipsis", () => {
  assert.match(css("files.css"), /h1\.files-title \{\s*display: block;\s*\}/);
});

// The Mac's "asking for permission" card in the Needs you sheet: its live-screen
// block sat beside the title and squeezed it to one word per line (Oct 6).
test("Needs you sheet puts the live-screen block under the title", () => {
  const sheet = css("chat-workspace.css");
  assert.match(sheet, /\.reach-chat-sheet \.need-screen \{\s*flex-basis: 100%;/);
  assert.match(sheet, /\.reach-chat-sheet \.need-text \{\s*flex: 1 1 0;\s*min-width: 0;/);
});

// The model sheets showed no handle (it's hidden unless a sheet shows it), so
// they couldn't be pulled down like the apps' sheets (Oct 6).
test("the model sheets show their handle and can be pulled down", () => {
  assert.match(css("model-sheet.css"), /\.ms-sheet \.sheet-handle \{[^}]*display: block;/);
  // The dots aren't drawn as the menu's checked rows (a box behind the knob).
  assert.match(css("model-sheet.css"), /\.as-mode-menu \.ms-dots button\[role="radio"\],\s*\.as-mode-menu \.ms-strip-label \{\s*padding: 0;\s*border-radius: 0;\s*background: none;/);
});
