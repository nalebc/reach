import test from "node:test";
import assert from "node:assert/strict";
import { createClaudeConsent as create, pressClaudeConsent as press } from "../server/agent-sessions/claude-consent.mjs";
import { createAppCards } from "../server/agent-sessions/app-cards.mjs";
// The Mac's card on any host (a Windows PC refuses: agent-claude-consent.test.mjs).
const createClaudeConsent = (options) => create({ platform: "darwin", ...options });
const pressClaudeConsent = (choice, options = {}) => press(choice, { platform: "darwin", ...options });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const stopped = () => Object.assign(Error("Desktop ownership changed; inspect before retrying."), { status: 409 });

for (const [name, call] of [
  ["consent", opts => pressClaudeConsent("Deny", opts)],
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
    const c = createClaudeConsent({ ...common, idle: () => 600,
      pending: async () => pending ? { id: "consent:one", apps: ["Calculator"] } : null,
      press: (choice, expect, guard) => pressClaudeConsent(choice, { ...options(guard), expect }),
    });
    invoke = () => c.answer("chat", "consent:one", { decision: "deny" });
  }
  return { invoke, preparing, ready, links, invalidate: () => { active = false; }, restore: () => { active = true; }, count: () => presses, transactions: () => transactions };
}
for (const kind of ["consent"]) {
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

for (const kind of ["consent"]) test(`${kind} acknowledged dispatch survives foreground interruption without replay`, async () => {
  const f = fixture(kind, { interruptOnSuccess: true });
  const answer = f.invoke();
  await f.preparing.promise; f.ready.resolve();
  assert.deepEqual(await answer, { answered: true });
  f.restore();
  await assert.rejects(f.invoke());
  assert.equal(f.count(), 1);
});

// The former screen-card path also prevented uncertain replay. The IPC path
// retains that guarantee without acquiring or moving the desktop.
test("Codex IPC approvals never replay an uncertain or acknowledged answer", async () => {
  for (const uncertain of [false, true]) {
    let calls = 0, requestId = 1;
    const cards = createAppCards({
      pending: async () => ({ id: "app-permission:codex:call", callId: "call" }),
      desktop: {
        requests: async () => [{ id: requestId, method: "item/commandExecution/requestApproval", params: { threadId: "chat", itemId: "call", command: "fixture" } }],
        answer: async () => { calls++; if (uncertain) throw Object.assign(Error("Unknown delivery"), { uncertain: true }); },
      },
      markAnswered: () => {},
    });
    const reply = () => cards.answer("codex", "chat", "app-permission:codex:call", { label: "Allow once" });
    if (uncertain) await assert.rejects(reply(), /Unknown delivery/);
    else assert.deepEqual(await reply(), { answered: true });
    await assert.rejects(reply(), /already attempted/);
    assert.equal(calls, 1);
    requestId++;
    if (uncertain) await assert.rejects(reply(), /Unknown delivery/);
    else await reply();
    assert.equal(calls, 2, "a new native request remains answerable");
  }
});

test("Codex IPC approval refused before delivery is retryable", async () => {
  let calls = 0;
  const cards = createAppCards({
    pending: async () => ({ id: "app-permission:codex:call", callId: "call" }),
    desktop: {
      requests: async () => [{ id: 1, method: "item/commandExecution/requestApproval", params: { threadId: "chat", itemId: "call" } }],
      answer: async () => { if (++calls === 1) throw Object.assign(Error("Unavailable"), { notDispatched: true }); },
    },
    markAnswered: () => {},
  });
  const reply = () => cards.answer("codex", "chat", "app-permission:codex:call", { label: "Deny" });
  await assert.rejects(reply(), /Unavailable/);
  assert.deepEqual(await reply(), { answered: true });
  assert.equal(calls, 2);
});
