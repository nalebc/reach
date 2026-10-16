import test from "node:test";
import assert from "node:assert/strict";
import { startDom } from "./dom/harness.mjs";

const peer = { id: "computer", name: "Computer", url: "https://reach.test", token: "t", platform: "darwin" };
const missing = () => new Response(JSON.stringify({ error: "This upload is no longer available. Start it again." }), { status: 404 });

for (const restartAt of ["chunk", "complete"]) {
  test(`an upload recovers when Reach restarts before the next ${restartAt}`, async (t) => {
    let sessions = 0, jobs = [], landed = [], completes = 0;
    const chunks = [];
    const dom = await startDom({ routes: {
      "/api/files/uploads": () => ({ id: `upload-${++sessions}`, offset: 0, chunk: 4 }),
      "/api/files/uploads/upload-1/complete": () => { completes++; return missing(); },
      "/api/files/uploads/upload-2/complete": () => { completes++; return {}; },
    } });
    t.after(() => dom.close());
    const original = globalThis.XMLHttpRequest;
    globalThis.XMLHttpRequest = class {
      upload = {};
      open(_method, url) { this.url = new URL(url); }
      setRequestHeader() {}
      send(chunk) {
        const offset = Number(this.url.searchParams.get("offset"));
        const id = this.url.pathname.split("/").at(-1);
        chunks.push({ id, offset, size: chunk.size });
        this.status = restartAt === "chunk" && id === "upload-1" && offset === 4 ? 404 : 200;
        this.responseText = JSON.stringify(this.status === 404
          ? { error: "This upload is no longer available. Start it again." }
          : { offset: offset + chunk.size });
        queueMicrotask(() => this.onload());
      }
      abort() { this.onabort?.(); }
    };
    t.after(() => { globalThis.XMLHttpRequest = original; });
    const transfers = await dom.load("/src/transfers.ts");
    t.after(() => { for (const job of jobs) { job.cancel(); transfers.dismiss(job.id); } });
    function Probe() { jobs = transfers.useTransfers(); return null; }
    await dom.render(dom.React.createElement(Probe));
    transfers.uploadFiles(peer, 0, "", [new File(["abcdefgh"], "notes.txt")], name => landed.push(name));
    await dom.waitFor(() => jobs[0] && ["done", "failed"].includes(jobs[0].state));
    assert.equal(jobs[0].state, "done", jobs[0].error);
    assert.deepEqual(landed, ["notes.txt"]);
    assert.equal(sessions, 2);
    assert.deepEqual(chunks.filter(chunk => chunk.id === "upload-2").map(chunk => chunk.offset), [0, 4],
      "a lost session restarts from byte zero");
    assert.equal(completes, restartAt === "chunk" ? 1 : 2);
  });
}

for (const failure of ["repeated restarts", "revoked access", "existing destination", "missing folder"]) {
  test(`upload restart recovery stops safely for ${failure}`, async t => {
    let sessions = 0, jobs = [], completions = 0;
    const landed = [];
    const dom = await startDom({ routes: {
      "/api/files/uploads": () => {
        sessions++;
        if (sessions > 1 && ["existing destination", "missing folder"].includes(failure))
          return new Response(JSON.stringify({ error: failure }), { status: failure === "existing destination" ? 409 : 404 });
        return { id: `upload-${sessions}`, offset: 0, chunk: 4 };
      },
    } });
    t.after(() => dom.close());
    const original = globalThis.XMLHttpRequest;
    globalThis.XMLHttpRequest = class {
      upload = {};
      open() {}
      setRequestHeader() {}
      send() {
        this.status = failure === "revoked access" ? 401 : 404;
        this.responseText = JSON.stringify({ error: failure });
        queueMicrotask(() => this.onload());
      }
      abort() { this.onabort?.(); }
    };
    t.after(() => { globalThis.XMLHttpRequest = original; });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, options) => {
      if (new URL(url).pathname.endsWith("/complete")) completions++;
      return originalFetch(url, options);
    };
    t.after(() => { globalThis.fetch = originalFetch; });
    const transfers = await dom.load("/src/transfers.ts");
    t.after(() => { for (const job of jobs) { job.cancel(); transfers.dismiss(job.id); } });
    function Probe() { jobs = transfers.useTransfers(); return null; }
    await dom.render(dom.React.createElement(Probe));
    transfers.uploadFiles(peer, 0, "", [new File(["bytes"], "notes.txt")], name => landed.push(name));
    await dom.waitFor(() => jobs[0]?.state === "failed");
    assert.equal(sessions, failure === "repeated restarts" ? 3 : failure === "revoked access" ? 1 : 2);
    assert.equal(completions, 0);
    assert.deepEqual(landed, []);
  });
}
