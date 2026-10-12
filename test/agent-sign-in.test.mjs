import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { claudeSignInLink, createSignIn, plainText } from "../server/agent-sessions/sign-in.mjs";
import { createReach } from "../server/index.mjs";
import { ALL_SCOPES } from "../server/core.mjs";

const exec = promisify(execFile);
// What `claude auth login` printed (claude 2.1.289), with made-up values: the
// link is an OSC 8 hyperlink whose target ends at ESC.
const MANUAL =
  "https://claude.com/cai/oauth/authorize?code=true&client_id=client-1&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=user%3Ainference&code_challenge=abc&code_challenge_method=S256&state=xyz";
const LOGIN_OUTPUT =
  "\x04\b\bOpening browser to sign in…\r\n" +
  `If the browser didn't open, visit: \x1b]8;;${MANUAL}\x1b\\${MANUAL}\x1b]8;;\x1b\\\r\n` +
  "Paste code here if prompted > ";

// A pseudo-terminal stand-in that records what was typed into it.
function fakeTerminal() {
  const spawned = [];
  let onData;
  let onExit;
  const proc = {
    written: [],
    killed: false,
    write: (text) => proc.written.push(text),
    kill: () => (proc.killed = true),
    onData: (fn) => (onData = fn),
    onExit: (fn) => (onExit = fn),
  };
  return {
    spawned,
    proc,
    spawn: (file, args, options) => (spawned.push({ file, args, options }), proc),
    print: (text) => onData(text),
    exit: (exitCode) => onExit({ exitCode }),
  };
}
const settle = (ms = 10) => new Promise((r) => setTimeout(r, ms));
const dataDir = () => fs.mkdtemp(path.join(os.tmpdir(), "reach-sign-in-"));

test("the sign-in link for another device is read from Claude Code's output", () => {
  assert.equal(claudeSignInLink(LOGIN_OUTPUT), MANUAL);
  // The link it tries to open on the Mac calls back to localhost: never that one.
  assert.equal(
    claudeSignInLink("https://claude.com/cai/oauth/authorize?code=true&redirect_uri=http%3A%2F%2Flocalhost%3A57911%2Fcallback"),
    null,
  );
  assert.equal(claudeSignInLink("Opening browser to sign in…"), null);
  assert.equal(plainText(LOGIN_OUTPUT).includes("\x1b"), false);
});

test("Claude sign-in keeps the configured Git Bash without inheriting host credentials", async t => {
  const dir = await dataDir(), term = fakeTerminal();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const signIn = createSignIn({
    dataDir: dir, claudeCommand: async () => "claude", claudeHealth: async () => ({}),
    spawn: term.spawn, platform: "darwin", linkMs: 0,
    env: { PATH: "/usr/bin", CLAUDE_CODE_GIT_BASH_PATH: "C:\\Custom Git\\bin\\bash.exe",
      CLAUDE_CODE_GIT_BASH_PATH_EXTRA: "not allowed", CLAUDE_CONFIG_DIR: "/another-profile",
      claudeCode: "nested", Anthropic_Api_Key: "secret", Reach_Pair_Token: "private" },
  });
  t.after(() => signIn.cancel("claude"));
  await signIn.start("claude");
  assert.deepEqual(term.spawned[0].options.env, {
    PATH: "/usr/bin", CLAUDE_CODE_GIT_BASH_PATH: "C:\\Custom Git\\bin\\bash.exe", TERM: "xterm-256color",
  });
});

