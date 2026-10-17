import test, { before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { startDom, settle } from "./dom/harness.mjs";

let dom, transfers, native, jobs = [];
let contentReads = 0;
const content = new TextEncoder().encode("route-data");
const peer = { id: "computer", name: "Computer", url: "https://reach.test", token: "t", platform: "darwin" };
const entry = { name: "notes.txt", path: "notes.txt", size: 10, type: "file" };
before(async () => {
  const fake = "test/dom/fakes/background-transfer.mjs";
  dom = await startDom({
    fakes: {
      "src/native.ts": fake, "@capacitor/core": fake, "@capacitor/share": fake,
      "src/tailnet-transport.ts": "test/dom/fakes/tailnet-toggle.mjs",
    },
    routes: {
      "/api/files": () => ({ items: [entry] }),
      "/api/files/content": () => {
        contentReads++;
        return new Response(content, { headers: { "Content-Type": "application/octet-stream", "Content-Length": String(content.byteLength) } });
      },
    },
  });
  native = await dom.load("/test/dom/fakes/background-transfer.mjs");
  transfers = await dom.load("/src/transfers.ts");
  function Probe() { jobs = transfers.useTransfers(); return null; }
  await dom.render(dom.React.createElement(Probe));
});
afterEach(async () => {
  for (const job of jobs) { job.cancel(); transfers.dismiss(job.id); }
  await settle();
  native.reset();
  contentReads = 0;
  delete globalThis.__reachTailnetBrowser;
  delete globalThis.__reachPeerUsesBrowserTailnet;
});
after(() => dom.close());

test("canceling while the native download is starting cancels its eventual task and removes listeners", async () => {
  const starting = transfers.downloadInBackground(peer, 0, entry, () => {});
  await dom.waitFor(() => native.state.finish && jobs.length);
  jobs[0].cancel();
  native.state.finish({ id: "native-1" });
  await starting;
  assert.deepEqual(native.state.canceled, ["native-1"]);
  assert.equal(native.state.listeners.size, 0);
  assert.equal(jobs[0].state, "canceled");
});

test("failed native listener setup releases earlier listeners and marks the transfer as failed", async () => {
  native.state.failListener = 2;
  await transfers.downloadInBackground(peer, 0, entry, () => {});
  await dom.waitFor(() => jobs.length);
  assert.equal(jobs[0].state, "failed");
  assert.match(jobs[0].error, /Listener unavailable/);
  assert.equal(native.state.listeners.size, 0);
  assert.equal(native.state.start, null);
});

test("a native cancellation event stops the transfer tray's running state", async () => {
  const starting = transfers.downloadInBackground(peer, 0, entry, () => {});
  await dom.waitFor(() => native.state.finish && jobs.length);
  native.state.finish({ id: "native-2" });
  await starting;
  native.state.listeners.get("failed")({ id: "native-2", canceled: true });
  await settle();
  assert.equal(jobs[0].state, "canceled");
  assert.equal(native.state.listeners.size, 0);
});


for (const [label, browserPrivate, heldBrowserPeer] of [
  ["browser-private", true, false],
  ["native private", false, false],
  ["browser-private again", true, false],
  ["original browser-private peer after native handoff", false, true],
])
  test(`native shell Download uses ${label} without bypassing its approved route`, async () => {
    globalThis.__reachTailnetBrowser = browserPrivate;
    if (heldBrowserPeer) globalThis.__reachPeerUsesBrowserTailnet = candidate => candidate.token === peer.token;
    const { default: Files } = await dom.load("/src/Files.tsx");
    const view = await dom.render(dom.React.createElement(Files, {
      peer, peers: [peer],
      device: { name: "Computer", platform: "darwin", roots: [{ id: 0, name: "Shared", path: "/shared" }], capabilities: { files: true } },
      onSession() {}, toast() {},
    }));
    try {
      await dom.waitFor(() => view.container.querySelector('[aria-label="Actions for notes.txt"]'));
      dom.update(() => view.container.querySelector('[aria-label="Actions for notes.txt"]').click());
      const download = () => [...view.container.querySelectorAll('button')].find(button => button.textContent.trim() === "Download");
      await dom.waitFor(download);
      dom.update(() => download().click());
      await dom.waitFor(() => native.state.start || native.state.saved.length);
      if (native.state.start) native.state.finish({ id: "native-route-test" });
      if (browserPrivate || heldBrowserPeer) {
        assert.equal(native.state.start, null, "iOS URLSession cannot bypass the page's private Tailscale node");
        assert.equal(contentReads, 1);
        assert.equal(native.state.saved[0].name, entry.name);
        assert.deepEqual(native.state.saved[0].bytes, content);
      } else {
        assert.equal(native.state.start, true, "native private mode retains background downloading");
        assert.equal(contentReads, 0);
        assert.deepEqual(native.state.saved, []);
      }
    } finally {
      await view.unmount();
    }
  });

test("a native download completed before a route change is still offered in browser-private mode", async () => {
  globalThis.__reachTailnetBrowser = true;
  native.state.finished = [{ id: "completed-native", name: "already-downloaded.txt", uri: "file:///cache/already-downloaded.txt" }];
  await transfers.collectFinishedDownloads();
  await dom.waitFor(() => jobs.some(job => job.name === "already-downloaded.txt"));
  const completed = jobs.find(job => job.name === "already-downloaded.txt");
  assert.equal(completed.state, "done");
  assert.equal(completed.action?.label, "Save");
  assert.equal(native.state.start, null);
});
