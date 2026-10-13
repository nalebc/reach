#!/usr/bin/env node
// Catalog/observation sizes, plus optional native transport overhead. The
// native probe uses an INVALID browser name and never opens or scripts apps.
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { toolsFor } from "./mcp-server.mjs";
import { presetScopes } from "../server/agent-presets.mjs";
import { compactTools } from "../server/browser-tools.mjs";
import { PREBUILT_TOOLS } from "../server/prebuilt-tools.mjs";
import { createObservations } from "../server/desktop-observation.mjs";
import { BrowserWorker } from "../server/browser-worker.mjs";
import { nativeToolProcess } from "../server/tool-browser-driver.mjs";

const bytes = value => Buffer.byteLength(JSON.stringify(value));
const access = { preset: "full", screen: true, control: true, open: true, shell: true, write: true, roots: [{ index: 0 }], terminals: [],
  browserTools: { browsers: ["Chrome", "Safari"], tools: PREBUILT_TOOLS } };
const full = toolsFor(presetScopes(access), access), compact = compactTools(full);
const observe = createObservations(), client = { id: "benchmark", policy: access, scopes: presetScopes(access) };
const screen = { snapshot: "first", app: "Fixture", title: "Invoices", items: Array.from({ length: 200 }, (_, i) => ({ n: i + 1, ref: `e-${i}`, role: "Button", name: `Invoice ${i}`, context: `Row ${i}`, x: 0, y: i / 200, w: .1, h: .005 })), texts: [] };
const whole = observe(client, screen);
const scoped = observe(client, screen, { query: "Invoice 199", maxChars: 2000 });
const delta = observe(client, { ...screen, snapshot: "second", items: screen.items.map((item, i) => i === 199 ? { ...item, name: "Invoice 199 opened" } : item) }, { sinceSnapshot: "first" });
const result = { kind: "agent-navigation-overhead", catalog: { fullTools: full.length, compactTools: compact.length, fullBytes: bytes(full), compactBytes: bytes(compact) },
  observationTextBytes: { full: Buffer.byteLength(whole.text), scoped: Buffer.byteLength(scoped.text), delta: Buffer.byteLength(delta.text) },
  note: "Synthetic catalog and screen. Native probe measures transport only; no page loads, model latency, screen reads or real input." };
if (process.argv.includes("--native-worker")) {
  if (process.platform !== "darwin") throw Error("Native transport benchmark requires macOS.");
  const script = fileURLToPath(new URL("native/tool-browser.js", import.meta.url));
  const input = JSON.stringify({ browser: "invalid-benchmark", op: "tabs" });
  const worker = new BrowserWorker("/usr/bin/osascript", ["-l", "JavaScript", script, "--worker"]);
  const measure = async run => {
    const times = [];
    for (let i = 0; i < 8; i++) {
      const start = performance.now(), value = JSON.parse(await run());
      if (value.code !== "invalid") throw Error("Unexpected benchmark response");
      times.push(performance.now() - start);
    }
    times.sort((a, b) => a - b);
    return { p50Ms: Math.round(times[4] * 100) / 100, p95Ms: Math.round(times[7] * 100) / 100 };
  };
  try {
    const start = performance.now();
    await worker.request(input);
    result.workerStartupMs = Math.round(performance.now() - start);
    result.coldProcess = await measure(() => nativeToolProcess("/usr/bin/osascript", ["-l", "JavaScript", script], input));
    result.warmWorker = await measure(() => worker.request(input));
  } finally { worker.stop(); await worker.terminated; }
}
console.log(JSON.stringify(result, null, 2));
