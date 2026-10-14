import test from "node:test";
import assert from "node:assert/strict";
import { routes } from "../server/openclaw-wizard.mjs";
import { startDom, typeInto } from "./dom/harness.mjs";
const base = "/api/sessions/openclaw";
const tick = () => new Promise((resolve) => setImmediate(resolve));
// jsdom has no modal dialogs: guided setup's page opens as in a browser.
async function startPage(options) {
  const dom = await startDom(options);
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  return dom;
}
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

// The security notice's lines as OpenClaw 2026.9.9 sends them (setup.shared).
const NOTICE = [
  "OpenClaw is an open-source assistant that learns and grows with you, by the OpenClaw Foundation (a non-profit).",
  "By default, OpenClaw is a personal agent for one operator.",
  "This bot can read files and run actions if tools are enabled.",
  "A bad prompt can trick it into doing unsafe things.",
  "",
  "OpenClaw is not designed to safely separate multiple users by default.",
  "If multiple users can message one tool-enabled agent, they can all influence how it uses its tools.",
  "",
  "If you're not comfortable managing access controls and security hardening, don't run OpenClaw without help.",
  "Ask someone experienced to help before enabling tools or exposing it to the internet.",
  "",
  "\x1b[1mRecommended safer setup\x1b[22m",
  "- Use pairing or allowlists; require mentions in group chats.",
  "- Shared inboxes: use separate gateways and credentials; separate OS users or hosts provide stronger isolation.",
  "- Use a sandbox and give tools only the permissions they need.",
  "- Shared inboxes: isolate DM sessions (session.dmScope: per-channel-peer) and keep tool access minimal.",
  "- Keep secrets outside the agent's reachable filesystem.",
  "- Use the strongest available model for bots with tools or shared/public inboxes.",
  "",
  "\x1b[1mRun regularly\x1b[22m",
  "openclaw security audit --deep",
  "openclaw security audit --fix",
  "",
  "Learn more at https://docs.openclaw.ai/gateway/security",
];

