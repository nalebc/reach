import test, { before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { startDom, settle, replaceText } from "./dom/harness.mjs";

const peer = { id: "mac", name: "Mac", url: "https://reach.test", token: "t", platform: "darwin" };
const initial = {
  id: "wf", title: "Work", state: "draft", cwd: "/work", updatedAt: 1, createdAt: 1,
  tasks: [{ id: "t1", title: "Original", task: "Do the work", agent: "codex", kind: "build", together: false, state: "waiting" }],
};
let dom, WorkflowSheet, view, stored, delay;
const edits = [];
before(async () => {
  dom = await startDom({ routes: {
    // The task editor's model picker.
    "/api/sessions/models": () => ({ models: [], modes: [], mode: null }),
    "/api/sessions/workflows/wf": (init) => {
      if (init.method !== "POST") return { ...stored, version: String(stored.updatedAt) };
      const body = JSON.parse(init.body);
      let finish;
      const pending = new Promise((resolve) => { finish = () => {
        stored = { ...stored, ...body, updatedAt: stored.updatedAt + 1 };
        resolve({ workflow: stored });
      }; });
      edits.push({ body, finish });
      if (!delay) finish();
      return pending;
    },
  } });
  ({ WorkflowSheet } = await dom.load("/src/Workflows.tsx"));
});
after(() => dom?.close());
afterEach(async () => {
  delay = false;
  for (const edit of edits) edit.finish();
  await settle();
  await view?.unmount();
  view = undefined;
  edits.length = 0;
});
async function open() {
  stored = structuredClone(initial);
  delay = true;
  view = await dom.render(dom.React.createElement(WorkflowSheet, { peer, id: "wf", initial: stored, logos: {}, onOpenChat() {}, onClose() {} }));
  dom.document.querySelector(".wf-item > button.wf-item-main").click();
  await settle();
}
const field = () => dom.document.querySelector('[aria-label="Task 1 title"]');

test("workflow autosaves serialize slow writes and save the latest edits afterward", async () => {
  await open();
  await replaceText(field(), "First edit");
  await dom.waitFor(() => edits.length === 1);
  await replaceText(field(), "Second edit");
  await settle(800);
  assert.equal(edits.length, 1, "a second save must wait for the first response");
  edits[0].finish();
  await dom.waitFor(() => edits.length === 2);
  assert.equal(edits[1].body.tasks[0].title, "Second edit");
  edits[1].finish();
  await settle();
  assert.equal(field().value, "Second edit");
  assert.equal(stored.tasks[0].title, "Second edit");
});

test("closing a workflow during an autosave does not send the same edit twice", async () => {
  await open();
  await replaceText(field(), "Saved once");
  await dom.waitFor(() => edits.length === 1);
  await view.unmount();
  view = undefined;
  assert.equal(edits.length, 1);
  edits[0].finish();
  await settle();
  assert.equal(edits.length, 1);
});

test("closing during a slow autosave still saves edits made after that request began", async () => {
  await open();
  await replaceText(field(), "First edit");
  await dom.waitFor(() => edits.length === 1);
  await replaceText(field(), "Last edit before leaving");
  await view.unmount();
  view = undefined;
  assert.equal(edits.length, 1);
  edits[0].finish();
  await dom.waitFor(() => edits.length === 2);
  assert.equal(edits[1].body.tasks[0].title, "Last edit before leaving");
  edits[1].finish();
  await settle();
  assert.equal(stored.tasks[0].title, "Last edit before leaving");
});
