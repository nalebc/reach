import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { windowsBrowserProcess } from "./windows-browser-lifetime.mjs";

const exec = promisify(execFile);

// A real browser for tests that need one (WebAuthn, say): headless Chrome,
// driven over the DevTools protocol on a pipe (no port, no window, nothing
// added to this computer's own Chrome profile or keychain). Found where it's
// usually installed, or at REACH_TEST_CHROME; null when there's none.
export function findChrome() {
  const given = process.env.REACH_TEST_CHROME;
  if (given) return fs.existsSync(given) ? given : null;
  const candidates =
    process.platform === "darwin"
      ? [
          "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
          "/Applications/Chromium.app/Contents/MacOS/Chromium",
        ]
      : process.platform === "linux"
        ? [
            "/usr/bin/google-chrome",
            "/usr/bin/google-chrome-stable",
            "/usr/bin/chromium",
            "/usr/bin/chromium-browser",
            "/snap/bin/chromium",
          ]
        : process.platform === "win32"
          ? [process.env.PROGRAMFILES, process.env["PROGRAMFILES(X86)"], process.env.LOCALAPPDATA]
              .filter(Boolean)
              .map((base) => path.join(base, "Google", "Chrome", "Application", "chrome.exe"))
          : [];
  return candidates.find((file) => fs.existsSync(file)) || null;
}

// A certificate for `host` (and its port-less twin), and the hash Chrome is
// told to accept it by: trusted by this one browser only, for this run.
export async function testCertificate(dir, host) {
  const key = path.join(dir, "tls.key"),
    cert = path.join(dir, "tls.pem"),
    conf = path.join(dir, "tls.cnf");
  fs.writeFileSync(
    conf,
    `[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=${host}\n[ext]\nsubjectAltName=DNS:${host}\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n`,
  );
  await exec(
    "openssl",
    ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-sha256", "-days", "1", "-keyout", key, "-out", cert, "-config", conf],
    { timeout: 20000 },
  );
  const pem = fs.readFileSync(cert);
  const spki = new crypto.X509Certificate(pem).publicKey.export({ type: "spki", format: "der" });
  return {
    key: fs.readFileSync(key),
    cert: pem,
    spki: crypto.createHash("sha256").update(spki).digest("base64"),
  };
}

