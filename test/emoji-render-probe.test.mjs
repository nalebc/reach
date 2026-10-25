import test from "node:test";
import { findChrome, launchChrome, openTab } from "./helpers/headless-chrome.mjs";

// Validation-only probe (not part of the suite): how long a fresh computer's
// Chrome takes to show each character the screen-control journey types,
// to test whether its first emoji costs the page seconds (a cold font).
const PAGE = `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><meta name=viewport content="width=device-width">
<input id=f style="font:16px system-ui;width:90%" autofocus><script>
window.__tasks = []; window.__frames = [];
new PerformanceObserver(l => { for (const e of l.getEntries()) __tasks.push({ start: Math.round(e.startTime), duration: Math.round(e.duration), name: e.name }); }).observe({ type: "longtask", buffered: true });
try { new PerformanceObserver(l => { for (const e of l.getEntries()) __frames.push({ start: Math.round(e.startTime), duration: Math.round(e.duration), blocking: Math.round(e.blockingDuration),
  renderAt: Math.round(e.renderStart - e.startTime), styleLayoutAt: Math.round(e.styleAndLayoutStart - e.startTime),
  scripts: e.scripts.map(s => ({ invokerType: s.invokerType, invoker: s.invoker, fn: s.sourceFunctionName, duration: Math.round(s.duration), forcedLayout: Math.round(s.forcedStyleAndLayoutDuration) })) }); }).observe({ type: "long-animation-frame", buffered: true }); } catch (e) { __frames.push({ error: String(e) }); }
</script>`)}`;
const TEXT = [..."hello worLD café naïve ü – “ok” ’ 😀 ✓ ", "😀", "🎉", " ", "😀"];

async function round(t, label) {
  const browser = await launchChrome(t, {});
  for (const tabRun of [1, 2]) {
    const tab = await openTab(browser);
    await tab.navigate(PAGE);
    await tab.evaluate("document.getElementById('f').focus(), true");
    const times = [];
    for (const ch of TEXT) {
      const started = performance.now();
      await tab.send("Input.insertText", { text: ch });
      await tab.evaluate("new Promise(r => requestAnimationFrame(() => setTimeout(() => r(true))))");
      times.push([ch, Math.round(performance.now() - started)]);
    }
    const slow = times.filter(([, ms]) => ms >= 100);
    const seen = await tab.evaluate("JSON.stringify({ value: document.getElementById('f').value, tasks: __tasks, frames: __frames.filter(f => f.error || f.duration >= 200) })");
    console.log(`EMOJI-PROBE ${JSON.stringify({ platform: process.platform, label, tab: tabRun, slow, total: times.reduce((s, [, ms]) => s + ms, 0), times, page: JSON.parse(seen) })}`);
  }
}

test("probe: time to show each typed character on this computer's Chrome", { skip: !findChrome() && "needs Chrome", timeout: 170000 }, async (t) => {
  await round(t, "first browser");
  await round(t, "second browser");
});
