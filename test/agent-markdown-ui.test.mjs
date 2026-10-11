import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { startDom } from "./dom/harness.mjs";

// Tables in a chat (Claude's /context, its comparisons) showed as raw "|"
// pipes; now they're tables, and what only looks like one stays words.
let dom, React, AgentMarkdown, SessionLinkContext;
before(async () => {
  dom = await startDom({ mobile: true });
  React = dom.React;
  ({ default: AgentMarkdown, SessionLinkContext } = await dom.load("/src/AgentMarkdown.tsx"));
});

test("a link to another Claude session opens it here, and says when it isn't here yet", async () => {
  const id = "local_4ff35923-e6eb-432e-9e43-ba980333dcde";
  const text = `It's running in its own worktree ([open it](#${id})); more [here](https://example.test).`;
  const opened = [];
  const view = await dom.render(
    React.createElement(
      SessionLinkContext.Provider,
      { value: (ref) => { opened.push(ref); return opened.length === 1; } },
      React.createElement(AgentMarkdown, { text }),
    ),
  );
  const link = view.container.querySelector("button.md-session-link");
  assert.equal(link.textContent, "open it");
  assert.equal(view.container.querySelector("a").getAttribute("href"), "https://example.test");
  link.click();
  await dom.settle?.(5);
  assert.deepEqual(opened, [id]);
  assert.equal(link.textContent, "open it", "found: nothing added to the link");
  link.click();
  await new Promise((done) => setTimeout(done, 10));
  assert.equal(link.textContent, "open it · not here yet");
  await view.unmount();
  // Where no chat can open a session (OpenClaw's space), the link is text.
  const plain = await dom.render(React.createElement(AgentMarkdown, { text }));
  assert.equal(plain.container.querySelector("button.md-session-link"), null);
  assert.equal(plain.container.querySelector("u").textContent, "open it");
  await plain.unmount();
  // A plain http link isn't tappable: only its text (connections audit, Oct 10).
  const insecure = await dom.render(React.createElement(AgentMarkdown, { text: "see [the page](http://example.test/x)" }));
  assert.equal(insecure.container.querySelector("a"), null);
  assert.equal(insecure.container.querySelector("u").textContent, "the page");
  await insecure.unmount();
});
after(() => dom?.close());
const show = async (text) => {
  const view = await dom.render(React.createElement(AgentMarkdown, { text }));
  const root = view.container.querySelector(".md");
  return { root, done: () => view.unmount() };
};

test("a markdown table shows as a table, aligned as written", async () => {
  const { root, done } = await show(
    [
      "## Context Usage",
      "Tokens in use:",
      "| Category | Tokens | Share |",
      "|----------|-------:|:-----:|",
      "| System prompt | 3.1k | **2%** |",
      "| `Messages` | 22k | 11% |",
      "| Pipes \\| inside | 1 |",
      "",
      "Done.",
    ].join("\n"),
  );
  const table = root.querySelector(".md-table table");
  assert.ok(table, "a table");
  assert.deepEqual([...table.querySelectorAll("th")].map((th) => th.textContent), ["Category", "Tokens", "Share"]);
  assert.deepEqual(
    [...table.querySelectorAll("tbody tr")].map((tr) => [...tr.children].map((td) => td.textContent)),
    [
      ["System prompt", "3.1k", "2%"],
      ["Messages", "22k", "11%"],
      ["Pipes | inside", "1", ""],
    ],
  );
  assert.equal(table.querySelector("th:nth-child(2)").style.textAlign, "right");
  assert.equal(table.querySelector("th:nth-child(3)").style.textAlign, "center");
  assert.ok(table.querySelector("tbody strong") && table.querySelector("tbody code"), "inline markdown in cells");
  assert.equal(root.querySelector("p").textContent, "Tokens in use:", "the line before stays a paragraph");
  assert.ok(!/\|---/.test(root.textContent), "no raw pipes");
  await done();
});

test("pipes that aren't a table stay as written", async () => {
  const { root, done } = await show("Use a | b to pipe.\n---\nor `x | y`");
  assert.equal(root.querySelectorAll("table").length, 0);
  assert.match(root.textContent, /Use a \| b to pipe\./);
  await done();
  assert.deepEqual(dom.errors, []);
});


test("session links keep a visible keyboard focus indicator after the link-style reset", async () => {
  const style = dom.document.createElement("style");
  const [base, chat] = await Promise.all(["styles.css", "agent-session.css"].map(
    file => fs.readFile(new URL(`../src/${file}`, import.meta.url), "utf8"),
  ));
  // jsdom does not expand `all: unset`. Model its initial outline values so
  // the lower-specificity global button rule cannot hide this regression.
  style.textContent = `${base}\n.md .md-session-link { outline: none; outline-offset: 0; }\n${chat}`;
  dom.document.head.append(style);
  const view = await dom.render(React.createElement(
    SessionLinkContext.Provider, { value: () => true },
    React.createElement(AgentMarkdown, { text: "[Related chat](#local_4ff35923-e6eb-432e-9e43-ba980333dcde)" }),
  ));
  try {
    const link = view.container.querySelector("button.md-session-link");
    dom.document.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
    link.focus();
    assert.equal(dom.document.activeElement, link);
    assert.equal(link.matches(":focus-visible"), true, "the fixture represents keyboard focus");
    assert.match(dom.window.getComputedStyle(link).outline, /2px solid/, "keyboard focus must remain visible");
    assert.equal(dom.window.getComputedStyle(link).outlineOffset, "4px");
  } finally {
    await view.unmount();
    style.remove();
  }
});
