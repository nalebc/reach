import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventEmitter, once } from "node:events";
import { PassThrough } from "node:stream";
import { WebSocket } from "ws";
import { DesktopTerminals } from "../server/desktop-terminals.mjs";
import { windowsArg, windowsLaunch, windowsTerminalRunner, wtEscape } from "../server/windows-terminals.mjs";
import { MacTerminalWatch, terminalWatchHelper } from "../server/mac-terminal-watch.mjs";
import { createAppShortcuts } from "../server/app-shortcuts.mjs";
import { powershellCall } from "../server/powershell.mjs";
import { createReach } from "../server/index.mjs";
import { ALL_SCOPES } from "../server/core.mjs";

// The PC's own terminals (workstream T, docs/WINDOWS_AGENT_PARITY.md): a
// Windows PC lists its Windows Terminal tabs and console windows beside
// Reach's terminals, reads them, types into them, brings them forward,
// closes them and opens new ones, through one C# helper
// (scripts/native/windows-terminals.cs). Here the helper is a stand-in, so
// these run on any computer; test/windows-terminals-native.test.mjs drives
// the real one on a real Windows runner.
const allow = () => {};
const pwsh = { file: String.raw`C:\Program Files\PowerShell\7\pwsh.exe`, args: ["-NoLogo"], kind: "powershell", name: "PowerShell" };
const cmd = { file: String.raw`C:\Windows\System32\cmd.exe`, args: "", kind: "cmd", name: "Command Prompt" };
const wsl = { file: String.raw`C:\Windows\System32\wsl.exe`, args: ["-d", "Ubuntu"], kind: "other", name: "Ubuntu" };
const powershell = () => ({ file: String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`, args: ["-NoLogo"], kind: "powershell", name: "Windows PowerShell" });

const session = (window, provider = "windows-terminal", name = "PowerShell") => ({
  provider,
  target: { window: String(window), pid: window + 1, start: "133713371337133713" },
  name,
  tty: String(window),
});
function fakePc() {
  const pc = {
    calls: [],
    sessions: [session(100), session(200, "console", "Command Prompt - npm  run dev")],
    run: async (payload) => {
      pc.calls.push(payload);
      if (payload.action === "list")
        return { sessions: pc.sessions, running: { "windows-terminal": true, console: true }, installed: { "windows-terminal": true, console: true } };
      if (!pc.sessions.some((s) => JSON.stringify(s.target) === JSON.stringify(payload.target)) && payload.action !== "create")
        throw Object.assign(Error("This terminal has closed. Refresh the list."), { status: 404 });
      if (payload.action === "read") return { text: payload.scrollback ? "earlier\nPS C:\\> " : "PS C:\\> " };
      if (payload.action === "focus") return { ok: true, front: false };
      return { ok: true };
    },
  };
  return pc;
}

test("a Windows PC lists its Windows Terminal tabs and console windows in one look, leaving Reach's own out", async () => {
  const pc = fakePc();
  pc.sessions.push({ ...session(300), provider: "vscode" }, { ...session(400), ended: true });
  const d = new DesktopTerminals({ platform: "win32", run: pc.run, reach: 4242 });
  const first = await d.list(allow);
  assert.deepEqual(pc.calls, [{ action: "list", exclude: 4242 }], "one helper run, told Reach's own process");
  assert.deepEqual(first.sessions.map((s) => [s.provider, s.name, s.tty]), [
    ["windows-terminal", "PowerShell", "100"],
    ["console", "Command Prompt - npm  run dev", "200"],
  ]);
  assert.deepEqual(first.providers, [
    { id: "windows-terminal", name: "Windows Terminal", running: true, installed: true },
    { id: "console", name: "Console window", running: true, installed: true },
  ]);
  // Ids come from the target, not the title or the order.
  pc.sessions = [{ ...session(200, "console"), name: "renamed" }, session(100)];
  const again = await d.list(allow);
  assert.equal(again.sessions[0].id, first.sessions[1].id);
  assert.equal(again.sessions[1].id, first.sessions[0].id);
  assert.notEqual(first.sessions[0].id, first.sessions[1].id);
});

test("a helper that can't run on the PC says why, instead of an empty list", async () => {
  const d = new DesktopTerminals({
    platform: "win32",
    run: async () => {
      throw Object.assign(Error("This needs Windows' C# compiler (csc.exe, part of the .NET Framework 4.8 that comes with Windows), and it isn't on this PC."), { status: 503 });
    },
  });
  await assert.rejects(d.list(allow), { status: 503, message: /C# compiler/ });
  // Only a Mac and a Windows PC have terminal apps Reach knows.
  await assert.rejects(new DesktopTerminals({ platform: "linux", run: fakePc().run }).list(allow), { status: 409, message: /macOS and Windows/ });
});

test("reading, typing into, bringing forward and closing a PC tab carry its target, with the Mac's checks", async () => {
  const pc = fakePc();
  const d = new DesktopTerminals({ platform: "win32", run: pc.run });
  const [tab, console] = (await d.list(allow)).sessions;
  const before = pc.calls.length;
  for (const text of [undefined, " ", "x".repeat(16001), "\0", "\x03", "\x1b[A"])
    await assert.rejects(d.action(tab.id, "send", { text }, allow), { status: 400 });
  await assert.rejects(d.action(tab.id, "close", {}, allow), { status: 400 });
  assert.equal(pc.calls.length, before, "nothing reaches the PC before its checks pass");
  const text = 'echo "quotes", $env:PATH; & ünïcode ✓';
  await d.action(tab.id, "send", { text }, allow);
  assert.deepEqual(pc.calls.at(-1), { provider: "windows-terminal", target: session(100).target, action: "send", text });
  // Return on its own answers a prompt, as on a Mac.
  await d.action(tab.id, "send", { text: "" }, allow);
  assert.equal(pc.calls.at(-1).text, "");
  assert.equal((await d.action(console.id, "read", { scrollback: true }, allow)).text, "earlier\nPS C:\\> ");
  assert.equal(pc.calls.at(-1).scrollback, true);
  assert.equal(pc.calls.at(-1).provider, "console");
  // Windows said it kept the window behind: the phone hears it.
  assert.deepEqual(await d.action(tab.id, "focus", {}, allow), { ok: true, front: false });
  await d.action(tab.id, "close", { confirm: true }, allow);
  assert.equal(pc.calls.at(-1).action, "close");
  await assert.rejects(d.action(tab.id, "read", {}, allow), { status: 404, message: "Terminal not found. Refresh the Windows PC terminal list." });
});

// How Windows programs read their command line (CommandLineToArgvW).
function argv(line) {
  const out = [];
  let i = 0;
  for (;;) {
    while (line[i] === " " || line[i] === "\t") i++;
    if (i >= line.length) return out;
    let arg = "",
      quoted = false;
    while (i < line.length && (quoted || (line[i] !== " " && line[i] !== "\t"))) {
      if (line[i] === "\\") {
        let slashes = 0;
        while (line[i] === "\\") {
          slashes++;
          i++;
        }
        if (line[i] === '"') {
          arg += "\\".repeat(slashes >> 1);
          if (slashes % 2) {
            arg += '"';
            i++;
          }
        } else arg += "\\".repeat(slashes);
      } else if (line[i] === '"') {
        quoted = !quoted;
        i++;
      } else arg += line[i++];
    }
    out.push(arg);
  }
}
// What wt.exe makes of its arguments (microsoft/terminal
// src/cascadia/TerminalApp/AppCommandlineArgs.cpp and Commandline.cpp): one
// command unless a ";" isn't escaped, each "\;" read as ";", and the new
// tab's command line joined back with plain quotes around parts with spaces.
function wt(args) {
  const parts = argv(args);
  for (const part of parts) assert.doesNotMatch(part, /(^;|[^\\];)/, `"${part}" would split wt.exe's command`);
  const read = parts.map((part) => part.replaceAll("\\;", ";"));
  const at = read.indexOf("--");
  return {
    options: read.slice(0, at < 0 ? read.length : at),
    folder: read[read.indexOf("-d") + 1],
    tab: at < 0 ? null : read.slice(at + 1).map((part) => (part.includes(" ") ? `"${part}"` : part)).join(" "),
  };
}
// cmd /s /k: the rest of its line, the first and the last quote taken off.
function cmdRuns(line) {
  const rest = line.slice(line.indexOf(" /k ") + 4);
  return rest.startsWith('"') ? rest.slice(1, rest.lastIndexOf('"')) + rest.slice(rest.lastIndexOf('"') + 1) : rest;
}
const encoded = (line) => {
  const args = argv(line);
  return Buffer.from(args[args.indexOf("-EncodedCommand") + 1], "base64").toString("utf16le");
};
const COMMANDS = [
  String.raw`"C:\Users\me\AppData\Roaming\npm\codex.cmd"`,
  String.raw`"C:\Program Files\nodejs\node.exe" "C:\Users\First Last\AppData\Roaming\npm\node_modules\@anthropic-ai\claude-code\cli.js"`,
  "npm run dev",
  'echo "a;b" & dir',
  String.raw`echo a\;b \\; c`,
  'git log --format="%h %s" -n 3',
  String.raw`cd "C:\My Folder\" && dir`,
  `python -c "print('héllo ✓')"`,
  ";starts with a semicolon",
  String.raw`ends with a backslash \\`,
];
const FOLDERS = [String.raw`C:\Users\me`, String.raw`C:\My Projects\a;b`, "D:\\", "C:\\x\\y z\\"];

test("a new terminal opens in Windows Terminal, or a console window, in the folder, the command only ever a shell's argument", () => {
  for (const cwd of FOLDERS)
    for (const command of COMMANDS) {
      const ps = windowsLaunch({ cwd, command, shell: pwsh, powershell });
      const tab = wt(ps.terminal);
      assert.deepEqual(tab.options, ["-w", "new", "new-tab", "-d", cwd]);
      assert.equal(tab.folder, cwd, "the folder as given");
      // PowerShell is given the command encoded: nothing in it is a quote,
      // a space or a semicolon for wt.exe or the console to read.
      assert.equal(encoded(tab.tab), powershellCall(command), command);
      assert.equal(encoded(ps.console.line), powershellCall(command));
      assert.match(tab.tab, /^"C:\\Program Files\\PowerShell\\7\\pwsh\.exe" -NoLogo -NoExit -EncodedCommand [A-Za-z0-9+/=]+$/);
      assert.equal(ps.console.file, pwsh.file);
      assert.equal(argv(ps.console.line)[0], pwsh.file);

      const cm = windowsLaunch({ cwd, command, shell: cmd, powershell });
      const cmdTab = wt(cm.terminal);
      assert.equal(cmdTab.folder, cwd);
      assert.ok(cmdTab.tab.startsWith(String.raw`C:\Windows\System32\cmd.exe /s /k "`), cmdTab.tab);
      assert.equal(cmdRuns(cmdTab.tab), `${command} `, `cmd runs it as written: ${command}`);
      assert.equal(cmdRuns(cm.console.line), command);
    }
});

test("a new terminal without a command is the owner's own: Windows Terminal's default profile, or their shell in a console", () => {
  const plain = windowsLaunch({ cwd: String.raw`C:\Users\me`, shell: pwsh, powershell });
  assert.deepEqual(wt(plain.terminal), { options: ["-w", "new", "new-tab", "-d", String.raw`C:\Users\me`], folder: String.raw`C:\Users\me`, tab: null });
  assert.deepEqual(argv(plain.console.line), [pwsh.file, "-NoLogo"]);
  // Windows Terminal's profile command line, as its settings write it.
  const profile = windowsLaunch({ cwd: "C:\\", shell: { ...cmd, args: "/k prompt $P$G" }, powershell });
  assert.equal(profile.console.line, String.raw`C:\Windows\System32\cmd.exe /k prompt $P$G`);
  // A shell that can't run a program by its path (WSL): PowerShell runs the
  // command, as in Reach's own terminals; without one, it's still WSL.
  const agent = windowsLaunch({ cwd: "C:\\", command: String.raw`"C:\x\codex.exe"`, shell: wsl, powershell });
  assert.equal(agent.console.file, powershell().file);
  assert.equal(encoded(agent.console.line), "& 'C:\\x\\codex.exe'");
  assert.deepEqual(argv(windowsLaunch({ cwd: "C:\\", shell: wsl, powershell }).console.line), [wsl.file, "-d", "Ubuntu"]);
});

test("the C runtime's quoting and wt.exe's escape round-trip any argument", () => {
  for (const arg of ["plain", "two words", 'say "hi"', "trailing\\", "trailing space\\", 'x\\"y', "", "a;b", "\\\\server\\share"])
    assert.deepEqual(argv(windowsArg(arg)), [arg], arg);
  assert.equal(wtEscape("a;b;c"), "a\\;b\\;c");
});

test("DesktopTerminals opens a PC terminal in the folder asked, the home folder otherwise, and refuses anything else first", async () => {
  const pc = fakePc();
  const d = new DesktopTerminals({
    platform: "win32",
    run: pc.run,
    launch: (options) => windowsLaunch({ ...options, shell: pwsh, powershell }),
    home: () => String.raw`C:\Users\me`,
  });
  await d.create("windows-terminal", allow, String.raw`"C:\x\codex.exe"`, { cwd: String.raw`C:\src\reach` });
  const opened = pc.calls.at(-1);
  assert.equal(opened.action, "create");
  assert.equal(opened.provider, "windows-terminal");
  assert.equal(opened.cwd, String.raw`C:\src\reach`);
  assert.equal(encoded(wt(opened.terminal).tab), "& 'C:\\x\\codex.exe'");
  await d.create("console", allow);
  assert.equal(pc.calls.at(-1).cwd, String.raw`C:\Users\me`);
  assert.equal(wt(pc.calls.at(-1).terminal).tab, null);
  const before = pc.calls.length;
  await assert.rejects(d.create("terminal", allow), { status: 400, message: "Choose Windows Terminal or a console window." });
  for (const cwd of ["relative\\folder", "\\\\server\\share", "/Users/me", 'C:\\"quoted"', "C:\\a\nb", 7])
    await assert.rejects(d.create("console", allow, undefined, { cwd }), { status: 400, message: "Choose a folder on this PC." }, String(cwd));
  for (const command of ["two\nlines", "tab\there", "\x1b[A", " "])
    await assert.rejects(d.create("console", allow, command, { cwd: "C:\\" }), { status: 400 }, JSON.stringify(command));
  assert.equal(pc.calls.length, before);
  // A Mac still opens Terminal or iTerm2 with its command, as before.
  const mac = [];
  await new DesktopTerminals({ platform: "darwin", run: async (p) => (mac.push(p), { ok: true }) }).create("terminal", allow, "cd '/x' && codex");
  assert.deepEqual(mac, [{ provider: "terminal", action: "create", command: "cd '/x' && codex" }]);
});

test("the helper runs with its request on stdin, hidden, without Reach's own settings, and its refusals keep their reason", async () => {
  const runs = [];
  const fake = (answer, { error = null } = {}) => (file, args, options, done) => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    let input = "";
    child.stdin.on("data", (chunk) => (input += chunk));
    child.stdin.on("end", () => {
      runs.push({ file, args, options, input: JSON.parse(input) });
      setImmediate(() => done(error, answer));
    });
    return child;
  };
  const build = async (config, kind) => path.join(config.dataDir, `reach-${kind}-0123456789ab.exe`);
  const env = { PATH: "C:\\Windows", REACH_DATA: "C:\\secret", reach_token: "x" };
  const run = windowsTerminalRunner({ dataDir: "C:\\data", build, run: fake('{"sessions":[]}\n'), env });
  assert.deepEqual(await run({ action: "list", exclude: 1 }), { sessions: [] });
  assert.equal(runs[0].file, path.join("C:\\data", "reach-windows-terminals-0123456789ab.exe"));
  assert.deepEqual(runs[0].args, []);
  assert.equal(runs[0].options.windowsHide, true);
  assert.deepEqual(runs[0].options.env, { PATH: "C:\\Windows" });
  assert.deepEqual(runs[0].input, { action: "list", exclude: 1 });
  await assert.rejects(
    windowsTerminalRunner({ dataDir: "C:\\data", build, run: fake('{"error":"Windows keeps Reach out of this terminal: it runs as administrator.","status":403}\n'), env })({ action: "read" }),
    { status: 403, message: /administrator/ },
  );
  await assert.rejects(
    windowsTerminalRunner({ dataDir: "C:\\data", build, run: fake("", { error: Object.assign(Error("killed"), { killed: true }) }), env })({ action: "read" }),
    { status: 502, message: "Windows didn't answer about its terminals. Try again in a moment." },
  );
  await assert.rejects(windowsTerminalRunner({ build, run: fake("{}") })({ action: "list" }), { status: 503 });
});

