import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import net from "node:net";
import { spawn } from "node:child_process";
import { startComputer, macInUse, markInput, desktopTurn } from "../helpers/journey.mjs";
import { HOST } from "../helpers/fake-tailscale.mjs";
import { recorder, rawTerminal } from "../helpers/input-recorder.mjs";

// Screen control from real iOS WebKit: Mobile Safari in an iOS simulator,
// driven by XCUITest (real UIKit touches, the real software keyboard), into
// windows on this Mac that record what arrived (test/helpers/input-recorder.mjs).
// The XCUITest runner lives outside the repository (REACH_TEST_IOS_PROJECT:
// a UI test target whose testScreenControl drives Safari and asks this
// file's oracle for the computer's side). Simulated: the touch hardware
// and the network; real: WebKit, UIKit's keyboard and focus rules, Reach,
// this Mac's input.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const project = process.env.REACH_TEST_IOS_PROJECT;
const simulator = process.env.REACH_TEST_IOS_SIMULATOR;
const asked = process.platform !== "darwin" ? "Mac only" : !project || !simulator ? "set REACH_TEST_IOS_PROJECT and REACH_TEST_IOS_SIMULATOR" : false;

// Reach as the phone reaches it through Tailscale, at a loopback address
// Safari treats as secure: its own host name and the phone's identity put
// back on each request (fake-tailscale's routes, as journey.mjs's stand-in).
function loopbackDoor(fake, origin, trace) {
  const target = async () => {
    const key = `${HOST}:443`;
    const routes = await fake.read();
    const proxy = [routes.serve, ...Object.values(routes.serve.Foreground || {})]
      .map((serve) => serve?.Web?.[key]?.Handlers?.["/"]?.Proxy)
      .find(Boolean);
    if (!proxy) return null;
    const headers = { host: HOST, "x-forwarded-for": "100.64.0.21", "tailscale-user-login": "owner@example.test", "tailscale-user-name": "Owner" };
    if (proxy.startsWith("unix:")) return { socketPath: proxy.slice(5), headers };
    const url = new URL(proxy);
    return { host: url.hostname, port: Number(url.port), headers };
  };
  const rewrite = (req, to) => {
    const h = Object.fromEntries(Object.entries(req.headers).filter(([n]) => !/^(tailscale-|x-forwarded-|forwarded$)/i.test(n)));
    if (h.origin) h.origin = origin;
    if (h.referer) h.referer = origin + "/";
    return { ...h, ...to.headers };
  };
  const open = new Set();
  const server = http.createServer(async (req, res) => {
    // The page's own trace (journeys' TRACE), same-origin so the page's CSP
    // runs it, posting to the oracle.
    if (trace && req.url === "/__reach_trace.js") return res.writeHead(200, { "content-type": "text/javascript", "cache-control": "no-store" }).end(trace);
    const page = trace && req.method === "GET" && /text\/html/.test(req.headers.accept || "");
    if (page) delete req.headers["accept-encoding"];
    const to = await target().catch(() => null);
    if (!to) return res.writeHead(502).end("No route.");
    const { headers, ...where } = to;
    const forward = http.request({ ...where, path: req.url, method: req.method, headers: rewrite(req, to) }, (back) => {
      const h = { ...back.headers };
      delete h["strict-transport-security"];
      if (h["content-security-policy"]) h["content-security-policy"] = String(h["content-security-policy"]).replace("connect-src 'self'", "connect-src 'self' ws://127.0.0.1:* http://127.0.0.1:*");
      if (h["access-control-allow-origin"]) h["access-control-allow-origin"] = req.headers.origin || h["access-control-allow-origin"];
      if (page && /text\/html/.test(h["content-type"] || "") && !h["content-encoding"]) {
        let body = "";
        back.setEncoding("utf8");
        back.on("data", (c) => (body += c));
        back.on("end", () => {
          body = body.replace(/<head([^>]*)>/i, (m) => `${m}<script src="/__reach_trace.js"></script>`);
          delete h["content-length"];
          res.writeHead(back.statusCode, h);
          res.end(body);
        });
        return;
      }
      res.writeHead(back.statusCode, h);
      back.pipe(res);
    });
    forward.on("error", () => res.destroy());
    req.pipe(forward);
  });
  server.on("upgrade", async (req, client, head) => {
    console.log(`DOOR upgrade ${req.url.split("?")[0]}`);
    client.on("error", () => {});
    const to = await target().catch(() => null);
    if (!to) return client.destroy();
    const upstream = to.socketPath ? net.connect(to.socketPath) : net.connect(to.port, to.host);
    open.add(upstream);
    open.add(client);
    upstream.on("error", (e) => { console.log(`DOOR upstream error ${e.message}`); client.destroy(); });
    upstream.once("data", (d) => console.log(`DOOR upgrade answer ${req.url.split("?")[0]}: ${d.toString("latin1").split("\r\n")[0]}`));
    client.on("close", () => console.log(`DOOR closed ${req.url.split("?")[0]}`));
    upstream.once("connect", () => {
      const lines = Object.entries(rewrite(req, to)).flatMap(([k, v]) => (Array.isArray(v) ? v.map((one) => `${k}: ${one}`) : [`${k}: ${v}`]));
      upstream.write(`${req.method} ${req.url} HTTP/1.1\r\n${lines.join("\r\n")}\r\n\r\n`);
      if (head?.length) upstream.write(head);
      // A tailnet's latency, each way (REACH_TEST_IOS_WS_DELAY ms): equal
      // delays keep every frame in order.
      const delay = Number(process.env.REACH_TEST_IOS_WS_DELAY || 0);
      if (!delay) {
        upstream.pipe(client);
        client.pipe(upstream);
        return;
      }
      upstream.on("data", (c) => setTimeout(() => client.writable && client.write(c), delay));
      client.on("data", (c) => setTimeout(() => upstream.writable && upstream.write(c), delay));
      upstream.on("end", () => setTimeout(() => client.end(), delay));
      client.on("end", () => setTimeout(() => upstream.end(), delay));
    });
  });
  return { server, close: () => { for (const s of open) s.destroy(); return new Promise((r) => server.close(r)); } };
}

