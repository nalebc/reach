import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createAgentShell, shellSandboxProfile } from "../server/agent-shell.mjs";
import { agentShellSandbox } from "../server/browser-private-paths.mjs";
import { presetScopes } from "../server/agent-presets.mjs";

// Full control commands run in a macOS sandbox (security audit, Oct 9): the
// deny list only reads a command's text, so Reach's socket, port, data and
// code, your browsers' data and what runs later outside the sandbox are kept
// out at the operating-system level, however a command spells them.

test("the sandbox profile denies exactly what it's given, quoted", () => {
  const profile = shellSandboxProfile({ readDeny: ['/a "b"\\c'], writeDeny: ["/w"], socketDeny: ["/s"], ports: [4317] });
  assert.match(profile, /^\(version 1\)\n\(allow default\)/);
  assert.ok(profile.includes('(deny file-read* (subpath "/a \\"b\\"\\\\c"))'));
  assert.ok(profile.includes('(deny file-write* (subpath "/w"))'));
  assert.ok(profile.includes('(deny network-outbound (remote unix-socket (subpath "/s")))'));
  assert.ok(profile.includes('(deny network-outbound (remote ip "localhost:4317"))'));
  assert.ok(profile.includes("(deny appleevent-send)"));
  const empty = shellSandboxProfile({});
  assert.doesNotMatch(empty, /file-read|file-write|unix-socket|remote ip/);
});

test("what an agent's commands can't reach", () => {
  const home = "/Users/me", appRoot = "/Users/me/code/reach/";
  const rules = agentShellSandbox({ dataDir: "/Users/me/code/reach/.reach/quick", port: 4317 },
    { home, appRoot, sockets: ["/tmp/reach-501-abc"] });
  for (const secret of ["/Users/me/code/reach/.reach/quick", "/Users/me/code/reach/.reach", "/tmp/reach-501-abc",
    "/Users/me/Library/Keychains", "/Users/me/Library/Application Support/Google/Chrome", "/Users/me/Library/Safari",
    "/Users/me/Library/Application Support/Firefox", "/Users/me/Library/Application Support/Arc"]) {
    assert.ok(rules.readDeny.includes(secret), `read ${secret}`);
    assert.ok(rules.writeDeny.includes(secret), `write ${secret}`);
  }
  // Reach's code and what runs later can be read, never changed.
  for (const later of ["/Users/me/code/reach", "/Users/me/Library/LaunchAgents", "/Users/me/.zshrc", "/Users/me/.zshenv",
    "/Users/me/.bash_profile", "/Users/me/.ssh/authorized_keys"]) {
    assert.ok(rules.writeDeny.includes(later), `write ${later}`);
    assert.ok(!rules.readDeny.includes(later), `read ${later}`);
  }
  assert.ok(rules.socketDeny.includes("/tmp/reach-501-abc"));
  assert.ok(rules.socketDeny.includes("/Users/me/code/reach/.reach/quick"));
  assert.deepEqual(rules.ports, [4317]);
  assert.ok(!rules.readDeny.includes("/Users/me/Documents"));
});

