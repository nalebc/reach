import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { execFile } from "node:child_process";
import express from "express";
import ts from "typescript";
import { createPublicStart } from "../server/public-start.mjs";
import { serveBuild } from "../server/delivery.mjs";
import { agentSteps, stepsCommand, wantsPage, windowsStepsCommand, YOUR_LINK } from "../server/agent-steps.mjs";

// Oct 12: the invite message is a line and a link; the link explains itself
// to a command-line agent. curl (and any program that doesn't ask for a
// page) gets the steps as text; a browser gets the start page with them in
// it (its script shows people what the link is for). The steps check the
// download against r=, the runtime's SHA-256 the link carries (audit M8).
const START = "https://mac.tail1.ts.net";
const SECRET = "s".repeat(43);
const sha = (text) => crypto.createHash("sha256").update(text).digest("hex");
const START_HTML = '<!doctype html><html><head><title>Reach</title><script type="module" src="/assets/start-abc.js"></script></head><body style="margin:0"><main id="start" class="start" aria-live="polite"><section role="status"><h1>Opening Reach…</h1></section></main><div id="root"></div></body></html>';
const BROWSER = "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8";

test("which requests get the page: only those that ask for HTML", () => {
  for (const accept of [BROWSER, "text/html", "application/xhtml+xml", "text/html, text/plain;q=0.5"]) assert.equal(wantsPage(accept), true, accept);
  for (const accept of [undefined, "", "*/*", "text/plain", "text/markdown", "text/markdown, text/html, */*", "text/plain, text/html;q=0.9", "text/html;q=0", "application/json"])
    assert.equal(wantsPage(accept), false, String(accept));
});

async function publicStart(t, files = { "start.html": START_HTML }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-agent-steps-"));
  const dist = path.join(dir, "dist");
  fs.mkdirSync(dist);
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dist, name), text);
  const server = createPublicStart({ dist, privateOrigin: "https://mac.tail1.ts.net:8443", home: START, name: "Mac", instance: "i1", platform: "darwin" });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return (route, { method = "GET", headers = {} } = {}) => new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: server.address().port, path: route, method, headers: { Host: "mac.tail1.ts.net", ...headers } }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.once("error", reject);
    req.end();
  });
}

