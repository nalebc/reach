import test from "node:test";
import assert from "node:assert/strict";
import { createClaudeConsent, pressClaudeConsent } from "../server/agent-sessions/claude-consent.mjs";
import { createAppCards, readAppCard, pressAppCard, answerAppQuestion } from "../server/agent-sessions/app-cards.mjs";
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const stopped = () => Object.assign(Error("Desktop ownership changed; inspect before retrying."), { status: 409 });

for (const [name, call] of [
  ["consent", opts => pressClaudeConsent("Deny", opts)],
  ["permission read", opts => readAppCard("claude", ["fixture"], opts)],
  ["permission press", opts => pressAppCard("claude", "Deny", ["fixture"], opts)],
  ["question answer", opts => answerAppQuestion("claude", [{ question: "Fixture?", picks: ["Yes"] }], opts)],
]) test(`${name} rechecks desktop ownership after native helper preparation`, async () => {
  const preparing = deferred(), ready = deferred();
  let valid = true, runs = 0;
  const result = call({
    binary: async () => { preparing.resolve(); await ready.promise; return "/inert/helper"; },
    beforeDispatch: () => { if (!valid) throw stopped(); },
    run: async () => { runs++; return { stdout: '{"pressed":"Deny"}' }; },
  });
  await preparing.promise;
  valid = false;
  ready.resolve();
  await assert.rejects(result, e => e.status === 409 && e.notDispatched === true);
  assert.equal(runs, 0, "no native process is dispatched after ownership changes");
});

function fixture(kind, { blocked = false, uncertain = false, switchChat = false, interruptOnSuccess = false } = {}) {
  const preparing = deferred(), ready = deferred();
  let active = true, first = true, pending = true, opened = false, presses = 0, transactions = 0;
  const links = [];
  const automation = { run: async (work) => {
    transactions++;
    if (blocked) throw stopped();
    return work(() => { if (!active) throw stopped(); });
  } };
  const options = guard => ({
    binary: async () => { if (first) { first = false; preparing.resolve(); await ready.promise; } return "/inert/helper"; },
    beforeDispatch: guard,
    run: async () => { presses++; if (uncertain) throw Error("Synthetic acknowledgement lost"); pending = false; if (interruptOnSuccess) active = false; return { stdout: '{"pressed":"Deny"}' }; },
  });
  const common = {
    desktopAutomation: automation,
    shown: () => [{ id: switchChat && !opened ? "other" : "chat", session: "local_other" }, { id: "chat", session: "local_chat" }],
    open: async (url, opts) => { links.push({ url, opts }); opened = true; },
    wait: async () => {},
    confirmMs: 50,
  };
  let invoke;
  if (kind === "consent") {
    const c = createClaudeConsent({ ...common,
      pending: async () => pending ? { id: "consent:one", apps: ["Calculator"] } : null,
      press: (choice, expect, guard) => pressClaudeConsent(choice, { ...options(guard), expect }),
    });
    invoke = () => c.answer("chat", "consent:one", { decision: "deny" });
  } else {
    const promptId = kind === "question" ? "app-question:one" : "app-permission:one";
    const c = createAppCards({ ...common,
      pending: async () => pending ? { id: promptId, expect: ["Fixture"], appSessionId: "local_chat" } : null,
      pendingQuestion: async () => pending ? { id: promptId, appSessionId: "local_chat", questions: [{ question: "Fixture?", options: [{ label: "Yes" }] }] } : null,
      read: async () => ({ found: true, texts: ["Fixture"], buttons: [{ label: "Deny" }] }),
      press: (agent, label, expect, guard) => pressAppCard(agent, label, expect, options(guard)),
      answerQuestion: (agent, answers, guard) => answerAppQuestion(agent, answers, options(guard)),
    });
    invoke = () => c.answer("claude", "chat", promptId, kind === "question" ? { answers: { q0: ["Yes"] } } : { label: "Deny" });
  }
  return { invoke, preparing, ready, links, invalidate: () => { active = false; }, restore: () => { active = true; }, count: () => presses, transactions: () => transactions };
}
for (const kind of ["consent", "permission", "question"]) {
  test(`${kind} refusal before helper dispatch stays manually retryable`, async () => {
    const f = fixture(kind, { switchChat: true });
    const answer = f.invoke();
    await f.preparing.promise;
    const transactions = f.transactions();
    const backgroundOnly = f.links.every(link => link.opts?.background === true);
    f.invalidate(); f.ready.resolve();
    await assert.rejects(answer, e => e.status === 409 && e.notDispatched === true);
    assert.equal(transactions, 1, "the entire card operation holds one transaction");
    assert.ok(backgroundOnly, "targeted app links do not steal foreground");
    assert.equal(f.count(), 0);
    f.restore();
    assert.deepEqual(await f.invoke(), { answered: true });
    assert.equal(f.count(), 1, "only the explicit second attempt dispatches");
  });
  test(`${kind} uncertain dispatched answer never replays`, async () => {
    const f = fixture(kind, { uncertain: true });
    const answer = f.invoke();
    await f.preparing.promise; f.ready.resolve();
    await assert.rejects(answer, /acknowledgement lost/);
    await assert.rejects(f.invoke(), /already.*(pressed|attempted)/);
    assert.equal(f.count(), 1);
  });
  test(`${kind} active desktop ownership prevents opening or answering`, async () => {
    const f = fixture(kind, { blocked: true, switchChat: true });
    f.ready.resolve();
    await assert.rejects(f.invoke(), e => e.status === 409);
    assert.equal(f.count(), 0);
    assert.equal(f.links.length, 0);
  });
}

