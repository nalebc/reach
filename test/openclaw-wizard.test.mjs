import test from "node:test";
import assert from "node:assert/strict";
import { routes } from "../server/openclaw-wizard.mjs";
import { startDom, typeInto } from "./dom/harness.mjs";
const base = "/api/sessions/openclaw";
const tick = () => new Promise((resolve) => setImmediate(resolve));
function fixture(answer, supported = true) {
  const handlers = {}, calls = [];
  routes({ get: (p, f) => handlers[`GET ${p}`] = f, post: (p, f) => handlers[`POST ${p}`] = f }, {
    can: () => supported,
    call: async (method, params, auth) => { auth(); calls.push({ method, params }); return answer(method, params); },
  }, { base, authorize: (req) => () => { if (req.revoked) throw new Error("revoked"); } });
  return { calls, async hit(action = "", body, revoked = false) {
    let result;
    await handlers[`${action ? "POST" : "GET"} ${base}/wizard${action ? `/${action}` : ""}`]({ body, revoked }, { json: (v) => result = v });
    return result;
  } };
}
const prompt = (type, extra = {}) => ({ done: false, status: "running", step: { id: "question-1", type, message: "Choose", executor: "client", ...extra } });

test("wizard maps offered options, refuses stale/invalid answers, and never exposes raw defaults", async () => {
  const f = fixture((method) => method === "wizard.start" ? { sessionId: "session", ...prompt("select", {
    initialValue: "sk-private", options: [{ value: { provider: "x" }, label: "Provider X" }],
  }) } : { done: true, status: "done" });
  await assert.rejects(f.hit("start", {}, true), /revoked/);
  await f.hit("start"); await tick();
  const state = await f.hit();
  assert.equal(state.step.options[0].index, 0);
  assert.equal("value" in state.step.options[0], false);
  assert.doesNotMatch(JSON.stringify(state), /sk-private|initialValue/);
  await assert.rejects(f.hit("answer", { stepId: "old", value: 0 }), /changed/);
  await assert.rejects(f.hit("answer", { stepId: "question-1", value: 4 }), /offered/);
  await f.hit("answer", { stepId: "question-1", value: 0 }); await tick();
  assert.deepEqual(f.calls[1].params, { sessionId: "session", answer: { stepId: "question-1", value: { provider: "x" } } });
  assert.equal((await f.hit()).status, "done");
});

test("wizard validates typed answers and multi-selects", async () => {
  for (const [type, invalid, valid] of [["confirm", "yes", false], ["multiselect", [0, 0], [1]], ["text", { command: "bad" }, "my-secret"]]) {
    const f = fixture((method) => method === "wizard.start" ? { sessionId: "session", ...prompt(type, { options: [{ value: "a", label: "A" }, { value: "b", label: "B" }] }) } : { done: true, status: "done" });
    await f.hit("start"); await tick();
    await assert.rejects(f.hit("answer", { stepId: "question-1", value: invalid }));
    await f.hit("answer", { stepId: "question-1", value: valid }); await tick();
    assert.deepEqual(f.calls[1].params.answer.value, type === "multiselect" ? ["b"] : valid);
  }
});

test("interrupted answers recover without resending, and cancellation is explicit", async () => {
  let reject = true;
  const f = fixture((method, params) => {
    if (method === "wizard.start") return { sessionId: "session", ...prompt("text", { message: "API key", initialValue: "hidden" }) };
    if (method === "wizard.cancel") return { status: "cancelled" };
    if (params.answer && reject) { reject = false; throw new Error("private failure"); }
    return prompt("note");
  });
  await f.hit("start"); await tick();
  assert.equal((await f.hit()).step.sensitive, true);
  await f.hit("answer", { stepId: "question-1", value: "private" }); await tick();
  assert.equal((await f.hit()).status, "uncertain");
  assert.doesNotMatch(JSON.stringify(await f.hit()), /private/);
  await f.hit("refresh"); await tick();
  assert.deepEqual(f.calls.at(-1).params, { sessionId: "session" });
  await f.hit("cancel");
  assert.equal((await f.hit()).status, "cancelled");
});

test("busy wizard excludes duplicates; unsupported steps never turn into commands", async () => {
  let resolve;
  const f = fixture(() => new Promise((r) => resolve = r));
  await f.hit("start");
  await assert.rejects(f.hit("start"), /already/);
  resolve({ sessionId: "session", ...prompt("action", { executor: "client", message: "Run a command" }) }); await tick();
  assert.equal((await f.hit()).step, null);
  assert.match((await f.hit()).problem, /isn't supported/);
  const unsupported = fixture(() => {}, false);
  await assert.rejects(unsupported.hit("start"), /doesn't offer/);
});

test("guided setup renders choices, checks, confirmations and secret inputs without a terminal", async () => {
  const sent = [], opened = [];
  const steps = [
    { id: "1", type: "select", title: "Provider", message: "Choose provider", options: [{ index: 0, label: "Provider X", hint: "" }] },
    { id: "2", type: "multiselect", title: "Models", message: "Choose models", options: [{ index: 0, label: "Model A", hint: "" }, { index: 1, label: "Model B", hint: "" }] },
    { id: "3", type: "confirm", title: "Confirm", message: "Enable this?", options: [] },
    { id: "4", type: "text", title: "Key", message: "API key", sensitive: true, options: [] },
  ];
  let index = -1;
  const state = () => ({ supported: true, busy: false, status: index < 0 ? "idle" : index < steps.length ? "running" : "done", problem: "", step: steps[index] || null });
  const dom = await startDom({ routes: {
    [`${base}/wizard`]: state,
    [`${base}/wizard/start`]: () => { index = 0; return state(); },
    [`${base}/wizard/answer`]: (init) => { sent.push(JSON.parse(init.body)); index++; return state(); },
  } });
  try {
    dom.window.addEventListener("reach:open-terminal", (e) => opened.push(e.detail));
    const { ClawWizard } = await dom.load("/src/OpenClawWizard.tsx");
    await dom.render(dom.React.createElement(ClawWizard, { peer: { id: "test", url: "https://reach.test", token: "inert" }, onClose() {} }));
    const button = (label) => [...dom.document.querySelectorAll("button")].find((b) => b.textContent.trim() === label);
    await dom.waitFor(() => button("Start guided setup")); button("Start guided setup").click();
    await dom.waitFor(() => button("Provider X")); button("Provider X").click();
    await dom.waitFor(() => dom.document.querySelectorAll('input[type="checkbox"]').length === 2);
    dom.document.querySelectorAll('input[type="checkbox"]')[1].click(); button("Continue").click();
    await dom.waitFor(() => button("No")); button("No").click();
    await dom.waitFor(() => dom.document.querySelector('input[type="password"]'));
    const field = dom.document.querySelector('input[type="password"]');
    await typeInto(field, "my-secret");
    field.closest("form").dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
    await dom.waitFor(() => dom.document.body.textContent.includes("Setup completed."));
    assert.deepEqual(sent.map((s) => s.value), [0, [1], false, "my-secret"]);
    assert.deepEqual(opened, []);
    assert.doesNotMatch(dom.document.body.textContent, /my-secret/);
    assert.deepEqual(dom.errors, []);
  } finally { await dom.close(); }
});

test("a failed start with no session can be started again", async () => {
  let fails = true;
  const f = fixture(() => {
    if (fails) { fails = false; throw new Error("timeout"); }
    return { sessionId: "s2", ...prompt("note") };
  });
  await f.hit("start"); await tick();
  assert.equal((await f.hit()).status, "uncertain");
  await f.hit("start"); await tick();
  assert.equal((await f.hit()).status, "running");
});