test("the PC's watch is its terminals helper run as a watch, hidden, and its output finds the tab it names", async () => {
  const started = [];
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stdin: new PassThrough() });
  const start = terminalWatchHelper(
    { dataDir: "C:\\data" },
    {
      platform: "win32",
      build: async (config, kind) => `${config.dataDir}\\reach-${kind}.exe`,
      start: (file, args, options) => (started.push({ file, args, options }), child),
    },
  );
  const helper = await start();
  assert.deepEqual(started, [{ file: "C:\\data\\reach-windows-terminals.exe", args: ["watch"], options: { stdio: ["pipe", "pipe", "ignore"], windowsHide: true } }]);
  const events = [];
  helper.on("event", (event) => events.push(event));
  child.stdout.write('{"type":"output","tty":"100"}\n');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, [{ type: "output", tty: "100" }]);

  // The same watch as a Mac's: told by the helper, a viewed tab is read.
  const pc = fakePc();
  const fakeHelper = Object.assign(new EventEmitter(), { sent: [], send: (m) => fakeHelper.sent.push(m), stop() {} });
  const watch = new MacTerminalWatch({ terminals: new DesktopTerminals({ platform: "win32", run: pc.run }), start: async () => fakeHelper, wait: 300, readGap: 0 });
  watch.retain();
  const until = async (check) => {
    for (let i = 0; i < 300 && !check(); i++) await new Promise((r) => setTimeout(r, 5));
    assert.ok(check());
  };
  await until(() => watch.ready);
  assert.deepEqual(fakeHelper.sent.at(-1), { ttys: ["100", "200"] });
  const id = watch.list(allow).sessions[0].id;
  const first = await watch.text(id, -1, allow);
  assert.equal(first.text, "earlier\nPS C:\\> ");
  const reads = pc.calls.filter((c) => c.action === "read").length;
  const next = watch.text(id, first.version, allow);
  fakeHelper.emit("event", { type: "output", tty: "100" });
  await next;
  assert.ok(pc.calls.filter((c) => c.action === "read").length > reads, "output read the tab it named");
  watch.end();
});

