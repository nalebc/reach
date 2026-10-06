import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { startDom, settle } from "./dom/harness.mjs";

// Queued messages as the agents' own apps show them: one line each (the
// whole message used to show, wrapped); Claude's fold into a stack and offer
// Send now and a new order; Codex's list Edit and remove only (the Codex app
// runs its own queue).
let dom, React, QueuedMessages;
before(async () => {
  dom = await startDom({ mobile: true });
  React = dom.React;
  ({ default: QueuedMessages } = await dom.load("/src/QueuedMessages.tsx"));
});
after(() => dom?.close());

const long = "Messages stay queued even after being sent. ".repeat(6).trim();
const three = [
  { id: "m1", text: long, images: 1, via: "app" },
  { id: "m2", text: "second", images: 0, via: "app", error: "Goes in when you open this chat in the Claude app." },
  { id: "m3", text: "third", images: 0, via: "app" },
];
const render = (props) => {
  const calls = { now: [], order: [], edit: [], remove: [] };
  return dom
    .render(
      React.createElement(QueuedMessages, {
        busy: null,
        canEdit: true,
        onEdit: (m) => calls.edit.push(m.id),
        onRemove: (m) => calls.remove.push(m.id),
        onSendNow: (m) => calls.now.push(m.id),
        onReorder: (ids) => calls.order.push(ids),
        ...props,
      }),
    )
    .then((view) => ({ view, calls }));
};
const $$ = (sel) => [...dom.document.querySelectorAll(sel)];
const button = (label) => $$("button").filter((b) => b.getAttribute("aria-label") === label);

test("Claude: a stack of one line each, opened with a tap", async () => {
  const { view } = await render({ agent: "claude", messages: three });
  assert.equal($$(".qm-row").length, 1, "folded: the first one only");
  const head = $$(".qm-head")[0];
  assert.match(head.textContent, /3 queued/);
  head.click();
  await settle(10);
  assert.equal($$(".qm-row").length, 3);
  // One line each: its text in a single line, the whole of it only on hover/long-press.
  const first = $$(".qm-text p")[0];
  assert.equal(first.textContent, long);
  assert.equal(first.getAttribute("title"), long);
  assert.equal($$(".qm-text p").length, 3);
  // Why one waits, in one line under it.
  assert.match($$(".qm-why")[0].textContent, /Claude app/);
  await view.unmount();
  assert.deepEqual(dom.errors, []);
});

test("Claude: Send now and a new order, by the handle and the arrow keys", async () => {
  const { view, calls } = await render({ agent: "claude", messages: three });
  $$(".qm-head")[0].click();
  await settle(10);
  button("Send now")[1].click();
  assert.deepEqual(calls.now, ["m2"]);
  const grip = button("Reorder queued message 1 of 3")[0];
  grip.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  assert.deepEqual(calls.order, [["m2", "m1", "m3"]]);
  await view.unmount();
});

test("Claude: Edit is in the row's menu", async () => {
  const { view, calls } = await render({ agent: "claude", messages: [three[1]] });
  button("Queued message actions")[0].click();
  await settle(10);
  const edit = $$('[role="menuitem"]')[0];
  assert.match(edit.textContent, /Edit in composer/);
  edit.click();
  assert.deepEqual(calls.edit, ["m2"]);
  await view.unmount();
});

test("Codex: a plain list, no Send now or reordering (the Codex app runs its queue)", async () => {
  const { view, calls } = await render({
    agent: "codex",
    messages: three.map(({ via, ...m }) => m),
    onSendNow: undefined,
    onReorder: undefined,
  });
  assert.equal($$(".qm-row").length, 3, "all shown, no stack");
  assert.equal($$(".qm-head").length, 0);
  assert.equal(button("Send now").length, 0);
  assert.equal($$(".qm-grip").length, 0);
  button("Remove queued message")[2].click();
  assert.deepEqual(calls.remove, ["m3"]);
  await view.unmount();
});