// The journeys' page trace (screen-control.test.mjs), flushed to the oracle.
const pageTrace = (oracle) => `(() => {
  if (window.__sc) return;
  const log = (window.__sc = []);
  const now = () => Math.round(performance.now());
  const P = WebSocket.prototype;
  const input = (ws) => /screen-input/.test(ws.url || "");
  const heartbeats = new Set();
  const send = P.send;
  P.send = function (data) {
    if (input(this)) {
      try {
        const m = JSON.parse(data);
        if (m.action?.type === "heartbeat") heartbeats.add(m.id);
        else if (m.type !== "auth") log.push({ t: now(), dir: "out", m });
      } catch {}
    }
    return send.call(this, data);
  };
  for (const name of ["onmessage", "onclose"]) {
    const d = Object.getOwnPropertyDescriptor(P, name);
    Object.defineProperty(P, name, {
      configurable: true, enumerable: true,
      get() { return d.get.call(this); },
      set(fn) {
        const ws = this;
        d.set.call(this, typeof fn !== "function" ? fn : function (e) {
          if (input(ws)) {
            if (name === "onmessage") {
              try { const m = JSON.parse(e.data); if (!(m.type === "ack" && heartbeats.has(m.id))) log.push({ t: now(), dir: "in", m: m.type === "fields" ? { type: "fields", n: m.fields.length, after: m.after } : m }); } catch {}
            } else log.push({ t: now(), dir: "close", code: e.code });
          }
          return fn.call(this, e);
        });
      },
    });
  }
  const focus = HTMLElement.prototype.focus;
  HTMLElement.prototype.focus = function (...a) {
    const e = window.event;
    if (this.tagName === "TEXTAREA" || this.tagName === "INPUT") log.push({ t: now(), dir: "focus", el: this.tagName + "." + String(this.className || ""), ev: e ? e.type : null, trusted: e ? e.isTrusted : null });
    return focus.apply(this, a);
  };
  const blur = HTMLElement.prototype.blur;
  HTMLElement.prototype.blur = function (...a) {
    if (this.tagName === "TEXTAREA" || this.tagName === "INPUT") log.push({ t: now(), dir: "blur", ev: window.event?.type || null });
    return blur.apply(this, a);
  };
  const who = (el) => el && el.tagName ? el.tagName + (typeof el.className === "string" && el.className ? "." + el.className.trim().split(/\\s+/)[0] : "") : "";
  for (const type of ["touchstart", "touchend", "pointerdown", "pointerup", "mousedown", "mouseup", "click", "dblclick", "focusin", "focusout", "contextmenu"])
    addEventListener(type, (e) => log.push({ t: now(), dir: "ev", type, trusted: e.isTrusted, target: who(e.target), prevented: e.defaultPrevented }), true);
  for (const type of ["keydown", "beforeinput", "selectionchange"])
    addEventListener(type, (e) => log.push({ t: now(), dir: "key", type, key: e.key, code: e.code, inputType: e.inputType, data: e.data, trusted: e.isTrusted, target: who(e.target), sel: document.activeElement && document.activeElement.selectionStart !== undefined ? [document.activeElement.selectionStart, document.activeElement.selectionEnd, (document.activeElement.value || "").length] : null }), true);
  window.visualViewport?.addEventListener("resize", () => log.push({ t: now(), dir: "viewport", h: Math.round(visualViewport.height), ih: innerHeight }));
  setInterval(() => {
    if (!log.length) return;
    const batch = log.splice(0);
    fetch("${oracle}/trace", { method: "POST", mode: "cors", body: JSON.stringify(batch) }).catch(() => {});
  }, 250);
})()`;