test("shortcuts on a Windows PC open the PC's own terminal in the shortcut's folder", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "reach-pc-shortcuts-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const real = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "win32" });
  try {
    const opened = [];
    const options = {
      dataDir,
      listApps: async () => [],
      loadIcon: async () => null,
      resolveFolder: (root, folder) => (folder ? `C:\\Users\\me\\src\\${folder}` : "C:\\Users\\me\\src"),
      locateCli: async (name) => (name === "codex" ? '"C:\\Users\\me\\AppData\\Roaming\\npm\\codex.cmd"' : null),
    };
    const shortcuts = createAppShortcuts({ ...options, windowsTerminal: async (where, authorize) => (opened.push(where), authorize(), { ok: true }) });
    const codex = (await shortcuts.list()).find((s) => s.id === "recipe:codex-terminal");
    assert.ok(codex, "Codex in Terminal is offered");
    await shortcuts.run(codex.id);
    const saved = await shortcuts.save({ name: "Dev", type: "terminal", command: "npm run dev", path: "app" });
    await shortcuts.run(saved.id);
    assert.deepEqual(opened, [
      { cwd: "C:\\Users\\me\\src", command: '"C:\\Users\\me\\AppData\\Roaming\\npm\\codex.cmd"' },
      { cwd: "C:\\Users\\me\\src\\app", command: "npm run dev" },
    ]);
    // No way to open one: no terminal shortcuts, rather than a broken one.
    const without = createAppShortcuts({ ...options, dataDir: await fs.mkdtemp(path.join(dataDir, "none-")) });
    assert.ok(!(await without.list()).some((s) => s.kind === "terminal"));
  } finally {
    Object.defineProperty(process, "platform", real);
  }
});

