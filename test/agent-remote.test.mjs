import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createReach } from "../server/index.mjs";
import { ALL_SCOPES } from "../server/core.mjs";
import {
  GONE,
  lock,
  parseAgentLink,
  shareNode,
  tailnetApi,
  viaShared,
} from "../scripts/agent-remote.mjs";
import { readTailnetManifest } from "../server/public-start.mjs";

// The agent's side of an invitation: one command joins, MCP serves the tools,
// and stdout carries nothing but results and JSON-RPC.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runtime = path.join(root, "scripts/agent-remote.mjs");
const SECRET = "a".repeat(43);

test("agent links: only /agent links on a tailnet, one computer each", () => {
  const link = parseAgentLink(
    `https://mac.tail1.ts.net/agent#k=tskey-auth-abc123def456&h=rg-ab12-abcdefghij&i=${encodeURIComponent(`https://mac.tail1.ts.net:8443~${SECRET}`)}`,
  );
  assert.deepEqual(link, {
    start: "https://mac.tail1.ts.net",
    origin: "https://mac.tail1.ts.net:8443",
    secret: SECRET,
    key: "tskey-auth-abc123def456",
    hostname: "rg-ab12-abcdefghij",
  });
  const i = `i=https://mac.tail1.ts.net:8443~${SECRET}`;
  for (const bad of [
    `https://mac.tail1.ts.net/guest#${i}`, // a person's link
    `https://evil.example.com/agent#${i}`,
    `http://mac.tail1.ts.net/agent#${i}`,
    `https://mac.tail1.ts.net/agent#i=https://evil.example.com~${SECRET}`,
    `https://mac.tail1.ts.net/agent#i=https://mac.tail1.ts.net:8443~short`,
    `https://mac.tail1.ts.net/agent#${i}&i=https://b.tail1.ts.net:8443~${SECRET}`,
    `http://127.0.0.1:4317/agent#i=http://127.0.0.1:4317~${SECRET}`,
    "not a link",
  ])
    assert.throws(() => parseAgentLink(bad), /agent link/, bad);
  // A bad key or device name is dropped, not trusted.
  const odd = parseAgentLink(
    `https://mac.tail1.ts.net/agent#k=nope&h=../x&${i}`,
  );
  assert.equal(odd.key, "");
  assert.equal(odd.hostname, "");
  assert.equal(
    parseAgentLink(
      `http://127.0.0.1:4317/agent#i=http://127.0.0.1:4317~${SECRET}`,
      {
        allowLocal: true,
      },
    ).origin,
    "http://127.0.0.1:4317",
  );
});

function launch(args, { env = {}, input } = {}) {
    const child = spawn(process.execPath, [runtime, ...args], {
      env: { ...process.env, ...env },
    });
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    const done = new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    });
    child.stdin.end(input);
    return { child, done, output: () => ({ stdout, stderr }) };
}
const run = (args, options) => launch(args, options).done;
async function waitUntil(read, timeout = 10000) {
  const deadline = Date.now() + timeout;
  do {
    const result = read();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 20));
  } while (Date.now() < deadline);
  assert.fail("Timed out waiting for the CLI admission request and verification code");
}

test(
  "a one-time key signs in by itself (guest links, agents), through Node's fetch, never on stdout",
  {
    skip:
      !readTailnetManifest(path.join(root, "tailnet/dist")) &&
      "tailnet client not built",
    timeout: 60000,
  },
  async () => {
    const dir = path.join(root, "tailnet/dist");
    const m = readTailnetManifest(dir);
    // Go disables its HTTP client when process.argv0 starts with "node"; then
    // nothing would ever reach Tailscale. Fetch is stubbed: no network used.
    const script = `
      import { loadTailnet } from ${JSON.stringify(pathToFileURL(runtime).href)};
      const seen = [];
      globalThis.fetch = async (url) => { seen.push(String(url)); throw new TypeError("offline (test)"); };
      const make = await loadTailnet(${JSON.stringify({ execFile: path.join(dir, m.exec), wasmFile: path.join(dir, m.wasm) })});
      const node = make({ hostname: "reach-agent-test", authKey: "tskey-auth-test0000000000", stateStorage: { getState: () => "", setState() {} } });
      node.start({ state() {}, authURL() {} });
      const t0 = Date.now();
      while (!seen.some((u) => u.includes("/key?")) && Date.now() - t0 < 40000) await new Promise((r) => setTimeout(r, 100));
      process.stdout.write(JSON.stringify({ seen, argv0: process.argv0 }) + "\\n");
      process.exit(0);
    `;
    const child = await new Promise((resolve, reject) => {
      const c = spawn(process.execPath, ["--input-type=module", "-e", script]);
      let stdout = "", stderr = "";
      c.stdout.on("data", (d) => (stdout += d));
      c.stderr.on("data", (d) => (stderr += d));
      c.on("error", reject);
      c.on("close", (code) => resolve({ code, stdout, stderr }));
    });
    assert.equal(child.code, 0, child.stderr);
    const lines = child.stdout.trim().split("\n");
    assert.equal(lines.length, 1, `stdout must stay clean: ${child.stdout}`);
    const result = JSON.parse(lines[0]);
    assert.ok(
      result.seen.some((u) =>
        /^https:\/\/controlplane\.tailscale\.com\/key\?/.test(u),
      ),
      JSON.stringify(result.seen),
    );
    assert.match(result.argv0, /node/, "the real process is back afterwards");
  },
);

