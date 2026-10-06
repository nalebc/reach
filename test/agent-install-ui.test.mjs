import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { startDom, settle } from "./dom/harness.mjs";

// "Claude Code isn't installed on this Mac" linked to a web page. Now the
// phone installs it: the command shown, then run once confirmed, its newest
// line while it runs, and a check again when it's done.
const peer = { id: "mac", name: "Mac", url: "https://reach.test", token: "t", platform: "darwin" };
const health = [
  { agent: "codex", installed: true, signedIn: true, supported: true },
  { agent: "claude", installed: false, signedIn: false, supported: true },
];
const sent = [];
let terminal = { id: "t1", status: "running", preview: "Downloading Claude Code…" };
let dom, React, EverythingChat;
before(async () => {
  dom = await startDom({
    mobile: true,
    routes: {
      "/api/sessions/logos": () => ({ version: "v1", logos: {} }),
      "/api/sessions/commands": () => ({ commands: [] }),
      "/api/sessions/models": () => ({ models: [], modes: [], mode: null }),
      "/api/sessions/agent-install/claude": (init) => {
        const body = JSON.parse(init.body || "{}");
        sent.push(body);
        const plan = { agent: "claude", name: "Claude Code", command: "curl -fsSL https://claude.ai/install.sh | bash" };
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
const click = async (el) => {
  assert.ok(el, "button exists");
  el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  await settle();
};

test("the phone installs Claude Code on the Mac: shown, confirmed, watched, checked again", async () => {
  dom.window.localStorage.setItem("reach.chatAgent", "claude");
  let rechecked = 0;
  const view = await dom.render(
    React.createElement(EverythingChat, {
      peer,
      feed: { sessions: [], errors: {}, health, failure: "", reload: async () => {}, recheck: () => rechecked++ },
    }),
  );
  await click(await dom.waitFor(() => button("Install on Mac")));
  // Its maker's own command, shown before anything runs.
  const command = await dom.waitFor(() => dom.document.querySelector(".chat-setup-command"));
  assert.equal(command.textContent, "curl -fsSL https://claude.ai/install.sh | bash");
  assert.deepEqual(sent, [{ confirm: false }]);
  await click(button("Install"));
  assert.deepEqual(sent, [{ confirm: false }, { confirm: true }]);
  await dom.waitFor(() => /Installing Claude Code on your Mac/.test(dom.document.body.textContent));
  await dom.waitFor(() => /Downloading Claude Code/.test(dom.document.body.textContent), 5000);
  // Done: checked again (the Mac now has it).
  terminal = { ...terminal, status: "exited", exitCode: 0, preview: "Claude Code installed" };
  await dom.waitFor(() => rechecked > 0, 5000);
  await view.unmount();
  assert.deepEqual(dom.errors, []);
});

// "Make sure install failures don't crash the app" (2026-10-06): an install
// that fails says so with Try again, and one whose terminal is gone (closed,
// or Reach restarted mid-install) no longer spins forever.
for (const [what, end] of [
  ["fails", () => (terminal = { ...terminal, status: "exited", exitCode: 1, preview: "curl: (6) Could not resolve host" })],
  ["loses its terminal", () => (terminal = null)],
]) {
  test(`an install that ${what} stops, says so, offers Try again, and checks the Mac again`, async () => {
    terminal = { id: "t1", status: "running", preview: "Downloading Claude Code…" };
    sent.length = 0;
    dom.window.localStorage.setItem("reach.chatAgent", "claude");
    let rechecked = 0;
    const view = await dom.render(
      React.createElement(EverythingChat, {
        peer,
        feed: { sessions: [], errors: {}, health, failure: "", reload: async () => {}, recheck: () => rechecked++ },
      }),
    );
    await click(await dom.waitFor(() => button("Install on Mac")));
    await click(await dom.waitFor(() => button("Install")));
    await dom.waitFor(() => /Installing Claude Code on your Mac/.test(dom.document.body.textContent));
    end();
    await dom.waitFor(() => /The install stopped before finishing/.test(dom.document.body.textContent), 5000);
    assert.ok(button("Try again"));
    assert.ok(rechecked > 0, "the Mac is checked again");
    await view.unmount();
    assert.deepEqual(dom.errors, []);
  });
}
