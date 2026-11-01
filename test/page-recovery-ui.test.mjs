import test, { before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { startDom, settle } from "./dom/harness.mjs";

let dom, recovery, stop;
before(async () => {
  dom = await startDom();
  recovery = await dom.load("/src/page-recovery.ts");
});
after(async () => dom?.close());
afterEach(() => {
  stop?.();
  stop = undefined;
  dom.document.body.replaceChildren();
  Object.defineProperty(dom.document, "hidden", { configurable: true, value: false });
});

function fixture(answers = async () => true) {
  dom.document.body.innerHTML = '<div id="root">Reach is open</div><script>/* retained script */</script>';
  let tick;
  const reads = [], reopened = [];
  stop = recovery.watchPageRecovery({
    every: check => { tick = check; return 0; }, clear() {},
    answers: (...args) => { reads.push(args); return answers(...args); },
    reopen: href => reopened.push(href),
  });
  return { reads, reopened, tick: () => tick(),
    blank: () => dom.document.getElementById("root").replaceChildren(),
    event: name => dom.window.dispatchEvent(new dom.window.Event(name)),
  };
}

test("an empty app container and retained scripts are blank, while text, controls and screen surfaces stay healthy", () => {
  for (const content of ["", "<div><div></div></div>", "   "]) {
    fixture();
    dom.document.getElementById("root").innerHTML = content;
    assert.equal(recovery.pageHasContent(dom.document), false);
    stop();
  }
  for (const content of ["Reach", "<canvas></canvas>", "<video></video>", "<button></button>", '<p role="status"></p>']) {
    dom.document.getElementById("root").innerHTML = content;
    assert.equal(recovery.pageHasContent(dom.document), true);
  }
});

test("foreground recovery preserves the current route, fragment, history state and saved approvals", async () => {
  const href = "/files/example?view=preview&connection=browser#saved-view";
  dom.window.history.replaceState({ reach: { page: "files", i: 2 } }, "", href);
  dom.window.localStorage.setItem("reach.devices", "fixture-owner-approval");
  const f = fixture();
  f.blank();
  f.event("pageshow");
  assert.equal(f.reads.length, 0, "allow a transient empty render to finish");
  f.tick();
  await settle();
  assert.deepEqual(f.reopened, [new URL(href, dom.window.location.origin).href]);
  const target = new URL(recovery.reconnectUrl(f.reopened[0], 123));
  assert.equal(target.pathname + target.search + target.hash, "/files/example?view=preview&connection=browser&reach-reconnect=123#saved-view");
  assert.deepEqual(dom.window.history.state, { reach: { page: "files", i: 2 } });
  assert.equal(dom.window.localStorage.getItem("reach.devices"), "fixture-owner-approval");
  f.event("focus"); f.tick();
  assert.equal(f.reads.length, 1, "duplicate wake events cannot start another recovery");
});

test("an unavailable document keeps visible recovery and retries reads until the network returns", async () => {
  let online = false;
  const f = fixture(async () => online);
  f.blank(); f.tick(); f.tick(); await settle();
  assert.match(dom.document.querySelector('[data-reach-page-recovery]').textContent, /Reconnecting to Reach/);
  assert.deepEqual(f.reopened, []);
  f.tick(); await settle();
  assert.equal(f.reads.length, 2);
  online = true;
  f.event("online"); await settle();
  assert.equal(f.reopened.length, 1);
});

test("concurrent wake events share one check and a late answer cannot replace a page that recovered", async () => {
  let answer;
  const f = fixture(() => new Promise(resolve => { answer = resolve; }));
  f.blank(); f.tick(); f.tick();
  f.event("focus"); f.event("pageshow"); f.tick();
  assert.equal(f.reads.length, 1);
  dom.document.getElementById("root").textContent = "Open work restored";
  f.tick();
  assert.equal(f.reads[0][1].aborted, true);
  answer(true); await settle();
  assert.deepEqual(f.reopened, []);
  assert.equal(dom.document.querySelector('[data-reach-page-recovery]'), null);
});

test("backgrounding aborts a held check; returning uses a fresh read and leaves working pages untouched", async () => {
  let answer;
  const f = fixture(() => new Promise(resolve => { answer = resolve; }));
  f.tick(); f.event("focus");
  assert.equal(f.reads.length, 0);
  f.blank(); f.tick(); f.tick();
  Object.defineProperty(dom.document, "hidden", { configurable: true, value: true });
  dom.document.dispatchEvent(new dom.window.Event("visibilitychange"));
  assert.equal(f.reads[0][1].aborted, true);
  answer(true); await settle();
  assert.deepEqual(f.reopened, []);
  Object.defineProperty(dom.document, "hidden", { configurable: true, value: false });
  dom.document.dispatchEvent(new dom.window.Event("visibilitychange"));
  f.tick();
  assert.equal(f.reads.length, 2);
  answer(true); await settle();
  assert.equal(f.reopened.length, 1);
});

test("a document with its whole body removed does not mistake its recovery cover for restored content", async () => {
  const f = fixture(async () => false);
  dom.document.body.replaceChildren();
  f.tick(); f.tick(); await settle();
  assert.equal(recovery.pageHasContent(dom.document), false);
  assert.ok(dom.document.querySelector('[data-reach-page-recovery]'));
  f.tick(); await settle();
  assert.equal(f.reads.length, 2);
});

test("disposing recovery aborts held work and removes every wake handler", async () => {
  let answer;
  const f = fixture(() => new Promise(resolve => { answer = resolve; }));
  f.blank(); f.tick(); f.tick();
  stop();
  assert.equal(f.reads[0][1].aborted, true);
  answer(true); await settle();
  f.event("pageshow"); f.event("online"); f.tick();
  assert.deepEqual(f.reopened, []);
  assert.equal(f.reads.length, 1);
  assert.equal(dom.document.querySelector('[data-reach-page-recovery]'), null);
});
