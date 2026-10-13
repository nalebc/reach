#!/usr/bin/env node
// Controlled workflows in the owner's installed browser. Nothing is sent to
// an external site: pages and form data live on a temporary loopback server.
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { createToolBrowserDriver } from "../server/tool-browser-driver.mjs";

export function fixturePage(nonce, page) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Navigation Test ${page}</title>
<style>body{font:18px system-ui;max-width:700px;margin:60px auto}label,input,button{margin:12px;padding:10px}section{border:1px solid #aaa;padding:20px}output{display:block;padding:20px}</style></head>
<body data-benchmark="${nonce}" data-page="${page}"><h1>Navigation test: ${page}</h1>
<p>This temporary page measures browser navigation and test form entry.</p>
<label>Search <input id="search" aria-label="Search"></label><button id="find">Search</button>
<section id="results" aria-live="polite">No search yet</section>
<form id="form"><label>Test note <input id="note" aria-label="Test note"></label><button id="save">Save test note</button></form>
<output id="saved" aria-live="polite"></output>
<script>
document.querySelector('#find').onclick=()=>{document.querySelector('#results').textContent='Loading';setTimeout(()=>{document.querySelector('#results').textContent='Result: '+document.querySelector('#search').value},180)};
document.querySelector('#form').onsubmit=e=>{e.preventDefault();document.querySelector('#saved').textContent='Saved: '+document.querySelector('#note').value};
document.body.dataset.ready='true';
</script></body></html>`;
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const round = value => Math.round(value * 100) / 100;
export const summarize = samples => {
  const times = samples.map(sample => sample.totalMs).sort((a, b) => a - b);
  return { runs: samples.length, medianMs: times.length ? round((times[Math.floor((times.length - 1) / 2)] + times[Math.floor(times.length / 2)]) / 2) : null,
    minMs: times.length ? round(times[0]) : null, maxMs: times.length ? round(times.at(-1)) : null,
    meanCalls: samples.length ? round(samples.reduce((sum, item) => sum + item.calls, 0) / samples.length) : null };
};

export async function benchmarkBrowserWorkflow({ browser = "Chrome", rounds = 3, driverFactory = createToolBrowserDriver, progress = () => {}, signal } = {}) {
  if (!["Chrome", "Safari"].includes(browser)) throw Error("Choose Chrome or Safari.");
  if (!Number.isInteger(rounds) || rounds < 1 || rounds > 10) throw Error("Choose 1 to 10 rounds.");
  signal?.throwIfAborted();
  const nonce = crypto.randomUUID(), basePath = `/navigation-test-${nonce}/`;
  // Carry the locally generated nonce as encoded data, not JS string syntax.
  const encodedNonce = Buffer.from(nonce, "utf8").toString("base64");
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (req.method !== "GET" || ![basePath + "one", basePath + "two"].includes(url.pathname)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; form-action 'none'; connect-src 'none'" });
    res.end(fixturePage(nonce, url.pathname.endsWith("one") ? "one" : "two"));
  });
  // Chrome can preconnect without sending an HTTP request. Such sockets can
  // outlive all test tabs and keep server.close() waiting indefinitely.
  const connections = new Set();
  server.on("connection", socket => {
    connections.add(socket);
    socket.once("close", () => connections.delete(socket));
  });
  const drivers = { cold: driverFactory({ persistent: false }), warm: driverFactory({ persistent: true }) };
  const cleanupWarnings = [], samples = { cold: [], warm: [] };
  const targets = new Map();
  try {
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const base = `http://127.0.0.1:${server.address().port}${basePath}`;
    const options = { timeoutMs: 12000, signal };
    // The production preflight scripts only its own nonce-addressed blank tab.
    await drivers.warm.transport(browser, { op: "preflight", probeId: nonce, background: true }, options);
    for (let index = 0; index < rounds; index++) {
      for (const mode of index % 2 ? ["warm", "cold"] : ["cold", "warm"]) {
        progress(`${browser}: ${mode} workflow ${index + 1}/${rounds}`);
        const driver = drivers[mode], steps = [];
        let calls = 0;
        const call = async request => { signal?.throwIfAborted(); calls++; return driver.transport(browser, request, options); };
        const timed = async (name, work) => { const start = performance.now(); const value = await work(); steps.push({ name, ms: round(performance.now() - start) }); return value; };
        const evaluate = (target, code) => call({ op: "evaluate", target, expectedURL: target.url,
          source: `JSON.stringify((()=>{if(document.body?.dataset.benchmark!==atob("${encodedNonce}"))return {ready:false};${code}})())` });
        const until = async (target, code) => {
          const end = performance.now() + 8000;
          for (;;) {
            const result = await evaluate(target, code);
            if (result?.ready) return result;
            if (performance.now() >= end) throw Error("The test page did not become ready; no action was replayed.");
            await delay(40);
          }
        };
        const created = async url => {
          const target = await call({ op: "create", url, background: true });
          // Use the requested address even if the creation reply is still blank.
          target.url = url; targets.set(`${target.window}:${target.tab}`, target);
          return target;
        };
        const ready = async target => {
          const deadline = performance.now() + 8000;
          for (;;) {
            const live = await call({ op: "info", target });
            if (live.url === target.url) break;
            if (live.url && live.url !== "about:blank") throw Error("The test tab navigated elsewhere. It was left untouched.");
            if (performance.now() >= deadline) throw Error("The test tab did not load.");
            await delay(40);
          }
          return until(target, "return {ready:document.body.dataset.ready==='true'};");
        };
        const start = performance.now();
        const first = await timed("open_and_ready", async () => {
          const target = await created(`${base}one?run=${mode}-${index}`);
          await ready(target); return target;
        });
        await timed("search_and_wait", async () => {
          const result = await evaluate(first, "document.querySelector('#search').value='Invoice 42';document.querySelector('#find').click();return {ready:true};");
          if (!result.ready) throw Error("The test page changed before search.");
          await until(first, "return {ready:document.querySelector('#results').textContent==='Result: Invoice 42'};");
        });
        const second = await timed("open_second_tab", async () => { const target = await created(`${base}two?run=${mode}-${index}`); await ready(target); return target; });
        await timed("switch_tab_and_fill", async () => {
          await call({ op: "focus", target: second, expectedURL: second.url });
          const result = await evaluate(second, "document.querySelector('#note').value='Benchmark note';document.querySelector('#save').click();return {ready:document.querySelector('#saved').textContent==='Saved: Benchmark note'};");
          if (!result.ready) throw Error("The test form was not saved.");
        });
        await timed("switch_back_and_verify", async () => {
          await call({ op: "focus", target: first, expectedURL: first.url });
          const result = await evaluate(first, "return {ready:document.querySelector('#results').textContent==='Result: Invoice 42'};");
          if (!result.ready) throw Error("The first tab lost its test result.");
        });
        samples[mode].push({ totalMs: round(performance.now() - start), calls, steps });
        // Reverse order is necessary for Safari's positional tab references.
        for (const target of [second, first]) {
          await driver.transport(browser, { op: "close", target, expectedURL: target.url }, options);
          targets.delete(`${target.window}:${target.tab}`);
        }
      }
    }
    const summary = { cold: summarize(samples.cold), warm: summarize(samples.warm) };
    return { kind: "real-browser-scripted-workflow", browser, rounds, summary,
      medianReductionPercent: summary.cold.medianMs ? round(100 * (1 - summary.warm.medianMs / summary.cold.medianMs)) : null,
      samples, cleanupWarnings,
      note: "Same local test pages and operations through Reach's production browser transport. Cold starts one helper per call; warm reuses it after preflight. Includes page loads, polling, tab selection and test form actions. Excludes MCP transport, model reasoning, accessibility input and external websites. Not an end-to-end agent benchmark." };
  } finally {
    // A changed address belongs to the owner now: the native expectedURL
    // check prevents cleanup from closing it. No mutation is retried.
    for (const target of [...targets.values()].reverse()) {
      try { await drivers.warm.transport(browser, { op: "close", target, expectedURL: target.url }, { timeoutMs: 5000 }); }
      catch { cleanupWarnings.push("A test tab changed or could not be closed; it was left open."); }
    }
    for (const driver of Object.values(drivers)) driver.close();
    await new Promise(resolve => {
      server.close(resolve);
      for (const socket of connections) socket.destroy();
    });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") {
    console.log("Usage: node scripts/benchmark-browser-workflow.mjs --browser Chrome|Safari [--rounds 3] [--output result.json]\nUses temporary local test tabs in an already-open browser profile. Does not contact external websites.");
    process.exit(0);
  }
  const value = (name, fallback) => { const at = args.indexOf(name); return at < 0 ? fallback : args[at + 1]; };
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once("SIGINT", cancel); process.once("SIGTERM", cancel);
  try {
    for (let i = 0; i < args.length; i += 2) if (!["--browser", "--rounds", "--output"].includes(args[i]) || !args[i + 1] || args[i + 1].startsWith("--")) throw Error("Use --help for benchmark options.");
    const result = await benchmarkBrowserWorkflow({ browser: value("--browser", "Chrome"), rounds: Number(value("--rounds", "3")), progress: text => process.stderr.write(text + "\n"), signal: controller.signal });
    const text = JSON.stringify(result, null, 2) + "\n", output = value("--output");
    if (output) await fs.writeFile(output, text, { mode: 0o600 });
    process.stdout.write(text);
  } catch (error) {
    process.stderr.write(JSON.stringify({ error: error.message, code: error.code, uncertain: error.uncertain === true }) + "\n");
    process.exitCode = 1;
  } finally { process.removeListener("SIGINT", cancel); process.removeListener("SIGTERM", cancel); }
}