test("Windows phone sign-in uses cmd, a browser shim and exited-PTY cleanup", async t => {
  const dir = await dataDir();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const term = fakeTerminal();
  let released = 0;
  term.proc._agent = { _inSocket: { destroy: () => released++ }, _conoutSocketWorker: { dispose: () => released++ } };
  const signIn = createSignIn({
    dataDir: dir, platform: "win32", claudeCommand: async () => "claude",
    claudeHealth: async () => ({ signedIn: true }), spawn: term.spawn, linkMs: 0,
    env: { Path: "C:\\Windows", ComSpec: "cmd.exe", BROWSER: "unwanted-browser", CLAUDECODE: "1",
      Claude_Code_Git_Bash_Path: "C:\\Custom Git\\bin\\bash.exe", Anthropic_Api_Key: "secret" },
  });
  await signIn.start("claude");
  t.after(() => signIn.cancel("claude"));
  const [{ file, args, options }] = term.spawned;
  assert.equal(file, "cmd.exe");
  assert.equal(args, '/d /s /c "claude auth login"');
  assert.equal(options.useConptyDll, true);
  assert.equal(options.env.PATH, `${path.join(dir, "sign-in")};C:\\Windows`);
  assert.equal(options.env.Path, undefined);
  assert.equal(options.env.CLAUDECODE, undefined);
  assert.equal(options.env.Claude_Code_Git_Bash_Path, "C:\\Custom Git\\bin\\bash.exe");
  assert.equal(options.env.Anthropic_Api_Key, undefined);
  assert.equal(options.env.BROWSER, path.join(dir, "sign-in", "open.cmd"));
  assert.match(await fs.readFile(options.env.BROWSER, "utf8"), /exit \/b 0/);
  term.print(LOGIN_OUTPUT);
  assert.equal(signIn.view("claude").url, MANUAL);
  await term.exit(0);
  assert.equal(released, 2);
  assert.equal(signIn.view("claude").state, "done");
});

test("Windows Claude phone sign-in runs a quoted cmd launcher through a real PTY", {
  skip: process.platform !== "win32", timeout: 30000,
}, async t => {
  const dir = await dataDir();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const folder = path.join(dir, "CLI with spaces");
  await fs.mkdir(folder);
  const script = path.join(folder, "fake-login.mjs"), command = path.join(folder, "claude.cmd"), completed = path.join(folder, "completed.txt");
  await fs.writeFile(script, `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    assert.deepEqual(process.argv.slice(2), ['auth', 'login']);
    assert.match(fs.readFileSync(process.env.BROWSER, 'utf8'), /exit \\/b 0/);
    assert.equal(process.env.CLAUDECODE, undefined);
    process.stdout.write(${JSON.stringify(LOGIN_OUTPUT)});
    const timeout = setTimeout(() => process.exit(2), 10000);
    process.stdin.on('data', data => {
      if (String(data).trim() === 'SYNTHETIC_CODE') {
        fs.writeFileSync(${JSON.stringify(completed)}, 'synthetic sign-in completed');
        clearTimeout(timeout); process.exit(0);
      }
    });
    process.stdin.resume();
  `);
  await fs.writeFile(command, `@"${process.execPath}" "${script}" %*\r\n`);
  let signedIn = false;
  const signIn = createSignIn({ dataDir: dir, claudeCommand: async () => `"${command}"`,
    claudeHealth: async () => ({ signedIn }), env: { ...process.env, CLAUDECODE: "synthetic" }, timeoutMs: 20000,
  });
  t.after(() => signIn.cancel("claude"));
  const result = await signIn.start("claude");
  assert.equal(result.state, "link", JSON.stringify(result));
  assert.equal(result.url, MANUAL);
  signedIn = true;
  signIn.submit("claude", "SYNTHETIC_CODE");
  const deadline = Date.now() + 10000;
  while (signIn.view("claude").state === "checking" && Date.now() < deadline) await settle(20);
  assert.equal(signIn.view("claude").state, "done", JSON.stringify(signIn.view("claude")));
  assert.equal(await fs.readFile(completed, "utf8"), "synthetic sign-in completed");
});

test("cancelled sign-in cannot start a late terminal or revive a late Codex login", async t => {
  const dir = await dataDir();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const command = Promise.withResolvers(), login = Promise.withResolvers(), term = fakeTerminal(), calls = [];
  const signIn = createSignIn({ dataDir: dir, claudeCommand: () => command.promise,
    claudeHealth: async () => ({}), spawn: term.spawn, linkMs: 0,
    daemon: { rpc: (method, params) => { calls.push([method, params]); return method === "account/login/start" ? login.promise : Promise.resolve({}); } },
  });
  const claude = signIn.start("claude");
  signIn.cancel("claude");
  command.resolve("claude");
  await claude;
  assert.equal(term.spawned.length, 0, "late discovery cannot start a cancelled login");
  const codex = signIn.start("codex");
  signIn.cancel("codex");
  login.resolve({ loginId: "late", verificationUrl: "https://auth.example/device", userCode: "synthetic" });
  await codex;
  assert.equal(signIn.view("codex").state, "cancelled");
  assert.deepEqual(calls.at(-1), ["account/login/cancel", { loginId: "late" }]);
});

