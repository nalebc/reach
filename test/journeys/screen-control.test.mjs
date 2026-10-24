import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { startComputer, phone, skip, needsDesktop, macInUse, markInput, desktopTurn, windows } from "../helpers/journey.mjs";
import { recorder, rawTerminal } from "../helpers/input-recorder.mjs";
import { SCREEN_CONTROL_DIAGNOSTICS } from "../helpers/screen-control-diagnostics.mjs";

// Screen control, hard: many taps, double-taps, holds, drags, scrolls and
// typing through Reach's live screen into windows on this Mac, each checked
// against what the Mac itself received (test/fixtures/mac/input-recorder.swift
// and a real Terminal window reading raw bytes). Every scenario runs and is
// reported (reports/journeys/screen-control-report.json); the test fails
// at the end with all of them, not at the first.
//
// The phone is headless Chrome as an iPhone (touch, its size). Safari's
// keyboard rule, that a field's focus opens the keyboard only inside a
// trusted touch-end or click, is checked by recording where each focus()
// of the typing field happened.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Long and it takes this computer's desktop: only when asked (on Windows,
// the real-desktop runs that list this file).
const stress = process.env.REACH_TEST_SCREEN_STRESS === "1" || (windows && process.env.REACH_TEST_WINDOWS_DESKTOP === "1") ? false : "set REACH_TEST_SCREEN_STRESS=1";
const KINDS = (process.env.REACH_TEST_SCREEN_PHONES || (windows ? "iPhone" : "iPhone Android iPad")).split(/\s+/).filter(Boolean);
const ROUNDS = Number(process.env.REACH_TEST_SCREEN_ROUNDS || (windows ? 1 : 3));

const TRACE = `(() => {
  if (window.__sc) return;
  const log = (window.__sc = []);
  const now = () => Math.round(performance.now());
  const diagnostics = window.__scDiagnostics = ${SCREEN_CONTROL_DIAGNOSTICS};
  const sockets = new WeakMap();
  let nextSocket = 0;
  const socketId = (ws) => {
    if (!sockets.has(ws)) sockets.set(ws, ++nextSocket);
    return sockets.get(ws);
  };
  const record = (ws, value) => diagnostics.record({ t: now(), socket: socketId(ws), ...value });
  const P = WebSocket.prototype;
  const input = (ws) => /screen-input/.test(ws.url || "");
  const send = P.send;
  P.send = function (data) {
    if (input(this)) {
      try {
        const m = JSON.parse(data);
        record(this, { dir: "out", m });
        if (m.type !== "auth" && m.action?.type !== "heartbeat") log.push({ t: now(), dir: "out", m });
      } catch {}
    }
    return send.call(this, data);
  };
  for (const name of ["onmessage", "onclose", "onopen", "onerror"]) {
    const d = Object.getOwnPropertyDescriptor(P, name);
    Object.defineProperty(P, name, {
      configurable: true,
      enumerable: true,
      get() { return d.get.call(this); },
      set(fn) {
        const ws = this;
        d.set.call(this, typeof fn !== "function" ? fn : function (e) {
          if (input(ws)) {
            if (name === "onmessage") {
              try {
                const m = JSON.parse(e.data);
                record(ws, { dir: "in", m });
                if (!(m.type === "ack" && m.id && heartbeats.has(m.id))) log.push({ t: now(), dir: "in", m: m.type === "fields" ? { type: "fields", n: m.fields.length, after: m.after } : m });
              } catch {}
            } else {
              record(ws, { dir: name.slice(2), code: e.code, reason: e.reason });
              log.push({ t: now(), dir: name.slice(2), code: e.code, reason: e.reason });
            }
          }
          return fn.call(this, e);
        });
      },
    });
  }
  const heartbeats = new Set();
  const send2 = P.send;
  P.send = function (data) {
    try { const m = JSON.parse(data); if (m.action?.type === "heartbeat") heartbeats.add(m.id); } catch {}
    return send2.call(this, data);
  };
  const focus = HTMLElement.prototype.focus;
  HTMLElement.prototype.focus = function (...a) {
    const e = window.event;
    if (this.tagName === "TEXTAREA" || this.tagName === "INPUT")
      log.push({ t: now(), dir: "focus", el: this.tagName + "." + String(this.className || ""), ev: e ? e.type : null, trusted: e ? e.isTrusted : null });
    return focus.apply(this, a);
  };
  for (const type of ["touchstart", "touchend", "click"])
    addEventListener(type, (e) => log.push({ t: now(), dir: "ev", type, trusted: e.isTrusted }), true);
})()`;

const place = (at) => `(() => {
  const c = document.querySelector("canvas.remote-canvas");
  if (!c || c.width <= 300 || getComputedStyle(c).visibility !== "visible") return null;
  const box = c.getBoundingClientRect();
  return { x: box.left + ${at.x} * box.width, y: box.top + ${at.y} * box.height };
})()`;

