import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { startDom, settle } from "./dom/harness.mjs";

// Enter in a Mac tab runs a command on the Mac: a second Enter while the
// first line is on its way must not send it again, and what's typed in the
// meantime stays for the next line.
const peer = { id: "mac", name: "Mac", url: "https://reach.test", token: "t", platform: "darwin" };
const sent = [];
let finish = [];
let dom, MacTerminalView, Terminal;
before(async () => {
  dom = await startDom({
    fakes: { "@xterm/xterm": "test/dom/fakes/xterm.mjs", "@xterm/addon-fit": "test/dom/fakes/xterm.mjs" },
    routes: {
      "/api/terminals/desktop/t1/send": (init) => {
        sent.push(JSON.parse(init.body).text);
        return new Promise((resolve) => finish.push(() => resolve({ ok: true })));
      },
      "/api/terminals/desktop/t1": () => new Promise(() => {}),
    },
  });
  ({ default: MacTerminalView } = await dom.load("/src/MacTerminalView.tsx"));
  ({ Terminal } = await dom.load("/test/dom/fakes/xterm.mjs"));
});
after(() => dom?.close());

test("a second Enter while a line is sending doesn't run it twice, and later typing is kept", async () => {
  const view = await dom.render(dom.React.createElement(MacTerminalView, { peer, tab: { id: "t1", name: "zsh" }, onGone() {} }));
  const term = Terminal.instances.at(-1);
  term.type("rm build.log");
  term.type("\r");
  term.type("\r");
  await settle();
  assert.deepEqual(sent, ["rm build.log"], "the line goes once");
  term.type("ls");
  finish.shift()();
  await settle();
  term.type("\r");
  await settle();
  assert.deepEqual(sent, ["rm build.log", "ls"], "typing during the send is the next line");
  for (const f of finish.splice(0)) f();
  await view.unmount();
});
