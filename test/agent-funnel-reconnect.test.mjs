import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import net from "node:net";
import { PassThrough } from "node:stream";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createAuth } from "../server/core.mjs";
import { agentKey, funnelApi, funnelGateway } from "../scripts/agent-funnel.mjs";
import { GONE, viaShared } from "../scripts/agent-remote.mjs";

// Real persisted admissions and credentials, with the HTTP transport mocked.
// These recovery rules apply on both macOS and Windows without native input.
function fixture(t) {
  const conn = fs.realpathSync.native(fs.mkdtempSync(path.join(process.platform === "win32" ? os.tmpdir() : "/tmp", "reach-funnel-reconnect-")));
  t.after(() => fs.rmSync(conn, { recursive: true, force: true }));
  const auth = createAuth({ dataDir: path.join(conn, "state"), roots: [conn], agentPolicyFile: path.join(conn, "policy.json") });
  const key = agentKey(conn);
  const grant = auth.inviteBrowser({ name: "Researcher", transport: "funnel", preset: "readonly", standing: true });
  const claim = auth.redeemFunnelBrowser(grant.invitation, key.thumbprint);
  auth.decideAgentAdmission(claim.requestId, "approve");
  const access = auth.pollFunnelAdmission(claim.requestId, claim.requestSecret, key.thumbprint);
  const credential = { origin: "https://mac.fixture.ts.net", invitation: grant.invitation, token: access.token, expiresAt: access.expiresAt };
  const saved = [];
  let reconnects = 0, dispatched = 0;
  const reply = (status, json, headers = {}) => ({ status, json, headers, bytes: Buffer.from(JSON.stringify(json)) });
  const exchange = (status, run) => {
    try { return reply(status, run()); }
    catch (error) { return reply(error.status || 500, { error: error.message }, { "reach-not-run": "1" }); }
  };
  const gateway = {
    async request(token) {
      if (!auth.verifyFunnel(token, key.thumbprint))
        return reply(401, { error: "This invitation or session is invalid, expired, or belongs to another browser." }, { "reach-not-run": "1" });
      dispatched++;
      return reply(200, { ok: true });
    },
    async reconnect(invitation) {
      reconnects++;
      return exchange(202, () => auth.reconnectFunnelBrowser(invitation, key.thumbprint));
    },
    async status(id, secret) {
      return exchange(200, () => auth.pollFunnelAdmission(id, secret, key.thumbprint));
    },
  };
  const api = (extra = {}) => funnelApi({ conn, credential, key, gateway, save: (next) => saved.push(next.token), ...extra });
  return { conn, auth, key, grant, credential, gateway, reply, api, saved, reconnects: () => reconnects, dispatched: () => dispatched };
}

test("concurrent refused agent calls share one reconnect and all resume their valid Always grant", async (t) => {
  const f = fixture(t);
  f.auth.reopenBrowserInvitation(f.grant.clientId);
  const api = f.api();
  const results = await Promise.allSettled([api("/api/browser"), api("/api/device"), api("/api/browser")]);
  assert.deepEqual(results.map((r) => r.status), ["fulfilled", "fulfilled", "fulfilled"]);
  assert.equal(f.reconnects(), 1, "one renewal; competing renewals invalidate each other's receipt");
  assert.equal(f.saved.length, 1);
  assert.equal(f.dispatched(), 3);
  assert.ok(f.auth.verifyFunnel(f.credential.token, f.key.thumbprint));
  assert.ok(f.credential.expiresAt > Date.now() + 9 * 365 * 86400_000);
});

test("a late rejection adopts the token another call already renewed", async (t) => {
  const f = fixture(t);
  f.auth.reopenBrowserInvitation(f.grant.clientId);
  const delayed = Promise.withResolvers();
  const started = Promise.withResolvers();
  const request = f.gateway.request;
  f.gateway.request = async (...args) => {
    const response = await request(...args);
    if (args[2] === "/api/device" && response.status === 401) {
      started.resolve();
      await delayed.promise;
    }
    return response;
  };
  const api = f.api();
  const slow = api("/api/device");
  await started.promise;
  try { assert.deepEqual(await api("/api/browser"), { ok: true }); }
  finally { delayed.resolve(); }
  assert.deepEqual(await slow, { ok: true });
  assert.equal(f.reconnects(), 1, "a delayed old rejection must not invalidate the new session");
});

