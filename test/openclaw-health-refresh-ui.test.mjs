import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { startDom, settle } from "./dom/harness.mjs";

// After a Gateway restart the pill asks again. A read already on its way
// started before the restart: its old answer must not be the last word.
const peer = { id: "mac", name: "Mac", url: "https://reach.test", token: "t", platform: "darwin" };
const replies = [];
let reads = 0;
let dom, ClawHealthPill;
before(async () => {
  dom = await startDom({ routes: {
    "/api/sessions/openclaw/health": () => {
      reads++;
      return new Promise((resolve) => replies.push(resolve));
    },
  } });
  ({ ClawHealthPill } = await dom.load("/src/OpenClawHealth.tsx"));
});
after(() => dom?.close());

const off = { supported: false };
const health = (status) => ({ status, gateway: off, uptime: off, channels: off, memory: off, storage: off });

test("a refresh asked for during a read still reads again afterwards", async () => {
  let setRefresh;
  function Host() {
    const [refresh, set] = dom.React.useState(0);
    setRefresh = set;
    return dom.React.createElement(ClawHealthPill, { peer, refresh });
  }
  const view = await dom.render(dom.React.createElement(Host));
  await dom.waitFor(() => replies.length === 1);
  // The Gateway restarts while the first read is on its way.
  dom.update(() => setRefresh(1));
  await settle();
  replies.shift()(health("attention"));
  await settle();
  assert.equal(reads, 2, "the refresh asked during the read happens after it");
  replies.shift()(health("ok"));
  await settle();
  assert.ok(dom.document.querySelector(".claw-health-pill.ok"));
  // A later refresh from the page is read at once, not held for 30 seconds.
  dom.update(() => setRefresh(2));
  await settle();
  assert.equal(reads, 3);
  replies.shift()(health("ok"));
  await settle();
  assert.deepEqual(dom.errors, []);
  await view.unmount();
});
