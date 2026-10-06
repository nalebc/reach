import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { startDom } from "./dom/harness.mjs";

// Tables in a chat (Claude's /context, its comparisons) showed as raw "|"
// pipes; now they're tables, and what only looks like one stays words.
let dom, React, AgentMarkdown;
before(async () => {
  dom = await startDom({ mobile: true });
  React = dom.React;
  ({ default: AgentMarkdown } = await dom.load("/src/AgentMarkdown.tsx"));
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