test("the public start page: /agent is text for curl, the start page with the steps for a browser, and never a secret", async (t) => {
  const get = await publicStart(t);
  for (const accept of [undefined, "*/*", "text/plain", "text/markdown"]) {
    const text = await get(`/agent?i=${SECRET}`, { headers: accept ? { Accept: accept } : {} });
    assert.equal(text.status, 200, String(accept));
    assert.equal(text.headers["content-type"], "text/plain; charset=utf-8");
    assert.equal(text.headers["cache-control"], "no-cache");
    assert.equal(text.headers.vary, "Accept");
    assert.equal(text.headers["content-security-policy"] !== undefined, true, "the start page's headers still apply");
    assert.equal(text.body, agentSteps(START, { platform: "darwin" }));
    assert.ok(!text.body.includes(SECRET), "nothing from the request comes back");
  }
  const steps = (await get("/agent")).body;
  assert.match(steps, /^Reach: connect an AI agent to this Mac\n/);
  assert.ok(steps.includes(`Your link starts with ${START}/agent#.`));
  assert.match(steps, /Node\.js 22 or later/);
  assert.ok(steps.includes(stepsCommand(START)) && steps.includes(windowsStepsCommand(START)));
  assert.match(steps, /connection code\. Tell the person who invited you: they approve it in Reach\./);
  assert.match(steps, /it prints what you may do on this Mac and the rules/);
  assert.doesNotMatch(steps, /\binvite=|tskey|[A-Za-z0-9_-]{43}/, "no invitation of any kind");

  const page = await get(`/agent?i=${SECRET}`, { headers: { Accept: BROWSER } });
  assert.equal(page.status, 200);
  assert.equal(page.headers["content-type"], "text/html; charset=utf-8");
  assert.equal(page.headers.vary, "Accept");
  assert.ok(!page.body.includes(SECRET));
  assert.doesNotMatch(page.body, /Opening Reach/, "the steps take the first screen's place");
  assert.match(page.body, /<main id="start" class="start" aria-live="polite"><section id="agent-steps"[^>]*><pre[^>]*>Reach: connect an AI agent to this Mac\n/);
  assert.ok(page.body.includes("L=&#39;&lt;YOUR WHOLE LINK&gt;&#39; &amp;&amp; curl"), "escaped as text");
  assert.ok(page.body.includes('<script type="module" src="/assets/start-abc.js"></script>'), "the page's own script, which shows people what it's for");
  // HEAD: the same headers, no body.
  const head = await get("/agent", { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(head.body, "");
  assert.equal(Number(head.headers["content-length"]), Buffer.byteLength(steps));
  // Everything else on the start page as before.
  assert.equal((await get("/guest", { headers: { Accept: BROWSER } })).body, START_HTML);
  assert.equal((await get("/", { headers: { Accept: "*/*" } })).body, START_HTML);
});

test("the start page's word for the computer, never a hardcoded Mac", () => {
  assert.match(agentSteps(START, { platform: "win32" }), /^Reach: connect an AI agent to this Windows PC\n[\s\S]*from this Windows PC,[\s\S]*on this Windows PC and the rules/);
  assert.doesNotMatch(agentSteps(START, { platform: "linux" }), /\bMac\b(?! ?OS)/);
});

test("the private address (an agent on the owner's tailnet) answers /agent the same way", async (t) => {
  const dist = fs.mkdtempSync(path.join(os.tmpdir(), "reach-agent-private-"));
  fs.writeFileSync(path.join(dist, "start.html"), START_HTML);
  fs.writeFileSync(path.join(dist, "index.html"), "<!doctype html>app");
  let start = START;
  const app = express();
  serveBuild(app, express, dist, { agentStart: () => start, platform: "darwin" });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { server.close(); fs.rmSync(dist, { recursive: true, force: true }); });
  const get = (route, accept) => fetch(`http://127.0.0.1:${server.address().port}${route}`, { headers: accept ? { Accept: accept } : {} })
    .then(async (r) => ({ status: r.status, type: r.headers.get("content-type"), vary: r.headers.get("vary"), body: await r.text() }));
  const text = await get(`/agent?i=${SECRET}`, "*/*");
  assert.equal(text.status, 200);
  assert.match(text.type, /^text\/plain; charset=utf-8/);
  assert.equal(text.vary, "Accept");
  assert.equal(text.body, agentSteps(START, { platform: "darwin" }));
  const page = await get(`/agent?i=${SECRET}`, BROWSER);
  assert.match(page.type, /^text\/html/);
  assert.match(page.body, /<section id="agent-steps"/);
  assert.ok(!text.body.includes(SECRET) && !page.body.includes(SECRET));
  // Not on Tailscale (no start page): the app, as before.
  start = "";
  assert.equal((await get("/agent", BROWSER)).body, "<!doctype html>app");
});

const run = (command, home) => new Promise((resolve) =>
  execFile("/bin/sh", ["-c", command], { env: { ...process.env, HOME: home } }, (error, stdout, stderr) =>
    resolve({ code: error ? error.code ?? 1 : 0, stdout, stderr })));

// The steps as an agent runs them: its whole link in place of the
// placeholder, one command, a runtime served by this computer.
test("the steps install only the runtime the link's r= names, then join with the link on standard input", { skip: process.platform === "win32", timeout: 30000 }, async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "reach-steps-run-"));
  let served = 'let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => console.log("runtime v2:", process.argv.slice(2).join(" "), s.trim()));\n';
  const server = http.createServer((req, res) => res.end(req.url === "/agent.mjs" ? served : ""));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { server.close(); fs.rmSync(home, { recursive: true, force: true }); });
  const start = `http://127.0.0.1:${server.address().port}`;
  const steps = agentSteps(start, { platform: "darwin" });
  const command = steps.split("\n").find((line) => line.trim().startsWith("L='")).trim();
  assert.equal(command, stepsCommand(start));
  const withLink = (link) => {
    assert.ok(!link.includes("'"));
    return command.replace(YOUR_LINK, link);
  };
  const runtime = path.join(home, ".reach-agent", "agent.mjs");
  const linkFor = (r) => `https://mac.t.ts.net/agent#i=${encodeURIComponent(`https://mac.t.ts.net:8443~${SECRET}`)}&t=funnel${r === undefined ? "" : `&r=${r}`}`;

  // As named: installed, then run with the whole link on standard input.
  const link = linkFor(sha(served));
  const ok = await run(withLink(link), home);
  assert.equal(ok.code, 0, ok.stderr);
  assert.equal(ok.stdout.trim(), `runtime v2: join ${link}`, "the link arrives on standard input, never as an argument");
  assert.equal(fs.readFileSync(runtime, "utf8"), served);

  // Something else served: refused, the runtime it had stays, nothing joins.
  const before = fs.readFileSync(runtime, "utf8");
  served = 'console.log("swapped");\n';
  const refused = await run(withLink(linkFor(sha("what the invitation named"))), home);
  assert.notEqual(refused.code, 0);
  assert.match(refused.stderr, /This is not the runtime your invitation names/);
  assert.equal(refused.stdout, "");
  assert.equal(fs.readFileSync(runtime, "utf8"), before);

  // A link without r= (or a broken one): no unchecked download is ever used.
  for (const r of [undefined, "", "not-a-hash", sha(served).toUpperCase()]) {
    const none = await run(withLink(linkFor(r)), home);
    assert.notEqual(none.code, 0, String(r));
    assert.match(none.stderr, /names no runtime|not the runtime/);
    assert.equal(fs.readFileSync(runtime, "utf8"), before);
  }
});