// Chrome, headless, with its own throwaway profile. `hosts`: names it
// resolves to this computer ("MAP name 127.0.0.1"); `spki`: the one test
// certificate it accepts. Returns a DevTools client: send(method, params,
// sessionId), on(method, listener), and close(). Closed after the test
// (`t.after`); close it first yourself when something else waits for its
// connections to end (a server's close()).
async function launchBrowserProcess(binary, flags) {
  if (process.platform === "win32") return windowsBrowserProcess(binary, flags);
  const child = spawn(binary, flags, { stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"], detached: true });
  return { child, async terminate() { process.kill(-child.pid, "SIGKILL"); } };
}

export async function launchChrome(t, { binary = findChrome(), hosts = [], spki, args = [], launchProcess = launchBrowserProcess } = {}) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "reach-chrome-"));
  const flags = [
    "--headless=new",
    `--user-data-dir=${profile}`,
    "--remote-debugging-pipe",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-component-update",
    // Disposable browser tests must not start the installed browser's updater,
    // which can outlive Chrome while inheriting its stderr socket on macOS.
    "--disable-updater-scheduler",
    "--disable-sync",
    "--use-mock-keychain",
    "--password-store=basic",
    "--disable-gpu",
    ...(process.platform === "linux" ? ["--no-sandbox"] : []),
    ...(hosts.length
      ? [`--host-resolver-rules=${hosts.map((h) => `MAP ${h} 127.0.0.1`).join(", ")}`]
      : []),
    ...(spki ? [`--ignore-certificate-errors-spki-list=${spki}`] : []),
    ...args,
    "about:blank",
  ];
  let owner;
  try { owner = await launchProcess(binary, flags); }
  catch (error) { await fs.promises.rm(profile, { recursive: true, force: true }); throw error; }
  const child = owner.child;
  const began = performance.now();
  const processEvents = [];
  child.once("exit", (code, signal) => processEvents.push({ kind: "exit", code, signal, elapsedMs: Math.round(performance.now() - began) }));
  let stderr = "";
  child.stderr.on("data", (c) => {
    if (stderr.length < 1 << 16) stderr += c;
  });
  const exited = new Promise((resolve) => child.once("exit", resolve));
  let hasClosed = false;
  const closed = new Promise(resolve => child.once("close", () => {
    hasClosed = true;
    processEvents.push({ kind: "close", elapsedMs: Math.round(performance.now() - began) });
    resolve();
  }));
  const toChrome = child.stdio[3],
    fromChrome = child.stdio[4];
  let next = 1,
    buffered = Buffer.alloc(0);
  const waiting = new Map(),
    listeners = new Map();
  const failPending = (error) => {
    for (const call of waiting.values()) call.reject(error);
    waiting.clear();
  };
  child.on("error", failPending);
  exited.then(() => failPending(Error(`Chrome exited: ${stderr.slice(-400)}`)));
  toChrome.on("error", failPending);
  fromChrome.on("error", failPending);
  fromChrome.on("data", (chunk) => {
    buffered = Buffer.concat([buffered, chunk]);
    let end;
    while ((end = buffered.indexOf(0)) >= 0) {
      const message = JSON.parse(buffered.subarray(0, end).toString("utf8"));
      buffered = buffered.subarray(end + 1);
      if (message.id && waiting.has(message.id)) {
        const { resolve, reject, method } = waiting.get(message.id);
        waiting.delete(message.id);
        if (message.error) reject(Error(`${method}: ${message.error.message}`));
        else resolve(message.result);
      } else if (message.method)
        for (const listener of listeners.get(message.method) || []) listener(message.params, message.sessionId);
    }
  });
  // Page calls keep their 20 s bound. The first browser handshake also
  // includes cold profile/sandbox startup on a shared runner.
  const send = (method, params = {}, sessionId, timeoutMs = 20000) =>
    new Promise((resolve, reject) => {
      if (hasClosed || child.exitCode !== null || child.signalCode !== null) return reject(Error(`Chrome exited: ${stderr.slice(-400)}`));
      const id = next++;
      const timer = setTimeout(() => {
        waiting.delete(id);
        reject(Error(`${method}: no answer from Chrome in ${timeoutMs / 1000} s${stderr.trim() ? `: ${stderr.trim().slice(-1000)}` : " (no stderr)"}`));
      }, timeoutMs);
      waiting.set(id, {
        resolve: (v) => (clearTimeout(timer), resolve(v)),
        reject: (e) => (clearTimeout(timer), reject(e)),
        method,
      });
      toChrome.write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + "\0");
    });
  const waitForClose = async (timeoutMs) => {
    let timer;
    try {
      return await Promise.race([
        closed.then(() => true),
        new Promise(resolve => { timer = setTimeout(() => resolve(false), timeoutMs); }),
      ]);
    } finally { clearTimeout(timer); }
  };
  let profileRemoved = false;
  const lifetime = () => ({
    pid: child.pid, exitCode: child.exitCode, signalCode: child.signalCode,
    hasClosed, profileRemoved, events: processEvents.map(event => ({ ...event })),
    pipes: [child.stderr, toChrome, fromChrome].map(pipe => ({ ended: pipe.readableEnded === true, writableEnded: pipe.writableEnded === true, destroyed: pipe.destroyed === true })),
    ...(owner.snapshot ? { ownedTree: owner.snapshot() } : {}),
  });
  let closing;
  const close = () => closing ||= (async () => {
    try {
      if (!hasClosed && child.pid) {
        if (child.exitCode === null && child.signalCode === null) {
          // Let Chrome stop its children and flush the throwaway profile before
          // deleting it. A CDP reply alone is not proof that they have stopped.
          void send("Browser.close", {}, undefined, 2000).catch(() => {});
          await waitForClose(2000);
        }
        if (!hasClosed) {
          let killError;
          try {
            await owner.terminate(2000);
          } catch (error) {
            killError = error;
            if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
          }
          if (!await waitForClose(2000)) {
            failPending(Error("Chrome shutdown timed out"));
            for (const pipe of [child.stderr, toChrome, fromChrome]) pipe.destroy();
            child.unref();
            throw Error("Disposable Chrome did not close after bounded termination", { cause: killError });
          }
        }
      }
      // EOF from destroyed pipes is not proof of a stopped Windows tree. The
      // broker must independently report zero kernel-owned processes and exit.
      owner.assertStopped?.();
      failPending(Error("Chrome closed"));
      // Async retries allow any final filesystem work to settle. Sync removal
      // blocks the test event loop while a killed browser's children can write.
      await fs.promises.rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      profileRemoved = true;
    } catch (error) {
      t.diagnostic?.(`Chrome lifetime ${JSON.stringify(lifetime())}`);
      throw error;
    }
  })();
  t.after(close);
  // Answers once it's up.
  await Promise.race([
    send("Browser.getVersion", {}, undefined, 60000),
    exited.then(() => {
      throw Error(`Chrome didn't start: ${stderr.slice(-400)}`);
    }),
  ]);
  return {
    send,
    on(method, listener) {
      listeners.set(method, [...(listeners.get(method) || []), listener]);
    },
    close,
    lifetime,
    stderr: () => stderr,
  };
}

// One tab: its session, and evaluate(expression) for the value of a page
// expression (awaited if it's a promise).
export async function openTab(chrome) {
  const { targetId } = await chrome.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await chrome.send("Target.attachToTarget", { targetId, flatten: true });
  const send = (method, params) => chrome.send(method, params, sessionId);
  // What the page said went wrong (its console errors and uncaught
  // exceptions), for a failing test's message.
  const problems = [];
  chrome.on("Runtime.exceptionThrown", (params, from) => {
    if (from === sessionId)
      problems.push(params.exceptionDetails?.exception?.description || params.exceptionDetails?.text);
  });
  chrome.on("Runtime.consoleAPICalled", (params, from) => {
    if (from === sessionId && ["error", "warning"].includes(params.type))
      problems.push(params.args.map((a) => a.value ?? a.description).join(" "));
  });
  chrome.on("Log.entryAdded", (params, from) => {
    if (from === sessionId && params.entry.level === "error")
      problems.push(`${params.entry.text} ${params.entry.url || ""}`.trim());
  });
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Log.enable");
  const evaluate = async (expression) => {
    const { result, exceptionDetails } = await send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (exceptionDetails)
      throw Error(exceptionDetails.exception?.description || exceptionDetails.text);
    return result.value;
  };
  let loads = 0;
  chrome.on("Page.loadEventFired", (_params, from) => {
    if (from === sessionId) loads++;
  });
  const navigate = async (url) => {
    const before = loads;
    await send("Page.navigate", { url });
    const until = Date.now() + 20000;
    while (loads === before) {
      if (Date.now() > until) throw Error(`${url} didn't load in 20 s`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  };
  return { sessionId, send, evaluate, navigate, problems };
}
