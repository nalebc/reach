import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { startDom, settle } from "./dom/harness.mjs";

// Phone side of pushed Mac terminals: an open Mac tab waits for the Mac to
// send new output instead of asking every second, and the Terminal page
// refetches its list when the live connection says it changed. Macs without
// the watcher are still asked on a timer.
const peer = {
  id: "mac",
  name: "Mac",
  url: "https://reach.test",
  token: "t",
  platform: "darwin",
};
const tabs = [
  {
    id: "a2",
    provider: "terminal",
    name: "reach — -zsh — 80×24",
    tty: "/dev/ttys007",
  },
];
const state = {
  requests: [],
  lists: 0,
  mode: "push",
  gate: null,
  waits: [],
  sent: [],
};
let dom, React, TerminalView, Terminal;
before(async () => {
  dom = await startDom({
    mobile: true,
    fakes: {
      "@xterm/xterm": "test/dom/fakes/xterm.mjs",
      "@xterm/addon-fit": "test/dom/fakes/xterm.mjs",
    },
    routes: {
      "/api/terminals/desktop": () => {
        state.lists++;
        return { sessions: tabs, providers: [] };
      },
      "/api/terminals/agents": () => ({ agents: [] }),
      "/api/terminals/desktop/a2/send": (init) => {
        state.sent.push(JSON.parse(init.body));
        return { ok: true };
      },
      "/api/terminals/desktop/a2": async (init, url) => {
        const after = url.searchParams.get("after");
        state.requests.push(after);
        if (state.mode === "poll")
          return { text: `plain ${state.requests.length}` };
        if (after === "0") return { text: "first line", version: 1 };
        if (after === "1") {
          await new Promise((r) => (state.gate = r));
          return { text: "first line\nsecond line", version: 2 };
        }
        state.waits.push(init.signal);
        return new Promise(() => {});
      },
    },
  });
  React = dom.React;
  ({ TerminalView } = await dom.load("/src/Sessions.tsx"));
  ({ Terminal } = await dom.load("/test/dom/fakes/xterm.mjs"));
});
after(async () => dom?.close());

let setChanges;
function Host(props) {
  const [changes, set] = React.useState(props.changes);
  setChanges = set;
  return React.createElement(TerminalView, {
    desktopTerminals: true,
    peer,
    sessions: [],
    selected: "",
    onSelect() {},
    onNew() {},
    onRefresh() {},
    toast() {},
    source: props.source ?? "mac",
    setSource() {},
    onExit() {},
    changes,
  });
}
const drawn = () => Terminal.instances.at(-1)?.written.join("") ?? "";

test("an open Mac tab shows new output when the Mac sends it, without asking every second", async () => {
  Object.assign(state, { requests: [], mode: "push", gate: null, waits: [] });
  const view = await dom.render(
    React.createElement(Host, {
      source: "mac:a2",
      changes: '{"macTerminals":"v1"}',
    }),
  );
  await dom.waitFor(() => drawn().includes("first line"));
  await dom.waitFor(() => state.gate);
  state.gate();
  await dom.waitFor(() => drawn().includes("second line"));
  // Now waiting for the next change: no reads on a timer.
  await settle(1300);
  assert.deepEqual(state.requests, ["0", "1", "2"]);
  await view.unmount();
  assert.equal(state.waits.at(-1).aborted, true, "leaving stops the wait");
});

test("a Mac without the watcher is still asked about once a second", async () => {
  Object.assign(state, { requests: [], mode: "poll" });
  const view = await dom.render(
    React.createElement(Host, { source: "mac:a2" }),
  );
  await dom.waitFor(() => drawn().includes("plain 1"));
  await dom.waitFor(() => state.requests.length >= 2, 2500);
  assert.equal(state.requests[0], "0");
  assert.equal(state.requests[1], null, "plain reads after the first answer");
  await view.unmount();
});

test("the Terminal page refetches Mac windows when told, not every five seconds", async () => {
  const timers = [];
  const real = globalThis.setInterval;
  globalThis.setInterval = (fn, ms, ...rest) => {
    timers.push(ms);
    return real(fn, ms, ...rest);
  };
  try {
    state.lists = 0;
    const view = await dom.render(
      React.createElement(Host, { changes: '{"macTerminals":"v1"}' }),
    );
    await dom.waitFor(() => state.lists === 1);
    assert.ok(!timers.includes(5000), "no five-second list timer");
    setChanges('{"macTerminals":"v2"}');
    await dom.waitFor(() => state.lists === 2);
    setChanges('{"macTerminals":"v2","terminals":"x"}');
    await settle(50);
    assert.equal(state.lists, 2, "other changes don't refetch Mac windows");
    await view.unmount();

    // An older Mac: asked every five seconds as before.
    timers.length = 0;
    const old = await dom.render(React.createElement(Host, {}));
    await dom.waitFor(() => timers.includes(5000));
    await old.unmount();
  } finally {
    globalThis.setInterval = real;
  }
  assert.deepEqual(dom.errors, []);
});

test("Return on an empty line in a Mac tab is sent, so prompts can be answered", async () => {
  Object.assign(state, {
    requests: [],
    mode: "push",
    gate: null,
    waits: [],
    sent: [],
  });
  const view = await dom.render(
    React.createElement(Host, {
      source: "mac:a2",
      changes: '{"macTerminals":"v1"}',
    }),
  );
  const enter = await dom.waitFor(() =>
    view.container.querySelector(".mac-line button[aria-label=Enter]:not(:disabled)"),
  );
  enter.click();
  await dom.waitFor(() => state.sent.length);
  assert.deepEqual(state.sent, [{ text: "" }]);
  // One line at a time: the next Enter after the Mac took this one.
  await settle();
  // Spaces alone are a slip: still just Return.
  const term = Terminal.instances.at(-1);
  term.type("  ");
  enter.click();
  await dom.waitFor(() => state.sent.length === 2);
  assert.deepEqual(state.sent[1], { text: "" });
  await view.unmount();
});
