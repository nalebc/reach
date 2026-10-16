import test, { before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { startDom, settle } from "./dom/harness.mjs";

let dom, transfers, native, jobs = [];
const peer = { id: "computer", name: "Computer", url: "https://reach.test", token: "t", platform: "darwin" };
const entry = { name: "notes.txt", path: "notes.txt", size: 10, type: "file" };
before(async () => {
  const fake = "test/dom/fakes/background-transfer.mjs";
  dom = await startDom({ fakes: { "src/native.ts": fake, "@capacitor/core": fake, "@capacitor/share": fake } });
  native = await dom.load("/test/dom/fakes/background-transfer.mjs");
  transfers = await dom.load("/src/transfers.ts");
  function Probe() { jobs = transfers.useTransfers(); return null; }
  await dom.render(dom.React.createElement(Probe));
});
afterEach(async () => {
  for (const job of jobs) { job.cancel(); transfers.dismiss(job.id); }
  await settle();
  native.reset();
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
