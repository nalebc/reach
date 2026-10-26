import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { startDom, settle } from "./dom/harness.mjs";

// One top bar on the phone (src/top-bar.css): Home and the pages beside it,
// Chat, and the Terminal page drew three different bars (heights, button
// sizes, title styles, the bell in different places). Now they share one
// set of measures, every icon-only button says what it does (to a screen
// reader and on hover), and the bell is the last button on the right.
const source = (name) => fs.readFileSync(new URL(`../src/${name}`, import.meta.url), "utf8");
const peer = { id: "mac", name: "Mac", url: "https://reach.test", token: "t", platform: "darwin" };

let dom, React, ChatList, TerminalView, ComputerSwitcher, NotificationCenter;
before(async () => {
  dom = await startDom({
    mobile: true,
    fakes: {
      "@xterm/xterm": "test/dom/fakes/xterm.mjs",
      "@xterm/addon-fit": "test/dom/fakes/xterm.mjs",
    },
    routes: {
      "/api/terminals/desktop": () => ({ sessions: [], providers: [] }),
      "/api/terminals/agents": () => ({ agents: [] }),
      "/api/push": () => ({ key: "test" }),
      "/api/notifications": () => ({ items: [], unavailable: [] }),
    },
  });
  React = dom.React;
  ({ default: ChatList } = await dom.load("/src/ChatList.tsx"));
  ({ TerminalView } = await dom.load("/src/Sessions.tsx"));
  ({ ComputerSwitcher } = await dom.load("/src/FleetMesh.tsx"));
  ({ NotificationCenter } = await dom.load("/src/Notifications.tsx"));
});
after(() => dom?.close());

// A button with no words of its own: it must be named, and titled.
const iconOnly = (root) =>
  [...root.querySelectorAll("button")].filter((b) => !b.textContent.trim());
const named = (buttons, where) => {
  assert.ok(buttons.length, `icon buttons in ${where}`);
  for (const b of buttons) {
    const label = b.getAttribute("aria-label");
    assert.ok(label, `${where}: ${b.outerHTML.slice(0, 80)} has an aria-label`);
    assert.ok(b.getAttribute("title"), `${where}: "${label}" has a title`);
  }
};

test("Chat's bar: every round button is named and titled, Workflows included, and the bell is last", async () => {
  // The bell shows inside Reach's notifications, as in the app.
  const view = await dom.render(
    React.createElement(
      NotificationCenter,
      { peer, enabled: true, onOpen() {} },
      React.createElement(ChatList, {
        peer,
        sessions: [],
        logos: {},
        agent: "codex",
        onOpen() {},
        onNew() {},
        onRefresh() {},
        workflows: { active: 1, paused: 0, onOpen() {} },
      }),
    ),
  );
  await settle();
  const header = dom.document.querySelector(".chat-mobile-header");
  assert.ok(header, "the phone's chat bar");
  named(iconOnly(header), "Chat's bar");
  // The two-squares icon: Workflows, with its count for a screen reader.
  const flows = header.querySelector(".chat-workflows");
  assert.equal(flows.getAttribute("title"), "Workflows");
  assert.equal(flows.getAttribute("aria-label"), "Workflows, 1 active");
  const tools = [...header.querySelectorAll(".chat-mobile-tools > button")];
  assert.equal(tools.at(-1).getAttribute("aria-label"), "Notifications", "the bell ends the bar");
  // Wider screens: Chat's heading keeps the same order, bell last before New chat.
  const wide = dom.document.querySelector(".chat-heading-actions");
  const round = iconOnly(wide);
  named(round, "Chat's heading");
  assert.equal(round.at(-1).getAttribute("aria-label"), "Notifications");
  await view.unmount();
  assert.deepEqual(dom.errors, []);
});

