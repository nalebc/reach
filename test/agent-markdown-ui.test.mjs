import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { startDom } from "./dom/harness.mjs";

// Tables in a chat (Claude's /context, its comparisons) showed as raw "|"
// pipes; now they're tables, and what only looks like one stays words.
let dom, React, AgentMarkdown, SessionLinkContext, RunCommandContext;
before(async () => {
  dom = await startDom({ mobile: true });
  React = dom.React;
  ({ default: AgentMarkdown, SessionLinkContext, RunCommandContext } = await dom.load("/src/AgentMarkdown.tsx"));
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

function mockClipboard(t, clipboard) {
  const navigator = dom.window.navigator;
  const saved = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: clipboard });
  t.after(() => {
    if (saved) Object.defineProperty(navigator, "clipboard", saved);
    else delete navigator.clipboard;
  });
}

test("Copy writes only the tapped block, preserving prompt whitespace and Unicode", async t => {
  const writes = [];
  let finish;
  mockClipboard(t, { writeText: text => {
    writes.push(text);
    return new Promise(resolve => { finish = resolve; });
  } });
  const prompt = "Check Reach’s connection.\n\n  Preserve indentation.\nReport ✓ or ❌.\n";
  const { root, done } = await show(`Intro with \`inline code\`.\n\n\`\`\`\n${prompt}\n\`\`\`\n\nOther text.\n\n\`\`\`js\nconst second = 2;\n\`\`\``);
  try {
    const buttons = [...root.querySelectorAll("button.md-copy")];
    assert.equal(buttons.length, 2, "plain text and labelled blocks both have Copy");
    assert.equal(buttons[0].getAttribute("aria-label"), "Copy text");
    buttons[0].click();
    assert.deepEqual(writes, [prompt], "clipboard write starts within the original tap and excludes prose/fences");
    assert.equal(buttons[0].getAttribute("aria-label"), "Copy text", "no confirmation before the clipboard accepts");
    finish();
    await dom.waitFor(() => buttons[0].getAttribute("aria-label") === "Copied");
    assert.equal(buttons[1].getAttribute("aria-label"), "Copy text", "other blocks keep their own state");
    buttons[1].click();
    assert.deepEqual(writes, [prompt, "const second = 2;"]);
    finish();
  } finally {
    await done();
  }
});

test("unavailable or denied clipboard access reports failure and lets the user retry", async t => {
  mockClipboard(t, undefined);
  for (const clipboard of [
    undefined,
    { writeText: () => Promise.reject(Error("NotAllowedError")) },
    { writeText: () => { throw Error("Clipboard unavailable"); } },
  ]) {
    Object.defineProperty(dom.window.navigator, "clipboard", { configurable: true, value: clipboard });
    const { root, done } = await show("```\nKeep this selectable.\n```");
    try {
      const button = root.querySelector("button.md-copy");
      assert.ok(button, "copy is offered without a terminal provider");
      button.click();
      const error = await dom.waitFor(() => root.querySelector('[role="status"]'));
      assert.match(error.textContent, /Couldn’t copy\. Select the text/);
      assert.equal(button.getAttribute("aria-label"), "Copy text", "failure never claims success");
      assert.equal(root.querySelector("pre code").textContent, "Keep this selectable.");
      let copied;
      Object.defineProperty(dom.window.navigator, "clipboard", {
        configurable: true,
        value: { writeText: async text => { copied = text; } },
      });
      button.click();
      await dom.waitFor(() => button.getAttribute("aria-label") === "Copied");
      assert.equal(copied, "Keep this selectable.");
      assert.equal(root.querySelector('[role="status"]'), null);
    } finally {
      await done();
    }
  }
  assert.deepEqual(dom.errors, []);
});

test("a streaming block copies its latest text and never confirms an older pending copy", async t => {
  const writes = [], pending = [];
  mockClipboard(t, { writeText: text => {
    writes.push(text);
    return new Promise(resolve => pending.push(resolve));
  } });
  let update;
  function Streaming() {
    const [text, setText] = React.useState("```\nFirst part");
    update = setText;
    return React.createElement(AgentMarkdown, { text });
  }
  const view = await dom.render(React.createElement(Streaming));
  try {
    const button = view.container.querySelector("button.md-copy");
    button.click();
    dom.update(() => update("```\nFirst part\nNow complete.\n```"));
    pending[0]();
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(button.getAttribute("aria-label"), "Copy text", "old text is no longer the displayed block");
    button.click();
    assert.deepEqual(writes, ["First part", "First part\nNow complete."]);
    pending[1]();
    await dom.waitFor(() => button.getAttribute("aria-label") === "Copied");
  } finally {
    await view.unmount();
  }
});

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

