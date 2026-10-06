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
      "/api/terminals": () => [terminal],
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