test("the Terminal page's bar names and titles its round buttons", async () => {
  const view = await dom.render(
    React.createElement(TerminalView, {
      desktopTerminals: false,
      peer: { ...peer, platform: "win32" },
      sessions: [],
      selected: "",
      onSelect() {},
      onNew() {},
      onRefresh() {},
      toast() {},
      source: "reach",
      setSource() {},
      onExit() {},
    }),
  );
  await settle();
  const bar = dom.document.querySelector(".terminal-bar");
  assert.ok(bar, "the Terminal page's bar");
  named(iconOnly(bar), "Terminal's bar");
  assert.ok(bar.querySelector('button[aria-label="New terminal"][title="New terminal"]'));
  await view.unmount();
});

test("Reach's header: Add a computer is named and titled", async () => {
  const view = await dom.render(
    React.createElement(ComputerSwitcher, {
      // Two computers: with one, there's no switcher to show at all.
      peers: [peer, { ...peer, id: "pc", name: "Desk PC", url: "https://pc.tail.ts.net", platform: "win32" }],
      active: peer.id,
      connections: {},
      choose() {},
      pair() {},
    }),
  );
  named(iconOnly(dom.document.querySelector(".fleet-switcher")), "the computers");
  await view.unmount();
});

test("Reach's header has one bell, beside Settings", () => {
  const right = source("App.tsx").match(/<div className="topbar-right">([\s\S]*?)<\/div>/)[1];
  assert.equal(right.split("<NotificationBell").length - 1, 1, "one bell in the header");
  assert.ok(right.indexOf("<NotificationBell") < right.indexOf('aria-label="Settings"'), "the bell, then Settings");
});

test("the three bars share one height, one button and one title style", () => {
  const css = source("top-bar.css");
  for (const token of ["--bar-height", "--bar-inline", "--bar-button", "--bar-gap", "--bar-title-size"])
    assert.match(css, new RegExp(`:root \\{[^}]*${token}:`), `${token} is defined once`);
  const rule = (selector) => {
    const at = css.indexOf(`${selector} {`);
    assert.ok(at >= 0, `a rule for ${selector}`);
    return css.slice(at, css.indexOf("}", at));
  };
  // The same height under the status bar, for each bar.
  assert.match(rule(".app-shell .main-shell > .topbar"), /height: calc\(var\(--bar-height\) \+ env\(safe-area-inset-top\)\)/);
  assert.match(rule(".app-shell .main-shell > .topbar"), /padding: env\(safe-area-inset-top\)/);
  assert.match(rule(".app-shell .chat-library .chat-list-top"), /padding: env\(safe-area-inset-top\)/);
  assert.match(rule(".app-shell .chat-mobile-header"), /height: var\(--bar-height\)/);
  assert.match(rule(".app-shell .terminal-bar"), /min-height: var\(--bar-height\)/);
  // One round button for all of them, the bell in both bars included.
  const round = css.match(/([^{}]*)\{\s*flex: none;\s*display: grid;[^}]*width: var\(--bar-button\)/)[1];
  for (const button of [
    ".topbar .notification-bell",
    ".fleet-switcher .fleet-add",
    ".chat-mobile-round",
    ".chat-mobile-tools .notification-bell",
    ".chat-mobile-tools .usage-button",
    ".terminal-bar-icon",
  ])
    assert.ok(round.includes(button), `${button} is one of the round buttons`);
  // One title style.
  assert.match(css, /\.chat-app-current \{[^}]*font-size: var\(--bar-title-size\)/);
  assert.match(css, /\.terminal-bar \.terminal-switch,[^{]*\{[^}]*font-size: var\(--bar-title-size\)/);
  // The computers end one button and gap before the bell, from the same measures.
  assert.match(css, /:has\(\.notification-bell\) \+ \.fleet-switcher \{\s*--bar-end: calc\(var\(--bar-inline\) \+ var\(--bar-button\) \+ var\(--bar-gap\)\)/);
  assert.doesNotMatch(source("notifications.css"), /right: 64px/, "no second, hard-coded bell reserve");
  // Loaded after the shared look, so its measures win.
  const main = source("main.tsx");
  assert.ok(main.indexOf('import "./top-bar.css"') > main.indexOf('import "./app-style.css"'));
});
