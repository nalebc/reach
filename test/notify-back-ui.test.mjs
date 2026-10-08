import test, { before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { startDom, settle } from "./dom/harness.mjs";

let dom, useNotifyBack, current, change, reply;
const calls = [];
const peer = { id: "one", name: "Mac", url: "https://reach.test", token: "t", platform: "darwin" };
before(async () => {
  dom = await startDom({ routes: {
    "/api/sessions/usage-watch": async (init) => {
      calls.push(JSON.parse(init.body));
      return reply ? await reply() : {};
    },
  } });
  ({ useNotifyBack } = await dom.load("/src/notify-back.ts"));
});
after(() => dom?.close());
let view;
afterEach(async () => {
  await view?.unmount();
  calls.length = 0;
  reply = undefined;
});
async function open() {
  function Harness() {
    const [props, setProps] = dom.React.useState({ peer, agent: "codex", session: "chat", asked: true });
    change = (next) => dom.update(() => setProps((old) => ({ ...old, ...next })));
    current = useNotifyBack(props.peer, props.agent, props.session, props.asked);
    return null;
  }
  view = await dom.render(dom.React.createElement(Harness));
}

test("switching computers restores that computer's notification state", async () => {
  await open();
  await current.toggle();
  await settle();
  assert.equal(current.on, false);
  change({ peer: { ...peer, id: "two", url: "https://other.test" } });
  await settle();
  assert.equal(current.on, true);
});

test("a late response from the old computer cannot change the new computer's state", async () => {
  await open();
  let finish;
  reply = () => new Promise((resolve) => { finish = resolve; });
  const pending = current.toggle();
  await dom.waitFor(() => finish);
  change({ peer: { ...peer, id: "two", url: "https://other.test" } });
  await settle();
  assert.equal(current.busy, false);
  finish({});
  await pending;
  await settle();
  assert.equal(current.on, true);
});

test("repeated taps submit only one pending notification change", async () => {
  await open();
  let finish;
  reply = () => new Promise((resolve) => { finish = resolve; });
  const first = current.toggle();
  const second = current.toggle();
  await dom.waitFor(() => finish);
  assert.equal(calls.length, 1);
  finish({});
  await Promise.all([first, second]);
});
