import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { cleanPreload } from "./clean-machine.mjs";
import { fakeTailscale, tailnetPreload, HOST } from "./fake-tailscale.mjs";

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const identity = (name, user = 42) => ({
  Node: { StableID: name, User: user, Name: `${name}.example.ts.net.`, KeyExpiry: "0001-01-01T00:00:00Z" },
  UserProfile: { ID: user, LoginName: user === 42 ? "owner@example.test" : "other@example.test" },
});

// The fake Tailscale's sign-in link, as the line Reach prints ends with it.
// Anchored at the line's end: a link with more after it isn't this one
// (CodeQL #231-#237 flagged the unanchored copies).
export const SIGN_IN_LINK = /https:\/\/login\.tailscale\.com\/a\/fixture-login$/m;
export const setupMenu = async (reach, title, answer = "") => {
  await reach.until(title);
  await reach.until(/Choose 1–\d+ \[\d+\], or q to cancel: /);
  reach.answer(answer);
};
export async function finishFirstSetup(reach, { link, source = false } = {}) {
  await setupMenu(reach, /Which Tailscale account should Reach use\?/);
  await link?.();
  // Invites and background wait for later: a first run asks nothing more.
  await reach.until(/▸ 3\. Your phone/, source ? 120000 : 15000);
  await reach.until(/Type a device request code to approve/, source ? 120000 : 15000);
  assert.equal((await reach.read("onboarding.json")).done, true);
  assert.equal((await reach.read("preferences.json")).owner.login, "owner@example.test");
  if (!source) assert.doesNotMatch(reach.output(), /installing dependencies|preparing the phone interface|Go isn't installed/, "an npm install ships its built interface and browser client");
}

// A fresh npm-shaped install through bin/reach.mjs: real bootstrap, menus,
// persisted setup, Serve/Funnel ingress and device approval. Only external
// Tailscale, OS app launching and process inventory are simulated. No source
// directory or saved preferences; no access to this machine's Reach state.
//
// `real` (the user journeys, test/journeys): this computer as it is, on a
// Mac or a Windows PC. Its own login shell for Reach's terminals, its apps
// and agents found as they are (nothing hidden), its screen, and the
// folders a first run shares (Home and the whole computer). The home and
// Reach's state are still this test's own, Tailscale is still the stand-in,
// and web pages still aren't opened on the computer. `tailscale`: more of
// the stand-in's scenario (its version, say).
export async function firstInstall(t, { missing = false, status = {}, funnelDenied = false, interactive = true, userApp = false, source = false, real = false, tailscale = {} } = {}) {
  if (source && process.platform !== "linux")
    throw Error("The cold source-install harness runs only on Linux, with fake Tailscale; it must not discover a host's Tailscale app.");
  const windows = process.platform === "win32";
  // Point at a clean npm install to run the same cases against the actual
  // release artifact; otherwise use the current checkout's package files.
  const packageRoot = path.resolve(source ? "." : process.env.REACH_TEST_PACKAGE || ".");
  const packageRequire = createRequire(path.join(packageRoot, "package.json"));
  const dependencies = path.dirname(path.dirname(packageRequire.resolve("express/package.json")));
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "reach-first-install-"));
  const app = path.join(temp, "package"), home = path.join(temp, "home");
  const state = path.join(home, ".reach"), shared = path.join(home, "shared");
  await fs.mkdir(shared, { recursive: true });
  await fs.mkdir(app);
  await fs.writeFile(path.join(shared, "welcome.txt"), "First installation works.");
  for (const name of ["bin", "scripts", "server"])
    await fs.cp(path.join(packageRoot, name), path.join(app, name), { recursive: true });
  if (source) {
    for (const name of ["reach", "src", "public", "index.html", "start.html", "agent.html", "tsconfig.json", "vite.config.mjs", "package-lock.json"])
      await fs.cp(path.join(packageRoot, name), path.join(app, name), { recursive: true });
    await fs.mkdir(path.join(app, "tailnet"));
    for (const name of ["main.go", "go.mod", "go.sum"])
      await fs.copyFile(path.join(packageRoot, "tailnet", name), path.join(app, "tailnet", name));
  } else {
    // Windows links folders as junctions, which need no privilege.
    const folder = windows ? "junction" : "dir";
    for (const name of ["dist", "tailnet"])
      await fs.symlink(path.join(packageRoot, name), path.join(app, name), folder);
    await fs.symlink(dependencies, path.join(app, "node_modules"), folder);
  }
  await fs.copyFile(path.join(packageRoot, "package.json"), path.join(app, "package.json"));
  const fake = await fakeTailscale(temp, { ...tailscale, setup: status, funnelDenied, identities: {
    "100.64.0.21": identity("phone-app"),
    "100.64.0.22": identity("phone-browser"),
    "100.64.0.23": identity("other-account", 99),
    ...Object.fromEntries([31, 32, 33, 34, ...Array.from({ length: 40 }, (_, i) => 50 + i)].map(n => [`100.64.0.${n}`, identity(`browser-${n}`)])),
  } });
  if (userApp) {
    const executable = path.join(home, "Applications/Tailscale.app/Contents/MacOS/Tailscale");
    await fs.mkdir(path.dirname(executable), { recursive: true });
    await fs.rename(fake.cli, executable);
    fake.cli = executable;
  }
  if (missing) await fs.rename(fake.cli, fake.cli + ".uninstalled");
  const shell = path.join(temp, "no-shell");
  await fs.writeFile(shell, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  const osPreload = path.join(temp, "fresh-os.mjs");
  const bootstrapPid = path.join(temp, "bootstrap.pid");
  await fs.writeFile(osPreload, `
    import cp from 'node:child_process';
    import fs from 'node:fs';
    import { promisify } from 'node:util';
    import { syncBuiltinESMExports } from 'node:module';
    const exec = cp.execFile, sync = cp.execFileSync;
    const exists = fs.existsSync;
    fs.existsSync = file => ['/opt/homebrew/bin/tailscale', '/usr/local/bin/tailscale'].includes(file) ? false : exists(file);
    // What opens a page on the computer: its browser, never started here. A
    // real computer's apps and files still open (the journeys' Apps).
    const page = (args) => !${real} || (Array.isArray(args[0]) && args[0].some(arg => /^https?:/i.test(String(arg))));
    cp.execFile = function(file, ...args) {
      // Hosted Linux images can provide /usr/bin/go even after PATH is
      // restricted. This scenario explicitly represents a computer without
      // Go: let the real spawn return ENOENT for that one optional tool.
      if (${source} && file === 'go') file = ${JSON.stringify(path.join(temp, "no-go"))};
      if (['open', '/usr/bin/open', 'xdg-open', 'explorer.exe'].includes(file) && page(args))
        return exec(process.execPath, ['-e', ''], args.find(value => typeof value === 'function'));
      return exec.call(this, file, ...args);
    };
    cp.execFile[promisify.custom] = exec[promisify.custom];
    // This simulated computer has no other Reach; never inspect or touch the
    // developer's live Reach, Terminal windows, service, or Tailscale daemon.
    cp.execFileSync = function(file, ...args) {
      return file === '/bin/ps' ? '' : sync.call(this, file, ...args);
    };
    // npm/build subprocesses really have pipes. Only Reach's own prompt
    // process represents the terminal; otherwise Vite expects TTY methods.
    // (Windows names the script with backslashes.)
    const script = (process.argv[1] || '').replaceAll('\\\\', '/');
    const reachTTY = ${interactive} && ['/scripts/bootstrap.mjs', '/bin/reach.mjs'].some(suffix => script.endsWith(suffix));
    Object.defineProperty(process.stdin, 'isTTY', { value: reachTTY, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: reachTTY, configurable: true });
    if (script.endsWith('/scripts/bootstrap.mjs'))
      fs.writeFileSync(${JSON.stringify(bootstrapPid)}, String(process.pid));
    syncBuiltinESMExports();
  `);
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("REACH_"))),
    HOME: home, PATH: "/usr/bin:/bin:/usr/sbin:/sbin", SHELL: real ? process.env.SHELL || "/bin/zsh" : shell, TERM: "dumb",
    REACH_HOME: state, REACH_CODEX: path.join(temp, "no-codex"),
    ...(userApp ? {} : { REACH_TAILSCALE: fake.cli }),
    REACH_SUPERVISED: "1",
    // One folder of native helper builds for every test that shares it.
    ...(real && process.env.REACH_TEST_NATIVE_DIR ? { REACH_TEST_NATIVE_DIR: process.env.REACH_TEST_NATIVE_DIR } : {}),
  };
  delete env.NODE_TEST_CONTEXT;
  if (windows) {
    // A Windows PC's own folders on the PATH (named in any case there), the
    // temporary home as the profile, no shell variable, and a process list
    // naming no other Reach: under a test runner the real one leads up to
    // GitHub's runner service, which Reach rightly takes for another app.
    const system = env.SystemRoot || "C:\\Windows";
    for (const key of Object.keys(env)) if (key.toUpperCase() === "PATH") delete env[key];
    env.Path = ["System32", "", "System32\\Wbem", "System32\\WindowsPowerShell\\v1.0"].map((dir) => path.win32.join(system, dir)).join(";");
    env.USERPROFILE = home;
    delete env.SHELL;
    const processes = path.join(temp, "processes.json");
    await fs.writeFile(processes, JSON.stringify({ processes: [] }));
    env.REACH_TEST_WINDOWS_PROCESSES = processes;
  }
  // As URLs: Windows' absolute paths aren't ones for --import.
  const entry = [
    "--import", pathToFileURL(path.resolve("test/helpers/runaway-guard.mjs")).href,
    ...(real ? [] : ["--import", cleanPreload]), "--import", tailnetPreload(fake.state), "--import", pathToFileURL(osPreload).href,
    path.join(app, "bin/reach.mjs"),
  ];
  let child, exited, output = "", cursor = 0, startedAt = 0, spawned = false;
  const start = () => {
    output = ""; cursor = 0; startedAt = Date.now(); spawned = false;
    const args = [...(real ? [] : ["--folder", shared]), "--no-stay-awake"];
    child = source
      ? spawn("/bin/sh", [path.join(app, "reach"), ...args], { env: {
        ...env, NODE_OPTIONS: entry.slice(0, -1).map(arg => JSON.stringify(arg)).join(" "),
        npm_config_cache: path.join(temp, "npm-cache"),
      }, stdio: ["pipe", "pipe", "pipe"] })
      : spawn(process.execPath, [...entry, ...args], { env, stdio: ["pipe", "pipe", "pipe"] });
    child.stdout.on("data", chunk => { output += chunk; });
    child.stderr.on("data", chunk => { output += chunk; });
    child.once("spawn", () => { spawned = true; });
    exited = once(child, "exit");
  };
  const until = async (pattern, ms = 15000) => {
    const deadline = Date.now() + ms;
    for (;;) {
      const match = output.slice(cursor).match(pattern);
      if (match) { cursor += match.index + match[0].length; return match; }
      if (child.exitCode !== null || child.signalCode !== null || Date.now() > deadline) {
        // Setup's dependency/build output goes to a private fixture log, not
        // stdout. Preserve its bounded tail before cleanup removes the fresh
        // home, otherwise a cold install timeout hides the operation that hung.
        const diagnostics = [];
        const logs = [path.join(state, "setup.log")];
        if (source) {
          const npmLogs = path.join(temp, "npm-cache", "_logs");
          const names = await fs.readdir(npmLogs).catch(() => []);
          logs.push(...names.filter(name => name.endsWith("-debug-0.log")).sort().slice(-2).map(name => path.join(npmLogs, name)));
        }
        for (const file of logs) {
          let handle;
          try {
            handle = await fs.open(file, "r");
            const size = (await handle.stat()).size;
            const buffer = Buffer.alloc(Math.min(size, 12000));
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, Math.max(0, size - buffer.length));
            if (bytesRead) diagnostics.push(`${path.relative(temp, file)}:\n${buffer.subarray(0, bytesRead).toString("utf8")}`);
          } catch { /* an install may not have created its log yet */ }
          finally { await handle?.close(); }
        }
        throw Error(`Fresh install did not reach ${pattern}:\n${JSON.stringify({
          pid: child.pid, spawned, exitCode: child.exitCode, signalCode: child.signalCode,
          elapsedMs: Date.now() - startedAt, waitBudgetMs: ms,
        })}\n${output.slice(-12000)}\n${diagnostics.join("\n")}`);
      }
      await sleep(20);
    }
  };
  const stop = async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      let pid;
      if (source) try { pid = Number(await fs.readFile(bootstrapPid, "utf8")); } catch {}
      if (pid) try { process.kill(pid, "SIGTERM"); } catch { child.kill("SIGTERM"); }
      else child.kill("SIGTERM");
      const forced = setTimeout(() => child.kill("SIGKILL"), 5000);
      try { await exited; } finally { clearTimeout(forced); }
    }
  };
  t.after(async () => {
    await stop();
    // The linked folders go first, as links: never what they point at.
    if (!source) for (const name of ["dist", "tailnet", "node_modules"]) await fs.rm(path.join(app, name), { force: true }).catch(() => {});
    await fs.rm(temp, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });
  const request = async (route, { ip = "100.64.0.21", public: internet = false, body, token, port, method } = {}) => {
    const routes = await fake.read();
    const target = routes.serve.Web?.[`${HOST}:${port || (funnelDenied ? 8443 : 443)}`]?.Handlers?.["/"]?.Proxy;
    if (!target?.startsWith("unix:")) throw Error("The simulated Tailscale route is not ready.");
    return new Promise((resolve, reject) => {
      const req = http.request({ socketPath: target.slice(5), path: route, method: method || (body === undefined ? "GET" : "POST"), headers: {
        Host: HOST, Origin: `https://${HOST}`, "X-Forwarded-For": internet ? "203.0.113.9" : ip,
        ...(internet ? { "Tailscale-Funnel-Request": "?1" } : { "Tailscale-User-Login": ip === "100.64.0.23" ? "other@example.test" : "owner@example.test" }),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      } }, res => {
        const chunks = [];
        res.on("data", chunk => chunks.push(chunk));
        res.on("end", () => {
          const data = Buffer.concat(chunks);
          const text = data.toString();
          let json; try { json = JSON.parse(text); } catch {}
          resolve({ status: res.statusCode, text, json, headers: res.headers, data });
        });
        res.on("error", reject);
      });
      req.on("error", reject);
      req.setTimeout(10000, () => req.destroy(Error("Fixture HTTP request timed out.")));
      req.end(body === undefined ? undefined : JSON.stringify(body));
    });
  };
  start();
  return {
    app, home, state, shared, fake, until, request, stop, temp, env,
    output: () => output, answer: text => child.stdin.write(text + "\n"),
    installTailscale: () => fs.rename(fake.cli + ".uninstalled", fake.cli),
    cli: args => new Promise((resolve, reject) => {
      const command = spawn(process.execPath, [...entry, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
      let result = "";
      command.stdout.on("data", chunk => { result += chunk; });
      command.stderr.on("data", chunk => { result += chunk; });
      const timeout = setTimeout(() => command.kill("SIGKILL"), 15000);
      command.once("error", reject);
      command.once("exit", code => { clearTimeout(timeout); code === 0 ? resolve(result) : reject(Error(result)); });
    }),
    restart: async () => { await stop(); start(); },
    exit: () => exited,
    interrupt: () => child.kill("SIGINT"),
    read: async name => JSON.parse(await fs.readFile(path.join(state, name), "utf8")),
  };
}
