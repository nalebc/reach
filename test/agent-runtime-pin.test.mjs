import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { startDom } from "./dom/harness.mjs";

// Security audit M8: an agent's join command carries the SHA-256 of the
// runtime the inviting computer serves. A download that isn't exactly it
// never replaces the runtime the agent already has, and with no hash there's
// no command (connections audit, Oct 10).
let dom, toolsCommand, windowsToolsCommand;
before(async () => {
  dom = await startDom();
  ({ toolsCommand, windowsToolsCommand } = await dom.load("/src/BrowserInvite.tsx"));
});
after(async () => dom?.close());

const run = (command, home) => new Promise((resolve) =>
  execFile("/bin/sh", ["-c", command], { env: { ...process.env, HOME: home } }, (error, stdout, stderr) =>
    resolve({ code: error ? error.code ?? 1 : 0, stdout, stderr })));

test("the join command installs only the runtime its invitation names", { skip: process.platform === "win32", timeout: 30000 }, async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "reach-pin-"));
  let served = 'let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => console.log("runtime v2:", process.argv.slice(2).join(" "), s.trim()));\n';
  const server = http.createServer((req, res) => res.end(req.url === "/agent.mjs" ? served : ""));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => { server.close(); fs.rmSync(home, { recursive: true, force: true }); });
  const start = `http://127.0.0.1:${server.address().port}`;
  const link = "https://mac.t.ts.net/agent#i=x";
  const runtime = path.join(home, ".reach-agent", "agent.mjs");
  const sha = (text) => crypto.createHash("sha256").update(text).digest("hex");

  // As named: installed, then run with the link.
  const ok = await run(toolsCommand(start, link, sha(served)), home);
  assert.equal(ok.code, 0, ok.stderr);
  assert.match(ok.stdout, /runtime v2: join https:\/\/mac\.t\.ts\.net\/agent#i=x/, "the link arrives on standard input");
  assert.equal(fs.readFileSync(runtime, "utf8"), served);

  // Something else served: refused, and the agent keeps the runtime it had.
  const before = fs.readFileSync(runtime, "utf8");
  served = 'console.log("swapped");\n';
  const refused = await run(toolsCommand(start, link, sha("what the invitation named")), home);
  assert.notEqual(refused.code, 0);
  assert.match(refused.stderr, /not the runtime your invitation names/);
  assert.doesNotMatch(refused.stdout, /swapped/);
  assert.equal(fs.readFileSync(runtime, "utf8"), before);

  // Without a hash (an older computer): no command at all, never an
  // unchecked download (connections audit, Oct 10).
  for (const missing of [undefined, "", "not-a-hash"])
    assert.throws(() => toolsCommand(start, link, missing), /Update Reach on that computer/);
  // The link is never an argument of a process (security audit L5).
  assert.doesNotMatch(toolsCommand(start, link, sha(served)), /agent\.mjs join '/);
});

test("an agent invitation carries the SHA-256 of the runtime this computer serves", { timeout: 30000 }, async (t) => {
  const { createReach } = await import("../server/index.mjs");
  const { ALL_SCOPES } = await import("../server/core.mjs");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-pin-srv-"));
  const agentRuntimeFile = path.join(dir, "agent.mjs");
  fs.writeFileSync(agentRuntimeFile, "// the runtime\n");
  const reach = await createReach({ roots: [dir], dataDir: path.join(dir, "private"), port: 0, agentRuntimeFile, agentPolicyFile: path.join(dir, "none.json") });
  await new Promise((r) => reach.server.listen(0, "127.0.0.1", r));
  t.after(async () => { await reach.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const owner = reach.auth.issue("owner", ALL_SCOPES);
  // Node's own HTTP: the DOM harness above stands in for fetch.
  const post = (route, body) => new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: reach.server.address().port, path: route, method: "POST",
      headers: { Authorization: `Bearer ${owner.token}`, "Content-Type": "application/json" } }, (res) => {
      let text = "";
      res.on("data", (c) => (text += c));
      res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(text || "null") }));
    });
    req.once("error", reject);
    req.end(JSON.stringify(body));
  });
  const made = await post("/api/agents/invitations", { name: "Builder", ttlSeconds: 3600, folders: [{ root: 0, path: "" }] });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  assert.equal(made.body.runtime, crypto.createHash("sha256").update("// the runtime\n").digest("hex"));
  // Rebuilt: the next invitation names the new one.
  fs.writeFileSync(agentRuntimeFile, "// rebuilt\n");
  fs.utimesSync(agentRuntimeFile, new Date(), new Date(Date.now() + 5000));
  const again = await post("/api/agents/invitations", { name: "Builder 2", ttlSeconds: 3600, folders: [{ root: 0, path: "" }] });
  assert.equal(again.body.runtime, crypto.createHash("sha256").update("// rebuilt\n").digest("hex"));
});