test("OpenClaw's words arrive whole: every line of a note, titles, labels, hints and placeholders", async () => {
  // Oct 13: each line came back cut to its line number (line 2 "T…") and
  // one-line texts empty, so a select showed blank buttons.
  const steps = [
    { id: "note-1", type: "note", title: "Security disclaimer", message: NOTICE.join("\n"), executor: "client" },
    { id: "mode-1", type: "select", message: "Setup mode", executor: "client", options: [
      { value: "quickstart", label: "QuickStart (recommended)", hint: "Recommended local setup. Change details later with openclaw configure." },
      { value: "advanced", label: "Manual", hint: "Configure port, network, Tailscale, and auth options." },
    ] },
    { id: "port-1", type: "text", message: "Gateway port", placeholder: "18789", executor: "client" },
  ];
  let at = 0;
  const f = fixture((method) => ({ sessionId: "session", done: false, status: "running", step: steps[method === "wizard.start" ? 0 : ++at] }));
  await f.hit("start"); await tick();
  const note = (await f.hit()).step;
  assert.equal(note.title, "Security disclaimer");
  const lines = note.message.split("\n");
  assert.equal(lines.length, NOTICE.length);
  for (const [i, line] of NOTICE.entries())
    assert.equal(lines[i], line.replace(/\x1b\[\d+m/g, "").replace("https://docs.openclaw.ai/gateway/security", "https://docs.openclaw.ai"), `line ${i + 1}`);
  await f.hit("answer", { stepId: "note-1", value: null }); await tick();
  const mode = (await f.hit()).step;
  assert.equal(mode.message, "Setup mode");
  assert.deepEqual(mode.options.map((o) => [o.label, o.hint]), steps[1].options.map((o) => [o.label, o.hint]));
  await f.hit("answer", { stepId: "mode-1", value: 0 }); await tick();
  const port = (await f.hit()).step;
  assert.equal(port.message, "Gateway port");
  assert.equal(port.placeholder, "18789");
});

test("OpenClaw's progress is shown and passed without an answer, a slow wait asked again", async () => {
  const waits = [];
  const wait = () => new Promise((resolve, reject) => waits.push({ resolve, reject }));
  const f = fixture((method) => method === "wizard.start"
    ? { sessionId: "session", done: false, status: "running", step: { id: "p1", type: "progress", title: "Gateway service", message: "Installing Gateway service…", executor: "gateway" } }
    : wait());
  await f.hit("start"); await tick(); await tick();
  let state = await f.hit();
  assert.equal(state.busy, true);
  assert.equal(state.step, null);
  assert.equal(state.problem, "");
  assert.deepEqual(state.progress, { title: "Gateway service", message: "Installing Gateway service…", code: "", link: "" });
  // A wait that ran out (a long install) is asked again, still without an answer.
  waits.shift().reject(Object.assign(new Error("slow"), { status: 504 })); await tick(); await tick();
  assert.equal((await f.hit()).busy, true);
  waits.shift().resolve({ done: false, status: "running", step: { id: "q1", type: "confirm", message: "Install the Gateway service?", executor: "client" } });
  await tick(); await tick();
  state = await f.hit();
  assert.equal(state.busy, false);
  assert.equal(state.progress, null);
  assert.equal(state.step.message, "Install the Gateway service?");
  assert.deepEqual(f.calls.slice(1).map((c) => c.params), [{ sessionId: "session" }, { sessionId: "session" }]);
});

test("a sign-in by code shows its code and page; other sign-in links stay on the computer", async () => {
  for (const [deviceCode, url, link] of [
    [{ code: "WDJB-MJHT", expiresInMinutes: 15 }, "https://github.com/login/device", "https://github.com/login/device"],
    [undefined, "https://auth.openai.com/oauth/authorize?state=private", ""],
    [{ code: "WDJB-MJHT" }, "http://example.test/device", ""],
  ]) {
    const waits = [];
    const f = fixture((method) => method === "wizard.start"
      ? { sessionId: "session", done: false, status: "running", step: { id: "p1", type: "progress", message: "Enter this one-time code.", deviceCode, externalUrl: url, executor: "gateway" } }
      : new Promise((resolve) => waits.push(resolve)));
    await f.hit("start"); await tick(); await tick();
    const { progress } = await f.hit();
    assert.equal(progress.link, link);
    assert.equal(progress.code, deviceCode ? "WDJB-MJHT" : "");
    assert.doesNotMatch(JSON.stringify(progress), /state=private/);
  }
});

test("a refused answer keeps its question with OpenClaw's reason; defaults are offered by index only", async () => {
  const key = { id: "key-1", type: "text", message: "Enter Anthropic API key", sensitive: true, executor: "client" };
  const f = fixture((method, params) => {
    if (method === "wizard.start") return { sessionId: "session", done: false, status: "running", step: key };
    if (params.answer?.value === "short") return { done: false, status: "running", step: key, error: "API key looks too short." };
    return { done: false, status: "running", step: { id: "m1", type: "multiselect", message: "Select channels", executor: "client",
      initialValue: [{ id: "telegram" }, "sk-private"],
      options: [{ value: { id: "whatsapp" }, label: "WhatsApp" }, { value: { id: "telegram" }, label: "Telegram" }] } };
  });
  await f.hit("start"); await tick();
  await f.hit("answer", { stepId: "key-1", value: "short" }); await tick();
  let state = await f.hit();
  assert.equal(state.status, "running");
  assert.equal(state.step.id, "key-1");
  assert.equal(state.problem, "API key looks too short.");
  await f.hit("answer", { stepId: "key-1", value: "long-enough-key" }); await tick();
  state = await f.hit();
  assert.equal(state.problem, "");
  assert.deepEqual(state.step.selected, [1]);
  assert.doesNotMatch(JSON.stringify(state), /sk-private|telegram"|initialValue/);
});

test("guided setup is a page of its own: a note laid out, choices as rows, checks, Yes/No and a secret, without a terminal", async () => {
  const sent = [], opened = [];
  const steps = [
    { id: "0", type: "note", title: "Security disclaimer", message: "This bot can read files.\nA bad prompt can trick it.\n\nRecommended safer setup\n- Use pairing or allowlists.\n- Use a sandbox.\n\nRun regularly\nopenclaw security audit --deep\n\nLearn more at https://docs.openclaw.ai", options: [] },
    { id: "1", type: "select", title: "", message: "Choose provider", options: [{ index: 0, label: "Provider X", hint: "API key" }, { index: 1, label: "Provider Y", hint: "" }], selected: [] },
    { id: "2", type: "multiselect", title: "Models", message: "Choose models", options: [{ index: 0, label: "Model A", hint: "" }, { index: 1, label: "Model B", hint: "" }] },
    { id: "3", type: "confirm", title: "Confirm", message: "Enable this?", options: [] },
    { id: "4", type: "text", title: "Key", message: "API key", sensitive: true, options: [] },
  ];
  let index = -1;
  const state = () => ({ supported: true, busy: false, status: index < 0 ? "idle" : index < steps.length ? "running" : "done", problem: "", progress: null, step: steps[index] || null });
  const dom = await startPage({ routes: {
    [`${base}/wizard`]: state,
    [`${base}/wizard/start`]: () => { index = 0; return state(); },
    [`${base}/wizard/answer`]: (init) => { sent.push(JSON.parse(init.body)); index++; return state(); },
  } });
  try {
    dom.window.addEventListener("reach:open-terminal", (e) => opened.push(e.detail));
    const { ClawWizard } = await dom.load("/src/OpenClawWizard.tsx");
    await dom.render(dom.React.createElement(ClawWizard, { peer: { id: "test", url: "https://reach.test", token: "inert" }, onClose() {} }));
    const doc = dom.document;
    const button = (label) => [...doc.querySelectorAll("button")].find((b) => b.textContent.trim() === label);
    // Full screen, never a sheet; one white pill to go on.
    assert.ok(doc.querySelector("dialog.claw-setup[open]"));
    assert.equal(doc.querySelector(".reach-chat-sheet"), null);
    await dom.waitFor(() => button("Start")); button("Start").click();
    // OpenClaw's note: its title large, a list, a heading over it, commands as code.
    await dom.waitFor(() => doc.querySelector(".claw-setup-ask h1")?.textContent === "Security disclaimer");
    assert.equal(doc.querySelector(".claw-setup-note p").textContent, "This bot can read files. A bad prompt can trick it.");
    assert.deepEqual([...doc.querySelectorAll(".claw-setup-note h3")].map((h) => h.textContent), ["Recommended safer setup", "Run regularly"]);
    assert.deepEqual([...doc.querySelectorAll(".claw-setup-note li")].map((li) => li.textContent), ["Use pairing or allowlists.", "Use a sandbox."]);
    assert.equal(doc.querySelector(".claw-setup-commands code").textContent, "openclaw security audit --deep");
    assert.equal(doc.querySelector(".claw-setup-note a").getAttribute("href"), "https://docs.openclaw.ai");
    assert.ok(button("Stop"), "a running setup can be stopped from the top bar");
    button("Continue").click();
    // A choice: rows with their words, Continue once one is picked.
    await dom.waitFor(() => doc.querySelectorAll('input[type="radio"]').length === 2);
    assert.match(doc.querySelector(".claw-setup-options").textContent, /Provider X.*API key.*Provider Y/);
    assert.equal(button("Continue").disabled, true);
    doc.querySelector('input[type="radio"]').click();
    await dom.waitFor(() => !button("Continue").disabled);
    button("Continue").click();
    await dom.waitFor(() => doc.querySelectorAll('input[type="checkbox"]').length === 2);
    doc.querySelectorAll('input[type="checkbox"]')[1].click(); button("Continue").click();
    await dom.waitFor(() => button("No")); button("No").click();
    await dom.waitFor(() => doc.querySelector('input[type="password"]'));
    const field = doc.querySelector('input[type="password"]');
    await typeInto(field, "my-secret");
    field.closest("form").dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
    await dom.waitFor(() => doc.body.textContent.includes("OpenClaw is set up"));
    assert.ok(button("Done"));
    assert.deepEqual(sent.map((s) => s.value), [null, 0, [1], false, "my-secret"]);
    assert.deepEqual(opened, []);
    assert.doesNotMatch(doc.body.textContent, /my-secret/);
    assert.deepEqual(dom.errors, []);
  } finally { await dom.close(); }
});

test("guided setup shows OpenClaw's progress and a sign-in code, OpenClaw's default chosen, a refused answer's reason", async () => {
  let current;
  const dom = await startPage({ routes: { [`${base}/wizard`]: () => current } });
  try {
    const { ClawWizard } = await dom.load("/src/OpenClawWizard.tsx");
    const doc = dom.document;
    const button = (label) => [...doc.querySelectorAll("button")].find((b) => b.textContent.trim() === label);
    current = { supported: true, busy: true, status: "running", problem: "", step: null,
      progress: { title: "GitHub Copilot", message: "Enter this one-time code on the provider's sign-in page.\nhttps://github.com\nCode: WDJB-MJHT", code: "WDJB-MJHT", link: "https://github.com/login/device" } };
    const view = await dom.render(dom.React.createElement(ClawWizard, { peer: { id: "test", url: "https://reach.test", token: "inert" }, onClose() {} }));
    await dom.waitFor(() => doc.querySelector(".claw-setup-code"));
    assert.equal(doc.querySelector(".claw-setup-progress h1").textContent, "GitHub Copilot");
    assert.equal(doc.querySelector(".claw-setup-code").textContent, "WDJB-MJHT");
    assert.equal(doc.querySelector(".claw-setup-link").getAttribute("href"), "https://github.com/login/device");
    // The code and its page aren't repeated in OpenClaw's words.
    assert.equal(doc.querySelector(".claw-setup-progress .claw-setup-note").textContent, "Enter this one-time code on the provider's sign-in page.");
    assert.ok(!button("Stop") && !button("Continue"), "nothing to press while OpenClaw works");
    await view.unmount();
    current = { supported: true, busy: false, status: "running", problem: "API key looks too short.", progress: null,
      step: { id: "m", type: "select", title: "", message: "Setup mode", sensitive: false, placeholder: "", selected: [1],
        options: [{ index: 0, label: "Manual", hint: "" }, { index: 1, label: "QuickStart (recommended)", hint: "" }] } };
    await dom.render(dom.React.createElement(ClawWizard, { peer: { id: "test", url: "https://reach.test", token: "inert" }, onClose() {} }));
    await dom.waitFor(() => doc.querySelectorAll('input[type="radio"]').length === 2);
    assert.deepEqual([...doc.querySelectorAll('input[type="radio"]')].map((r) => r.checked), [false, true]);
    assert.equal(button("Continue").disabled, false);
    assert.equal(doc.querySelector('[role="alert"]').textContent, "API key looks too short.");
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

test("a setup that ends with an error, or a status Reach doesn't know, is never shown as done", async () => {
  for (const [end, status] of [[{ done: true, status: "done", error: "boom" }, "error"], [{ done: true, error: "boom" }, "error"], [{ done: true, status: "exploded" }, "error"], [{ done: true }, "done"]]) {
    const f = fixture((method) => method === "wizard.start" ? { sessionId: "session", ...end } : end);
    await f.hit("start"); await tick();
    assert.equal((await f.hit()).status, status, JSON.stringify(end));
  }
});
