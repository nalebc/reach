import test, { before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { startDom, settle } from "./dom/harness.mjs";

let dom, transfers, jobs, finish, view;
const calls = [];
const landed = [];
const peer = { id: "mac", name: "Mac", url: "https://reach.test", token: "t", platform: "darwin" };
before(async () => {
  dom = await startDom({ routes: {
    "/api/files/uploads": (init) => {
      calls.push(["begin", init.method]);
      return new Promise((resolve) => { finish = resolve; });
    },
    "/api/files/uploads/upload-1": (init) => { calls.push(["session", init.method]); return {}; },
    "/api/files/uploads/upload-1/complete": (init) => { calls.push(["complete", init.method]); return {}; },
  } });
  transfers = await dom.load("/src/transfers.ts");
});
after(() => dom?.close());
afterEach(async () => {
  await view?.unmount();
  for (const job of jobs || []) { job.cancel(); transfers.dismiss(job.id); }
  calls.length = 0; landed.length = 0; finish = undefined;
});

for (const content of ["", "file contents"]) test(`canceling ${content ? "a nonempty" : "an empty"} file while its upload is starting deletes the session and never commits the file`, async () => {
  function Probe() { jobs = transfers.useTransfers(); return null; }
  view = await dom.render(dom.React.createElement(Probe));
  transfers.uploadFiles(peer, 0, "", [new File([content], "file.txt")], (name) => landed.push(name));
  await dom.waitFor(() => finish && jobs.length);
  jobs[0].cancel();
  finish({ id: "upload-1", offset: 0, chunk: 1024 });
  await settle(80);
  assert.equal(calls.some(([route]) => route === "complete"), false);
  assert.ok(calls.some(([route, method]) => route === "session" && method === "DELETE"));
  assert.equal(jobs[0].state, "canceled");
  assert.deepEqual(landed, []);
});

test("canceling an offline upload prevents a later online event from resuming it", async (t) => {
  const original = globalThis.XMLHttpRequest;
  globalThis.XMLHttpRequest = class {
    upload = {};
    open() {}
    setRequestHeader() {}
    send() { queueMicrotask(() => this.onerror()); }
    abort() { this.onabort?.(); }
  };
  Object.defineProperty(dom.window.navigator, "onLine", { configurable: true, value: false });
  t.after(() => {
    globalThis.XMLHttpRequest = original;
    delete dom.window.navigator.onLine;
  });
  function Probe() { jobs = transfers.useTransfers(); return null; }
  view = await dom.render(dom.React.createElement(Probe));
  transfers.uploadFiles(peer, 0, "", [new File(["bytes"], "file.txt")], (name) => landed.push(name));
  await dom.waitFor(() => finish);
  finish({ id: "upload-1", offset: 0, chunk: 1024 });
  await dom.waitFor(() => jobs[0]?.state === "waiting");
  jobs[0].cancel();
  Object.defineProperty(dom.window.navigator, "onLine", { configurable: true, value: true });
  dom.window.dispatchEvent(new dom.window.Event("online"));
  await settle(1200);
  assert.equal(calls.some(([route, method]) => route === "session" && method !== "DELETE"), false);
  assert.equal(jobs[0].state, "canceled");
  assert.deepEqual(landed, []);
});

test("a dropped answer to the last step still ends as uploaded, not failed", async (t) => {
  const original = globalThis.XMLHttpRequest;
  globalThis.XMLHttpRequest = class {
    upload = {};
    open() {}
    setRequestHeader() {}
    send(chunk) {
      this.status = 200;
      this.responseText = JSON.stringify({ offset: chunk.size });
      queueMicrotask(() => this.onload());
    }
    abort() {}
  };
  const realFetch = globalThis.fetch;
  let completes = 0;
  globalThis.fetch = dom.window.fetch = async (url, init) => {
    if (new URL(url).pathname.endsWith("/complete") && ++completes === 1)
      throw new TypeError("Load failed");
    return realFetch(url, init);
  };
  t.after(() => {
    globalThis.XMLHttpRequest = original;
    globalThis.fetch = dom.window.fetch = realFetch;
  });
  function Probe() { jobs = transfers.useTransfers(); return null; }
  view = await dom.render(dom.React.createElement(Probe));
  transfers.uploadFiles(peer, 0, "", [new File(["bytes"], "file.txt")], (name) => landed.push(name));
  await dom.waitFor(() => finish);
  finish({ id: "upload-1", offset: 0, chunk: 1024 });
  await dom.waitFor(() => landed.length, 5000);
  assert.equal(completes, 2);
  assert.equal(jobs[0].state, "done");
});

test("a failed (not canceled) upload also deletes its server session", async (t) => {
  const original = globalThis.XMLHttpRequest;
  globalThis.XMLHttpRequest = class {
    upload = {};
    open() {}
    setRequestHeader() {}
    send() {
      this.status = 400;
      this.responseText = JSON.stringify({ error: "Not allowed" });
      queueMicrotask(() => this.onload());
    }
    abort() {}
  };
  t.after(() => { globalThis.XMLHttpRequest = original; });
  function Probe() { jobs = transfers.useTransfers(); return null; }
  view = await dom.render(dom.React.createElement(Probe));
  transfers.uploadFiles(peer, 0, "", [new File(["bytes"], "file.txt")], (name) => landed.push(name));
  await dom.waitFor(() => finish);
  finish({ id: "upload-1", offset: 0, chunk: 1024 });
  await dom.waitFor(() => jobs[0]?.state === "failed", 5000);
  assert.ok(calls.some(([route, method]) => route === "session" && method === "DELETE"));
  assert.deepEqual(landed, []);
});