test("Reach on a Windows PC: owners reach its terminals over HTTP, agents don't, phones are told of changes, and words say Windows PC", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "reach-pc-terminals-"));
  const pc = fakePc();
  const helpers = [];
  const reach = await createReach({
    roots: [root],
    dataDir: path.join(root, ".reach"),
    desktopTerminals: { platform: "win32", run: pc.run, home: () => "C:\\Users\\me", launch: (options) => windowsLaunch({ ...options, shell: pwsh, powershell }) },
    terminalWatch: async () => {
      const helper = Object.assign(new EventEmitter(), { sent: [], send: (m) => helper.sent.push(m), stop() {} });
      helpers.push(helper);
      return helper;
    },
    macTerminalWatch: { linger: 50 },
  });
  await new Promise((r) => reach.server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${reach.server.address().port}`;
  const owner = reach.auth.issue("owner", ALL_SCOPES);
  const agent = reach.auth.issue("agent", ["terminal"], "agent");
  const sockets = [];
  t.after(async () => {
    for (const ws of sockets) ws.terminate();
    await reach.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const call = async (route, token, body) => {
    const r = await fetch(url + route, {
      method: body ? "POST" : "GET",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, body: await r.json() };
  };
  const refused = await call("/api/terminals/desktop", agent.token);
  assert.equal(refused.status, 403);
  assert.equal(refused.body.error, "Only a paired person can access existing Windows PC terminals.");
  const listed = await call("/api/terminals/desktop", owner.token);
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body.sessions.map((s) => s.provider), ["windows-terminal", "console"]);
  const id = listed.body.sessions[0].id;
  assert.equal((await call(`/api/terminals/desktop/${id}/send`, owner.token, { text: "dir" })).status, 200);
  assert.equal((await call(`/api/terminals/desktop/${id}/focus`, owner.token, {})).body.front, false);
  assert.equal((await call("/api/terminals/desktop", owner.token, { provider: "windows-terminal" })).status, 200);
  assert.equal(pc.calls.at(-1).cwd, "C:\\Users\\me");

  // A phone connected: the PC's terminals are watched, and changes pushed.
  const ws = new WebSocket(url.replace("http:", "ws:") + "/ws/presence");
  sockets.push(ws);
  const seen = [];
  ws.on("message", (b) => {
    const m = JSON.parse(b);
    if (m.type === "presence") seen.push(m.changes?.macTerminals);
  });
  await once(ws, "open");
  ws.send(JSON.stringify({ type: "auth", token: owner.token, kind: "phone" }));
  for (let i = 0; i < 400 && !seen.some(Boolean); i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(seen.some(Boolean), "the phone hears the PC's terminals' fingerprint");
  assert.deepEqual(helpers[0].sent.at(-1), { ttys: ["100", "200"] });
});

test("the helper's source keeps to the rules: no inherited Ctrl+C ignore, no handles handed on, no input tricks, no PowerShell", async () => {
  const source = await fs.readFile(new URL("../scripts/native/windows-terminals.cs", import.meta.url), "utf8");
  // Ignoring Ctrl+C with a null handler is inherited by the terminals it opens.
  assert.doesNotMatch(source, /SetConsoleCtrlHandler\(\s*(null|IntPtr\.Zero)/);
  // A new terminal gets nothing of this helper's (its pipes to Reach).
  assert.match(source, /CreateProcessW\(file, [^;]*IntPtr\.Zero, IntPtr\.Zero, false,/);
  // docs/parity/B-desktop-helper.md §6: no synthetic keys or focus tricks.
  for (const forbidden of [/AttachThreadInput/, /SendInput/, /keybd_event/, /SwitchToThisWindow/, /\.SetFocus\(/, /AllowSetForegroundWindow/, /LockSetForegroundWindow/, /powershell/i])
    assert.doesNotMatch(source, forbidden);
});
