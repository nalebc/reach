import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { scriptString } from "./helpers/script-string.mjs";
import {
  findChrome,
  launchChrome,
  openTab,
} from "./helpers/headless-chrome.mjs";

// Real Chrome layout, touch and keyboard on synthetic HTTP fixtures only.
// No Reach process, host screen, providers or physical devices are involved.
const repo = fileURLToPath(new URL("..", import.meta.url));
const binary = findChrome();
test(
  "outcome sheet: five result states at phone/tablet widths, keyboard decisions and touch evidence inspection",
  { skip: !binary },
  async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-outcome-ui-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    await build({
      stdin: {
        resolveDir: repo,
        loader: "tsx",
        contents: `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { WorkflowSheet } from './src/Workflows';
import './src/styles.css';
import './src/agent-session.css';
import './src/chat-home.css';
import './src/chat-workspace.css';
import { outcomeWorkflowFixture, outcomeResultFixture, outcomeReceiptFixture, uiDigest } from './test/helpers/outcome-ui-fixture.mjs';
const root = createRoot(document.getElementById('root'));
let outcome, workflow, generation = 0;
window.sent = []; window.opened = []; window.outcomeClosed = 0;
window.untrusted = () => { window.injected = true; };
window.fetch = async (input, init = {}) => {
 const route = new URL(typeof input === 'string' ? input : input.url, location.href).pathname;
 let data;
 if (route.endsWith('/outcome/accept')) { window.sent.push(JSON.parse(init.body)); outcome = { ...outcome, version: outcome.version+1, phase: 'accepted', acceptance: { status: 'accepted', eligible: false, decision: { at: 3000, tuple: JSON.parse(init.body) } } }; data = { outcome }; }
 else if (route.endsWith('/outcome')) data = { outcome, capabilities: { executionAvailable: true, reason: '' } };
 else if (route.endsWith('/outcome-capabilities')) data = { executionAvailable: true, reason: '' };
 else if (route.endsWith('/result')) data = { result: outcomeReceiptFixture(), omittedAttempts: 0 };
 else if (route.endsWith('/models')) data = { models: [] };
 else data = workflow;
 return new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
};
window.showScenario = name => {
 outcome = outcomeResultFixture(); workflow = outcomeWorkflowFixture();
 if (name === 'failed') { outcome.phase = 'needs_owner'; outcome.acceptance.eligible = false; outcome.checks[0].status = 'failed'; outcome.checks[0].exitCode = 1; outcome.unresolved = [{ id: 'check_failed_unit', blocking: true }]; outcome.review.report = { status: 'findings', findings: [{ id: 'total', text: '<script>untrusted()</script> Incorrect total.', blocking: true }] }; }
 if (name === 'incomplete') { outcome.acceptance.eligible = false; outcome.historyIncomplete = true; outcome.truncated = true; outcome.checks[0].exitCode = null; outcome.unresolved = [{ id: 'execution_disposition_unknown', blocking: true }]; }
 if (name === 'stale') { outcome.acceptance = { status: 'stale', eligible: false, decision: { at: 1000, tuple: { resultRevision: 0 } } }; outcome.checks[0].candidateDigest = uiDigest('a'); outcome.unresolved = [{ id: 'approval_stale', blocking: true }]; }
 if (name === 'accepted') { outcome.phase = 'accepted'; outcome.acceptance = { status: 'accepted', eligible: false, decision: { at: 3000, tuple: { ...outcome } } }; }
 if (name === 'draft') { workflow.state = 'draft'; workflow.tasks = workflow.tasks.slice(0, 1).map(t => ({ ...t, state: 'waiting' })); outcome.execution = null; outcome.phase = 'draft'; outcome.resultRevision = null; outcome.acceptance.eligible = false; }
 root.render(<WorkflowSheet key={++generation} peer={{ id: 'computer', name: 'Computer', url: location.origin, token: 'fixture', platform: 'darwin' }} id={workflow.id} initial={workflow} logos={{}} onClose={() => window.outcomeClosed++} onOpenChat={c => window.opened.push(c.id)} onScreen={() => window.opened.push('screen')} onApps={() => window.opened.push('apps')} onFiles={() => window.opened.push('files')}/>);
};
window.showScenario('successful');
`,
      },
      bundle: true,
      outdir: dir,
      entryNames: "entry",
      format: "esm",
      jsx: "automatic",
      external: ["/fonts.css"],
      loader: { ".svg": "dataurl" },
      define: { "process.env.NODE_ENV": '"production"' },
      logLevel: "silent",
    });
    const server = http.createServer((req, res) => {
      if (req.url === "/favicon.ico") return res.writeHead(204).end();
      if (req.url === "/fonts.css")
        return res.writeHead(200, { "Content-Type": "text/css" }).end("");
      if (req.url === "/")
        return res.end(
          '<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/entry.css"><div id="root"></div><script type="module" src="/entry.js"></script>',
        );
      if (!["/entry.js", "/entry.css"].includes(req.url))
        return res.writeHead(404).end();
      res.setHeader(
        "Content-Type",
        req.url.endsWith(".css") ? "text/css" : "text/javascript",
      );
      res.end(fs.readFileSync(path.join(dir, req.url.slice(1))));
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    t.after(() => {
      server.closeAllConnections();
      return new Promise((resolve) => server.close(resolve));
    });
    const browser = await launchChrome(t, { binary });
    const tab = await openTab(browser);
    const wait = async (expression) => {
      const end = Date.now() + 10000;
      while (!(await tab.evaluate(expression))) {
        if (Date.now() > end)
          assert.fail(
            `Timed out: ${expression}; ${JSON.stringify(tab.problems)}; ${JSON.stringify(await tab.evaluate('({ sent: window.sent, alerts: [...document.querySelectorAll("[role=alert]")].map(e=>e.textContent), focus: document.activeElement?.outerHTML })'))}`,
          );
        await new Promise((r) => setTimeout(r, 20));
      }
    };
    const frame = () =>
      tab.evaluate(
        "new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))",
      );
    const findButton = (text) =>
      `[...document.querySelectorAll('button')].find(b => b.textContent.includes(${scriptString(text)}))`;
    const key = async (name, code, virtual) => {
      await tab.send("Input.dispatchKeyEvent", {
        type: "keyDown",
        key: name,
        code,
        windowsVirtualKeyCode: virtual,
        ...(name === "Enter" ? { text: "\r", unmodifiedText: "\r" } : {}),
      });
      await tab.send("Input.dispatchKeyEvent", {
        type: "keyUp",
        key: name,
        code,
        windowsVirtualKeyCode: virtual,
      });
      await frame();
    };
    const touch = async (expression) => {
      const point = await tab.evaluate(
        `(() => { const e = ${expression}; e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return { x: r.x + r.width/2, y: r.y + r.height/2 }; })()`,
      );
      await tab.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [point],
      });
      await tab.send("Input.dispatchTouchEvent", {
        type: "touchEnd",
        touchPoints: [],
      });
      await frame();
    };
    await tab.navigate(`http://127.0.0.1:${server.address().port}/`);
    await wait("!!document.querySelector('.wf-outcome-result')");
    for (const width of [320, 390, 768]) {
      await tab.send("Emulation.setDeviceMetricsOverride", {
        width,
        height: 844,
        deviceScaleFactor: 1,
        mobile: true,
      });
      await tab.send("Emulation.setTouchEmulationEnabled", { enabled: true });
      for (const state of [
        "successful",
        "failed",
        "incomplete",
        "stale",
        "accepted",
      ]) {
        await tab.evaluate(`window.showScenario(${scriptString(state)})`);
        await frame();
        await wait(`!!${findButton("Accept result")}`);
        const layout = await tab.evaluate(
          `(() => { const s = document.querySelector('.workflow-sheet'), o = document.querySelector('.wf-outcome'); return { overflow: s.scrollWidth > s.clientWidth + 1, inside: o.getBoundingClientRect().right <= innerWidth + 1, enabled: !(${findButton("Accept result")}).disabled, facts: document.querySelectorAll('.wf-outcome-facts > div').length }; })()`,
        );
        assert.equal(
          layout.overflow,
          false,
          `${state} at ${width}px overflows sheet`,
        );
        assert.equal(layout.inside, true);
        assert.equal(layout.enabled, state === "successful");
        assert.equal(layout.facts, 4);
      }
    }
    await tab.send("Emulation.setDeviceMetricsOverride", {
      width: 320,
      height: 720,
      deviceScaleFactor: 1,
      mobile: true,
    });
    await tab.evaluate("window.showScenario('successful')");
    await frame();
    const summary =
      "[...document.querySelectorAll('summary')].find(s => s.textContent.includes('attempt 1'))";
    await touch(summary);
    await wait("document.body.textContent.includes('+return a + b;')");
    await touch(
      "[...document.querySelectorAll('.wf-outcome [aria-label=\"Wrap lines\"]')].find(b => b.checkVisibility())",
    );
    assert.equal(
      await tab.evaluate(
        "[...document.querySelectorAll('.wf-outcome [aria-label=\"Wrap lines\"]')].find(b => b.checkVisibility()).getAttribute('aria-pressed')",
      ),
      "true",
    );
    assert.equal(
      await tab.evaluate(
        "document.querySelector('.workflow-sheet').scrollWidth <= document.querySelector('.workflow-sheet').clientWidth + 1",
      ),
      true,
    );
    assert.equal(
      await tab.evaluate(
        '!!window.injected || !!document.querySelector(".wf-outcome script, .wf-outcome iframe, .wf-outcome img")',
      ),
      false,
    );
    for (const label of [
      "Inspect in Screen",
      "Inspect in Apps",
      "Browse Files and previews",
    ])
      await touch(findButton(label));
    assert.deepEqual(await tab.evaluate("window.opened"), [
      "screen",
      "apps",
      "files",
    ]);
    // Native Tab reaches the next action; native Enter activates acceptance.
    await tab.evaluate(`(${findButton("Browse Files")}).focus()`);
    await key("Tab", "Tab", 9);
    assert.equal(
      await tab.evaluate(
        "document.activeElement.textContent.includes('Accept result')",
      ),
      true,
    );
    await key("Enter", "Enter", 13);
    await wait("document.body.textContent.includes('Accepted revision 1')");
    assert.equal(await tab.evaluate("window.sent.length"), 1);
    assert.equal(await tab.evaluate("window.sent[0].resultRevision"), 1);
    await key("Escape", "Escape", 27);
    assert.equal(await tab.evaluate("window.outcomeClosed"), 1);
    // Draft editing and the repair branch remain within a narrow viewport.
    await tab.evaluate("window.showScenario('draft')");
    await frame();
    await touch(findButton("Edit goal"));
    await wait("!!document.querySelector('.wf-outcome-editor')");
    await tab.evaluate(
      "document.querySelector('.wf-outcome-editor textarea').focus(); document.querySelector('.wf-outcome-editor textarea').select()",
    );
    await tab.send("Input.insertText", {
      text: "Restore the synthetic total.",
    });
    await frame();
    assert.equal(
      await tab.evaluate(
        "document.querySelector('.wf-outcome-editor textarea').value",
      ),
      "Restore the synthetic total.",
    );
    await touch(
      "[...document.querySelectorAll('.wf-outcome-editor label')].find(l => l.textContent.includes('Preapprove one repair')).querySelector('input')",
    );
    assert.equal(
      await tab.evaluate(
        "document.querySelector('.wf-outcome-editor').textContent.includes('2 builds, 3 checks including baseline, 2 reviews')",
      ),
      true,
    );
    assert.equal(
      await tab.evaluate(
        "document.querySelector('.workflow-sheet').scrollWidth <= document.querySelector('.workflow-sheet').clientWidth + 1",
      ),
      true,
    );
    assert.deepEqual(tab.problems, []);
    await browser.close();
  },
);
