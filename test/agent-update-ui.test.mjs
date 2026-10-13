import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { startDom, settle } from "./dom/harness.mjs";

// An update for Claude Code or Codex (server/agent-updates.mjs): one quiet
// line over the chats when a newer version is certain, its command shown
// before it runs, then checked again. Nothing shows otherwise.
const peer = { id: "mac", name: "Mac", url: "https://reach.test", token: "t", platform: "darwin" };
const health = [
  { agent: "codex", installed: true, signedIn: true, supported: true },
  { agent: "claude", installed: true, signedIn: true, supported: true },
];
const sent = [];
const looks = [];
let updates = [];
let terminal = null;
let confirming = null;
let dom, React, EverythingChat;
before(async () => {
  dom = await startDom({
    mobile: true,
    routes: {
      "/api/sessions/logos": () => ({ version: "v1", logos: {} }),
      "/api/sessions/commands": () => ({ commands: [] }),
      "/api/sessions/models": () => ({ models: [], modes: [], mode: null }),
      "/api/sessions/agent-updates": (_init, href) => (looks.push(href), { agents: updates }),
      "/api/sessions/agent-update/claude": async (init) => {
        const body = JSON.parse(init.body || "{}");
        sent.push(body);
        if (body.confirm && confirming) await confirming;
        const plan = { agent: "claude", name: "Claude Code", command: "'/Users/me/.local/bin/claude' update", from: "2.1.291", to: "2.1.295" };
        return body.confirm ? { ...plan, terminal } : plan;
      },
      "/api/terminals": () => (terminal ? [terminal] : []),
    },
  });
  React = dom.React;
  ({ default: EverythingChat } = await dom.load("/src/EverythingChat.tsx"));
});
after(() => dom?.close());
const $$ = (s) => [...dom.document.querySelectorAll(s)];
const button = (text) => $$("button").find((b) => b.textContent.trim() === text);
const text = () => dom.document.body.textContent;
const click = async (el) => {
  assert.ok(el, "button exists");
  el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  await settle();
};
const render = () => {
  dom.window.localStorage.setItem("reach.chatAgent", "claude");
  return dom.render(
    React.createElement(EverythingChat, {
      peer,
      feed: { sessions: [], errors: {}, health, failure: "", reload: async () => {}, recheck: () => {} },
    }),
  );
};
const available = { agent: "claude", name: "Claude Code", state: "available", installed: "2.1.291", latest: "2.1.295" };

test("a newer Claude Code: shown, its command confirmed, watched, then checked again", async () => {
  updates = [available];
  terminal = { id: "u1", status: "running", preview: ["Checking for updates…"] };
  sent.length = 0;
  const view = await render();
  await dom.waitFor(() => /Claude Code 2\.1\.295 is out/.test(text()));
  await click(button("Update"));
  const command = await dom.waitFor(() => dom.document.querySelector(".agent-update .chat-setup-command"));
  assert.equal(command.textContent, "'/Users/me/.local/bin/claude' update");
  assert.deepEqual(sent, [{ confirm: false }]);
  await click(button("Update"));
  assert.deepEqual(sent, [{ confirm: false }, { confirm: true }]);
  await dom.waitFor(() => /Updating Claude Code…/.test(text()));
  await dom.waitFor(() => /Checking for updates/.test(text()), 5000);
  updates = [{ ...available, state: "current", installed: "2.1.295" }];
  terminal = { ...terminal, status: "exited", exitCode: 0, preview: ["Successfully updated"] };
  await dom.waitFor(() => /Claude Code updated to 2\.1\.295/.test(text()), 5000);
  assert.ok(looks.some((href) => /fresh=1/.test(href)), "checked again, fresh");
  await view.unmount();
  assert.deepEqual(dom.errors, []);
});

test("an update that fails says so and offers Try again", async () => {
  updates = [available];
  terminal = { id: "u2", status: "running", preview: [] };
  const view = await render();
  await click(await dom.waitFor(() => button("Update")));
  await click(await dom.waitFor(() => button("Update")));
  await dom.waitFor(() => /Updating Claude Code…/.test(text()));
  terminal = { ...terminal, status: "exited", exitCode: 1, preview: ["Error: network unreachable"] };
  await dom.waitFor(() => /Update stopped\. Error: network unreachable/.test(text()), 5000);
  assert.ok(button("Try again"));
  await view.unmount();
  assert.deepEqual(dom.errors, []);
});

test("repeated update taps while starting send only one confirmation", async t => {
  updates = [available];
  terminal = { id: "slow-update", status: "running", preview: [] };
  sent.length = 0;
  let release;
  confirming = new Promise(resolve => { release = resolve; });
  const view = await render();
  t.after(async () => { confirming = null; release(); await view.unmount(); });
  await click(await dom.waitFor(() => button("Update")));
  await dom.waitFor(() => dom.document.querySelector(".agent-update .chat-setup-command"));
  await click(button("Update"));
  await click(button("Update"));
  assert.deepEqual(sent, [{ confirm: false }, { confirm: true }]);
  assert.equal(button("Cancel").disabled, true, "a started request cannot be cancelled by hiding it");
  release();
  await dom.waitFor(() => /Updating Claude Code/.test(text()));
});

for (const [what, list] of [
  ["current", [{ ...available, state: "current", installed: "2.1.295" }]],
  ["unknown", [{ agent: "claude", name: "Claude Code", state: "unknown", reason: "Couldn't check for a newer version." }]],
  ["inside an app", [{ agent: "claude", name: "Claude Code", state: "app", app: "Claude" }]],
  ["an unexpected answer", "not a list"],
]) {
  test(`nothing shows when it's ${what}`, async () => {
    updates = list;
    const before = looks.length;
    const view = await render();
    await dom.waitFor(() => looks.length > before);
    await settle();
    assert.equal(dom.document.querySelector(".agent-update"), null);
    assert.equal(button("Update"), undefined);
    await view.unmount();
    assert.deepEqual(dom.errors, []);
  });
}