// An admitted agent on an older runtime sees the computer's (its hash on
// /api/device) and fetches it, hashed from the very bytes sent. Only agents.
test("an admitted agent is told the runtime's hash and may fetch exactly those bytes", { timeout: 30000 }, async (t) => {
  const { createReach } = await import("../server/index.mjs");
  const { ALL_SCOPES } = await import("../server/core.mjs");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-runtime-srv-"));
  const agentRuntimeFile = path.join(dir, "agent.mjs");
  const text = "// the runtime: é\n";
  fs.writeFileSync(agentRuntimeFile, text);
  const reach = await createReach({ roots: [dir], dataDir: path.join(dir, "private"), port: 0, agentRuntimeFile, agentPolicyFile: path.join(dir, "none.json") });
  await new Promise((r) => reach.server.listen(0, "127.0.0.1", r));
  t.after(async () => { await reach.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const owner = reach.auth.issue("owner", ALL_SCOPES);
  const agent = reach.auth.issue("Builder", ["files:read"], "agent");
  const get = (route, token) => new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port: reach.server.address().port, path: route, headers: { Authorization: `Bearer ${token}` } }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(body || "null") }));
    }).once("error", reject);
  });
  const sha = crypto.createHash("sha256").update(text).digest("hex");
  assert.equal((await get("/api/device", agent.token)).body.runtime, sha);
  assert.equal((await get("/api/device", owner.token)).body.runtime, undefined, "only agents are told");
  const fetched = await get("/api/device/runtime", agent.token);
  assert.equal(fetched.status, 200);
  assert.deepEqual(fetched.body, { sha256: sha, text });
  assert.equal((await get("/api/device/runtime", owner.token)).status, 403, "only an agent fetches it");
  fs.rmSync(agentRuntimeFile);
  assert.equal((await get("/api/device/runtime", agent.token)).status, 404);
});