async function stressRun(t, kind) {
  {
    const report = { scenarios: [], problems: [] };
    const problem = (scenario, what, detail = {}) => {
      report.problems.push({ scenario, what, ...detail });
      console.log(`PROBLEM [${scenario}] ${what} ${JSON.stringify(detail)}`);
    };
    const computer = await startComputer(t);
    const dir = fs.mkdtempSync(path.join(computer.reach.temp, "control-"));
    const rec = await recorder(t, dir);
    // Where this test may tap, and the window its typing must go to: its
    // own, never anything else on a Mac someone owns (Oct 18: a tap meant
    // to step away from the test's terminal hit the Dock, and the typing
    // that followed went into the owner's app).
    let zone = (at) => rec.contains(at);
    let front = () => rec.front();
    const page = await phone(t, computer, { kind });
    const tab = page.tab;
    // From the page's start: the input socket's frames and every focus.
    await tab.send("Page.addScriptToEvaluateOnNewDocument", { source: TRACE });
    await page.skipIntro();
    await page.open("/");
    await page.see(() => document.querySelector("nav.mobile-nav"), "the app again after reload", 60000);
    assert.ok(await page.evaluate("Array.isArray(window.__sc)"), "the trace is in");
    await page.tap(`nav.mobile-nav button[aria-label="Screen"]`, "Screen in the bottom bar");
    await page.see({ js: place({ x: 0.5, y: 0.5 }) }, "the live screen", 120000);
    await page.tap(`[aria-label="Screen controls"] button[aria-label="Control"]`, "Control");
    await page.see(() => document.querySelector('[aria-label="Screen controls"] button[aria-pressed="true"]'), "control on", 30000);
    await page.see(() => !/Connecting controls|View only/.test(document.querySelector(".simple-screen-caption")?.innerText || ""), "controls connected", 30000);
    await sleep(1500);

    const trace = () => page.evaluate("window.__sc.splice(0)");
    // A separate bounded, sanitized trace survives the detailed trace's
    // scenario-local drains. Keep the error before a retryable close, the
    // socket it belongs to, and heartbeat timing in the archived report.
    const recordScenario = async (detail) => report.scenarios.push({
      ...detail,
      protocol: await page.evaluate("window.__scDiagnostics.drain()"),
    });
    // Every point on the picture this test touches: inside its own window,
    // and only while nobody is at the Mac.
    const where = async (at) => {
      guard();
      if (!zone(at)) throw new Error(`Refusing to touch outside the test's own windows: ${JSON.stringify(at)}`);
      const p = await page.evaluate(place(at));
      assert.ok(p, "the live picture");
      return p;
    };
    const touchDown = (x, y) => {
      guard();
      return tab.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
    };
    const touchUp = () => tab.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    // Someone at the Mac: stop, nothing more is sent.
    const guard = () => {
      const busy = macInUse();
      if (busy) throw new Error(`Stopped, nothing more sent: ${busy}`);
    };
    let checkedFront = 0;
    // Each keystroke: nobody at the Mac, and the test's window in front.
    const typeSend = async (method, params) => {
      guard();
      if (Date.now() - checkedFront > 1500) {
        if (!(await front())) throw new Error("The test's own window isn't in front: stopped, nothing typed.");
        checkedFront = Date.now();
      }
      if (method) await tab.send(method, params);
    };
    // A person's tap: down, about 90 ms, up.
    const tapAt = async (at, hold = 90) => {
      guard();
      if (!zone(at)) throw new Error(`Refusing to tap outside the test's own windows: ${JSON.stringify(at)}`);
      checkedFront = 0;
      const p = await where(at);
      await touchDown(p.x, p.y);
      await sleep(hold);
      await touchUp();
      markInput();
      return p;
    };
    const typing = () => page.evaluate(`(() => {
      const a = document.activeElement;
      return { focused: !!a && (a.tagName === "TEXTAREA" || a.tagName === "INPUT") && !!a.closest(".simple-screen, .screen-viewer"),
        viewer: !!document.querySelector(".screen-typing"), tapToType: !!document.querySelector(".tap-to-type"),
        caption: document.querySelector(".simple-screen-caption")?.innerText || "", feedback: document.querySelector(".screen-feedback, .screen-gesture-feedback")?.innerText || "" };
    })()`);
    // The bar's keyboard button, as a person opens the keyboard when a tap didn't.
    const keyboardButton = async () => {
      const b = await page.evaluate(`(() => { const b = document.querySelector('.tap-to-type') || document.querySelector('[aria-label="Screen controls"] button[aria-label="Open phone keyboard"]'); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
      if (!b) return false;
      await touchDown(b.x, b.y);
      await sleep(80);
      await touchUp();
      await sleep(700);
      return (await typing()).focused;
    };
    const status = () => page.evaluate(`(() => ({
      control: !!document.querySelector('[aria-label="Screen controls"] button[aria-pressed="true"]'),
      caption: document.querySelector(".simple-screen-caption")?.innerText || "",
      shown: [...document.querySelectorAll(".screen-feedback, .screen-gesture-feedback, .screen-error, [role=alert], .toast")].map((e) => e.innerText).filter(Boolean).join(" | ").slice(0, 300),
    }))()`);
    const ensureControl = async (scenario) => {
      const s = await status();
      if (s.control && !/View only|Connecting|Reconnecting/.test(s.caption)) return;
      problem(scenario, "control was off before the scenario (turning it back on)", s);
      const b = await page.evaluate(`(() => { const b = document.querySelector('[aria-label="Screen controls"] button[aria-label="Control"]'); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
      if (b) {
        await touchDown(b.x, b.y);
        await sleep(80);
        await touchUp();
      }
      await page.see(() => !/Connecting controls|View only/.test(document.querySelector(".simple-screen-caption")?.innerText || "") && document.querySelector('[aria-label="Screen controls"] button[aria-pressed="true"]'), "controls connected again", 30000);
      await sleep(800);
    };
    const until = async (check, ms) => {
      const end = Date.now() + ms;
      let last;
      while (Date.now() < end) {
        last = await check();
        if (last?.ok) return last;
        await sleep(50);
      }
      return last;
    };
    const keyboardClosed = async () => {
      // Tap a grid cell far from the fields: an ordinary tap dismisses typing.
      await tapAt(rec.share(rec.regions.cell3, 0.8, 0.5));
      await sleep(700);
    };
    const keyFor = (k) => ({
      Enter: { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" },
      Backspace: { key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 },
    })[k];
    const pressKey = async (k) => {
      await typeSend("Input.dispatchKeyEvent", { type: "keyDown", ...keyFor(k) });
      await tab.send("Input.dispatchKeyEvent", { type: "keyUp", ...keyFor(k), text: undefined });
    };
    const ackStats = (log) => {
      const sent = new Map();
      const out = {};
      for (const e of log) {
        if (e.dir === "out" && e.m?.type === "input") sent.set(e.m.id, { type: e.m.action.type, t: e.t });
        if (e.dir === "in" && e.m?.type === "ack" && sent.has(e.m.id)) {
          const s = sent.get(e.m.id);
          (out[s.type] ||= []).push(e.t - s.t);
        }
      }
      return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, { n: v.length, max: Math.max(...v), median: v.sort((a, b) => a - b)[v.length >> 1] }]));
    };

    // 1. Tap accuracy: each cell's middle and near its corners, one click each.
    {
      const name = "tap accuracy";
      await ensureControl(name);
      const results = [];
      await trace();
      for (let round = 0; round < ROUNDS; round++) {
        for (let i = 0; i < 8; i++) {
          for (const [fx, fy] of [[0.5, 0.5], [0.12, 0.15], [0.88, 0.85]]) {
            const before = rec.events().length;
            await tapAt(rec.share(rec.regions[`cell${i}`], fx, fy));
            const got = await until(async () => {
              const ev = rec.events().slice(before);
              const downs = ev.filter((e) => e.kind === "down");
              return { ok: downs.length >= 1 && ev.some((e) => e.kind === "up"), ev, downs };
            }, 3000);
            await sleep(250);
            const ev = rec.events().slice(before);
            const downs = ev.filter((e) => e.kind === "down");
            const r = rec.regions[`cell${i}`];
            const expect = { x: r.width * fx, y: r.height * fy };
            const d = downs[0];
            const entry = { cell: i, fx, fy, downs: downs.length, landed: d?.cell, count: d?.count, dx: d ? Math.round(d.x - expect.x) : null, dy: d ? Math.round(d.y - expect.y) : null };
            results.push(entry);
            if (!got?.ok) problem(name, "tap never reached the Mac", { ...entry, macGot: ev.map((e) => e.kind === "mouse" ? `mouse${e.type}@${Math.round(e.x)},${Math.round(e.y)}x${e.count}` : e.kind).slice(0, 6), phone: await status() });
            else if (downs.length !== 1) problem(name, "tap delivered a different number of clicks", entry);
            else if (d.cell !== i) problem(name, "tap landed in the wrong cell", entry);
            else if (d.count !== 1) problem(name, "single tap arrived with a click count", entry);
            else if (Math.hypot(entry.dx, entry.dy) > 12) problem(name, "tap landed more than 12 points away", entry);
            await sleep(450);
          }
        }
      }
      const errs = results.filter((r) => r.dx !== null).map((r) => Math.hypot(r.dx, r.dy));
      await recordScenario({ name, taps: results.length, maxError: Math.max(...errs), meanError: errs.reduce((a, b) => a + b, 0) / errs.length, acks: ackStats(await trace()) });
    }

    // 2. Fast taps across cells, 150 ms apart.
    {
      const name = "fast taps";
      await ensureControl(name);
      const before = rec.events().length;
      const order = [0, 5, 2, 7, 1, 4, 3, 6, 0, 7];
      for (const i of order) {
        await tapAt(rec.share(rec.regions[`cell${i}`]), 60);
        await sleep(150);
      }
      await sleep(2500);
      const downs = rec.events().slice(before).filter((e) => e.kind === "down");
      const landed = downs.map((d) => d.cell);
      if (JSON.stringify(landed) !== JSON.stringify(order)) problem(name, "fast taps landed differently", { expected: order, landed, counts: downs.map((d) => d.count) });
      if (downs.some((d) => d.count !== 1)) problem(name, "fast taps on different cells became multi-clicks", { counts: downs.map((d) => d.count) });
      await recordScenario({ name, expected: order, landed, acks: ackStats(await trace()) });
    }

    // 3. Double-tap a word: one double-click selecting it.
    {
      const name = "double-tap word";
      await ensureControl(name);
      const outcomes = [];
      for (let round = 0; round < ROUNDS; round++) {
        await keyboardClosed();
        const before = rec.events().length;
        // "charlie" sits about a third of the way along the first line.
        const at = rec.share(rec.regions.text, 0.3, 0.12);
        await tapAt(at, 70);
        await sleep(120);
        await tapAt(at, 70);
        await sleep(1500);
        const ev = rec.events().slice(before);
        const downs = ev.filter((e) => e.kind === "mouse" && e.type === 1).map((e) => e.count);
        const selection = ev.filter((e) => e.kind === "selection").at(-1);
        outcomes.push({ downs, selected: selection?.selected });
        if (JSON.stringify(downs) !== "[1,2]") problem(name, "double-tap didn't arrive as click then double-click", { round, downs });
        if (!selection || !/^\w+ ?$/.test(selection.selected || "") || selection.length === 0) problem(name, "double-tap didn't select a word", { round, selection });
      }
      await recordScenario({ name, outcomes, acks: ackStats(await trace()) });
    }

    // 3b. A real finger's double-tap: the second tap a few pixels from the
    // first (no finger lands twice on the same pixel).
    {
      const name = "double-tap with finger drift";
      await ensureControl(name);
      const outcomes = [];
      for (const drift of [0, 1, 2, 3, 5, 7]) {
        await keyboardClosed();
        await trace();
        const before = rec.events().length;
        const p = await where(rec.share(rec.regions.text, 0.3, 0.12));
        await touchDown(p.x, p.y);
        await sleep(60);
        await touchUp();
        await sleep(110);
        await touchDown(p.x + drift, p.y + drift / 2);
        await sleep(60);
        await touchUp();
        markInput();
        await sleep(1500);
        const ev = rec.events().slice(before);
        const downs = ev.filter((e) => e.kind === "mouse" && e.type === 1).map((e) => e.count);
        const selected = ev.filter((e) => e.kind === "selection").at(-1)?.selected;
        // What the phone asked for and what the computer did with it.
        const log = await trace();
        const clicks = log.filter((e) => e.dir === "out" && e.m?.action?.type === "click").map((e) => {
          const ack = log.find((a) => a.dir === "in" && a.m?.type === "ack" && a.m.id === e.m.id)?.m;
          return { asked: e.m.action.clickState, did: ack?.clickState, retargeted: ack?.retargeted, x: +(e.m.action.x * rec.display.width).toFixed(1), y: +(e.m.action.y * rec.display.height).toFixed(1), landedX: ack?.point ? +(ack.point.x * rec.display.width).toFixed(1) : null };
        });
        outcomes.push({ drift, downs, selected, clicks });
        if (JSON.stringify(downs) !== "[1,2]") problem(name, `a double-tap ${drift} px apart didn't arrive as a double-click`, { drift, downs, selected, clicks });
      }
      await recordScenario({ name, outcomes, acks: ackStats(await trace()) });
    }

    // 3c. Slow taps: a finger resting 300 to 700 ms, still or wobbling a
    // few pixels, is still one click where it landed (never nothing, never
    // a drag selecting text).
    {
      const name = "slow taps";
      await ensureControl(name);
      const outcomes = [];
      for (const [hold, wobble] of [[300, 0], [380, 0], [420, 0], [500, 0], [700, 0], [500, 4], [700, 6]]) {
        await keyboardClosed();
        // Clicks in a cell: one down/up there.
        const before = rec.events().length;
        const p = await where(rec.share(rec.regions.cell1));
        await touchDown(p.x, p.y);
        const steps = Math.max(1, Math.floor(hold / 50));
        for (let i = 0; i < steps; i++) {
          await sleep(hold / steps);
          if (wobble) await tab.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: p.x + (i % 2 ? wobble : 0), y: p.y + (i % 2 ? wobble / 2 : 0) }] });
        }
        await touchUp();
        markInput();
        await sleep(1200);
        const ev = rec.events().slice(before);
        const downs = ev.filter((e) => e.kind === "down" && e.cell === 1).length;
        const ups = ev.filter((e) => e.kind === "up" && e.cell === 1).length;
        const shown = (await status()).shown;
        outcomes.push({ hold, wobble, downs, ups, shown });
        if (downs !== 1 || ups !== 1) problem(name, `a ${hold} ms tap${wobble ? ` wobbling ${wobble} px` : ""} didn't click once`, { hold, wobble, downs, ups, shown, events: ev.slice(0, 6) });
        // On words: a slow tap places the caret, it doesn't select.
        await keyboardClosed();
        await tapAt(rec.share(rec.regions.text, 0.97, 0.9));
        await sleep(600);
        await keyboardClosed();
        const before2 = rec.events().length;
        const q = await where(rec.share(rec.regions.text, 0.15, 0.12));
        await touchDown(q.x, q.y);
        for (let i = 0; i < steps; i++) {
          await sleep(hold / steps);
          if (wobble) await tab.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: q.x + (i % 2 ? wobble : 0), y: q.y }] });
        }
        await touchUp();
        markInput();
        await sleep(1200);
        const sel = rec.events().slice(before2).filter((e) => e.kind === "selection").at(-1);
        if (sel && sel.length > 0) problem(name, `a ${hold} ms tap${wobble ? ` wobbling ${wobble} px` : ""} on text selected "${sel.selected}" instead of placing the caret`, { hold, wobble });
        if (!sel) problem(name, `a ${hold} ms tap${wobble ? ` wobbling ${wobble} px` : ""} on text did nothing`, { hold, wobble, shown: (await status()).shown });
      }
      await recordScenario({ name, outcomes });
    }

    // 3d. Touch and hold, still, on plain content: never a right-click
    // (Android's long-press opens a context menu on the page).
    {
      const name = "long press";
      await ensureControl(name);
      await keyboardClosed();
      const before = rec.events().length;
      const p = await where(rec.share(rec.regions.cell2));
      await touchDown(p.x, p.y);
      await sleep(1200);
      await touchUp();
      markInput();
      await sleep(1500);
      const ev = rec.events().slice(before);
      const rights = ev.filter((e) => e.kind === "right" || (e.kind === "mouse" && e.type === 3));
      const downs = ev.filter((e) => e.kind === "down");
      if (rights.length) problem(name, "a long press sent a right-click", { rights: rights.length, downs: downs.length });
      await recordScenario({ name, rights: rights.length, downs: downs.length });
    }

    // 4. Tap a text field: does the keyboard open on that tap, and would
    // Safari have opened it (focus inside a trusted touch-end or click)?
    {
      const name = "keyboard opens on a field";
      await ensureControl(name);
      const outcomes = [];
      for (let round = 0; round < ROUNDS * 2; round++) {
        await keyboardClosed();
        await trace();
        const tapped = Date.now();
        await tapAt(rec.share(rec.regions.field, 0.5, 0.5));
        const state = await until(async () => {
          const s = await typing();
          return { ...s, ok: s.focused && s.viewer };
        }, 2500);
        const log = await trace();
        const focuses = log.filter((e) => e.dir === "focus");
        const gesture = focuses.find((f) => f.trusted && /touchend|click|pointerup|mouseup/.test(f.ev || ""));
        const probe = log.find((e) => e.dir === "out" && e.m?.action?.type === "probe");
        const probeAck = probe && log.find((e) => e.dir === "in" && e.m?.type === "ack" && e.m.id === probe.m.id);
        const touchEnd = log.find((e) => e.dir === "ev" && e.type === "touchend");
        const o = {
          round,
          opened: !!state?.ok,
          ms: Date.now() - tapped,
          tapToType: state?.tapToType,
          safariWouldOpen: !!gesture,
          focuses: focuses.map((f) => `${f.ev}${f.trusted ? "" : "(untrusted)"}@${f.t - (touchEnd?.t ?? 0)}`),
          probeMs: probe && probeAck ? probeAck.t - probe.t : null,
          probeAnswer: probeAck?.m && { field: probeAck.m.field, secure: probeAck.m.secure },
          probeAfterLift: probe && probeAck && touchEnd ? probeAck.t - touchEnd.t : null,
        };
        outcomes.push(o);
        if (!o.opened) problem(name, "keyboard didn't open on a text field tap", o);
        else if (!o.safariWouldOpen) problem(name, "keyboard focus happened outside the tap: Safari would keep the keyboard closed", o);
        // Type one letter to prove it reaches the field.
        if (o.opened) {
          const beforeField = rec.field();
          await typeSend("Input.insertText", { text: "x" });
          const typed = await until(async () => ({ ok: rec.field() === beforeField + "x", now: rec.field() }), 3000);
          if (!typed?.ok) problem(name, "letter typed after the keyboard opened didn't arrive", { round, before: beforeField, now: typed?.now });
        }
      }
      await recordScenario({ name, outcomes });
    }

    // 5. Typing exactly: words, corrections, accents, dashes, quotes,
    // emoji, Return, at a person's pace and then as a burst.
    {
      const name = "typing exactly";
      await ensureControl(name);
      await keyboardClosed();
      // Select everything in the text view first: Cmd+A through the phone is
      // not this scenario, so clear by tapping at its end and typing on.
      const start = rec.text();
      await tapAt(rec.share(rec.regions.text, 0.95, 0.9));
      const opened = await until(async () => {
        const s = await typing();
        return { ...s, ok: s.focused && s.viewer };
      }, 2500);
      if (!opened?.ok) {
        problem(name, "keyboard didn't open on the text view", opened);
        if (!(await keyboardButton())) problem(name, "the keyboard button didn't open the keyboard either", await typing());
      }
      await sleep(400);
      const paced = " hello world";
      for (const ch of paced) {
        await typeSend("Input.insertText", { text: ch });
        await sleep(110);
      }
      await pressKey("Backspace");
      await sleep(110);
      await pressKey("Backspace");
      await sleep(110);
      for (const ch of "LD café naïve ü – “ok” ’ 😀 ✓") {
        await typeSend("Input.insertText", { text: ch });
        await sleep(110);
      }
      await pressKey("Enter");
      await sleep(150);
      const fast = "The quick brown fox jumps over the lazy dog";
      // A fast typist: 25 letters a second.
      for (const ch of fast) {
        await typeSend("Input.insertText", { text: ch });
        await sleep(40);
      }
      const expected = start + " hello worLD café naïve ü – “ok” ’ 😀 ✓\n" + fast;
      const got = await until(async () => ({ ok: rec.text() === expected, now: rec.text() }), 15000);
      if (!got?.ok) problem(name, "typed text differs from what reached the Mac", { expected: expected.slice(start.length), got: got?.now.slice(start.length), phone: await status() });
      let log = await trace();
      const drops = log.filter((e) => e.dir === "in" && e.m?.type === "ack" && e.m.ok === false);
      if (drops.length) problem(name, "actions turned down while typing", { errors: [...new Set(drops.map((d) => d.m.error))], n: drops.length });
      await recordScenario({ name, ok: !!got?.ok, acks: ackStats(log), closes: log.filter((e) => e.dir === "close") });
    }

    // 5b. A burst: 40 letters as fast as the page takes them (a held key,
    // a hardware keyboard, an app inserting text letter by letter).
    {
      const name = "typing burst";
      const start = rec.text();
      const s0 = await typing();
      if (!s0.focused) {
        await tapAt(rec.share(rec.regions.text, 0.95, 0.9));
        await sleep(800);
      }
      const burst = "0123456789abcdefghijklmnopqrstuvwxyzABCD";
      for (const ch of burst) await typeSend("Input.insertText", { text: ch });
      const got = await until(async () => ({ ok: rec.text() === start + burst, now: rec.text() }), 15000);
      const log = await trace();
      const drops = log.filter((e) => e.dir === "in" && e.m?.type === "ack" && e.m.ok === false);
      const phone = await status();
      if (!got?.ok) problem(name, "burst differs from what reached the Mac", { got: got?.now.slice(start.length), phone, turnedDown: drops.length, errors: [...new Set(drops.map((d) => d.m.error))], closes: log.filter((e) => e.dir === "close") });
      await recordScenario({ name, ok: !!got?.ok, acks: ackStats(log), phone });
    }

    // 5b2. Pasting two lines from the phone's keyboard: a line break, never
    // a shortcut (Ctrl+Enter sends mail and posts messages).
    {
      const name = "multiline paste";
      const start = rec.text();
      if (!(await typing()).focused) {
        await tapAt(rec.share(rec.regions.text, 0.95, 0.9));
        await sleep(800);
        if (!(await typing()).focused) await keyboardButton();
      }
      const before = rec.events().length;
      await typeSend(null);
      await page.evaluate(`(() => { const el = document.activeElement; const dt = new DataTransfer(); dt.setData("text/plain", "first line\\nsecond line"); el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true })); })()`);
      const expected = start + "first line\nsecond line";
      const got = await until(async () => ({ ok: rec.text() === expected, now: rec.text() }), 8000);
      const keys = rec.events().slice(before).filter((e) => e.kind === "key");
      const shortcuts = keys.filter((e) => (windows ? (e.mods & 0x20000) !== 0 : (e.mods & (1 << 18)) !== 0 || (e.mods & (1 << 20)) !== 0));
      if (!got?.ok) problem(name, "pasted lines differ from what reached the computer", { expected: expected.slice(start.length), got: got?.now.slice(start.length) });
      if (shortcuts.length) problem(name, "the paste's line break arrived as a shortcut", { keys: shortcuts.slice(0, 4) });
      await recordScenario({ name, ok: !!got?.ok, keys: keys.length });
    }

    // 5c. Typing as Android's keyboard does: each word composed letter by
    // letter (underlined), then committed; a correction replaces the word.
    {
      const name = "composition typing";
      const start = rec.text();
      const s0 = await typing();
      if (!s0.focused) {
        await tapAt(rec.share(rec.regions.text, 0.95, 0.9));
        await sleep(800);
      }
      const words = ["hello", "wrold", "again"];
      for (const [i, word] of words.entries()) {
        for (let n = 1; n <= word.length; n++) {
          await typeSend("Input.imeSetComposition", { text: word.slice(0, n), selectionStart: n, selectionEnd: n });
          await sleep(60);
        }
        // Autocorrect: the composed "wrold" is committed as "world".
        await typeSend("Input.insertText", { text: word === "wrold" ? "world" : word });
        await sleep(80);
        if (i < words.length - 1) {
          await typeSend("Input.insertText", { text: " " });
          await sleep(80);
        }
      }
      const expected = start + "hello world again";
      const got = await until(async () => ({ ok: rec.text() === expected, now: rec.text() }), 10000);
      const log = await trace();
      if (!got?.ok) problem(name, "composed words differ from what reached the Mac", { expected: expected.slice(start.length), got: got?.now.slice(start.length), sent: log.filter((e) => e.dir === "out").map((e) => e.m.action).slice(-40) });
      await recordScenario({ name, ok: !!got?.ok });
    }

    // 6. Keyboard reopened again and again: each time, one letter arrives once.
    {
      const name = "keyboard reopen cycle";
      await ensureControl(name);
      let failures = 0;
      for (let round = 0; round < ROUNDS * 3; round++) {
        await keyboardClosed();
        const before = rec.field();
        await tapAt(rec.share(rec.regions.field, 0.3 + (round % 5) * 0.1, 0.5));
        const s = await until(async () => {
          const v = await typing();
          return { ...v, ok: v.focused && v.viewer };
        }, 2500);
        if (!s?.ok) {
          failures++;
          problem(name, "keyboard didn't open", { round, ...s });
          continue;
        }
        await typeSend("Input.insertText", { text: String(round % 10) });
        const got = await until(async () => ({ ok: rec.field().length === before.length + 1, now: rec.field() }), 3000);
        if (!got?.ok) {
          failures++;
          problem(name, "letter didn't arrive exactly once", { round, before, now: got?.now });
        }
      }
      await recordScenario({ name, rounds: ROUNDS * 3, failures });
    }

    // 7. Touch and hold, then drag across words: a selection.
    {
      const name = "hold and drag";
      await ensureControl(name);
      const outcomes = [];
      for (let round = 0; round < ROUNDS; round++) {
        await keyboardClosed();
        // A press inside the last round's selection would drag that text
        // away (macOS text drag and drop): collapse it first, at the end.
        await tapAt(rec.share(rec.regions.text, 0.97, 0.9));
        await sleep(700);
        await keyboardClosed();
        await trace();
        const before = rec.events().length;
        const a = await where(rec.share(rec.regions.text, 0.02, 0.12));
        const b = await where(rec.share(rec.regions.text, 0.25, 0.12));
        await touchDown(a.x, a.y);
        await sleep(700);
        for (let i = 1; i <= 10; i++) {
          await tab.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: a.x + ((b.x - a.x) * i) / 10, y: a.y }] });
          await sleep(40);
        }
        await sleep(200);
        await touchUp();
        markInput();
        await sleep(1500);
        const ev = rec.events().slice(before);
        const selection = ev.filter((e) => e.kind === "selection").at(-1);
        outcomes.push({ selected: selection?.selected, downs: ev.filter((e) => e.kind === "mouse").length });
        const sent = (await trace()).filter((e) => e.dir === "out" || (e.dir === "in" && e.m?.type === "ack")).map((e) => e.dir === "out" ? `${e.t}:${e.m.action?.type}#${e.m.id}` : `${e.t}:ack#${e.m.id}${e.m.skipped ? "(skipped)" : ""}${e.m.ok === false ? "(" + e.m.error + ")" : ""}`);
        if (!selection || (selection.selected || "").length < 5) problem(name, "hold and drag didn't select text", { round, selection, events: ev.slice(-6), sent: sent.slice(-30), phone: await status() });
      }
      await recordScenario({ name, outcomes });
    }

    // 8. Two-finger scroll on a cell.
    {
      const name = "two-finger scroll";
      await ensureControl(name);
      const before = rec.events().length;
      const c = await where(rec.share(rec.regions.cell5));
      await tab.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: c.x - 20, y: c.y, id: 1 }, { x: c.x + 20, y: c.y, id: 2 }] });
      for (let i = 1; i <= 12; i++) {
        await tab.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: c.x - 20, y: c.y - i * 8, id: 1 }, { x: c.x + 20, y: c.y - i * 8, id: 2 }] });
        await sleep(30);
      }
      await touchUp();
      markInput();
      await sleep(2000);
      const ev = rec.events().slice(before);
      const scrolls = ev.filter((e) => e.kind === "scroll");
      const clicks = ev.filter((e) => e.kind === "down" || (e.kind === "mouse" && e.type === 1));
      if (!scrolls.length) problem(name, "two-finger swipe didn't scroll", { events: ev.slice(0, 8) });
      if (clicks.length) problem(name, "two-finger swipe also clicked", { clicks });
      await recordScenario({ name, scrolls: scrolls.length, clicks: clicks.length });
    }

    // 10. More letters at once than the input queue holds (a held key, an
    // app or keyboard inserting letter by letter): what reaches the
    // computer, and whether control survives.
    if (process.env.REACH_TEST_SCREEN_OVERFLOW === "1") {
      const name = "queue overflow";
      await ensureControl(name);
      await keyboardClosed();
      await tapAt(rec.share(rec.regions.field, 0.9, 0.5));
      await sleep(900);
      if (!(await typing()).focused) await keyboardButton();
      const start = rec.field();
      await trace();
      const burst = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
      for (const ch of burst) await typeSend("Input.insertText", { text: ch });
      const timeline = [];
      for (let i = 0; i < 40; i++) {
        const st = await status();
        timeline.push(`${i * 250}ms control=${st.control} caption="${st.caption}" shown="${st.shown}" focused=${(await typing()).focused}`);
        await sleep(250);
      }
      const log = await trace();
      const got = rec.field().slice(start.length);
      const closes = log.filter((e) => e.dir === "close" || e.dir === "open");
      const refused = log.filter((e) => e.dir === "in" && (e.m?.type === "error" || e.m?.ok === false)).map((e) => e.m.error);
      const sent = log.filter((e) => e.dir === "out").map((e) => `${e.m.action?.type}${e.m.action?.text ? ":" + e.m.action.text : ""}${e.m.action?.delete ? "-" + e.m.action.delete : ""}`);
      const acks = log.filter((e) => e.dir === "in" && e.m?.type === "ack").length;
      if (got !== burst) problem(name, `${burst.length} letters typed at once: the computer got ${got.length}`, { got, closes, refused: [...new Set(refused)], sentCount: sent.length, sent: sent.slice(0, 80), acks, fieldNow: rec.field(), timeline: [...new Set(timeline.map((l) => l.replace(/^\d+ms /, "")))] });
      const after = await status();
      if (!after.control) problem(name, "control ended after the burst", { after, timeline });
      await recordScenario({ name, got, timeline });
    }

    // 9. A real Terminal: tap into it, the keyboard opens, typing and keys arrive as bytes.
    {
      const name = "terminal";
      await ensureControl(name);
      rec.stop();
      await sleep(800);
      const term = await rawTerminal(t, dir);
      const [l, top, r, bottom] = term.bounds;
      const d = rec.display;
      zone = (p) => p.x * d.width >= l && p.x * d.width <= r && p.y * d.height >= top && p.y * d.height <= bottom;
      front = () => term.front();
      const at = { x: (l + (r - l) * 0.5) / d.width, y: (top + (bottom - top) * 0.6) / d.height };
      await sleep(1500);
      const outcomes = [];
      for (let round = 0; round < ROUNDS; round++) {
        if (round) {
          // Away from the terminal and back: the keyboard put away on the
          // phone itself (its bar), never a click elsewhere on the Mac.
          const off = await page.evaluate(`(() => { const b = document.querySelector('[aria-label="Screen controls"] button[aria-label="Dismiss phone keyboard"]'); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
          if (off) {
            await touchDown(off.x, off.y);
            await sleep(80);
            await touchUp();
          }
          await sleep(800);
        }
        await trace();
        await tapAt(at);
        const s = await until(async () => {
          const v = await typing();
          return { ...v, ok: v.focused && v.viewer };
        }, 2500);
        const log = await trace();
        const probe = log.find((e) => e.dir === "out" && e.m?.action?.type === "probe");
        const probeAck = probe && log.find((e) => e.dir === "in" && e.m?.type === "ack" && e.m.id === probe.m.id);
        const o = { round, opened: !!s?.ok, tapToType: s?.tapToType, probeMs: probe && probeAck ? probeAck.t - probe.t : null, probeAnswer: probeAck?.m && { field: probeAck.m.field } };
        outcomes.push(o);
        if (!o.opened) problem(name, "keyboard didn't open on a tap into Terminal", o);
      }
      // Type regardless (the Type button if the tap didn't open it).
      if (!(await typing()).focused && !(await keyboardButton())) problem(name, "no way to open the keyboard for the terminal", await typing());
      const start = term.bytes().length;
      for (const ch of "echo hi") {
        await typeSend("Input.insertText", { text: ch });
        await sleep(90);
      }
      await pressKey("Backspace");
      await sleep(90);
      await typeSend("Input.insertText", { text: "I" });
      await sleep(90);
      await pressKey("Enter");
      await sleep(90);
      const burst = "ls -la /tmp && echo done";
      for (const ch of burst) await typeSend("Input.insertText", { text: ch });
      const want = Buffer.from("echo hi" + term.backspace + "I" + term.enter + burst);
      const got = await until(async () => {
        const b = term.bytes().subarray(start);
        return { ok: b.equals(want), now: JSON.stringify(b.toString("latin1")) };
      }, 10000);
      if (!got?.ok) problem(name, "bytes Terminal received differ", { want: JSON.stringify(want.toString("latin1")), got: got?.now });
      await recordScenario({ name, outcomes, bytesOk: !!got?.ok });
    }

    fs.mkdirSync(path.resolve("reports", "journeys"), { recursive: true });
    const file = path.resolve("reports", "journeys", `screen-control-${process.platform}-${kind}.json`);
    fs.writeFileSync(file, JSON.stringify(report, null, 2));
    console.log(`Report: ${file}`);
    assert.deepEqual(report.problems, [], `Screen control problems (report: ${file})`);
  }
}

for (const kind of KINDS)
  test(
    `Screen control under stress (${kind}): taps, double-taps, holds, scrolls and typing reach this computer exactly`,
    { skip: skip || needsDesktop || stress || macInUse(), timeout: 1500000 },
    (t) => desktopTurn(t).then((mine) => mine && stressRun(t, kind)),
  );