test("after rejection an agent reloads a credential another process saved before reconnecting", async (t) => {
  const f = fixture(t);
  f.auth.reopenBrowserInvitation(f.grant.clientId);
  let savedToken = f.credential.token;
  const request = f.gateway.request;
  f.gateway.request = async (...args) => {
    const response = await request(...args);
    if (response.status === 401) {
      const receipt = f.auth.reconnectFunnelBrowser(f.grant.invitation, f.key.thumbprint);
      savedToken = f.auth.pollFunnelAdmission(receipt.requestId, receipt.requestSecret, f.key.thumbprint).token;
    }
    return response;
  };
  const api = f.api({ reload: () => { f.credential.token = savedToken; } });
  assert.deepEqual(await api("/api/browser"), { ok: true });
  assert.equal(f.reconnects(), 0, "use what the other process saved, without replacing it");
});

test("reconnect reports its actual refusal instead of the original generic session error", async (t) => {
  const f = fixture(t);
  f.auth.reopenBrowserInvitation(f.grant.clientId);
  for (const status of [410, 423, 429, 503]) {
    f.gateway.reconnect = async () => f.reply(status, { error: `Reconnect failed: ${status}` });
    await assert.rejects(f.api()("/api/browser"), (error) => error.status === status && error.message === `Reconnect failed: ${status}`);
  }
});

test("a failed renewal can be retried through the same connection", async (t) => {
  const f = fixture(t);
  f.auth.reopenBrowserInvitation(f.grant.clientId);
  const reconnect = f.gateway.reconnect;
  f.gateway.reconnect = async () => f.reply(503, { error: "Reach is restarting" });
  const api = f.api();
  await assert.rejects(api("/api/browser"), { status: 503 });
  f.gateway.reconnect = reconnect;
  assert.deepEqual(await api("/api/browser"), { ok: true });
  assert.equal(f.reconnects(), 1);
});

test("a refused credential collection retains its actual reason", async (t) => {
  const f = fixture(t);
  f.auth.reopenBrowserInvitation(f.grant.clientId);
  for (const [status, json, expected] of [
    [503, { error: "Reach is restarting" }, 503],
    [200, { status: "denied" }, 403],
    [200, { status: "expired" }, 410],
  ]) {
    f.gateway.status = async () => f.reply(status, json);
    await assert.rejects(f.api()("/api/browser"), { status: expected });
  }
  assert.equal(f.dispatched(), 0);
});

test("a mutating call refused before execution runs exactly once after renewal", async (t) => {
  const f = fixture(t);
  f.auth.reopenBrowserInvitation(f.grant.clientId);
  assert.deepEqual(await f.api()("/api/browser/tools/run", "POST", {}), { ok: true });
  assert.equal(f.reconnects(), 1);
  assert.equal(f.dispatched(), 1);
});

test("only a request refused before execution is repeated, at most once", async (t) => {
  const f = fixture(t);
  let requests = 0;
  f.gateway.request = async () => {
    requests++;
    return f.reply(401, { error: "Route refused after dispatch" });
  };
  await assert.rejects(f.api()("/api/browser/tools/run", "POST", {}), { status: 401 });
  assert.equal(requests, 1);
  assert.equal(f.reconnects(), 0);

  f.gateway.request = async () => {
    requests++;
    return f.reply(401, { error: "Refused before dispatch" }, { "reach-not-run": "1" });
  };
  requests = 0;
  await assert.rejects(f.api()("/api/browser/tools/run", "POST", {}), { status: 401 });
  assert.equal(requests, 2, "a repeatedly refused call cannot reconnect forever");
  assert.equal(f.reconnects(), 1);
});

test("concurrent private route failures each reach the public fallback", async (t) => {
  const f = fixture(t);
  const endpoints = ["https://mac.fixture.ts.net:8443", "https://mac.fixture.ts.net"];
  const attempted = [], failed = Promise.withResolvers();
  let privateCalls = 0;
  const gateway = funnelGateway(endpoints[1], f.key, { endpoints, send: async (endpoint) => {
    attempted.push(endpoint);
    if (endpoint === endpoints[0]) {
      if (++privateCalls === 2) failed.resolve();
      await failed.promise;
      throw Object.assign(Error("Private route is down"), { unreachable: true });
    }
    return f.reply(200, { ok: true });
  } });
  const answers = await Promise.all([gateway.request(f.credential.token, "GET", "/api/device"), gateway.request(f.credential.token, "GET", "/api/browser")]);
  assert.ok(answers.every((r) => r.status === 200 && r.endpoint === endpoints[1]));
  assert.equal(attempted.filter((endpoint) => endpoint === endpoints[1]).length, 2);
  attempted.length = 0;
  await gateway.request(f.credential.token, "GET", "/api/device");
  assert.deepEqual(attempted, [endpoints[1]], "subsequent calls remember the working route");
});

