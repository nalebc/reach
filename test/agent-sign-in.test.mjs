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