test("without the sandbox, every command is refused", async () => {
  const records = [], root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "reach-nosbx-")));
  const marker = path.join(root, "ran");
  const shell = createAgentShell({ commandLog: { append: async (record) => records.push(record), history: async () => records },
    home: os.homedir(), sandbox: () => ({ readDeny: ["/nonexistent"] }), sandboxExec: path.join(root, "no-sandbox-exec") });
  const policy = { invite: true, browser: true, preset: "full", roots: [root] };
  const client = { id: "agent", kind: "agent", name: "Agent", expiresAt: Date.now() + 60000, policy, scopes: presetScopes(policy), agentRoots: [root] };
  try {
    await assert.rejects(shell.run(client, { command: `touch ${JSON.stringify(marker)}`, root: 0, cwd: "" },
      { resolve: () => root, authorize: () => client }), (error) => error.status === 503 && /can't sandbox/.test(error.message));
    await assert.rejects(fs.access(marker));
    assert.equal(records.at(-1).status, "failed");
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("a sandboxed command can't reach Reach's socket, port, data or code; ordinary work still runs",
  { skip: process.platform !== "darwin", timeout: 30000 }, async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "reach-sbx-")));
    const sockets = await fs.realpath(await fs.mkdtemp("/tmp/reach-sbx-sock-"));
    const appRoot = path.join(root, "reach"), dataDir = path.join(appRoot, ".reach", "quick"), work = path.join(root, "work");
    const home = path.join(root, "home");
    await fs.mkdir(dataDir, { recursive: true });
    await fs.mkdir(work, { recursive: true });
    await fs.mkdir(path.join(home, "Library", "Application Support", "Google", "Chrome"), { recursive: true });
    await fs.writeFile(path.join(dataDir, "clients.json"), "owner-secret");
    await fs.writeFile(path.join(home, "Library", "Application Support", "Google", "Chrome", "Cookies"), "browser-secret");
    await fs.writeFile(path.join(home, ".zshrc"), "# owner's\n");
    const answer = (req, res) => res.end("reach-answered");
    const socketServer = http.createServer(answer), portServer = http.createServer(answer);
    const socketPath = path.join(sockets, "s");
    await new Promise((resolve) => socketServer.listen(socketPath, resolve));
    await new Promise((resolve) => portServer.listen(0, "127.0.0.1", resolve));
    const port = portServer.address().port;
    // Both answer when asked outside the sandbox.
    const outside = (options) => new Promise((resolve, reject) =>
      http.get({ ...options, path: "/" }, (res) => { let text = ""; res.on("data", (c) => (text += c)); res.on("end", () => resolve(text)); }).on("error", reject));
    assert.equal(await outside({ socketPath }), "reach-answered");
    assert.equal(await outside({ host: "127.0.0.1", port }), "reach-answered");

    const records = [];
    const shell = createAgentShell({
      commandLog: { append: async (record) => records.push(record), history: async () => records },
      home: os.homedir(), timeoutMs: 15000,
      sandbox: () => agentShellSandbox({ dataDir, port }, { home, appRoot, sockets: [sockets] }),
    });
    const policy = { invite: true, browser: true, preset: "full", roots: [root] };
    const client = { id: "agent", kind: "agent", name: "Agent", expiresAt: Date.now() + 60000, policy,
      scopes: presetScopes(policy), agentRoots: [root] };
    const run = async (command) => {
      const item = await shell.run(client, { command, root: 0, cwd: "work" },
        { resolve: (index, cwd) => path.join(root, cwd), authorize: () => client });
      return item.output || "";
    };
    try {
      const S = JSON.stringify(socketPath), D = JSON.stringify(dataDir);
      assert.doesNotMatch(await run(`curl -s --max-time 3 --unix-socket ${S} http://x/; echo " exit=$?"`), /reach-answered/);
      assert.doesNotMatch(await run(`curl -s --max-time 3 http://127.0.0.1:${port}/; echo " exit=$?"`), /reach-answered/);
      assert.doesNotMatch(await run(`curl -s --max-time 3 http://localhost:${port}/; echo " exit=$?"`), /reach-answered/);
      assert.doesNotMatch(await run(`node -e 'require("http").get({socketPath:process.argv[1],path:"/"},r=>r.pipe(process.stdout)).on("error",e=>console.log(e.code))' ${S}`), /reach-answered/);
      assert.doesNotMatch(await run(`cat ${D}/clients.json 2>&1`), /owner-secret/);
      assert.doesNotMatch(await run(`cat ${JSON.stringify(path.join(home, "Library", "Application Support", "Google", "Chrome", "Cookies"))} 2>&1`), /browser-secret/);
      await run(`echo planted >> ${JSON.stringify(path.join(home, ".zshrc"))} 2>&1; touch ${JSON.stringify(path.join(appRoot, "server.mjs"))} 2>&1`);
      assert.equal(await fs.readFile(path.join(home, ".zshrc"), "utf8"), "# owner's\n");
      await assert.rejects(fs.access(path.join(appRoot, "server.mjs")));
      // Ordinary work: its folder, the network, tools.
      assert.match(await run("echo hello > out.txt && cat out.txt && node -e 'console.log(6*7)'"), /hello\n42/);
      assert.equal(await fs.readFile(path.join(work, "out.txt"), "utf8"), "hello\n");
    } finally {
      await new Promise((resolve) => socketServer.close(resolve));
      await new Promise((resolve) => portServer.close(resolve));
      await fs.rm(root, { recursive: true, force: true });
      await fs.rm(sockets, { recursive: true, force: true });
    }
  });
