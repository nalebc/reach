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
// never replaces the runtime the agent already has.
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

  // Without a hash (an older computer): the plain download.
  assert.equal(toolsCommand(start, link), `curl -fsSL --create-dirs -o ~/.reach-agent/agent.mjs ${start}/agent.mjs && printf '%s\\n' '${link}' | node ~/.reach-agent/agent.mjs join`);
  // The link is never an argument of a process (security audit L5).
  assert.doesNotMatch(toolsCommand(start, link, sha(served)), /agent\.mjs join '/);
  assert.equal(toolsCommand(start, link, "not-a-hash"), toolsCommand(start, link));
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

// Any laptop: on Windows the same join, in PowerShell (no curl, printf or ~),
// and the runtime shares its connection through a named pipe.
test("Windows: the join in PowerShell, checked the same way; the runtime's pipe and quoting", async () => {
  const start = "https://mac.t.ts.net", link = "https://mac.t.ts.net/agent#i=x&t=funnel", sha = "a".repeat(64);
  const pinned = windowsToolsCommand(start, link, sha);
  assert.equal(pinned, `[Net.ServicePointManager]::SecurityProtocol = 'Tls12'; $d = "$HOME\\.reach-agent"; New-Item -ItemType Directory -Force $d | Out-Null; Invoke-WebRequest -UseBasicParsing -Uri ${start}/agent.mjs -OutFile "$d\\agent.mjs.new"; if ((Get-FileHash "$d\\agent.mjs.new" -Algorithm SHA256).Hash -ne '${sha}') { throw 'This is not the runtime your invitation names. Ask for a new invitation.' }; Move-Item -Force "$d\\agent.mjs.new" "$d\\agent.mjs"; '${link}' | node "$d\\agent.mjs" join`);
  assert.doesNotMatch(windowsToolsCommand(start, link), /Get-FileHash/, "an older computer: no hash to check");
  assert.doesNotMatch(pinned, /join '/, "the link goes in on standard input");
  const { socketOf, quote } = await import("../scripts/agent-remote.mjs");
  assert.match(socketOf("C:\\Users\\me\\.reach-agent\\mac", "win32"), /^\\\\\.\\pipe\\reach-agent-[0-9a-f]{24}$/);
  assert.equal(socketOf("/home/me/.reach-agent/mac", "linux"), "/home/me/.reach-agent/mac/agent.sock");
  assert.equal(quote("C:\\Users\\Jane Doe\\.reach-agent\\agent.mjs", "win32"), '"C:\\Users\\Jane Doe\\.reach-agent\\agent.mjs"');
  assert.equal(quote("/home/jane/.reach-agent/agent.mjs", "linux"), "/home/jane/.reach-agent/agent.mjs");
});
