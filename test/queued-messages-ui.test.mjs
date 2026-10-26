import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { startDom, settle } from "./dom/harness.mjs";

// Queued messages, the same list in every chat that queues: one line each,
// the whole of it on a tap; Edit where it waits (pictures kept); Send now
// (Claude: into its app chat at once; Codex: its Steer); a new order by
// dragging the handle (a lifted copy, the others sliding, a gap) or from the
// keyboard, announced.
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


test("Claude: the same list as Codex's, one line each; a message opens whole on a tap", async () => {
  const { view } = await render({ agent: "claude", messages: three });
  try {
    assert.equal($$(".qm-row").length, 3, "every row shown, no fold");
    assert.equal($$(".qm-head").length, 0);
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

test("the message and edit controls keep their full widths in the queue styles", async () => {
  const style = dom.document.createElement("style");
  style.textContent = readFileSync(new URL("../src/queued-messages.css", import.meta.url), "utf8");
  dom.document.head.append(style);
  const { view } = await render({ agent: "codex", messages: [three[0]] });
  try {
    assert.equal(dom.window.getComputedStyle($$(".qm-open")[0]).width, "100%");
    button("Edit queued message")[0].click();
    await settle(10);
    assert.equal(dom.window.getComputedStyle($$(".qm-edit-actions button")[0]).width, "auto");
  } finally {
    await view.unmount();
    style.remove();
  }
});

test("Claude: Send now and a new order, by the handle and the arrow keys", async () => {
  const { view, calls } = await render({ agent: "claude", messages: three });
  try {
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

test("saving a queued edit freezes its text and competing actions until the server replies", async () => {
  let finish;
  const { view } = await render({ agent: "codex", messages: three,
    onEdit: () => new Promise((resolve) => { finish = resolve; }) });
  try {
    button("Edit queued message")[0].click();
    await settle();
    $$(".qm-edit button.primary")[0].click();
    await settle();
    assert.equal($$(".qm-edit textarea")[0].disabled, true, "typing during save would otherwise be discarded");
    assert.ok(button("Remove queued message").every((el) => el.disabled));
    assert.ok(button("Send now").every((el) => el.disabled));
  } finally { finish?.(); await settle(); await view.unmount(); }
});

test("two submit events in one render send a queued edit only once", async () => {
  let finish, calls = 0;
  const pending = new Promise((resolve) => { finish = resolve; });
  const { view } = await render({ agent: "codex", messages: three,
    onEdit: () => { calls++; return pending; } });
  try {
    button("Edit queued message")[0].click();
    await settle();
    const form = $$(".qm-edit")[0];
    dom.update(() => {
      form.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
      form.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
    });
    assert.equal(calls, 1);
  } finally { finish(); await settle(); await view.unmount(); }
});

// Rows 40px tall, stacked from the top; a pointer on one row's handle.
const geometry = () => {
  for (const el of $$(".qm-row"))
    el.getBoundingClientRect = () => {
      const top = $$(".qm-row").indexOf(el) * 40;
      return { top, bottom: top + 40, height: 40, left: 0, width: 300 };
    };
};
const pointerOn = (grip) => {
  grip.setPointerCapture = () => {};
  return (type, clientY) => {
    const event = new dom.window.MouseEvent(type, { bubbles: true, button: 0, clientY });
    Object.defineProperty(event, "pointerId", { value: 1 });
    dom.update(() => grip.dispatchEvent(event));
  };
};
const key = (el, k) => dom.update(() => el.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: k, bubbles: true })));
const texts = () => $$(".qm-open").map((el) => el.textContent);
// The harness answers every media query with `mobile`: reduced motion set here.
const motion = (reduced) => {
  const saved = dom.window.matchMedia;
  dom.window.matchMedia = (media) => ({ ...saved(media), matches: /reduced-motion/.test(media) ? reduced : saved(media).matches });
  return () => { dom.window.matchMedia = saved; };
};
const said = () => $$(".qm-live")[0].textContent;

test("every app's queue rows carry the same controls: handle, preview, Send now, Edit, remove", async () => {
  for (const [agent, messages] of [["codex", three.map(({ via, ...m }) => m)], ["claude", three]]) {
    const { view } = await render({ agent, messages });
    try {
      const rows = $$(".qm-row");
      assert.equal(rows.length, 3, agent);
      for (const row of rows) {
        const labels = [...row.querySelectorAll("button")].map((b) => b.getAttribute("aria-label") || "open");
        assert.deepEqual(labels.map((l) => l.replace(/ \d of 3$/, "")),
          ["Reorder queued message", "open", "Send now", "Edit queued message", "Remove queued message"], agent);
      }
      assert.equal(rows[0].querySelector(".qm-images").getAttribute("aria-label"), "1 image");
    } finally { await view.unmount(); }
  }
});

test("rows nothing can move have no handle and keep their place: Claude Code's own queue, the phone's copy, one being sent", async () => {
  const restore = motion(true);
  const messages = [
    { id: "h1", text: "already in Claude Code", images: 0, held: true },
    { id: "l1", text: "phone copy", images: 0, held: true, local: true },
    { id: "s1", text: "on its way", images: 0, sending: true },
    { id: "a", text: "alpha", images: 0 },
    { id: "b", text: "beta", images: 0 },
  ];
  const { view, calls } = await render({ agent: "claude", messages });
  try {
    assert.equal($$(".qm-grip").length, 2, "only the two still waiting in Reach's queue");
    geometry();
    const pointer = pointerOn(button("Reorder queued message 5 of 5")[0]);
    // Dragged far above the top: it stops below the rows that can't move.
    pointer("pointerdown", 180);
    pointer("pointermove", -400);
    pointer("pointerup", -400);
    await settle(10);
    assert.deepEqual(calls.order, [["s1", "b", "a"]], "the Mac's queue in its new order, not what only shows here");
    assert.deepEqual(texts(), ["already in Claude Code", "phone copy", "on its way", "beta", "alpha"]);
  } finally { restore(); await view.unmount(); }
});

test("dragging: a press lifts a copy, the others slide, a gap shows, and the row settles into place on release", async () => {
  const restore = motion(false);
  const { view, calls } = await render({ agent: "codex", messages: three });
  try {
    geometry();
    const pointer = pointerOn(button("Reorder queued message 1 of 3")[0]);
    pointer("pointerdown", 20);
    assert.equal($$(".qm-ghost").length, 0, "not lifted by the press alone yet");
    await settle(260);
    // Held: lifted, a copy following the finger, its own slot a gap.
    assert.equal($$(".qm-ghost").length, 1);
    assert.equal($$(".qm-ghost")[0].getAttribute("aria-hidden"), "true");
    assert.match($$(".qm-ghost")[0].textContent, /Messages stay queued/);
    assert.ok($$(".qm-row")[0].classList.contains("qm-gap"));
    assert.ok($$(".qm")[0].classList.contains("sorting"));
    pointer("pointermove", 105);
    await settle(40);
    // Past both other rows' middles: they slide up, the gap goes to the end.
    const [first, second, third] = $$(".qm-row");
    assert.equal(second.style.transform, "translate3d(0, -40px, 0)");
    assert.equal(third.style.transform, "translate3d(0, -40px, 0)");
    assert.equal(first.style.transform, "translate3d(0, 80px, 0)");
    assert.match($$(".qm-ghost")[0].style.transform, /translate3d\(0, 85px, 0\) scale\(1\.03\)/);
    pointer("pointerup", 105);
    // Released: the copy glides into the gap first.
    assert.ok($$(".qm-ghost")[0].classList.contains("qm-dropping"));
    assert.equal($$(".qm-ghost")[0].style.transform, "translate3d(0, 80px, 0)");
    assert.deepEqual(calls.order, []);
    await settle(260);
    assert.deepEqual(calls.order, [["m2", "m3", "m1"]]);
    assert.deepEqual(texts(), ["second", "third", long]);
    assert.equal($$(".qm-ghost").length, 0);
    assert.ok($$(".qm-row").every((r) => !r.style.transform && !r.classList.contains("qm-gap")));
    assert.match(said(), /Moved to position 3 of 3/);
  } finally { restore(); await view.unmount(); }
  assert.deepEqual(dom.errors, []);
});

// Oct 25, Intel macOS CI: Escape pressed while the row was lifted did
// nothing. The window's Escape listener came with a passive effect, which
// React runs some time after the lifted copy shows: a busy phone (or CI
// machine) let an Escape land in between. It listens as the copy shows.
test("Escape the moment a row lifts puts it back: the copy never shows without Escape working", async () => {
  const restore = motion(true);
  const { view, calls } = await render({ agent: "codex", messages: three });
  try {
    geometry();
    const pointer = pointerOn(button("Reorder queued message 1 of 3")[0]);
    pointer("pointerdown", 20);
    pointer("pointermove", 100);
    // The lift renders in a later task (a move isn't a discrete event):
    // the moment its copy shows, and not a task later, Escape.
    for (let i = 0; i < 50 && !$$(".qm-ghost").length; i++) await settle(0);
    assert.equal($$(".qm-ghost").length, 1, "lifted, its copy showing");
    dom.update(() => dom.window.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    assert.equal($$(".qm-ghost").length, 0);
    pointer("pointerup", 100);
    await settle(10);
    assert.deepEqual(calls.order, []);
    assert.deepEqual(texts(), [long, "second", "third"]);
    assert.match(said(), /Cancelled\. Back at position 1 of 3/);
  } finally { restore(); await view.unmount(); }
});

test("Escape while dragging puts the row back where it was, nothing sent", async () => {
  const restore = motion(true);
  const { view, calls } = await render({ agent: "codex", messages: three });
  try {
    geometry();
    const pointer = pointerOn(button("Reorder queued message 1 of 3")[0]);
    pointer("pointerdown", 20);
    pointer("pointermove", 100);
    await settle(40);
    assert.notEqual($$(".qm-row")[1].style.transform, "");
    dom.update(() => dom.window.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    await settle(10);
    assert.equal($$(".qm-ghost").length, 0);
    assert.ok($$(".qm-row").every((r) => !r.style.transform));
    pointer("pointerup", 100);
    await settle(10);
    assert.deepEqual(calls.order, []);
    assert.deepEqual(texts(), [long, "second", "third"]);
    assert.match(said(), /Cancelled\. Back at position 1 of 3/);
  } finally { restore(); await view.unmount(); }
});

test("with reduced motion a drop lands at once, without the glide", async () => {
  const restore = motion(true);
  const { view, calls } = await render({ agent: "claude", messages: three });
  try {
    geometry();
    const pointer = pointerOn(button("Reorder queued message 3 of 3")[0]);
    pointer("pointerdown", 100);
    pointer("pointermove", 10);
    pointer("pointerup", 10);
    assert.deepEqual(calls.order, [["m3", "m1", "m2"]], "no wait for an animation");
    assert.equal($$(".qm-ghost").length, 0);
  } finally { restore(); await view.unmount(); }
});

test("keyboard: Space picks a row up, arrows move it, Enter drops it; each step announced, focus kept", async () => {
  const restore = motion(true);
  const { view, calls } = await render({ agent: "codex", messages: three });
  try {
    geometry();
    const grip = button("Reorder queued message 1 of 3")[0];
    grip.focus();
    key(grip, " ");
    assert.equal(grip.getAttribute("aria-pressed"), "true");
    assert.ok($$(".qm-row")[0].classList.contains("lifted"));
    assert.match(said(), /Picked up\. Position 1 of 3/);
    key(grip, "ArrowDown");
    assert.match(said(), /Position 2 of 3/);
    key(grip, "ArrowDown");
    key(grip, "ArrowDown");
    assert.match(said(), /Position 3 of 3/, "stops at the end");
    assert.equal($$(".qm-row")[0].style.transform, "translate3d(0, 80px, 0) scale(1.02)");
    assert.deepEqual(calls.order, [], "nothing sent while it's held");
    key(grip, "Enter");
    await settle(10);
    assert.deepEqual(calls.order, [["m2", "m3", "m1"]]);
    assert.match(said(), /Moved to position 3 of 3/);
    assert.equal(dom.document.activeElement, $$(".qm-grip")[2], "focus stays on the moved row's handle");
    assert.equal($$(".qm-grip")[2].getAttribute("aria-label"), "Reorder queued message 3 of 3");
  } finally { restore(); await view.unmount(); }
});

test("keyboard: the focus comes back to the moved row's handle once the Mac has taken the order", async () => {
  const restore = motion(true);
  let accept;
  function Fixture() {
    const [busy, setBusy] = React.useState(null);
    return React.createElement(QueuedMessages, { agent: "codex", messages: three, busy, canEdit: true,
      onEdit: async () => {}, onRemove() {},
      onReorder: () => {
        // As AgentSession: busy while the Mac takes it; the disabled handle
        // drops the focus, as a browser does.
        setBusy("order");
        dom.document.activeElement?.blur();
        return new Promise((resolve) => { accept = () => { setBusy(null); resolve(); }; });
      } });
  }
  const view = await dom.render(React.createElement(Fixture));
  try {
    geometry();
    const grip = button("Reorder queued message 1 of 3")[0];
    grip.focus();
    key(grip, "Enter");
    key(grip, "ArrowDown");
    key(grip, "Enter");
    await settle(10);
    assert.ok($$(".qm-grip").every((g) => g.disabled));
    assert.equal(dom.document.activeElement, dom.document.body);
    dom.update(() => accept());
    await settle(10);
    assert.equal(dom.document.activeElement, $$(".qm-grip")[1]);
    assert.equal($$(".qm-grip")[1].getAttribute("aria-label"), "Reorder queued message 2 of 3");
  } finally { restore(); await view.unmount(); }
});

test("keyboard: Escape puts a picked-up row back, nothing sent", async () => {
  const restore = motion(true);
  const { view, calls } = await render({ agent: "claude", messages: three });
  try {
    geometry();
    const grip = button("Reorder queued message 2 of 3")[0];
    grip.focus();
    key(grip, "Enter");
    key(grip, "ArrowUp");
    assert.match(said(), /Position 1 of 3/);
    key(grip, "Escape");
    await settle(10);
    assert.deepEqual(calls.order, []);
    assert.deepEqual(texts(), [long, "second", "third"]);
    assert.ok($$(".qm-row").every((r) => !r.style.transform && !r.classList.contains("lifted")));
    assert.match(said(), /Cancelled\. Back at position 2 of 3/);
  } finally { restore(); await view.unmount(); }
});

test("a poll mid-drag with the same queue keeps the drag; a queue that changed puts it down", async () => {
  const restore = motion(true);
  let setMessages;
  const orders = [];
  function Fixture() {
    const [messages, update] = React.useState(three); setMessages = update;
    return React.createElement(QueuedMessages, { agent: "codex", messages, busy: null, canEdit: true,
      onEdit: async () => {}, onRemove() {}, onReorder: (ids) => { orders.push(ids); } });
  }
  const view = await dom.render(React.createElement(Fixture));
  try {
    geometry();
    const pointer = pointerOn(button("Reorder queued message 1 of 3")[0]);
    pointer("pointerdown", 20);
    pointer("pointermove", 70);
    await settle(30);
    // Each poll hands over a new array with the same messages.
    dom.update(() => setMessages(three.map((m) => ({ ...m }))));
    await settle(10);
    assert.equal($$(".qm-row")[1].style.transform, "translate3d(0, -40px, 0)", "still dragging");
    dom.update(() => setMessages([three[1], three[2]]));
    await settle(10);
    assert.ok($$(".qm-row").every((r) => !r.style.transform));
    pointer("pointerup", 70);
    await settle(10);
    assert.deepEqual(orders, []);
  } finally { restore(); await view.unmount(); }
});

test("near the list's bottom edge a drag scrolls the list", async () => {
  const restore = motion(true);
  const many = Array.from({ length: 8 }, (_, i) => ({ id: `q${i}`, text: `row ${i}`, images: 0 }));
  const { view } = await render({ agent: "codex", messages: many });
  try {
    geometry();
    const list = $$(".qm-list")[0];
    let top = 0;
    Object.defineProperty(list, "scrollTop", { get: () => top, set: (v) => { top = Math.max(0, Math.min(200, v)); }, configurable: true });
    list.getBoundingClientRect = () => ({ top: 0, bottom: 120, height: 120, left: 0, width: 300 });
    const pointer = pointerOn(button("Reorder queued message 1 of 8")[0]);
    pointer("pointerdown", 20);
    pointer("pointermove", 118);
    await settle(150);
    assert.ok(top > 0, "scrolled while held at the edge");
    pointer("pointercancel", 118);
    await settle(10);
    assert.equal($$(".qm-ghost").length, 0);
  } finally { restore(); await view.unmount(); }
});
