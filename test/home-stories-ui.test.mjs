import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { startDom, settle } from "./dom/harness.mjs";

// Home's "Live on your Mac": a circle per running thing, a ring that turns
// while it works, amber when it needs you, a check (or "!") for a few
// minutes after it ends, and one tap to open it. Same on a Mac and a PC.
let dom, React, HomeStories;
let macTabs = [];
before(async () => {
  dom = await startDom({
    mobile: true,
    routes: {
      "/api/terminals/desktop": () => ({ sessions: macTabs }),
      "/api/terminals/desktop/activity": () => ({ version: 1, peeks: {} }),
    },
  });
  React = dom.React;
  ({ default: HomeStories } = await dom.load("/src/HomeStories.tsx"));
});
after(() => dom?.close());

const minute = 60 * 1000;
const session = (id, status, ago, extra = {}) => ({
  agent: "codex", id, title: id, status, updatedAt: Date.now() - ago, preview: "", archived: false, ...extra,
});
const features = { terminal: true, codex: true, desktopTerminals: false, screen: false, shortcuts: false, owner: true, writeFiles: false };
const render = (platform, props = {}) => {
  const opened = [];
  const view = dom.render(
    React.createElement(HomeStories, {
      peer: { id: "mac", name: "Studio-Mac", url: "https://mac.test", token: "t", platform },
      device: { name: "Studio-Mac", platform, roots: [] },
      features,
      visible: true,
      terminals: [],
      agentSessions: [],
      openTerminal: (id) => opened.push(["terminal", id]),
      openMacTab: (id) => opened.push(["mac", id]),
      openAgentSession: (s) => opened.push(["agent", s.id]),
      onStart: () => opened.push(["start"]),
      ...props,
    }),
  );
  return { view, opened };
};
const ring = (name) => dom.document.querySelector(`.story[aria-label^="${name}"] .story-ring`);
const names = () => [...dom.document.querySelectorAll(".story > small")].map((s) => s.textContent);

for (const [platform, word] of [["darwin", "Mac"], ["win32", "Windows PC"]]) {
  test(`${word}: what needs you first, a turning ring while it works, a check when it just ended`, async () => {
    const { view, opened } = render(platform, {
      agentSessions: [
        session("Fix login", "idle", 2 * minute),
        session("Write tests", "running", 0),
        session("Approve deploy", "waiting", 0),
        session("Broken build", "error", minute),
        session("Old work", "idle", 60 * minute),
      ],
    });
    const v = await view;
    await settle();
    assert.equal(dom.document.querySelector(".home-section h2").textContent, `Live on your ${word}`);
    // ＋ first, then needs-you, failed, working, done; long-idle chats aren't shown.
    assert.deepEqual(names(), ["New", "Approve deploy", "Broken build", "Write tests", "Fix login"]);
    assert.match(ring("Approve deploy").className, /\battention\b/);
    assert.match(ring("Write tests").className, /\bactive\b/, "the ring turns while it works");
    assert.match(ring("Fix login").className, /\bdone\b/);
    assert.ok(ring("Fix login").querySelector(".story-mark svg"), "a check");
    assert.equal(ring("Broken build").querySelector(".story-mark").textContent, "!");
    dom.document.querySelector('.story[aria-label^="Write tests"]').click();
    dom.document.querySelector(".story-ring.new").closest("button").click();
    assert.deepEqual(opened, [["agent", "Write tests"], ["start"]]);
    await v.unmount();
  });

  test(`${word}: Reach's own terminals and the computer's terminal windows, each opening where it lives`, async () => {
    macTabs = [{ id: "w1", name: "zsh" }];
    const { view, opened } = render(platform, {
      features: { ...features, desktopTerminals: true },
      terminals: [{ id: "t1", name: "Claude Code", status: "running", preview: ["thinking"] }, { id: "t2", name: "old", status: "exited" }],
    });
    const v = await view;
    await dom.waitFor(() => dom.document.querySelector('.story[aria-label^="zsh"]'));
    assert.deepEqual(names(), ["New", "Claude Code", "zsh"]);
    const badge = dom.document.querySelector('.story[aria-label^="zsh"] .story-badge').textContent;
    assert.equal(badge, platform === "win32" ? "PC" : "Mac");
    dom.document.querySelector('.story[aria-label^="Claude Code"]').click();
    dom.document.querySelector('.story[aria-label^="zsh"]').click();
    assert.deepEqual(opened, [["terminal", "t1"], ["mac", "w1"]]);
    await v.unmount();
    macTabs = [];
  });
}

test("nothing running: no row at all, Home stays quiet", async () => {
  const { view } = render("darwin");
  const v = await view;
  await settle();
  assert.equal(dom.document.querySelector(".home-section"), null);
  await v.unmount();
});

test("the circles wrap instead of scrolling sideways, and stop turning for Reduce Motion", () => {
  const css = fs.readFileSync(new URL("../src/home-stories.css", import.meta.url), "utf8");
  assert.match(css, /\.home-stories \{[^}]*flex-wrap: wrap;/);
  assert.doesNotMatch(css, /overflow-x/);
  assert.match(css, /prefers-reduced-motion: reduce\)[\s\S]*\.story-ring\.active::before[\s\S]*animation: none/);
});