test("Windows: the same steps in PowerShell, checked against the link's r=", () => {
  const command = windowsStepsCommand(START);
  assert.ok(command.startsWith(`$L = '${YOUR_LINK}'; [Net.ServicePointManager]::SecurityProtocol = 'Tls12'; `));
  assert.ok(command.includes(`Invoke-WebRequest -UseBasicParsing -Uri ${START}/agent.mjs -OutFile "$d\\agent.mjs.new"`));
  assert.ok(command.includes(`$r = [regex]::Match($L, '[#&]r=([0-9a-f]{64})(&|$)').Groups[1].Value; if (-not $r -or (Get-FileHash "$d\\agent.mjs.new" -Algorithm SHA256).Hash -ne $r) { throw `));
  assert.ok(command.indexOf("Get-FileHash") < command.indexOf("Move-Item"), "checked before it's put in place");
  assert.ok(command.endsWith(`Move-Item -Force "$d\\agent.mjs.new" "$d\\agent.mjs"; $L | node "$d\\agent.mjs" join`), "the link on standard input");
  assert.equal(command.split(YOUR_LINK).length, 2, "the link goes in once");
  assert.equal(stepsCommand(START).split(YOUR_LINK).length, 2);
});

async function loadTs(file) {
  const { outputText } = ts.transpileModule(await fsp.readFile(new URL(`../src/${file}`, import.meta.url), "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  });
  return import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);
}

test("the link carries the runtime's SHA-256 as r=; the start page and join take it in stride", async () => {
  const { guestLinkUrl, parseGuestLink } = await loadTs("start-flow.ts");
  const { parseAgentLink } = await import("../scripts/agent-remote.mjs");
  const r = "ab".repeat(32);
  const invites = [{ origin: "https://mac.tail1.ts.net:8443", secret: SECRET }];
  const link = guestLinkUrl(START, { key: "", hostname: "", invites, funnel: true, runtime: r }, "/agent");
  assert.ok(link.startsWith(`${START}/agent#i=`) && link.endsWith(`&t=funnel&r=${r}`), link);
  assert.equal(guestLinkUrl(START, { key: "", hostname: "", invites, funnel: true, runtime: "not-a-hash" }, "/agent").includes("r="), false);
  assert.deepEqual(parseGuestLink(new URL(link).hash).invites, invites, "the start page ignores it");
  const parsed = parseAgentLink(link);
  assert.equal(parsed.runtime, r);
  assert.equal(parsed.secret, SECRET);
  assert.equal(parseAgentLink(link.replace(`&r=${r}`, "")).runtime, undefined, "older links have none");
  for (const broken of [`${link.slice(0, -1)}`, link.replace(r, r.toUpperCase()), link.replace(`r=${r}`, "r=")])
    assert.throws(() => parseAgentLink(broken), /incomplete/, broken);
});

test("join refuses a runtime whose SHA-256 isn't the link's r=, before using the invitation", async () => {
  const { runtimeMismatch } = await import("../scripts/agent-remote.mjs");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-join-pin-"));
  const file = path.join(dir, "agent.mjs");
  fs.writeFileSync(file, "// the runtime\n");
  try {
    const r = sha("// the runtime\n");
    assert.equal(runtimeMismatch({ runtime: r }, { file, bundle: true }), false);
    assert.equal(runtimeMismatch({ runtime: sha("another") }, { file, bundle: true }), true);
    assert.equal(runtimeMismatch({ runtime: r }, { file: path.join(dir, "gone.mjs"), bundle: true }), true, "unreadable: refused");
    assert.equal(runtimeMismatch({}, { file, bundle: true }), false, "a link without r=");
    assert.equal(runtimeMismatch({ runtime: sha("another") }, { file, bundle: false }), false, "run from source there's no one file");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// The real bundle an agent downloads: given a link whose r= names another
// runtime, it stops before the invitation is used or anything is made.
test("the bundle's join refuses a link that names another runtime", { timeout: 90000 }, async (t) => {
  const { buildAgent } = await import("../scripts/build-agent.mjs");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-join-bundle-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "agent.mjs");
  await buildAgent(file);
  const home = path.join(dir, "agent-home");
  const join = (link) => new Promise((resolve) => {
    const child = execFile(process.execPath, [file, "join"], { env: { ...process.env, REACH_AGENT_HOME: home } }, (error, stdout, stderr) =>
      resolve({ code: error ? error.code ?? 1 : 0, stdout, stderr }));
    child.stdin.end(link + "\n");
  });
  const link = `https://mac.t.ts.net/agent#i=${encodeURIComponent(`https://mac.t.ts.net:8443~${SECRET}`)}&t=funnel&r=${sha("another runtime")}`;
  const refused = await join(link);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /isn't the runtime your link names\. Open your link and follow its steps again/);
  assert.equal(refused.stdout, "");
  assert.equal(fs.existsSync(home), false, "nothing made, nothing used");
});
