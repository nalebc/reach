import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { once } from "node:events";
import { JSDOM } from "jsdom";
import { benchmarkBrowserWorkflow, summarize } from "../scripts/benchmark-browser-workflow.mjs";

function fixture(t, { loseSearchReply = false, expectedBrowser = "Safari", preconnect = false } = {}) {
  const tabs = new Map(), modes = [], actions = [], sockets = [];
  let id = 0;
  t.after(() => { for (const socket of sockets) socket.destroy(); for (const tab of tabs.values()) tab.dom.window.close(); });
  return { tabs, modes, actions, sockets, driverFactory: ({ persistent }) => {
    modes.push(persistent);
    return {
      close() {},
      async transport(browser, request) {
        assert.equal(browser, expectedBrowser);
        if (request.op === "preflight") return { ok: true };
        if (request.op === "create") {
          assert.equal(new URL(request.url).hostname, "127.0.0.1");
          if (preconnect && !sockets.length) {
            const socket = net.createConnection({ host: "127.0.0.1", port: Number(new URL(request.url).port) });
            sockets.push(socket);
            await once(socket, "connect");
          }
          const response = await fetch(request.url);
          assert.equal(response.status, 200);
          assert.match(response.headers.get("content-security-policy"), /connect-src 'none'/);
          const dom = new JSDOM(await response.text(), { url: request.url, runScripts: "dangerously" });
          const tab = { window: 1, tab: ++id, url: request.url, dom };
          tabs.set(tab.tab, tab);
          return { window: tab.window, tab: tab.tab, url: tab.url };
        }
        const tab = tabs.get(request.target.tab);
        assert.ok(tab);
        if (request.expectedURL) assert.equal(request.expectedURL, tab.url);
        if (request.op === "info" || request.op === "focus") return { window: 1, tab: tab.tab, url: tab.url };
        if (request.op === "close") { tab.dom.window.close(); tabs.delete(tab.tab); return {}; }
        assert.equal(request.op, "evaluate");
        const result = JSON.parse(tab.dom.window.eval(request.source));
        if (request.source.includes(".click()")) actions.push(request.source);
        if (loseSearchReply && request.source.includes("#find")) throw Object.assign(Error("Response lost after search"), { uncertain: true });
        return result;
      },
    };
  } };
}

for (const browser of ["Safari", "Chrome"]) test(`${browser} workflow compares identical page operations and removes its test tabs`, async t => {
  const f = fixture(t, { expectedBrowser: browser });
  const result = await benchmarkBrowserWorkflow({ browser, rounds: 1, driverFactory: f.driverFactory });
  assert.deepEqual(f.modes, [false, true]);
  assert.equal(result.summary.cold.runs, 1);
  assert.equal(result.summary.warm.runs, 1);
  assert.deepEqual(result.samples.cold[0].steps.map(step => step.name), result.samples.warm[0].steps.map(step => step.name));
  assert.equal(f.actions.length, 4);
  assert.equal(f.tabs.size, 0);
  assert.deepEqual(result.cleanupWarnings, []);
  assert.match(result.note, /Not an end-to-end agent benchmark/);
});

test("cleanup completes when Chrome preconnects without sending a request", { timeout: 3000 }, async t => {
  const f = fixture(t, { expectedBrowser: "Chrome", preconnect: true });
  const result = await benchmarkBrowserWorkflow({ browser: "Chrome", rounds: 1, driverFactory: f.driverFactory });
  assert.equal(result.summary.warm.runs, 1);
  assert.equal(f.tabs.size, 0);
  assert.equal(f.sockets.length, 1);
  if (!f.sockets[0].destroyed) await once(f.sockets[0], "close");
  assert.equal(f.sockets[0].destroyed, true);
});

test("a lost effect response stops the benchmark without replay and still cleans up", async t => {
  const f = fixture(t, { loseSearchReply: true });
  await assert.rejects(benchmarkBrowserWorkflow({ browser: "Safari", rounds: 1, driverFactory: f.driverFactory }), /Response lost/);
  assert.equal(f.actions.length, 1);
  assert.equal(f.tabs.size, 0);
});

test("benchmark summaries handle even samples and reject invalid run choices before opening anything", async () => {
  assert.deepEqual(summarize([{ totalMs: 10, calls: 2 }, { totalMs: 30, calls: 4 }]), { runs: 2, medianMs: 20, minMs: 10, maxMs: 30, meanCalls: 3 });
  await assert.rejects(benchmarkBrowserWorkflow({ rounds: 100, driverFactory: () => assert.fail("No browser should be touched") }), /1 to 10/);
});