// Any laptop: on Windows the same join, in PowerShell (no curl, printf or ~),
// and the runtime shares its connection through a named pipe.
test("Windows: the join in PowerShell, checked the same way; the runtime's pipe and quoting", async () => {
  const start = "https://mac.t.ts.net", link = "https://mac.t.ts.net/agent#i=x&t=funnel", sha = "a".repeat(64);
  const pinned = windowsToolsCommand(start, link, sha);
  assert.equal(pinned, `[Net.ServicePointManager]::SecurityProtocol = 'Tls12'; $d = "$HOME\\.reach-agent"; New-Item -ItemType Directory -Force $d | Out-Null; Invoke-WebRequest -UseBasicParsing -Uri ${start}/agent.mjs -OutFile "$d\\agent.mjs.new"; if ((Get-FileHash "$d\\agent.mjs.new" -Algorithm SHA256).Hash -ne '${sha}') { throw 'This is not the runtime your invitation names. Ask for a new invitation.' }; Move-Item -Force "$d\\agent.mjs.new" "$d\\agent.mjs"; '${link}' | node "$d\\agent.mjs" join`);
  assert.throws(() => windowsToolsCommand(start, link), /Update Reach on that computer/, "an older computer: no unchecked command");
  assert.doesNotMatch(pinned, /join '/, "the link goes in on standard input");
  const { socketOf, quote } = await import("../scripts/agent-remote.mjs");
  assert.match(socketOf("C:\\Users\\me\\.reach-agent\\mac", "win32"), /^\\\\\.\\pipe\\reach-agent-[0-9a-f]{24}$/);
  assert.equal(socketOf("/home/me/.reach-agent/mac", "linux"), "/home/me/.reach-agent/mac/agent.sock");
  assert.equal(quote("C:\\Users\\Jane Doe\\.reach-agent\\agent.mjs", "win32"), '"C:\\Users\\Jane Doe\\.reach-agent\\agent.mjs"');
  assert.equal(quote("/home/jane/.reach-agent/agent.mjs", "linux"), "/home/jane/.reach-agent/agent.mjs");
});

// Connections audit, Oct 10: every download an agent runs is checked. The
// tailnet client against the hashes its runtime carries (or, run from source,
// the hash its file names carry); a line from `keep` restores with exactly the
// runtime it was kept with, which the computer keeps serving by its hash.
test("the tailnet client runs only as its runtime pins it", async () => {
  const { tailnetFileTrusted } = await import("../scripts/agent-remote.mjs");
  const sha = (text) => crypto.createHash("sha256").update(text).digest("hex");
  const wasm = "the client", exec = "its loader";
  const pins = { wasm: { name: "reach-tailnet.0a0ddf611b0a.wasm", sha256: sha(wasm) }, exec: { name: "wasm_exec.0c949f4996f9.js", sha256: sha(exec) } };
  assert.equal(tailnetFileTrusted(pins.wasm.name, Buffer.from(wasm), pins), true);
  assert.equal(tailnetFileTrusted(pins.exec.name, Buffer.from(exec), pins), true);
  assert.equal(tailnetFileTrusted(pins.wasm.name, Buffer.from("swapped"), pins), false);
  assert.equal(tailnetFileTrusted("reach-tailnet.ffffffffffff.wasm", Buffer.from(wasm), pins), false, "a name the runtime doesn't pin");
  // From source: the hash in its name.
  const named = `reach-tailnet.${sha(wasm).slice(0, 12)}.wasm`;
  assert.equal(tailnetFileTrusted(named, Buffer.from(wasm), null), true);
  assert.equal(tailnetFileTrusted(named, Buffer.from("swapped"), null), false);
  assert.equal(tailnetFileTrusted("reach-tailnet.wasm", Buffer.from(wasm), null), false);
});

test("a kept line restores with exactly the runtime it was kept with", { skip: process.platform === "win32", timeout: 30000 }, async (t) => {
  const { restoreCommand } = await import("../scripts/agent-remote.mjs");
  const { keepRuntime } = await import("../server/runtime-archive.mjs");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-restore-pin-"));
  const home = path.join(dir, "home");
  fs.mkdirSync(home);
  const dist = path.join(dir, "dist");
  fs.mkdirSync(dist);
  const sha = (text) => crypto.createHash("sha256").update(text).digest("hex");
  const v1 = 'let s="";process.stdin.on("data",(d)=>(s+=d)).on("end",()=>console.log("v1", process.argv.slice(2).join(" "), s.trim()));\n';
  fs.writeFileSync(path.join(dist, "agent.mjs"), v1);
  assert.equal(keepRuntime(path.join(dist, "agent.mjs")), `${sha(v1)}.mjs`);
  // Reach changed since: the computer serves v2, and still v1 by its hash.
  fs.writeFileSync(path.join(dist, "agent.mjs"), 'console.log("v2");\n');
  keepRuntime(path.join(dist, "agent.mjs"));
  const server = http.createServer((req, res) => {
    const file = path.join(dist, decodeURIComponent(req.url.slice(1)));
    if (!file.startsWith(dist + path.sep) || !fs.existsSync(file)) { res.writeHead(404); return res.end(); }
    res.end(fs.readFileSync(file));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const start = `http://127.0.0.1:${server.address().port}`;
  const ok = await run(`printf 'the line\\n' | (${restoreCommand(start, "", sha(v1)).replace("node ~/.reach-agent/agent.mjs restore", "node ~/.reach-agent/agent.mjs restore")})`, home);
  assert.equal(ok.code, 0, ok.stderr);
  assert.match(ok.stdout, /^v1 restore the line/);
  // A runtime the computer doesn't keep, or other bytes under its name: nothing replaced.
  const before = fs.readFileSync(path.join(home, ".reach-agent", "agent.mjs"), "utf8");
  fs.writeFileSync(path.join(dist, "agent-runtimes", `${sha(v1)}.mjs`), 'console.log("swapped");\n');
  const swapped = await run(restoreCommand(start, "", sha(v1)), home);
  assert.notEqual(swapped.code, 0);
  assert.match(swapped.stderr, /not the runtime your line was kept with/);
  assert.equal(fs.readFileSync(path.join(home, ".reach-agent", "agent.mjs"), "utf8"), before);
  assert.notEqual((await run(restoreCommand(start, "", "ef".repeat(32)), home)).code, 0);
  // Run from source (no runtime to name): the plain download, as before.
  assert.equal(restoreCommand("https://mac.t.ts.net", "AbCd", ""), "curl -fsSL --create-dirs -H 'Reach-Key: AbCd' -o ~/.reach-agent/agent.mjs https://mac.t.ts.net/agent.mjs && node ~/.reach-agent/agent.mjs restore");
});

test("kept runtimes: the current one always, the newest 50 from the last 90 days", async () => {
  const { keepRuntime } = await import("../server/runtime-archive.mjs");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-kept-"));
  try {
    const file = path.join(dir, "agent.mjs");
    const kept = path.join(dir, "agent-runtimes");
    const now = Date.now();
    for (let i = 0; i < 55; i++) {
      fs.writeFileSync(file, `// build ${i}\n`);
      const name = keepRuntime(file, { now: now - (55 - i) * 1000 });
      fs.utimesSync(path.join(kept, name), new Date(now - (55 - i) * 1000), new Date(now - (55 - i) * 1000));
    }
    assert.equal(fs.readdirSync(kept).length, 50);
    // Old ones go after 90 days, never the current one.
    fs.writeFileSync(file, "// today\n");
    const current = keepRuntime(file, { now: now + 91 * 86400000 });
    assert.deepEqual(fs.readdirSync(kept), [current]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the built runtime carries the tailnet client's hashes, keeps itself by hash, and `keep` names it", { skip: process.platform === "win32", timeout: 120000 }, async () => {
  const { buildAgent, tailnetPins } = await import("../scripts/build-agent.mjs");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-built-pin-"));
  try {
    const outfile = path.join(dir, "agent.mjs");
    await buildAgent(outfile);
    const bytes = fs.readFileSync(outfile);
    const sha = crypto.createHash("sha256").update(bytes).digest("hex");
    assert.ok(fs.existsSync(path.join(dir, "agent-runtimes", `${sha}.mjs`)), "kept by its hash");
    const pins = tailnetPins();
    if (pins) for (const p of [pins.exec, pins.wasm]) assert.ok(bytes.includes(p.sha256), `pins ${p.name}`);
    const home = path.join(dir, "home");
    const conn = path.join(home, "mac");
    fs.mkdirSync(conn, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(conn, "credential.json"), JSON.stringify({ version: 1, via: "tailnet", computer: "Fixture Mac", start: "https://mac.t.ts.net", origin: "https://mac.t.ts.net:8443",
      token: "t".repeat(43), clientId: "c1", scopes: ["device"], expiresAt: Date.now() + 86400_000, joinedAt: new Date().toISOString() }), { mode: 0o600 });
    const kept = await new Promise((resolve) => execFile(process.execPath, [outfile, "keep", "--computer", "mac"], { env: { ...process.env, REACH_AGENT_HOME: home, REACH_AGENT_UPDATES: "off" } },
      (error, stdout, stderr) => resolve({ code: error ? error.code ?? 1 : 0, stdout, stderr })));
    assert.equal(kept.code, 0, kept.stderr);
    assert.ok(kept.stderr.includes(`https://mac.t.ts.net/agent-runtimes/${sha}.mjs`), kept.stderr);
    assert.ok(kept.stderr.includes(`~/.reach-agent/agent.mjs.new ${sha} && mv`), "checked before it replaces anything");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