test(
  "join once, then MCP: the agent's folder and access, and nothing else on stdout",
  { skip: process.platform === "win32", timeout: 60000 },
  async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-agent-remote-"));
    const files = path.join(dir, "files");
    fs.mkdirSync(path.join(files, "acme"), { recursive: true });
    fs.mkdirSync(path.join(files, "other"));
    fs.writeFileSync(path.join(files, "acme/brief.txt"), "the brief");
    const reach = await createReach({
      roots: [files],
      dataDir: path.join(dir, "private"),
      agentPolicyFile: path.join(dir, "none.json"),
    });
    await new Promise((r) => reach.server.listen(0, "127.0.0.1", r));
    t.after(async () => {
      await reach.close();
      fs.rmSync(dir, { recursive: true, force: true });
    });
    const owner = reach.auth.issue("owner", ALL_SCOPES);
    const origin = `http://127.0.0.1:${reach.server.address().port}`;
    const grant = reach.auth.inviteAgent({
      name: "Builder",
      ttlSeconds: 3600,
      folders: [{ root: 0, path: "acme" }],
      exec: true,
    });
    const link = `${origin}/agent#i=${encodeURIComponent(`${origin}~${grant.invitation}`)}`;
    const env = { REACH_AGENT_HOME: path.join(dir, "agent-home") };

    // The link can come on stdin (kept out of the shell history).
    const joining = launch(["join", "--allow-local"], { env, input: link });
    t.after(() => joining.child.kill());
    const admission = await waitUntil(() => {
      const request = reach.auth.listAgentAdmissions().find((entry) => entry.clientId === grant.clientId);
      return request && joining.output().stderr.includes(request.verificationCode) ? request : null;
    });
    assert.equal(joining.output().stdout, "", "no successful connection output before owner approval");
    assert.equal(fs.existsSync(path.join(env.REACH_AGENT_HOME, "127", "credential.json")), false);
    const approved = await fetch(`${origin}/api/agents/admissions/${admission.id || admission.requestId}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${owner.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ decision: "approve" }),
    });
    assert.equal(approved.status, 200, await approved.text());
    const joined = await joining.done;
    assert.equal(joined.code, 0, joined.stderr);
    assert.match(joined.stdout, /Connected to /);
    assert.match(
      joined.stdout,
      new RegExp(
        `claude mcp add --scope user reach -- node ${runtime.replace(/[/.]/g, "\\$&")} mcp`,
      ),
    );
    assert.match(joined.stdout, /codex mcp add reach -- node /);
    const conn = path.join(env.REACH_AGENT_HOME, "127");
    const credentialFile = path.join(conn, "credential.json");
    if (process.platform !== "win32") assert.equal(fs.statSync(env.REACH_AGENT_HOME).mode & 0o777, 0o700);
    if (process.platform !== "win32") assert.equal(fs.statSync(credentialFile).mode & 0o777, 0o600);
    const credential = JSON.parse(fs.readFileSync(credentialFile, "utf8"));
    assert.equal(credential.via, "direct");
    assert.equal(credential.clientId, grant.clientId);
    assert.deepEqual(credential.scopes, ["device", "files:read", "exec"]);
    // Used once: the same link can't join again, even after leaving.
    const again = await run(["join", link, "--allow-local"], { env });
    assert.equal(again.code, 1);
    assert.match(again.stderr, /Already connected/);

    const rpc = [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "reach_read_file", arguments: { path: "brief.txt" } },
      },
      {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "reach_list_files", arguments: { path: "../other" } },
      },
    ];
    const mcp = await run(["mcp", "--allow-local"], {
      env,
      input: rpc.map((m) => JSON.stringify(m)).join("\n") + "\n",
    });
    assert.equal(mcp.code, 0, mcp.stderr);
    const replies = mcp.stdout
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    const by = Object.fromEntries(replies.map((r) => [r.id, r]));
    assert.equal(by[1].result.serverInfo.name, "reach-127");
    const names = by[2].result.tools.map((x) => x.name);
    assert.ok(
      names.includes("reach_read_file") && names.includes("reach_run_command"),
    );
    assert.ok(!names.includes("reach_write_file"), "no edits were granted");
    assert.match(by[3].result.content[0].text, /the brief/);
    assert.equal(by[4].result.isError, true, "nothing beside its folder");

    // A large result arrives whole (the process waits for its output).
    fs.writeFileSync(path.join(files, "acme/big.txt"), "x".repeat(300_000));
    const big = await run(
      ["call", "reach_read_file", '{"path":"big.txt"}', "--allow-local"],
      { env },
    );
    assert.equal(big.code, 0, big.stderr);
    assert.equal(JSON.parse(big.stdout).text.length, 300_000);

    const once = await run(["call", "reach_device", "{}", "--allow-local"], {
      env,
    });
    assert.equal(once.code, 0, once.stderr);
    assert.equal(JSON.parse(once.stdout).roots.length, 1);

    // A join cut short elsewhere leaves a placeholder: not a connection.
    fs.mkdirSync(path.join(env.REACH_AGENT_HOME, "half"), { mode: 0o700 });
    fs.writeFileSync(
      path.join(env.REACH_AGENT_HOME, "half/credential.json"),
      "{}",
      { mode: 0o600 },
    );
    const status = await run(["status"], { env });
    assert.equal(status.code, 0, status.stderr);
    assert.deepEqual(
      JSON.parse(status.stdout).map((x) => x.name),
      ["127"],
    );

    const left = await run(["leave"], { env });
    assert.equal(left.code, 0, left.stderr);
    assert.equal(fs.existsSync(conn), false);
    const reused = await run(["join", link, "--allow-local"], { env });
    assert.equal(reused.code, 1);
    assert.match(
      reused.stderr,
      /expired, was revoked, or has already been used/,
    );
    assert.equal(fs.existsSync(conn), false, "a failed join leaves nothing");
  },
);

test("a denied CLI invitation never saves an active credential or connection", { timeout: 20000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-agent-denied-"));
  const reach = await createReach({ roots: [dir], dataDir: path.join(dir, "private"), agentPolicyFile: path.join(dir, "none.json") });
  await new Promise((resolve) => reach.server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { await reach.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const owner = reach.auth.issue("Owner", ALL_SCOPES);
  const origin = `http://127.0.0.1:${reach.server.address().port}`;
  const grant = reach.auth.inviteAgent({ name: "Builder", ttlSeconds: 600, folders: [{ root: 0, path: "" }] });
  const env = { REACH_AGENT_HOME: path.join(dir, "agent-home") };
  const joining = launch(["join", "--allow-local"], { env, input: `${origin}/agent#i=${encodeURIComponent(`${origin}~${grant.invitation}`)}` });
  t.after(() => joining.child.kill());
  const admission = await waitUntil(() => {
    const request = reach.auth.listAgentAdmissions().find((entry) => entry.clientId === grant.clientId);
    return request && joining.output().stderr.includes(request.verificationCode) ? request : null;
  });
  assert.equal(joining.output().stdout, "");
  assert.equal(fs.existsSync(path.join(env.REACH_AGENT_HOME, "127", "credential.json")), false);
  const denied = await fetch(`${origin}/api/agents/admissions/${admission.id || admission.requestId}`, {
    method: "POST", headers: { Authorization: `Bearer ${owner.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ decision: "deny" }),
  });
  assert.equal(denied.status, 200, await denied.text());
  const result = await joining.done;
  assert.equal(result.code, 1);
  assert.match(result.stderr, /denied/i);
  assert.equal(result.stdout, "");
  assert.equal(fs.existsSync(path.join(env.REACH_AGENT_HOME, "127")), false);
  assert.equal(reach.auth.list().some((client) => client.id === grant.clientId && client.status === "accepted"), false);
});

test(
  "one connection per computer, shared: a second agent session uses it, and takes over when it's gone",
  { skip: process.platform === "win32" },
  async () => {
    const conn = fs.mkdtempSync(path.join(os.tmpdir(), "reach-agent-share-"));
    try {
      // Held by a live process (not us): not ours to take.
      fs.writeFileSync(path.join(conn, "lock"), String(process.ppid));
      assert.equal(lock(conn), false);
      // Its holder died: ours.
      fs.writeFileSync(path.join(conn, "lock"), "999999");
      assert.equal(lock(conn), true);
      assert.equal(
        fs.readFileSync(path.join(conn, "lock"), "utf8"),
        String(process.pid),
      );
      const seen = [];
      const server = shareNode(conn, async (route, method, body) => {
        seen.push([route, method, body]);
        if (route === "/api/fail")
          throw Error("This credential does not grant exec access.");
        if (route === "/api/busy") throw Object.assign(Error("Agent B is using the Mac."), { status: 409, body: { kind: "busy", holder: "Agent B", retryInMs: 900, secret: "must not cross" } });
        if (route === "/api/slow") return new Promise(() => {});
        return { ok: route };
      });
      const open = new Set();
      server.on("connection", (socket) => open.add(socket));
      await once(server, "listening");
      if (process.platform !== "win32") assert.equal(
        fs.statSync(path.join(conn, "agent.sock")).mode & 0o777,
        0o600,
      );
      const api = viaShared(conn);
      const [a, b] = await Promise.all([
        api("/api/device"),
        api("/api/jobs", "POST", { command: "pwd" }),
      ]);
      assert.deepEqual([a, b], [{ ok: "/api/device" }, { ok: "/api/jobs" }]);
      assert.deepEqual(seen[1], ["/api/jobs", "POST", { command: "pwd" }]);
      await assert.rejects(api("/api/fail"), /does not grant exec/);
      await assert.rejects(api("/api/busy"), error => {
        assert.deepEqual(error.body, { error: "Agent B is using the Mac.", status: 409, kind: "busy", holder: "Agent B", retryInMs: 900 });
        return true;
      });
      // The holder ends (its process exits): callers learn it's gone, then
      // hold the connection themselves.
      const pending = api("/api/slow");
      await new Promise((r) => setTimeout(r, 20));
      for (const socket of open) socket.destroy();
      server.close();
      fs.rmSync(path.join(conn, "agent.sock"), { force: true });
      await assert.rejects(pending, (e) => e.code === GONE);
      await assert.rejects(api("/api/device"), (e) => e.code === GONE);
    } finally {
      fs.rmSync(conn, { recursive: true, force: true });
    }
  },
);

// A node shaped like the Go client: fetch → { response: Promise<head>, abort }.
function fakeNode(answer) {
  const calls = [];
  return {
    calls,
    fetch(req) {
      calls.push(req);
      let abort = () => {};
      const response = new Promise((resolve, reject) => {
        abort = () => reject(Error("context canceled"));
        const head = answer(req);
        if (head) resolve(head);
      });
      return { response, abort: () => abort() };
    },
  };
}
const head = (status, chunks, cancelled = {}) => ({
  status,
  headers: ["content-type", "application/json"],
  read: async () => chunks.shift() ?? null,
  cancel: () => (cancelled.yes = true),
});
const bytes = (v) => new TextEncoder().encode(JSON.stringify(v));

test("requests through the agent's own node: credential, body, errors, size cap, timeout", async () => {
  const origin = "https://mac.tail1.ts.net:8443";
  // Using the invitation: no credential yet.
  const node = fakeNode(() => head(200, [bytes({ token: "t" })]));
  const redeem = tailnetApi(node, origin, "");
  assert.deepEqual(
    await redeem("/api/invitations/redeem", "POST", { invitation: SECRET }),
    { token: "t" },
  );
  const sent = node.calls[0];
  assert.equal(sent.url, `${origin}/api/invitations/redeem`);
  assert.equal(sent.method, "POST");
  assert.equal(sent.redirect, "error");
  assert.ok(!sent.headers.includes("Authorization"));
  assert.equal(
    new TextDecoder().decode(sent.body),
    JSON.stringify({ invitation: SECRET }),
  );
  // With it: sent on every request; results can come in several pieces.
  const enc = (t) => new TextEncoder().encode(t);
  const two = fakeNode(() => head(200, [enc('{"items":'), enc("[1,2]}")]));
  assert.deepEqual(await tailnetApi(two, origin, "tok")("/api/files?root=0"), {
    items: [1, 2],
  });
  assert.deepEqual(two.calls[0].headers.slice(0, 2), [
    "Authorization",
    "Bearer tok",
  ]);
  assert.equal(two.calls[0].body, undefined);
  // The computer's own refusal comes through as it said it.
  const no = fakeNode(() =>
    head(403, [
      bytes({ error: "This credential does not grant exec access." }),
    ]),
  );
  await assert.rejects(
    tailnetApi(no, origin, "tok")("/api/jobs", "POST", {}),
    /does not grant exec access/,
  );
  // Never more than 2 MiB.
  const cancelled = {};
  const big = fakeNode(() =>
    head(
      200,
      Array.from({ length: 4 }, () => new Uint8Array(1024 * 1024)),
      cancelled,
    ),
  );
  await assert.rejects(
    tailnetApi(big, origin, "tok")("/api/files/text?path=x"),
    /exceeds 2 MiB/,
  );
  assert.equal(cancelled.yes, true);
  // No answer: given up, and said plainly.
  const silent = fakeNode(() => null);
  await assert.rejects(
    tailnetApi(silent, origin, "tok", { timeoutMs: 30 })("/api/device"),
    /timed out/,
  );
  await assert.rejects(
    tailnetApi(silent, origin, "tok")("https://evil.example/api/x"),
    /Invalid API route/,
  );
});