test("card reading rechecks after asynchronous preparation before opening a target chat", async () => {
  let active = true, opens = 0, reads = 0;
  const started = deferred(), ready = deferred();
  const c = createAppCards({
    desktopAutomation: { run: work => work(() => { if (!active) throw stopped(); }) },
    pending: async () => { started.resolve(); await ready.promise; return { id: "app-permission:one", expect: ["Fixture"], appSessionId: "local_chat" }; },
    shown: () => [],
    open: async () => { opens++; }, read: async () => { reads++; return {}; },
  });
  const result = c.card("claude", "chat");
  await started.promise; active = false; ready.resolve();
  await assert.rejects(result, e => e.status === 409);
  assert.equal(opens, 0); assert.equal(reads, 0);
});

test("a replaced question after app switching cannot receive the old answers", async () => {
  let current = "app-question:one", answers = 0;
  const c = createAppCards({
    pendingQuestion: async () => ({ id: current, appSessionId: "local_chat", questions: [{ question: "Fixture?", options: [{ label: "Yes" }] }] }),
    shown: () => [], open: async () => {}, wait: async () => { current = "app-question:two"; },
    answerQuestion: async () => { answers++; }, confirmMs: 0,
  });
  await assert.rejects(c.answer("claude", "chat", "app-question:one", { answers: { q0: ["Yes"] } }), /already answered/);
  assert.equal(answers, 0);
});

for (const kind of ["consent", "permission", "question"]) test(`${kind} acknowledged dispatch survives foreground interruption without replay`, async () => {
  const f = fixture(kind, { interruptOnSuccess: true });
  const answer = f.invoke();
  await f.preparing.promise; f.ready.resolve();
  assert.deepEqual(await answer, { answered: true });
  f.restore();
  await assert.rejects(f.invoke());
  assert.equal(f.count(), 1);
});

test("Codex acknowledged permission is marked answered after foreground interruption", async () => {
  let active = true, presses = 0;
  const marked = [];
  const c = createAppCards({
    desktopAutomation: { run: work => work(() => { if (!active) throw stopped(); }) },
    pending: async () => ({ id: "app-permission:codex:one", expect: ["Fixture"] }),
    open: async () => {}, wait: async () => {},
    read: async () => ({ found: true, texts: ["Fixture"], buttons: [{ label: "Deny" }] }),
    press: async () => { presses++; active = false; return { pressed: "Deny" }; },
    markAnswered: id => marked.push(id),
  });
  assert.deepEqual(await c.answer("codex", "chat", "app-permission:codex:one", { label: "Deny" }), { answered: true });
  assert.deepEqual(marked, ["one"]);
  active = true;
  await assert.rejects(c.answer("codex", "chat", "app-permission:codex:one", { label: "Deny" }), /already attempted/);
  assert.equal(presses, 1);
});
