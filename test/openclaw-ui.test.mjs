import test, { before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { startDom, settle, typeInto } from "./dom/harness.mjs";
const peer = {
  id: "claw-test",
  name: "Home Mac",
  url: "https://reach.test",
  token: "token",
  platform: "darwin",
};
const sessions = [
  {
    key: "agent:main:whatsapp:a",
    title: "Weekend plans",
    agentId: "main",
    channel: "whatsapp",
    canDeliver: true,
    updatedAt: Date.now(),
    model: "test",
    status: "idle",
  },
  {
    key: "agent:work:discord:b",
    title: "Launch notes",
    agentId: "work",
    channel: "discord",
    canDeliver: true,
    updatedAt: Date.now(),
    model: "test",
    status: "idle",
  },
];
let dom,
  Component,
  sent = [],
  reads = [],
  fail = false,
  view;
const base = "/api/sessions/openclaw";
before(async () => {
  dom = await startDom({
    routes: {
      [base + "/overview"]: () => ({
        connected: true,
        sessions,
        approvals: [],
      }),
      [base + "/history"]: (_, url) => {
        const key = url.searchParams.get("key");
        reads.push(key);
        return {
          session: sessions.find((s) => s.key === key),
          items: [
            {
              id: "hello",
              role: "assistant",
              text: "Ready to continue.",
              tool: false,
            },
          ],
          approvals: [],
          streaming: "",
          error: "",
        };
      },
      [base + "/send"]: (init) => {
        sent.push(JSON.parse(init.body));
        return fail
          ? Response.json(
              { error: "Connection interrupted. Retry." },
              { status: 503 },
            )
          : { runId: "run" };
      },
      "/api/sessions/logos": () => ({ version: "test", logos: {} }),
    },
  });
  Component = (await dom.load("/src/EverythingChat.tsx")).default;
});
after(() => dom?.close());
afterEach(async () => {
  await view?.unmount();
  assert.deepEqual(dom.errors, []);
});
const button = (name) =>
  [...dom.document.querySelectorAll("button")].find(
    (b) =>
      b.getAttribute("aria-label") === name || b.textContent.includes(name),
  );
const click = async (name) => {
  const b = button(name);
  assert.ok(b, name);
  b.click();
  await settle();
};
async function mount() {
  sent = [];
  reads = [];
  fail = false;
  dom.window.localStorage.clear();
  dom.window.sessionStorage.clear();
  view = await dom.render(
    dom.React.createElement(Component, {
      peer,
      feed: {
        sessions: [
          {
            agent: "codex",
            id: "c",
            title: "Only Codex",
            cwd: "/work",
            updatedAt: Date.now(),
            status: "idle",
          },
        ],
        health: [{ agent: "openclaw", name: "OpenClaw", installed: true, signedIn: false, supported: true }],
        errors: {},
        failure: "",
        macPrompts: [],
        reload() {},
        recheck() {},
      },
    }),
  );
  await settle(80);
  await click("OpenClaw");
  await dom.waitFor(() =>
    dom.document.body.textContent.includes("Weekend plans"),
  );
}
test("auto discovery is app-separated, searchable, and reads no messages until selection", async () => {
  await mount();
  assert.equal(dom.document.body.textContent.includes("Only Codex"), false);
  assert.equal(reads.length, 0);
  await click("Discord");
  assert.equal(dom.document.body.textContent.includes("Weekend plans"), false);
  await click("All channels");
  await typeInto(dom.document.querySelector("input[type=search]"), "Weekend");
  await settle();
  assert.equal(dom.document.body.textContent.includes("Launch notes"), false);
  await click("Weekend plans");
  assert.equal(reads[0], sessions[0].key);
  assert.equal(dom.document.querySelector("select").value, "reach");
});
test("failed send retains draft and reuses id; external delivery must be explicitly selected", async () => {
  await mount();
  await click("Weekend plans");
  await typeInto(dom.document.querySelector("textarea"), "Please continue");
  fail = true;
  await click("Send to OpenClaw");
  assert.equal(dom.document.querySelector("textarea").value, "Please continue");
  assert.equal(sent[0].deliver, false);
  assert.equal(sent[0].key, sessions[0].key);
  fail = false;
  await click("Send to OpenClaw");
  assert.equal(sent[0].requestId, sent[1].requestId);
  assert.equal(dom.document.querySelector("textarea").value, "");
  const select = dom.document.querySelector("select");
  select.value = "channel";
  select.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  await settle();
  await typeInto(dom.document.querySelector("textarea"), "Reply there");
  await click("Send to OpenClaw");
  assert.equal(sent.at(-1).deliver, true);
  assert.notEqual(sent.at(-1).requestId, sent[0].requestId);
});
