import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { createReach } from "../server/index.mjs";
import { ALL_SCOPES } from "../server/core.mjs";
import { readAgentPolicy, intersectRoots } from "../server/agent-policy.mjs";
import {
  createAgentClient,
  reachOrigin,
  privateFile,
} from "../scripts/agent-client.mjs";
import { networkPolicy, joinArguments } from "../scripts/agent-network.mjs";
import { parseOptions } from "../scripts/launcher-options.mjs";
const exec = promisify(execFile);
const cli = fileURLToPath(new URL("../scripts/agent-cli.mjs", import.meta.url));
const run = (args, options = {}) =>
  exec(process.execPath, [cli, ...args], { timeout: 10000, ...options });
const write = async (file, value) =>
  fs.writeFile(file, JSON.stringify(value), { mode: 0o600 });

test("owner CLI grants only selected folders, supports writes, preserves pairing, and revokes credentials", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "reach-agent-test-"));
  const project = path.join(dir, "project"),
    secret = path.join(dir, "other"),
    dataDir = path.join(dir, ".reach"),
    policy = path.join(dir, "policy.json");
  await fs.mkdir(project);
  await fs.mkdir(secret);
  await fs.writeFile(path.join(project, "hello.txt"), "hello");
  await fs.writeFile(path.join(secret, "private.txt"), "not shared");
  if (process.platform !== "win32")
    await fs.symlink(secret, path.join(project, "escape"));
  await run(["policy", "init", "--folder", project, "--out", policy]);
  const parsed = readAgentPolicy(policy);
  assert.deepEqual(parsed.profiles.workspace.scopes, [
    "device",
    "files:read",
    "files:write",
  ]);
  const reach = await createReach({
    roots: [dir],
    dataDir,
    agentPolicyFile: policy,
    agentPolicyRequired: true,
  });
  await new Promise((r) => reach.server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${reach.server.address().port}`;
  await write(path.join(dataDir, "agent-host.json"), {
    roots: [dir],
    agentPolicyFile: policy,
    publicOrigin: url,
  });
  const pairing = await fs.readFile(path.join(dataDir, "pairing.json"), "utf8");
  const file = path.join(dir, "credential.json");
  const owner = reach.auth.issue("phone", ALL_SCOPES);
  try {
    const grant = await run([
      "grant",
      "--profile",
      "workspace",
      "--name",
      "test-agent",
      "--out",
      file,
      "--data-dir",
      dataDir,
      "--allow-local",
    ]);
    const credential = JSON.parse(await fs.readFile(file, "utf8"));
    assert(!grant.stdout.includes(credential.token));
    if (process.platform !== "win32")
      if (process.platform !== "win32") assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
    assert.equal(
      await fs.readFile(path.join(dataDir, "pairing.json"), "utf8"),
      pairing,
    );
    const api = createAgentClient(credential, { allowLocal: true });
    const device = await api("/api/device");
    assert.equal(device.roots.length, 1);
    assert.equal(device.roots[0].path, await fs.realpath(project));
    assert.deepEqual(device.network.peers, []);
    const listed = await run([
      "files",
      "list",
      "--credential",
      file,
      "--allow-local",
    ]);
    assert(JSON.parse(listed.stdout).items.some((f) => f.name === "hello.txt"));
    assert(!JSON.parse(listed.stdout).items.some((f) => f.name === "escape"));
    assert.equal((await api("/api/files/text?path=hello.txt")).text, "hello");
    await assert.rejects(
      api("/api/files/text?path=../other/private.txt"),
      /outside/,
    );
    await assert.rejects(api("/api/files?root=1"), /valid folder/);
    if (process.platform !== "win32")
      await assert.rejects(api("/api/files?path=escape"), /outside/);
    for (const route of [
      "/api/terminals",
      "/api/terminals/desktop",
      "/api/jobs",
      "/api/chats",
      "/api/clients",
      "/api/screen",
      "/api/apps",
    ])
      await assert.rejects(api(route), /does not grant/);
    await run([
      "files",
      "mkdir",
      "--credential",
      file,
      "--name",
      "results",
      "--allow-local",
    ]);
    const upload = path.join(dir, "report.txt");
    await fs.writeFile(upload, "hello from cloud");
    await run([
      "files",
      "put",
      "--credential",
      file,
      "--file",
      upload,
      "--path",
      "results",
      "--name",
      "résumé.txt",
      "--allow-local",
    ]);
    assert.equal(
      await fs.readFile(path.join(project, "results/résumé.txt"), "utf8"),
      "hello from cloud",
    );
    await assert.rejects(
      run([
        "files",
        "put",
        "--credential",
        file,
        "--file",
        upload,
        "--path",
        "results",
        "--name",
        "résumé.txt",
        "--allow-local",
      ]),
      /already exists/,
    );
    const original = await api("/api/files/text?path=hello.txt");
    await fs.writeFile(upload, "edited from cloud");
    await run([
      "files",
      "write",
      "--credential",
      file,
      "--file",
      upload,
      "--path",
      "hello.txt",
      "--if-match",
      original.sha256,
      "--allow-local",
    ]);
    assert.equal(
      await fs.readFile(path.join(project, "hello.txt"), "utf8"),
      "edited from cloud",
    );
    await assert.rejects(
      api("/api/files/text?path=hello.txt", "PUT", {
        text: "stale edit",
        sha256: original.sha256,
      }),
      /file changed/,
    );
    const mcp = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [
        cli,
        "mcp",
        "--credential",
        file,
        "--allow-local",
      ]);
      let output = "",
        error = "";
      child.stdout.on("data", (chunk) => (output += chunk));
      child.stderr.on("data", (chunk) => (error += chunk));
      child.on("error", reject);
      child.on("close", (code) =>
        code === 0
          ? resolve(output.trim().split("\n").map(JSON.parse))
          : reject(Error(error)),
      );
      child.stdin.end(
        JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) + "\n",
      );
    });
    const names = mcp[0].result.tools.map((tool) => tool.name);
    assert(names.includes("reach_write_file"));
    assert(!names.includes("reach_run_command"));
    const current = JSON.parse(await fs.readFile(policy, "utf8"));
    current.profiles.workspace.scopes = ["files:read"];
    await write(policy, current);
    await assert.rejects(
      api("/api/files/folder", "POST", { name: "blocked" }),
      /does not grant/,
    );
    current.profiles.workspace.scopes.push("exec");
    await write(policy, current);
    await assert.rejects(
      api("/api/jobs", "POST", { command: "echo forbidden" }),
      /does not grant/,
    ); // No expansion of an already-issued token.
    await fs.writeFile(policy, "invalid JSON");
    await assert.rejects(api("/api/device"), /Access expired or was revoked/);
    assert.equal(
      (
        await fetch(url + "/api/device", {
          headers: { Authorization: `Bearer ${owner.token}` },
        })
      ).status,
      200,
    );
    await write(policy, current);
    await run(["revoke", "--id", credential.clientId, "--data-dir", dataDir]);
    await assert.rejects(api("/api/device"), /Access expired or was revoked/);
  } finally {
    await reach.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("policy expiry, disabled profiles, root narrowing, legacy-token blocking and TTL caps fail closed", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "reach-policy-test-"));
  const dataDir = path.join(dir, ".reach"),
    policy = path.join(dir, "policy.json"),
    sub = path.join(dir, "sub");
  await fs.mkdir(sub);
  const reach = await createReach({
    roots: [dir],
    dataDir,
    agentPolicyFile: policy,
  });
  try {
    const legacy = reach.auth.issue("legacy", ["files"], "agent");
    assert(reach.auth.verify(legacy.token));
    const value = {
      version: 1,
      profiles: {
        workspace: {
          scopes: ["files:read", "exec"],
          roots: [dir],
          ttlSeconds: 60,
          maxJobMs: 1000,
        },
      },
    };
    await write(policy, value);
    assert.equal(reach.auth.verify(legacy.token), null);
    assert.throws(
      () =>
        reach.auth.issue("too long", [], "agent", {
          profile: "workspace",
          ttlSeconds: 61,
        }),
      /lifetime/,
    );
    const agent = reach.auth.issue("bounded", [], "agent", {
      profile: "workspace",
    });
    assert.equal(reach.auth.verify(agent.token).maxJobMs, 1000);
    const clientsFile = path.join(dataDir, "clients.json");
    const savedClients = JSON.parse(await fs.readFile(clientsFile, "utf8"));
    await write(
      clientsFile,
      savedClients.map((c) =>
        c.id === agent.clientId ? { ...c, expiresAt: Date.now() - 1 } : c,
      ),
    );
    assert.equal(reach.auth.verify(agent.token), null);
    await write(clientsFile, savedClients);
    value.profiles.workspace.roots = [sub];
    await write(policy, value);
    assert.deepEqual(reach.auth.verify(agent.token).agentRoots, [
      await fs.realpath(sub),
    ]);
    value.profiles.workspace.scopes = ["files:read"];
    await write(policy, value);
    assert(!reach.auth.verify(agent.token).scopes.includes("exec"));
    delete value.profiles.workspace;
    await write(policy, value);
    assert.equal(reach.auth.verify(agent.token), null);
    await fs.rm(policy);
    assert.equal(reach.auth.verify(agent.token), null);
    assert.equal(reach.auth.verify(legacy.token), null);
    assert.deepEqual(intersectRoots(["/a/one"], ["/a/one-more"]), []);
  } finally {
    await reach.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("CLI rejects unsafe origins and readable secret files; redirects never receive credentials", async () => {
  for (const url of [
    "http://example.com",
    "https://example.com",
    "https://mac.test.ts.net/path",
    "https://user:pass@mac.test.ts.net",
    "https://mac.test.ts.net/?token=x",
    "file:///etc/passwd",
  ])
    assert.throws(() => reachOrigin(url));
  assert.equal(reachOrigin("https://mac.test.ts.net:8443").port, "8443");
  assert.throws(() => reachOrigin("http://localhost:4317"));
  assert.equal(reachOrigin("http://localhost:4317", true).protocol, "http:");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "reach-secret-test-"));
  const file = path.join(dir, "key");
  await fs.writeFile(file, "fake-key", { mode: 0o644 });
  try {
    if (process.platform !== "win32")
      assert.throws(() => privateFile(file), /permissions/);
    await fs.chmod(file, 0o600);
    assert.equal(privateFile(file), "fake-key");
    if (process.platform !== "win32") {
      await fs.symlink(file, path.join(dir, "link"));
      assert.throws(() => privateFile(path.join(dir, "link")));
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
  let calls = 0;
  const server = http.createServer((req, res) => {
    calls++;
    res.writeHead(302, { Location: "/api/other" });
    res.end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    await assert.rejects(
      createAgentClient(
        {
          url: `http://127.0.0.1:${server.address().port}`,
          token: "synthetic-token-1234567890",
        },
        { allowLocal: true },
      )("/api/device"),
      /redirects/,
    );
    assert.equal(calls, 1);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test("network plans are single-host and single-port; joining uses private file secrets and isolated sockets", async () => {
  assert.deepEqual(networkPolicy("100.90.80.70").grants, [
    { src: ["tag:reach-agent"], dst: ["100.90.80.70"], ip: ["tcp:8443"] },
  ]);
  for (const ip of ["8.8.8.8", "127.0.0.1", "100.1.1.1", "100.128.0.1", "*"])
    assert.throws(() => networkPolicy(ip));
  assert.throws(() => networkPolicy("100.90.80.70", 8443, "tag:a,tag:admin"));
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "reach-join-args-"));
  const key = path.join(dir, "key");
  await fs.writeFile(key, "SYNTHETIC-SECRET", { mode: 0o600 });
  try {
    const args = joinArguments(
      { tag: "tag:reach-agent", "auth-key-file": key },
      "/tmp/private/socket",
    );
    assert(!JSON.stringify(args).includes("SYNTHETIC-SECRET"));
    assert(args.includes("--auth-key=file:" + key));
    assert(args.includes("--socket=/tmp/private/socket"));
    assert(args.includes("--ssh=false"));
    assert(args.includes("--accept-routes=false"));
    assert.throws(() =>
      joinArguments(
        {
          tag: "tag:reach-agent",
          "auth-key-file": key,
          "client-id": "x",
          "id-token-file": key,
        },
        "socket",
      ),
    );
    const oidc = joinArguments(
      { tag: "tag:reach-agent", "client-id": "test", "id-token-file": key },
      "socket",
    );
    assert(oidc.includes("--id-token=file:" + key));
    assert.equal(parseOptions(["--agent-policy", key]).agentPolicyFile, key);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test(
  "isolated join verifies tags, propagates its private proxy socket and logs out on child exit",
  { skip: process.platform === "win32" },
  async () => {
    const dir = await fs.mkdtemp(
      path.join(os.tmpdir(), "reach-tailnet-fixture-"),
    );
    const daemon = path.join(dir, "tailscaled"),
      ts = path.join(dir, "tailscale"),
      log = path.join(dir, "actions"),
      key = path.join(dir, "key");
    await fs.writeFile(key, "SYNTHETIC-SECRET", { mode: 0o600 });
    await fs.writeFile(
      daemon,
      `#!${process.execPath}\nconst net=require('node:net');const socket=process.argv.find(a=>a.startsWith('--socket=')).slice(9);net.createServer().listen(socket);process.on('SIGTERM',()=>process.exit(0));`,
      { mode: 0o700 },
    );
    await fs.writeFile(
      ts,
      `#!${process.execPath}\nconst fs=require('node:fs');const args=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(args)+'\\n');if(args.includes('status'))console.log(JSON.stringify({BackendState:'Running',Self:{Tags:[process.env.REACH_FIXTURE_TAG||'tag:reach-agent']}}));`,
      { mode: 0o700 },
    );
    const args = [
      "join",
      "--tag",
      "tag:reach-agent",
      "--auth-key-file",
      key,
      "--tailscale",
      ts,
      "--tailscaled",
      daemon,
      "--",
      process.execPath,
      "-e",
      "console.log(JSON.stringify({proxy:process.env.REACH_PROXY}))",
    ];
    try {
      const result = await run(args);
      // A socket in the run's private folder, not a port anyone could use.
      assert.match(
        JSON.parse(result.stdout).proxy,
        /^unix:\/.+\/proxy\.sock$/,
      );
      assert(!result.stderr.includes("SYNTHETIC-SECRET"));
      const actions = (await fs.readFile(log, "utf8"))
        .trim()
        .split("\n")
        .map(JSON.parse);
      assert(actions.some((a) => a.includes("logout")));
      const socket = actions[0][0].slice("--socket=".length);
      await assert.rejects(fs.access(path.dirname(socket)));
      await assert.rejects(
        run(args, { env: { ...process.env, REACH_FIXTURE_TAG: "tag:admin" } }),
        /exactly the requested restricted tag/,
      );
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  },
);

test(
  "HTTPS over the userspace proxy validates certificates and keeps tokens out of CONNECT",
  { skip: process.platform === "win32" },
  async () => {
    const https = await import("node:https");
    const net = await import("node:net");
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "reach-proxy-test-"));
    const key = path.join(dir, "key.pem"),
      cert = path.join(dir, "cert.pem"),
      conf = path.join(dir, "cert.conf");
    await fs.writeFile(
      conf,
      "[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=mac.fixture.ts.net\n[ext]\nsubjectAltName=DNS:mac.fixture.ts.net\nbasicConstraints=CA:TRUE\n",
    );
    await exec("/usr/bin/openssl", [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      key,
      "-out",
      cert,
      "-days",
      "1",
      "-config",
      conf,
    ]);
    let receivedToken, connectHeaders;
    const target = https.createServer(
      { key: await fs.readFile(key), cert: await fs.readFile(cert) },
      (req, res) => {
        receivedToken = req.headers.authorization;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ fixture: true }));
      },
    );
    await new Promise((r) => target.listen(0, "127.0.0.1", r));
    const proxy = http.createServer();
    const sockets = new Set();
    for (const server of [target, proxy])
      server.on("connection", (socket) => {
        sockets.add(socket);
        socket.on("close", () => sockets.delete(socket));
      });
    proxy.on("connect", (req, socket, head) => {
      connectHeaders = req.headers;
      const remote = net.connect(target.address().port, "127.0.0.1", () => {
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) remote.write(head);
        socket.pipe(remote);
        remote.pipe(socket);
      });
      socket.on("error", () => remote.destroy());
      remote.on("error", () => socket.destroy());
      socket.on("close", () => remote.destroy());
    });
    await new Promise((r) => proxy.listen(0, "127.0.0.1", r));
    const proxyUrl = `http://127.0.0.1:${proxy.address().port}`;
    const credential = {
      url: "https://mac.fixture.ts.net:8443",
      token: "synthetic-secret-1234567890",
    };
    try {
      await assert.rejects(
        createAgentClient(credential, { proxy: proxyUrl })("/api/device"),
        /self.signed|certificate/i,
      );
      const file = path.join(dir, "credential.json");
      await write(file, credential);
      const result = await run(["device", "--credential", file], {
        env: {
          ...process.env,
          REACH_PROXY: proxyUrl,
          NODE_EXTRA_CA_CERTS: cert,
        },
      });
      assert.deepEqual(JSON.parse(result.stdout), { fixture: true });
      assert.equal(receivedToken, `Bearer ${credential.token}`);
      assert.equal(connectHeaders.authorization, undefined);
    } finally {
      for (const socket of sockets) socket.destroy();
      target.closeAllConnections();
      await new Promise((r) => target.close(r));
      await new Promise((r) => proxy.close(r));
      await fs.rm(dir, { recursive: true, force: true });
    }
  },
);