test("a shell block has a play button that runs its command; other code, or no chat to run it, has none", async () => {
  const text = [
    "Run the tests:",
    "```bash",
    "npm test",
    "```",
    "Then this, in a console:",
    "```console",
    "$ cd app",
    "$ npm run build",
    "```",
    "The code:",
    "```js",
    "const x = 1;",
    "```",
    "Still streaming:",
    "```sh",
    "echo partial",
  ].join("\n");
  const ran = [];
  const view = await dom.render(
    React.createElement(RunCommandContext.Provider, { value: (command) => ran.push(command) },
      React.createElement(AgentMarkdown, { text })),
  );
  const blocks = [...view.container.querySelectorAll(".md-code")];
  assert.equal(blocks.length, 4);
  assert.deepEqual(blocks.map((b) => b.querySelector("code").textContent),
    ["npm test", "$ cd app\n$ npm run build", "const x = 1;", "echo partial"], "code shows as written");
  const buttons = [...view.container.querySelectorAll("button.md-run")];
  assert.equal(buttons.length, 3, "bash, console and sh blocks; not js");
  assert.equal(buttons[0].getAttribute("aria-label"), "Run in a terminal");
  for (const b of buttons) b.click();
  assert.deepEqual(ran, ["npm test", "cd app\nnpm run build", "echo partial"], "a console's $ prompts aren't typed");
  assert.match(view.container.textContent, /Then this, in a console:/);
  assert.match(view.container.textContent, /The code:/);
  await view.unmount();
  // Where nothing can run it (a device without Reach terminals), no button.
  const plain = await dom.render(React.createElement(AgentMarkdown, { text }));
  assert.equal(plain.container.querySelectorAll("button.md-run").length, 0);
  assert.equal(plain.container.querySelectorAll("pre").length, 4);
  await plain.unmount();
});

test("a bare https address is a tappable link; punctuation, code and plain http stay text", async () => {
  const view = await dom.render(React.createElement(AgentMarkdown, {
    text: "PR: https://github.com/nalebc/reach/pull/26. Run (https://github.com/nalebc/reach/actions/runs/1), and **see https://example.test/a_(b)** or <https://example.test/c>. Not `https://example.test/code` nor http://example.test/plain.",
  }));
  const links = [...view.container.querySelectorAll("a")].map((a) => [a.getAttribute("href"), a.textContent, a.getAttribute("target"), a.getAttribute("rel")]);
  assert.deepEqual(links.map(([href]) => href), [
    "https://github.com/nalebc/reach/pull/26",
    "https://github.com/nalebc/reach/actions/runs/1",
    "https://example.test/a_(b)",
    "https://example.test/c",
  ]);
  for (const [href, text, target, rel] of links) {
    assert.equal(text, href, "the address shows as itself");
    assert.equal(target, "_blank");
    assert.equal(rel, "noopener noreferrer");
  }
  const text = view.container.textContent;
  assert.match(text, /pull\/26\. Run \(/, "the full stop and the bracket stay outside the link");
  assert.match(text, /runs\/1\), and/);
  assert.equal(view.container.querySelector("strong a")?.getAttribute("href"), "https://example.test/a_(b)", "a link inside bold");
  assert.equal(view.container.querySelector("code").textContent, "https://example.test/code", "code stays code");
  assert.match(text, /http:\/\/example\.test\/plain/, "plain http stays text");
  await view.unmount();
});

test("a link's address comes back as written when it's well formed, and escaped when it isn't", async () => {
  const view = await dom.render(React.createElement(AgentMarkdown, {
    text: "https://example.test/a%20b?q=1&r=two#frag and [x](https://example.test/%E2%9C%93) and https://example.test/%zz",
  }));
  const hrefs = [...view.container.querySelectorAll("a")].map((a) => a.getAttribute("href"));
  assert.deepEqual(hrefs, ["https://example.test/a%20b?q=1&r=two#frag", "https://example.test/%E2%9C%93"]);
  assert.match(view.container.textContent, /https:\/\/example\.test\/%zz/, "a malformed address stays text");
  await view.unmount();
});
