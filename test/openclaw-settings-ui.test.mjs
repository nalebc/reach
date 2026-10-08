import test from "node:test";
import assert from "node:assert/strict";
import { startDom, settle, typeInto } from "./dom/harness.mjs";
const peer = { id: "fixture", url: "https://reach.test", token: "inert" };
const session = { key: "agent:main:reach-fixture", title: "Original", model: "old", modelProvider: "provider", thinkingLevel: "low" };
async function fixture({ wait } = {}) {
  const sent = [], callbacks = [];
  const native = { model: "provider/new", thinkingLevel: "high" };
  const dom = await startDom({ routes: {
    "/api/sessions/openclaw/catalog": () => ({ agents: [], models: [{ id: "provider/old", name: "Old", reasoning: true }, { id: "provider/fast", name: "Fast", reasoning: false }], canEdit: true, errors: [] }),
    "/api/sessions/openclaw/settings": async init => { const body = JSON.parse(init.body); sent.push(body); if (wait) await wait; Object.assign(native, body); return { saved: true }; },
  } });
  const { ClawSessionSettings } = await dom.load("/src/OpenClawControls.tsx");
  const props = { peer, session, disabled: false, onSaved: () => callbacks.push("saved"), onClose: () => callbacks.push("closed") };
  const mount = p => dom.render(dom.React.createElement(ClawSessionSettings, { ...props, ...p }));
  const field = name => dom.document.querySelector(`[aria-label="${name}"]`);
  const ready = () => dom.waitFor(() => field("OpenClaw model"));
  const choose = async (name, value) => { const el = field(name); el.value = value; el.dispatchEvent(new dom.window.Event("change", { bubbles: true })); await settle(); };
  const submit = () => dom.document.querySelector("form").dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
  return { dom, sent, callbacks, native, ClawSessionSettings, props, mount, ready, field, choose, submit };
}

test("name-only settings preserve model and thinking changed independently in OpenClaw", async () => {
  const f = await fixture();
  try {
    await f.mount(); await f.ready();
    assert.equal(f.field("OpenClaw model").value, "provider/old", "initial model is provider-qualified");
    await typeInto(f.field("OpenClaw chat name"), " renamed");
    f.submit(); await f.dom.waitFor(() => f.sent.length === 1);
    assert.deepEqual(f.sent, [{ key: session.key, label: "Original renamed" }]);
    assert.equal(f.native.model, "provider/new");
    assert.equal(f.native.thinkingLevel, "high");
  } finally { await f.dom.close(); }
});

test("unchanged settings send no RPC; deliberate defaults remain explicit nulls", async () => {
  const f = await fixture();
  try {
    await f.mount(); await f.ready();
    assert.equal(f.dom.document.querySelector('button.claw-primary').disabled, true);
    f.submit(); await settle(); assert.equal(f.sent.length, 0);
    await f.choose("OpenClaw model", ""); await f.choose("OpenClaw thinking level", "");
    f.submit(); await f.dom.waitFor(() => f.sent.length === 1);
    assert.deepEqual(f.sent[0], { key: session.key, model: null, thinkingLevel: null });
  } finally { await f.dom.close(); }
});

test("choosing a nonreasoning model explicitly turns thinking off", async () => {
  const f = await fixture();
  try {
    await f.mount({ session: { ...session, thinkingLevel: "off" } }); await f.ready();
    await f.choose("OpenClaw model", "provider/fast");
    assert.equal(f.field("OpenClaw thinking level").disabled, true);
    f.submit(); await f.dom.waitFor(() => f.sent.length === 1);
    assert.deepEqual(f.sent[0], { key: session.key, model: "provider/fast", thinkingLevel: "off" });
  } finally { await f.dom.close(); }
});

for (const change of ["credential", "session"]) test(`pending settings completion is isolated after ${change} changes`, async () => {
  let finish;
  const wait = new Promise(resolve => { finish = resolve; });
  const f = await fixture({ wait });
  try {
    function Parent() {
      const [next, setNext] = f.dom.React.useState(false);
      return f.dom.React.createElement("main", null,
        f.dom.React.createElement("button", { onClick: () => setNext(true), id: "replace" }, "Change context"),
        f.dom.React.createElement(f.ClawSessionSettings, { ...f.props,
          peer: next && change === "credential" ? { ...peer, token: "replacement" } : peer,
          session: next ? { ...session, ...(change === "session" ? { key: "agent:main:reach-other" } : {}), title: "Replacement" } : session,
        }));
    }
    await f.dom.render(f.dom.React.createElement(Parent)); await f.ready();
    await typeInto(f.field("OpenClaw chat name"), " pending"); f.submit();
    await f.dom.waitFor(() => f.sent.length === 1);
    f.dom.document.querySelector('#replace').click(); await settle();
    assert.equal(f.field("OpenClaw chat name").value, "Replacement");
    finish(); await settle();
    assert.deepEqual(f.callbacks, [], "old completion cannot close or refresh the new context");
    assert.equal(f.sent.length, 1, "the old mutation is never retried");
    assert.equal(f.field("OpenClaw chat name").disabled, false);
  } finally { finish(); await f.dom.close(); }
});