// The isolated tailnet's proxy is a socket in the run's private folder that
// dials through tailscaled with `tailscale nc`: no port for another user on
// the agent's machine, tailnet addresses only, certificates still checked
// end to end (connections audit, Oct 10).
test(
  "the isolated tailnet's private proxy reaches tailnet hosts only, and HTTPS through it checks the certificate",
  { skip: process.platform === "win32" },
  async () => {
    const https = await import("node:https");
    const { tailnetProxy } = await import("../scripts/agent-network.mjs");
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "reach-ncproxy-"));
    await fs.chmod(dir, 0o700);
    const key = path.join(dir, "key.pem"),
      cert = path.join(dir, "cert.pem"),
      conf = path.join(dir, "cert.conf");
    await fs.writeFile(
      conf,
      "[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=mac.fixture.ts.net\n[ext]\nsubjectAltName=DNS:mac.fixture.ts.net\nbasicConstraints=CA:TRUE\n",
    );
    await exec("/usr/bin/openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "1", "-config", conf]);
    let receivedToken;
    const target = https.createServer({ key: await fs.readFile(key), cert: await fs.readFile(cert) }, (req, res) => {
      receivedToken = req.headers.authorization;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ fixture: true }));
    });
    await new Promise((r) => target.listen(0, "127.0.0.1", r));
    // `tailscale nc <host> <port>` as the isolated daemon would: here, to the fixture.
    const log = path.join(dir, "nc.log");
    const cli = path.join(dir, "tailscale");
    await fs.writeFile(
      cli,
      `#!${process.execPath}\nconst fs=require('node:fs');fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(process.argv.slice(2))+'\\n');const s=require('node:net').connect(${target.address().port},'127.0.0.1');process.stdin.pipe(s);s.pipe(process.stdout);s.on('close',()=>process.exit(0));`,
      { mode: 0o700 },
    );
    const file = path.join(dir, "proxy.sock");
    const proxy = await tailnetProxy({ file, cli, socket: path.join(dir, "tailscaled.sock") });
    try {
      assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
      const connect = (to) =>
        new Promise((resolve, reject) => {
          const req = http.request({ socketPath: file, method: "CONNECT", path: to, headers: { Host: to } });
          req.on("connect", (res, socket) => { socket.destroy(); resolve(res.statusCode); });
          req.on("response", (res) => resolve(res.statusCode));
          req.on("error", reject);
          req.end();
        });
      for (const outside of ["evil.example.com:443", "192.168.1.4:22", "127.0.0.1:22", "100.128.0.1:443"])
        assert.equal(await connect(outside), 403, outside);
      const credential = { url: "https://mac.fixture.ts.net:8443", token: "synthetic-secret-1234567890" };
      const file2 = path.join(dir, "credential.json");
      await write(file2, credential);
      const result = await run(["device", "--credential", file2], {
        env: { ...process.env, REACH_PROXY: `unix:${file}`, NODE_EXTRA_CA_CERTS: cert },
      });
      assert.deepEqual(JSON.parse(result.stdout), { fixture: true });
      assert.equal(receivedToken, `Bearer ${credential.token}`);
      const dialed = (await fs.readFile(log, "utf8")).trim().split("\n").map(JSON.parse);
      assert.deepEqual(dialed.at(-1).slice(1), ["nc", "mac.fixture.ts.net", "8443"]);
      // Without the fixture's certificate the same route is refused.
      await assert.rejects(
        createAgentClient(credential, { proxy: `unix:${file}` })("/api/device"),
        /self.signed|certificate/i,
      );
      // A socket in a folder others can open isn't taken as the proxy.
      await fs.chmod(dir, 0o755);
      assert.throws(() => createAgentClient(credential, { proxy: `unix:${file}` }), /private socket/);
    } finally {
      proxy.close();
      target.closeAllConnections();
      await new Promise((r) => target.close(r));
      await fs.rm(dir, { recursive: true, force: true });
    }
  },
);