test("a failed shared socket's delayed close cannot reject a newer connection's request", async t => {
  const sockets = [new PassThrough(), new PassThrough()];
  t.after(() => { for (const socket of sockets) socket.destroy(); });
  const written = [];
  for (const socket of sockets) socket.write = line => { written.push(JSON.parse(line)); return true; };
  let connections = 0;
  t.mock.method(net, "connect", () => sockets[connections++]);
  const api = viaShared("fixture-no-real-socket");
  const first = api("/api/device");
  sockets[0].emit("error", Error("Fixture connect refused"));
  await assert.rejects(first, error => error.code === GONE);
  const next = api("/api/browser").then(value => ({ value }), error => ({ error }));
  sockets[1].emit("connect");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(written.length, 1);
  sockets[0].emit("close");
  sockets[1].emit("data", Buffer.from(JSON.stringify({ id: written[0].id, result: { ok: true } }) + "\n"));
  const answer = await next;
  assert.equal(answer.error, undefined, "the old socket owns no request on its replacement");
  assert.deepEqual(answer.value, { ok: true });
});

// Exercise the real public CLI main() -> open() -> shared-holder path, with
// no production instrumentation. Only the tailnet node and its remote HTTP
// service are stand-ins; IPC, sockets/named pipes and separate processes are
// real. Hash-valid empty cache files are never executed: loadTailnet() uses
// the preinstalled fake factory instead of starting WebAssembly.
async function cliProcesses(t, intercept = async (run) => run()) {
  const home = fs.realpathSync.native(fs.mkdtempSync(path.join(process.platform === "win32" ? os.tmpdir() : "/tmp", "reach-holder-cli-")));
  const conn = path.join(home, "fixture"), cache = path.join(home, "tailnet", "mac.fixture.ts.net");
  fs.mkdirSync(conn, { recursive: true }); fs.mkdirSync(cache, { recursive: true });
  const file = path.join(conn, "credential.json");
  const credential = { version: 1, via: "tailnet", origin: "https://mac.fixture.ts.net", start: "https://mac.fixture.ts.net",
    token: "a".repeat(43), computer: "Fixture", scopes: ["device", "exec"], expiresAt: Date.now() + 86400_000, joinedAt: new Date().toISOString() };
  fs.writeFileSync(file, JSON.stringify(credential), { mode: 0o600 });
  const names = { exec: "fake.e3b0c44298fc.js", wasm: "fake.e3b0c44298fc.wasm" };
  for (const name of Object.values(names)) fs.writeFileSync(path.join(cache, name), "");
  fs.writeFileSync(path.join(cache, "tailnet.json"), JSON.stringify(names));
  const calls = [], counts = { mutations: 0, rotations: 0 };
  const server = http.createServer(async (req, res) => {
    try {
      let text = ""; for await (const chunk of req) text += chunk;
      const input = JSON.parse(text); calls.push(input);
      const answer = await intercept(async () => {
        if (input.route === "/api/device") return { access: { scopes: ["device", "exec"] } };
        if (input.route === "/api/device/rotate") {
          const index = ++counts.rotations;
          await new Promise(resolve => setTimeout(resolve, 25));
          return { token: String(index).repeat(43) };
        }
        if (input.route === "/api/jobs" && input.method === "POST") { counts.mutations++; return { id: "inert-job", ok: true }; }
        throw Error("Unexpected synthetic route");
      }, input, counts);
      if (!res.destroyed) { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(answer)); }
    } catch (error) {
      if (!res.destroyed) { res.statusCode = 500; res.end(JSON.stringify({ error: error.message })); }
    }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const children = new Set();
  t.after(async () => {
    await Promise.all([...children].map(async child => { if (child.exitCode === null && child.signalCode === null) { const ended = once(child, "exit"); child.kill(); await ended; } }));
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    fs.rmSync(home, { recursive: true, force: true });
  });
  const source = `
    import { main } from ${JSON.stringify(new URL("../scripts/agent-remote.mjs", import.meta.url).href)};
    const endpoint = ${JSON.stringify(`http://127.0.0.1:${server.address().port}`)};
    globalThis.reachTailnet = () => ({
      start: callbacks => callbacks.state("Running"),
      status: () => ({ peers: [{ dnsName: "mac.fixture.ts.net", online: true }] }),
      fetch(input) {
        const controller = new AbortController();
        return { abort: () => controller.abort(), response: fetch(endpoint, { method: "POST", signal: controller.signal,
          body: JSON.stringify({ route: new URL(input.url).pathname, method: input.method, body: input.body ? JSON.parse(Buffer.from(input.body)) : null })
        }).then(response => ({ status: response.status, headers: ["content-type", "application/json"],
          read: (() => { let read = false; return async () => read ? null : (read = true, Buffer.from(await response.arrayBuffer())); })(), cancel() {},
        })) };
      },
    });
    process.on("message", async ({ id, args }) => {
      try { process.send({ id, result: { code: await main(args) } }); }
      catch (error) { process.send({ id, error: error.message, status: error.status }); }
    });
    if (process.env.FIXTURE_WARM === "1") await main(["tools"]);
    process.send({ ready: true });
  `;
  let id = 0;
  const start = async ({ warm = true } = {}) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", source], {
      stdio: ["ignore", "ignore", "pipe", "ipc"], env: { ...process.env, REACH_AGENT_HOME: home, FIXTURE_WARM: warm ? "1" : "0" },
    });
    children.add(child); let stderr = "";
    child.stderr.on("data", chunk => { stderr += chunk; });
    const exited = once(child, "exit");
    const ready = await Promise.race([once(child, "message"), exited.then(() => { throw Error(stderr || "CLI process exited before readiness"); })]);
    assert.equal(ready[0].ready, true, stderr);
    const ask = args => new Promise((resolve, reject) => {
      const wanted = ++id;
      const receive = answer => {
        if (answer.id !== wanted) return;
        child.off("message", receive);
        answer.error ? reject(Object.assign(Error(answer.error), { status: answer.status })) : resolve(answer.result);
      };
      child.on("message", receive); child.send({ id: wanted, args });
    });
    return { child, ask, exited };
  };
  return { start, file, credential, counts, calls };
}

test("the production CLI never replays a POST whose holder died after dispatch", { timeout: 15000 }, async t => {
  const dispatched = Promise.withResolvers(), release = Promise.withResolvers();
  const p = await cliProcesses(t, async (run, input, counts) => {
    const answer = await run();
    if (input.route === "/api/jobs" && input.method === "POST" && counts.mutations === 1) { dispatched.resolve(); await release.promise; }
    return answer;
  });
  const holder = await p.start(), other = await p.start();
  const action = other.ask(["call", "reach_run_command", JSON.stringify({ command: "inert-fixture-never-executed" })])
    .then(value => ({ value }), error => ({ error }));
  await dispatched.promise;
  holder.child.kill(); await holder.exited;
  let outcome;
  try { outcome = await action; } finally { release.resolve(); }
  assert.equal(p.counts.mutations, 1, "a lost POST response must not dispatch the synthetic job twice");
  assert.equal(outcome.error?.status, 503);
  assert.match(outcome.error?.message || "", /Check the result before retrying/);
  assert.deepEqual(await other.ask(["call", "reach_device", "{}"]), { code: 0 }, "the next explicit read can take over");
});

test("concurrent production CLI calls share a single credential rotation", { timeout: 15000 }, async t => {
  const p = await cliProcesses(t);
  fs.writeFileSync(p.file, JSON.stringify({ ...p.credential, joinedAt: new Date(Date.now() - 2 * 3600_000).toISOString() }), { mode: 0o600 });
  const process = await p.start({ warm: false });
  const results = await Promise.all([process.ask(["call", "reach_device", "{}"]), process.ask(["call", "reach_device", "{}"])]);
  assert.deepEqual(results, [{ code: 0 }, { code: 0 }]);
  assert.equal(p.counts.rotations, 1, "one same-process holder must rotate once for concurrent CLI calls");
});

