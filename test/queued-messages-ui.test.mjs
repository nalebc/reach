import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { startDom, settle } from "./dom/harness.mjs";

// Queued messages as the agents' own apps show them: one line each, the
// whole of it on a tap; Edit where it waits (pictures kept); Send now (Claude:
// into its app chat at once; Codex: its Steer); Claude's fold into a stack and
// take a new order.
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
        onEdit: async (m, text) => {
          calls.edit.push([m.id, text]);
        },
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


test("Claude: a stack of one line each, opened with a tap; a message opens whole on a tap", async () => {
  const { view } = await render({ agent: "claude", messages: three });
  try {
    assert.equal($$(".qm-row").length, 1, "folded: the first one only");
    const head = $$(".qm-head")[0];
    assert.match(head.textContent, /3 queued/);
    head.click();
    await settle(10);
    assert.equal($$(".qm-row").length, 3);
    // One line each; a tap shows all of it, another folds it back.
    const first = $$(".qm-open")[0];
    assert.equal(first.textContent, long);
    assert.equal(first.getAttribute("aria-expanded"), "false");
    first.click();
    await settle(10);
    assert.equal($$(".qm-open")[0].getAttribute("aria-expanded"), "true");
    assert.equal($$(".qm-text.whole").length, 1);
    $$(".qm-open")[0].click();
    await settle(10);
    assert.equal($$(".qm-text.whole").length, 0);
    // Why one waits, in one line under it.
    assert.match($$(".qm-why")[0].textContent, /Claude app/);
  } finally {
    await view.unmount();
  }
  assert.deepEqual(dom.errors, []);
});

test("Claude: Send now and a new order, by the handle and the arrow keys", async () => {
  const { view, calls } = await render({ agent: "claude", messages: three });
  try {
    $$(".qm-head")[0].click();
    await settle(10);
    button("Send now")[1].click();
    assert.deepEqual(calls.now, ["m2"]);
    const grip = button("Reorder queued message 1 of 3")[0];
    grip.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    assert.deepEqual(calls.order, [["m2", "m1", "m3"]]);
  } finally {
    await view.unmount();
  }
});

test("dragging a handle crosses a row midpoint and keeps the new order visible while it syncs", async () => {
  const { view, calls } = await render({ agent: "codex", messages: three });
  try {
    for (const el of $$(".qm-row")) {
      el.getBoundingClientRect = () => {
        const top = $$(".qm-row").indexOf(el) * 40;
        return { top, bottom: top + 40, height: 40 };
      };
    }
    const grip = button("Reorder queued message 1 of 3")[0];
    grip.setPointerCapture = () => {};
    const pointer = (type, clientY) => {
      const event = new dom.window.MouseEvent(type, { bubbles: true, button: 0, clientY });
      Object.defineProperty(event, "pointerId", { value: 1 });
      dom.update(() => grip.dispatchEvent(event));
    };
    pointer("pointerdown", 20);
    pointer("pointermove", 23);
    pointer("pointerup", 23);
    assert.deepEqual(calls.order, [], "a tap does not reorder");
    pointer("pointerdown", 20);
    pointer("pointermove", 70);
    pointer("pointerup", 70);
    await settle(10);
    assert.deepEqual(calls.order, [["m2", "m1", "m3"]]);
    assert.deepEqual($$(".qm-open").map((el) => el.textContent), ["second", long, "third"]);
  } finally {
    await view.unmount();
  }
});

test("Edit is directly available and changes a queued message where it waits, one with pictures too", async () => {
  const { view, calls } = await render({ agent: "claude", messages: [three[0]] });
  try {
    button("Edit queued message")[0].click();
    await settle(10);
    const box = $$('textarea[aria-label="Edit queued message"]')[0];
    assert.equal(box.value, long);
    dom.update(() => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value").set.call(box, "shorter");
      box.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
    $$(".qm-edit button.primary")[0].click();
    await settle(20);
    assert.deepEqual(calls.edit, [["m1", "shorter"]]);
    // Saved: back to one line.
    assert.equal($$("textarea").length, 0);
  } finally {
    await view.unmount();
  }
});

test("Codex: a plain list with Send now (its Steer) and direct edit", async () => {
  const { view, calls } = await render({
    agent: "codex",
    messages: three.map(({ via, ...m }) => m),
    onReorder: undefined,
  });
  try {
    assert.equal($$(".qm-row").length, 3, "all shown, no stack");
    assert.equal($$(".qm-head").length, 0);
    assert.equal(button("Send now").length, 3);
    assert.equal(button("Edit queued message").length, 3);
    button("Send now")[0].click();
    assert.deepEqual(calls.now, ["m1"]);
    assert.equal($$(".qm-grip").length, 0);
    button("Remove queued message")[2].click();
    assert.deepEqual(calls.remove, ["m3"]);
  } finally {
    await view.unmount();
  }
});


test("an in-flight queue action blocks competing mutations but keeps text expandable", async () => {
  const { view } = await render({ agent: "codex", messages: three, busy: "order" });
  try {
    for (const selector of [".qm-grip", ".qm-action", ".qm-now", '[aria-label="Remove queued message"]'])
      assert.ok($$(selector).every(el => el.disabled), selector);
    assert.ok($$(".qm-open").every(el => !el.disabled));
  } finally { await view.unmount(); }
});

test("a different authoritative native order replaces a pending optimistic order", async () => {
  let setMessages;
  const orders = [];
  function Fixture() {
    const [messages, update] = React.useState(three); setMessages = update;
    return React.createElement(QueuedMessages, { agent: "codex", messages, busy: null, canEdit: true,
      onEdit: async () => {}, onRemove() {}, onReorder: ids => { orders.push(ids); } });
  }
  const view = await dom.render(React.createElement(Fixture));
  try {
    dom.update(() => button("Reorder queued message 1 of 3")[0].dispatchEvent(
      new dom.window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
    await settle(10);
    assert.deepEqual(orders, [["m2", "m1", "m3"]]);
    dom.update(() => setMessages([three[2], three[0], three[1]]));
    await settle(10);
    assert.deepEqual($$(".qm-open").map(el => el.textContent), ["third", long, "second"]);
  } finally { await view.unmount(); }
});

test("a rejected queue reorder rolls back without another request", async () => {
  let reject, calls = 0;
  const pending = new Promise((_resolve, fail) => { reject = fail; });
  const { view } = await render({ agent: "codex", messages: three,
    onReorder: () => { calls++; return pending; } });
  try {
    dom.update(() => button("Reorder queued message 1 of 3")[0].dispatchEvent(
      new dom.window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
    assert.deepEqual($$(".qm-open").map(el => el.textContent), ["second", long, "third"]);
    reject(Error("Native queue changed")); await settle(10);
    assert.deepEqual($$(".qm-open").map(el => el.textContent), [long, "second", "third"]);
    assert.equal(calls, 1);
  } finally { await view.unmount(); }
});