test("Claude Code signs in from the phone: link out, code in, nothing opens on the Mac", { skip: process.platform === "win32" && "Executes a POSIX shell shim" }, async () => {
  const dir = await dataDir();
  const term = fakeTerminal();
  let signedIn = false;
  const signIn = createSignIn({
    dataDir: dir,
    claudeCommand: async () => "claude",
    claudeHealth: async () => ({ signedIn }),
    spawn: term.spawn,
    shell: "/bin/zsh",
    env: { PATH: "/usr/bin", HOME: "/Users/me", CLAUDECODE: "1", ANTHROPIC_API_KEY: "x", REACH_DATA: "/x", LANG: "en_US.UTF-8" },
  });
  try {
    const starting = signIn.start("claude");
    await settle();
    term.print(LOGIN_OUTPUT);
    assert.deepEqual(await starting, { agent: "claude", state: "link", url: MANUAL, code: null, error: null });
    const [{ file, args, options }] = term.spawned;
    assert.equal(file, "/bin/zsh");
    const shim = path.join(dir, "sign-in");
    assert.deepEqual(args, ["-lc", `PATH='${shim}':"$PATH" BROWSER='${shim}/open' exec claude auth login`]);
    // Reach's own environment, not a host app's or its own pairing settings.
    assert.deepEqual(Object.keys(options.env).sort(), ["HOME", "LANG", "PATH", "TERM"]);
    // The stand-in for `open` does nothing, successfully.
    await exec(path.join(shim, "open"), ["https://example.com"]);
    assert.equal(((await fs.stat(path.join(shim, "open"))).mode & 0o777).toString(8), "755");

    assert.throws(() => signIn.submit("claude", "abc\u001b[2J"), /Paste the code/);
    assert.deepEqual(signIn.submit("claude", "  CODE#123  "), { agent: "claude", state: "checking", url: MANUAL, code: null, error: null });
    assert.deepEqual(term.proc.written, ["CODE#123\r"]);
    assert.throws(() => signIn.submit("claude", "again"), (e) => e.status === 409);
    signedIn = true;
    term.exit(0);
    await settle();
    assert.equal(signIn.view("claude").state, "done");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("a Claude sign-in that doesn't take says what the login said", async () => {
  const dir = await dataDir();
  const term = fakeTerminal();
  const signIn = createSignIn({
    dataDir: dir,
    claudeCommand: async () => "claude",
    claudeHealth: async () => ({ signedIn: false }),
    spawn: term.spawn,
    env: {},
  });
  try {
    const starting = signIn.start("claude");
    await settle();
    term.print(LOGIN_OUTPUT);
    await starting;
    signIn.submit("claude", "wrong");
    term.print("\r\nOAuth error: Invalid code\r\n");
    term.exit(1);
    await settle();
    assert.deepEqual(signIn.view("claude"), {
      agent: "claude",
      state: "failed",
      url: MANUAL,
      code: null,
      error: "OAuth error: Invalid code",
    });
    // Starting again begins a new login.
    const again = signIn.start("claude");
    await settle();
    term.print(LOGIN_OUTPUT);
    assert.equal((await again).state, "link");
    assert.equal(term.spawned.length, 2);
    assert.equal(signIn.cancel("claude").state, "cancelled");
    assert.equal(term.proc.killed, true);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
  await assert.rejects(
    createSignIn({ dataDir: "/tmp", claudeCommand: async () => null, claudeHealth: async () => ({}), env: {} }).start("claude"),
    (e) => e.status === 404,
  );
});

test("Codex signs in with a device code through its daemon", async () => {
  const calls = [];
  let notify;
  const daemon = {
    rpc: async (method, params) => {
      calls.push([method, params]);
      return method === "account/login/start"
        ? { type: "chatgptDeviceCode", loginId: `login-${calls.length}`, verificationUrl: "https://auth.example/codex/device", userCode: "ABCD-1234" }
        : {};
    },
    onNotification: (fn) => (notify = fn),
  };
  const signIn = createSignIn({ dataDir: "/tmp", claudeCommand: async () => null, claudeHealth: async () => ({}), daemon });
  assert.deepEqual(await signIn.start("codex"), {
    agent: "codex",
    state: "link",
    url: "https://auth.example/codex/device",
    code: "ABCD-1234",
    error: null,
  });
  assert.deepEqual(calls[0], ["account/login/start", { type: "chatgptDeviceCode" }]);
  // Another login's result changes nothing here.
  notify({ method: "account/login/completed", params: { loginId: "other", success: true } });
  assert.equal(signIn.view("codex").state, "link");
  notify({ method: "account/login/completed", params: { loginId: "login-1", success: true } });
  assert.equal(signIn.view("codex").state, "done");
  // Codex has no code to paste back.
  assert.throws(() => signIn.submit("codex", "x"), (e) => e.status === 409);
  await signIn.start("codex");
  signIn.cancel("codex");
  assert.deepEqual(calls.at(-1), ["account/login/cancel", { loginId: "login-2" }]);
  assert.equal(signIn.view("codex").state, "cancelled");
});

test("a sign-in left waiting times out", async () => {
  const term = fakeTerminal();
  const signIn = createSignIn({
    dataDir: await dataDir(),
    claudeCommand: async () => "claude",
    claudeHealth: async () => ({ signedIn: false }),
    spawn: term.spawn,
    env: {},
    timeoutMs: 30,
    linkMs: 5,
  });
  assert.equal((await signIn.start("claude")).state, "starting");
  await settle(60);
  assert.deepEqual(signIn.view("claude"), {
    agent: "claude",
    state: "failed",
    url: null,
    code: null,
    error: "Sign-in timed out. Start again.",
  });
  assert.equal(term.proc.killed, true);
});

test("sign-in routes are owner-only and pass through", async () => {
  const root = await dataDir();
  const seen = [];
  const reach = await createReach({
    roots: [root],
    dataDir: path.join(root, ".reach"),
    agentSessions: {
      list: async () => ({ sessions: [], errors: {} }),
      health: async () => [],
      signIn: {
        start: async (agent) => (seen.push(["start", agent]), { agent, state: "link", url: "https://x", code: null, error: null }),
        submit: (agent, code) => (seen.push(["submit", agent, code]), { agent, state: "checking" }),
        view: (agent) => ({ agent, state: "link" }),
        cancel: (agent) => (seen.push(["cancel", agent]), { agent, state: "cancelled" }),
      },
    },
  });
  await new Promise((r) => reach.server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${reach.server.address().port}`;
  const owner = reach.auth.issue("owner", ALL_SCOPES);
  const agent = reach.auth.issue("agent", ["terminal", "files", "codex"], "agent");
  const call = (route, token, method = "GET", body) =>
    fetch(url + route, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  try {
    assert.equal((await call("/api/sessions/sign-in", agent.token, "POST", { agent: "claude" })).status, 403);
    assert.equal((await call("/api/sessions/sign-in", owner.token, "POST", { agent: "gemini" })).status, 404);
    assert.equal((await (await call("/api/sessions/sign-in", owner.token, "POST", { agent: "claude" })).json()).state, "link");
    assert.equal((await (await call("/api/sessions/sign-in?agent=claude", owner.token)).json()).state, "link");
    assert.equal(
      (await (await call("/api/sessions/sign-in/code", owner.token, "POST", { agent: "claude", code: "C-1" })).json()).state,
      "checking",
    );
    assert.equal((await (await call("/api/sessions/sign-in?agent=claude", owner.token, "DELETE")).json()).state, "cancelled");
    assert.deepEqual(seen, [
      ["start", "claude"],
      ["submit", "claude", "C-1"],
      ["cancel", "claude"],
    ]);
  } finally {
    reach.server.close();
    await reach.close?.();
    await fs.rm(root, { recursive: true, force: true });
  }
});
