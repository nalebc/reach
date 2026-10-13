import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { installPlan } from "../server/agent-install.mjs";
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
let terminal = { id: "t1", status: "running", preview: ["Downloading Claude Code…"] };
let confirming = null;
let dom, React, EverythingChat;
before(async () => {
  dom = await startDom({
    mobile: true,
    routes: {
      "/api/sessions/logos": () => ({ version: "v1", logos: {} }),
      "/api/sessions/commands": () => ({ commands: [] }),
      "/api/sessions/models": () => ({ models: [], modes: [], mode: null }),
      "/api/sessions/agent-install/claude": async (init) => {
        const body = JSON.parse(init.body || "{}");
        sent.push(body);
        if (body.confirm && confirming) await confirming;
        const plan = await installPlan("claude", { platform: "darwin", has: async () => true });
        return body.confirm ? { ...plan, terminal } : plan;
      },
      "/api/sessions/agent-install/git": async (init) => {
        const body = JSON.parse(init.body || "{}");
        sent.push({ git: body });
        const plan = await installPlan("git", { platform: "win32", has: async () => true });
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
  assert.equal(command.textContent, (await installPlan("claude", { platform: "darwin", has: async () => true })).command);
  assert.deepEqual(sent, [{ confirm: false }]);
  await click(button("Install"));
  assert.deepEqual(sent, [{ confirm: false }, { confirm: true }]);
  await dom.waitFor(() => /Installing Claude Code on your Mac/.test(dom.document.body.textContent));
  await dom.waitFor(() => /Downloading Claude Code/.test(dom.document.body.textContent), 5000);
  // Done: checked again (the Mac now has it).
  terminal = { ...terminal, status: "exited", exitCode: 0, preview: ["Claude Code installed"] };
  await dom.waitFor(() => rechecked > 0, 5000);
  await view.unmount();
  assert.deepEqual(dom.errors, []);
});

test("an install that finished but isn't found yet says so, with the installer's own last line", async () => {
  // Oct 12: the install ended, the check still said "not installed", and the
  // phone showed Install again as if nothing had happened; its last line was
  // zsh closing its session.
  dom.window.localStorage.setItem("reach.chatAgent", "claude");
  const view = await dom.render(
    React.createElement(EverythingChat, {
      peer,
      feed: { sessions: [], errors: {}, health, failure: "", reload: async () => {}, recheck: () => {} },
    }),
  );
  await click(await dom.waitFor(() => button("Install on Mac")));
  await dom.waitFor(() => dom.document.querySelector(".chat-setup-command"));
  await click(button("Install"));
  terminal = { ...terminal, status: "running", preview: ["Claude Code successfully installed!", "...saving history...truncating history files...", "...completed."] };
  await dom.waitFor(() => /Claude Code successfully installed!/.test(dom.document.querySelector(".chat-setup-running code")?.textContent || ""), 5000);
  assert.doesNotMatch(dom.document.body.textContent, /saving history|completed\./);
  terminal = { ...terminal, status: "exited", exitCode: 0 };
  await dom.waitFor(() => /Claude Code is installed\. Looking for it/.test(dom.document.body.textContent), 5000);
  await dom.waitFor(() => /finished installing, but Reach doesn't find it on your Mac yet/.test(dom.document.body.textContent), 10000);
  assert.match(dom.document.body.textContent, /run claude --version/);
  assert.ok(button("Check again"));
  assert.equal(button("Install on Mac"), undefined, "never the Install button again as if nothing happened");
  await view.unmount();
  assert.deepEqual(dom.errors, []);
});

test("repeated install taps while starting send only one confirmation", async t => {
  terminal = { id: "slow-install", status: "running", preview: [] };
  sent.length = 0;
  dom.window.localStorage.setItem("reach.chatAgent", "claude");
  let release;
  confirming = new Promise(resolve => { release = resolve; });
  const view = await dom.render(React.createElement(EverythingChat, {
    peer,
    feed: { sessions: [], errors: {}, health, failure: "", reload: async () => {}, recheck() {} },
  }));
  t.after(async () => { confirming = null; release(); await view.unmount(); });
  await click(await dom.waitFor(() => button("Install on Mac")));
  await click(await dom.waitFor(() => button("Install")));
  await click(button("Install"));
  assert.deepEqual(sent, [{ confirm: false }, { confirm: true }]);
  assert.equal(button("Cancel").disabled, true, "a started request cannot be cancelled by hiding it");
  release();
  await dom.waitFor(() => /Installing Claude Code/.test(dom.document.body.textContent));
});

// "Make sure install failures don't crash the app" (2026-10-06): an install
// that fails says so with Try again, and one whose terminal is gone (closed,
// or Reach restarted mid-install) no longer spins forever.
for (const [what, end] of [
  ["fails", () => (terminal = { ...terminal, status: "exited", exitCode: 1, preview: ["curl: (6) Could not resolve host"] })],
  ["loses its terminal", () => (terminal = null)],
]) {
  test(`an install that ${what} stops, says so, offers Try again, and checks the Mac again`, async () => {
    terminal = { id: "t1", status: "running", preview: ["Downloading Claude Code…"] };
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

// Claude Code on a Windows PC without Git for Windows (audit #7, Oct 12):
// installed, then the first message failed. The phone says what it needs
// before sign-in, with Windows' own installer a tap away, run as an install.
test("Claude Code needing Git for Windows shows its install before sign-in, and nothing to start a chat with", async () => {
  terminal = { id: "t-git", status: "running", preview: ["Downloading Git for Windows…"] };
  sent.length = 0;
  dom.window.localStorage.setItem("reach.chatAgent", "claude");
  let rechecked = 0;
  const pc = { ...peer, id: "pc", name: "PC", platform: "win32" };
  const needsGit = [
    { agent: "codex", installed: false, signedIn: false, supported: true },
    { agent: "claude", installed: true, signedIn: false, supported: true, needs: ["git"] },
  ];
  const view = await dom.render(
    React.createElement(EverythingChat, {
      peer: pc,
      feed: { sessions: [], errors: {}, health: needsGit, failure: "", reload: async () => {}, recheck: () => rechecked++ },
    }),
  );
  const setup = await dom.waitFor(() => dom.document.querySelector('[aria-label="Set up Git for Windows"]'));
  assert.match(setup.textContent, /Claude Code needs Git for Windows/);
  assert.match(setup.textContent, /isn't on this Windows PC yet/);
  assert.doesNotMatch(dom.document.body.textContent, /Sign in|Mac/);
  await click(button("Install on Windows PC"));
  const command = await dom.waitFor(() => dom.document.querySelector(".chat-setup-command"));
  assert.equal(command.textContent, (await installPlan("git", { platform: "win32", has: async () => true })).command);
  assert.match(setup.textContent, /Reach installs it with winget on your Windows PC\. Windows may ask you to approve it there/);
  await click(button("Install"));
  assert.deepEqual(sent, [{ git: { confirm: false } }, { git: { confirm: true } }]);
  await dom.waitFor(() => /Installing Git for Windows on your Windows PC/.test(dom.document.body.textContent));
  terminal = { ...terminal, status: "exited", exitCode: 0, preview: ["Successfully installed"] };
  await dom.waitFor(() => rechecked > 0, 5000);
  await view.unmount();
  assert.deepEqual(dom.errors, []);
});