test(
  "Screen control from iOS Safari (simulator): taps, the keyboard and typing reach this Mac exactly",
  { skip: asked || macInUse(), timeout: 1800000 },
  async (t) => {
    if (!(await desktopTurn(t))) return;
    const computer = await startComputer(t);
    const dir = fs.mkdtempSync(path.join(computer.reach.temp, "ios-control-"));
    const rec = await recorder(t, dir);
    const report = { scenarios: [], problems: [], trace: [] };
    let door, url;
    let term = null, done = false, checkedFront = 0;
    // Where the XCUITest may tap and type: this test's own windows only, and
    // only while nobody is at the Mac (it asks before each tap and keystroke).
    const zone = (at) => {
      if (!term) return rec.contains(at);
      const [l, top, r, bottom] = term.bounds, d = rec.display;
      return at.x * d.width >= l && at.x * d.width <= r && at.y * d.height >= top && at.y * d.height <= bottom;
    };
    const answered = new Set();
    const oracle = http.createServer(async (req, res) => {
      const body = await new Promise((r) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { try { r(JSON.parse(b || "{}")); } catch { r({}); } }); });
      const reply = (v) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(v));
      const route = new URL(req.url, "http://x").pathname;
      if (route === "/trace") {
        res.writeHead(200, { "access-control-allow-origin": "*" }).end("{}");
        try { report.trace.push(...JSON.parse(JSON.stringify(body))); } catch {}
        return;
      }
      try {
        if (route === "/mark") {
          report.trace.push({ mark: body.name, at: Date.now() });
          return reply({});
        }
        if (route === "/start") return reply({ url });
        if (route === "/guard") {
          const busy = macInUse();
          if (busy) return reply({ ok: false, why: busy });
          if (Number.isFinite(body.x) && !zone(body)) return reply({ ok: false, why: `outside the test's own windows: ${body.x},${body.y}` });
          if (body.typing && Date.now() - checkedFront > 1500) {
            if (!(await (term ? term.front() : rec.front()))) return reply({ ok: false, why: "the test's own window isn't in front" });
            checkedFront = Date.now();
          }
          return reply({ ok: true });
        }
        if (route === "/approve") {
          // The device request this Safari made, as Reach's terminal says it.
          for (const end = Date.now() + 90000; Date.now() < end; await sleep(250)) {
            const codes = [...computer.reach.output().matchAll(/\b([a-f0-9]{8})\b · /g)].map((m) => m[1]).filter((c) => !answered.has(c));
            if (codes.length) {
              answered.add(codes.at(-1));
              computer.reach.answer(codes.at(-1));
              return reply({ ok: true, code: codes.at(-1) });
            }
          }
          return reply({ ok: false, output: computer.reach.output().slice(-1500) });
        }
        if (route === "/state") return reply({ regions: rec.regions, display: rec.display, field: rec.field(), text: rec.text(), terminal: term ? term.bytes().toString("utf8") : "" });
        if (route === "/events") return reply({ events: rec.events() });
        if (route === "/terminal") {
          rec.stop();
          await sleep(800);
          term = await rawTerminal(t, dir);
          return reply({ bounds: term.bounds });
        }
        if (route === "/problem") {
          report.problems.push(body);
          console.log(`PROBLEM ${JSON.stringify(body)}`);
          markInput();
          return reply({});
        }
        if (route === "/scenario") {
          report.scenarios.push(body);
          console.log(`SCENARIO ${JSON.stringify(body).slice(0, 2000)}`);
          markInput();
          return reply({});
        }
        if (route === "/shot") {
          const out = path.resolve("reports", "journeys", `ios-simulator-${String(body.name).replace(/[^a-z0-9-]/gi, "-")}.png`);
          fs.mkdirSync(path.dirname(out), { recursive: true });
          fs.writeFileSync(out, Buffer.from(String(body.png || ""), "base64"));
          console.log(`SHOT ${out}`);
          return reply({});
        }
        if (route === "/done") {
          if (body.tree) console.log(`TREE ${body.tree}`);
          done = body.problems !== -1;
          return reply({});
        }
        reply({ error: "unknown" });
      } catch (error) {
        reply({ error: error.message });
      }
    });
    await new Promise((r) => oracle.listen(0, "127.0.0.1", r));
    t.after(() => new Promise((r) => oracle.close(r)));
    door = loopbackDoor(computer.reach.fake, computer.origin, pageTrace(`http://127.0.0.1:${oracle.address().port}`));
    await new Promise((r) => door.server.listen(0, "127.0.0.1", r));
    t.after(() => door.close());
    url = `http://127.0.0.1:${door.server.address().port}/`;
    const env = { ...process.env, TEST_RUNNER_ORACLE_URL: `http://127.0.0.1:${oracle.address().port}`, TEST_RUNNER_ROUNDS: process.env.REACH_TEST_SCREEN_ROUNDS || "2" };
    const derived = path.join(os.homedir(), ".reach-dev", "ios-e2e", "dd");
    const xcode = spawn("xcodebuild", ["test-without-building", "-project", project, "-scheme", "AppUi", "-destination", `platform=iOS Simulator,id=${simulator}`, "-derivedDataPath", derived, "-only-testing:AppUiUITests/AppUiUITests/testScreenControl", "-parallel-testing-enabled", "NO"], { env, stdio: ["ignore", "pipe", "pipe"] });
    let log = "";
    xcode.stdout.on("data", (c) => (log += c));
    xcode.stderr.on("data", (c) => (log += c));
    t.after(() => xcode.kill());
    const code = await new Promise((r) => xcode.on("exit", r));
    console.log(`REACH said:\n${computer.reach.output().split("\n").filter((l) => /video|stream|screen|control|decoder|denied|refused|error/i.test(l)).slice(-40).join("\n")}`);
    fs.mkdirSync(path.resolve("reports", "journeys"), { recursive: true });
    const file = path.resolve("reports", "journeys", "screen-control-ios-simulator.json");
    fs.writeFileSync(file, JSON.stringify({ ...report, xcode: code, log: log.split("\n").filter((l) => /error|fail|assert|PROBLEM|Test Case/i.test(l)).slice(-80) }, null, 2));
    console.log(`Report: ${file}`);
    assert.ok(done, `the XCUITest ran to its end (xcodebuild ${code}):\n${log.slice(-4000)}`);
    assert.deepEqual(report.problems, [], `Screen control problems on iOS (report: ${file})`);
  },
);
