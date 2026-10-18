import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import http from "node:http";
import { pathToFileURL } from "node:url";
import { stopReach } from "../scripts/stop.mjs";
import { startCleanReach } from "./helpers/clean-machine.mjs";
import { fakeTailscale, tailnetPreload, HOST, SELF_IP } from "./helpers/fake-tailscale.mjs";
import { onlyReach } from "./helpers/windows-stop.mjs";
import { scanTerminalQRs } from "./helpers/scan-terminal-qr.mjs";

// Windows' browser sign-in, wired end to end (docs/parity/D-public-door.md
// §7): a real Reach set up with your account that takes its Windows paths
// (test/helpers/as-windows.mjs), against a stand-in Tailscale whose sessions
// run a stand-in for tailscaled's proxy, and a stand-in peer check that
// knows which connections that proxy opened. Its folders' permissions are a
// stand-in too; the real checks run on a real Windows runner
// (test/windows-tailscaled-peer.test.mjs). This computer's Tailscale is never
// asked or changed. On a real Windows runner the stand-in is a tailscale.exe,
// and Windows itself ends each session's process with Reach.
const AS_WINDOWS = pathToFileURL(path.resolve("test/helpers/as-windows.mjs")).href;
const PEER = pathToFileURL(path.resolve("test/helpers/fake-peer-check.mjs")).href;
const asWindows = { timeout: 120000 };
const KEYED = /^http:\/\/127\.0\.0\.1:(\d+)\/r-([A-Za-z0-9_-]{43})$/;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (check, what, ms = 15000) => {
  for (const end = Date.now() + ms; !(await check()); ) {
    if (Date.now() > end) throw Error(`timed out waiting: ${what}`);
    await sleep(50);
  }
};

function keyedReach(t, { scenario = {}, problem = "", folders = "", prefs = true, unrecognised = "", noted = null, healthWaitMs = 0, ready, browserCheck } = {}) {
  const seen = {};
  const started = startCleanReach(t, {
    args: { local: false, stayAwake: false },
    preloads: [AS_WINDOWS],
    env: { FAKE_TTY: "1" },
    ready: ready || /Open on your phone: https:\/\/mac\.example\.ts\.net\n/,
    pair: false,
    prepare: async (root, home) => {
      seen.root = root;
      seen.fake = await fakeTailscale(root, { version: "1.104.0", ...scenario });
      seen.peerLog = path.join(root, "peer-log.jsonl");
      if (prefs) {
        fs.mkdirSync(path.join(root, ".reach"), { recursive: true });
        fs.writeFileSync(
          path.join(root, ".reach", "preferences.json"),
          JSON.stringify({ version: 1, owner: { userId: "42", login: "owner@example.test" }, folders: [home], stayAwake: "always", httpsPort: 8443 }),
        );
      }
      // An earlier start's note that Tailscale's own connections weren't recognised.
      if (noted) fs.writeFileSync(path.join(root, ".reach", "sign-in-unrecognised.json"), JSON.stringify(noted));
      const privateFolders = folders
        ? `async () => ({ ok: false, reason: ${JSON.stringify(folders)} })`
        : `async (asked) => (fs.writeFileSync(${JSON.stringify(path.join(root, "folders.json"))}, JSON.stringify(asked)), { ok: true, sid: "S-1-5-21-1-2-3-1001", helper: () => async () => ({}) })`;
      return {
        env: { REACH_TAILSCALE: seen.fake.cli },
        preloads: [tailnetPreload(seen.fake.state)],
        launchCode: [
          // Given launch's hooks, as the real check is.
          `peerCheck: ((m) => (hooks) => m.fakePeerCheck(${JSON.stringify(root)}, { problem: ${JSON.stringify(problem)}, unrecognised: ${JSON.stringify(unrecognised)}, log: ${JSON.stringify(seen.peerLog)}, ...hooks }))(await import(${JSON.stringify(PEER)}))`,
          `privateFolders: await (async () => { const fs = (await import("node:fs")).default; return ${privateFolders}; })()`,
          "keyedEveryMs: 1000",
          `browserCheck: ${browserCheck || "async () => ({ ready: true })"}`,
          ...(healthWaitMs ? [`healthWaitMs: ${healthWaitMs}`] : []),
        ].join(", "),
      };
    },
  });
  return { seen, started };
}
// Through the stand-in tailscaled proxy of the session on `port` (8443:
// your devices; 443: Funnel, the internet), as a phone or this PC.
const viaProxy = async (fake, port, route, { method = "GET", headers = {}, body, host = port === 443 ? HOST : `${HOST}:8443` } = {}) => {
  const session = (await fake.sessions()).find((s) => s.config.TCP?.[port] && s.proxy);
  assert.ok(session, `a session on ${port}`);
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port: session.proxy, path: route, method, agent: false, headers: { Host: host, ...headers, ...(body && { "Content-Type": "application/json" }) } },
      (res) => {
        let text = "";
        res.on("data", (chunk) => (text += chunk));
        res.on("end", () => {
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {}
          resolve({ status: res.statusCode, json, text });
        });
      },
    );
    req.on("error", reject);
    req.end(body ? JSON.stringify(body) : undefined);
  });
};
// Straight to Reach's keyed port from this process: whatever comes back,
// and whether it was closed on us.
const direct = (port, text) =>
  new Promise((resolve) => {
    const socket = net.connect(port, "127.0.0.1");
    const chunks = [];
    let done = false;
    const finish = (how) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      resolve({ how, text: Buffer.concat(chunks).toString("latin1") });
    };
    socket.on("data", (chunk) => chunks.push(chunk));
    socket.on("close", () => finish("closed"));
    socket.on("error", () => finish("closed"));
    const timer = setTimeout(() => finish("open"), 3000);
    socket.write(text);
  });
const keyedSessions = async (fake) => {
  const sessions = await fake.sessions();
  const serve = sessions.find((s) => s.args[0] === "serve");
  const funnel = sessions.find((s) => s.args[0] === "funnel");
  return { sessions, serve, funnel };
};
// Anywhere Reach keeps or says anything: never the key, nor 12 of its characters.
const FAKE_FILES = /^(tailscale(\.exe)?|fake-tailscale.*|peer-log\.jsonl|folders\.json)$/;
const files = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) return files(file);
    return entry.isFile() && !FAKE_FILES.test(entry.name) ? [file] : [];
  });
const leaked = (key, texts) => {
  for (const [where, text] of texts)
    for (let i = 0; i + 12 <= key.length; i++) if (text.includes(key.slice(i, i + 12))) return `${where}: ${key.slice(i, i + 12)}`;
  return "";
};
const assertNoKey = (key, root, output) =>
  assert.equal(leaked(key, [["output", output], ...files(root).map((file) => [file, fs.readFileSync(file, "latin1")])]), "");
const stop = (root, pid) =>
  stopReach(root, {
    platform: "win32",
    yes: true,
    print() {},
    state: () => path.join(root, ".reach"),
    table: () => [],
    launchctl: () => "",
    windows: { taskkill: () => assert.fail("it stops itself"), end: () => assert.fail("it stops itself"), reaches: onlyReach({ pid, root }) },
  });

test("Windows set up with your account: a keyed private route and a foreground Funnel, browser sign-in, and a key nobody else sees", { ...asWindows, timeout: 180000 }, async (t) => {
  const { seen, started } = keyedReach(t, { scenario: { sessionLingerMs: 300 } });
  const reach = await started;
  const { fake, root } = seen;
  // 1. Two foreground sessions to the same keyed target; nothing in the background.
  const { sessions, serve, funnel } = await keyedSessions(fake);
  assert.equal(sessions.length, 2);
  const target = serve.args.at(-1);
  const [, port, key] = target.match(KEYED);
  const Q = Number(port);
  assert.deepEqual(serve.args, ["serve", "--https=8443", target]);
  assert.deepEqual(funnel.args, ["funnel", "--https=443", target]);
  const state = await fake.read();
  assert.ok(!state.calls.some((args) => args.includes("--bg")), "no --bg on Windows");
  assert.deepEqual(Object.keys(state.serve), ["Foreground"], "nothing in Tailscale's background config");
  assert.equal(fs.existsSync(path.join(root, ".reach", "funnel-owner.json")), false, "no record, no janitor");
  // Its folders were made private before anything else (stand-in here).
  const asked = JSON.parse(fs.readFileSync(path.join(root, "folders.json"), "utf8"));
  assert.deepEqual(asked.protect, [path.join(root, ".reach"), path.join(root, ".reach", "quick")]);
  assert.deepEqual(asked.check, [root]);
  assert.deepEqual(asked.helpers, ["tailscaled-peer"]);
  // An exit node is allowed (owner, Oct 12): Tailscale's prefs aren't even read.
  assert.ok(!state.calls.some(([command]) => command === "debug"));
  // 2. The one address, no pairing code.
  const text = reach.output();
  assert.ok(text.includes(`Open on your phone: https://${HOST}\n`), text);
  assert.doesNotMatch(text, /Pairing code/);
  assert.doesNotMatch(text, /browser sign-in is off/);
  // 3. A phone through Serve: account sign-in. The internet through Funnel:
  // the start page, while the pairing window is open.
  const method = await viaProxy(fake, 8443, "/api/auth/method");
  // With how this Windows PC runs Reach, for the phone's hints.
  assert.deepEqual(method.json, { method: "tailscale", eligible: true, login: "owner@example.test", command: ".\\reach.cmd" });
  const start = await viaProxy(fake, 443, "/reach-start.json");
  assert.equal(start.status, 200);
  assert.equal(start.json.product, "Reach");
  // 4. This PC's own browser (tailscaled's own-machine listener): allowed,
  // and its request says so where you approve it (owner, Oct 12).
  const self = await viaProxy(fake, 8443, "/api/auth/method", { headers: { "x-fake-from": SELF_IP } });
  assert.deepEqual(self.json, { method: "tailscale", eligible: true, login: "owner@example.test", command: ".\\reach.cmd" });
  const asking = await viaProxy(fake, 8443, "/api/auth/requests", { method: "POST", headers: { "x-fake-from": SELF_IP }, body: { name: "This PC's Edge" } });
  assert.equal(asking.status, 202, asking.text);
  await until(() => /New device request:\n.*This PC's Edge[\s\S]*From this PC itself: anyone signed in to Windows here could have asked\. Approve only if you just asked from this PC's browser\./.test(reach.output()), "the request, marked");
  const phone = await viaProxy(fake, 8443, "/api/auth/requests", { method: "POST", body: { name: "Phone Safari" } });
  assert.equal(phone.status, 202);
  await until(() => /Phone Safari/.test(reach.output()), "the phone's request");
  assert.doesNotMatch(reach.output().slice(reach.output().indexOf("Phone Safari")), /From this PC itself/);
  // 5. Straight to the keyed port with the key and a forged identity: not
  // Tailscale's own connection, closed without a byte, and said.
  const forged = await direct(Q, `GET /r-${key}/api/auth/method HTTP/1.1\r\nHost: ${HOST}:8443\r\nTailscale-User-Login: owner@example.test\r\nX-Forwarded-For: 100.64.0.20\r\n\r\n`);
  assert.deepEqual(forged, { how: "closed", text: "" });
  await until(() => reach.output().includes("Reach: refused a connection to its private route (not from Tailscale's own process)."), "the refusal said", 1500);
  // Without the key, even through a path Tailscale's process would pass: 404.
  const keyless = await direct(Q, `GET /api/auth/method HTTP/1.1\r\nHost: ${HOST}:8443\r\n\r\n`);
  assert.equal(keyless.how, "closed");
  assert.match(keyless.text, /^HTTP\/1\.1 404 /);
  // A session that fails and comes back: still no key anywhere.
  process.kill(serve.pid, "SIGKILL");
  await until(async () => (await fake.sessions()).some((s) => s.args[0] === "serve" && s.pid !== serve.pid), "the private route back", 60000);
  const again = (await keyedSessions(fake)).serve;
  assert.equal(again.args.at(-1), target, "the same key and port while Reach runs");
  // 6. The key: nowhere Reach keeps or says anything.
  assertNoKey(key, root, reach.output());
  // 7. Stop: both sessions gone before the keyed listener closes; the check closed.
  let closedAt = 0;
  const watching = (async () => {
    for (;;) {
      const open = await new Promise((resolve) => {
        const socket = net.connect(Q, "127.0.0.1");
        socket.once("connect", () => (socket.destroy(), resolve(true)));
        socket.once("error", () => resolve(false));
      });
      if (!open) return (closedAt = Date.now());
      await sleep(10);
    }
  })();
  const stoppedAt = Date.now();
  const result = await stop(root, reach.child.pid);
  assert.equal(result.stopped, 1);
  const [code] = await reach.exited;
  await watching;
  assert.equal(code, 0);
  assert.ok(Date.now() - stoppedAt < 6000, "gone within its deadline");
  const gone = await fake.gone();
  assert.ok(gone.length >= 2, JSON.stringify(gone));
  for (const g of gone) assert.ok(g.at <= closedAt, `session ${g.args[0]} gone (${g.at}) before the listener closed (${closedAt})`);
  assert.ok(fs.readFileSync(seen.peerLog, "utf8").includes('"closed"'), "the peer check closed");
  assertNoKey(key, root, reach.output());
});

test("Windows shows a private QR while waiting for a publicly reachable browser page, then adds its browser QR", asWindows, async (t) => {
  const { seen, started } = keyedReach(t, {
    ready: /Type a device request code to approve/,
    browserCheck: `(() => { let checks = 0; return async () => ++checks >= 2 ? { ready: true } : { ready: false, reason: "Public DNS is still publishing." }; })()`,
  });
  const reach = await started;
  const text = reach.output();
  assert.doesNotMatch(text, /Open on your phone:/);
  assert.deepEqual(scanTerminalQRs(text), [`https://${HOST}:8443`], "the healthy private QR is available without typing a transport command");
  assert.ok(text.includes(`Private link: https://${HOST}:8443`));
  assert.match(text, /Your phone's Tailscale app must be on this computer's Tailscale network/);
  const stateFile = path.join(seen.root, ".reach/host-status.json");
  assert.equal(JSON.parse(fs.readFileSync(stateFile)).browserLink.ready, false);
  reach.stdin.write("private\n");
  await until(() => /Your phone's Tailscale app must be on this computer's Tailscale network/.test(reach.output()) && /▄|█/.test(reach.output()), "private fallback for a phone already on this tailnet");
  assert.match(reach.output(), /Your phone's Tailscale app must be on this computer's Tailscale network/);
  assert.match(reach.output(), /▄|█/, "a private QR is still available when explicitly requested");
  await until(() => /browser connection is ready/.test(reach.output()), "public publication to recover");
  assert.ok(reach.output().includes(`Open on your phone: https://${HOST}\n`));
  assert.match(reach.output(), /▄|█/);
  const recovered = JSON.parse(fs.readFileSync(stateFile));
  assert.equal(recovered.browserLink.ready, true);
  assert.equal(recovered.link, `https://${HOST}`);
  assert.equal(scanTerminalQRs(reach.output()).at(-1), `https://${HOST}`);
});

for (const funnelEnable of ["wait", "exit"]) {
  test(`Windows shows a private QR before Funnel approval (${funnelEnable}), then adds browser pairing without another command`, asWindows, async (t) => {
    const { seen, started } = keyedReach(t, {
      ready: /Type a device request code to approve/,
      scenario: { funnelEnable },
    });
    const reach = await started;
    const text = reach.output();
    assert.match(text, /Allow Tailscale Funnel for this computer/);
    assert.deepEqual(scanTerminalQRs(text), [`https://${HOST}:8443`]);
    assert.match(text, /Your phone's Tailscale app must be on this computer's Tailscale network/);
    assert.doesNotMatch(text, /Open on your phone:/, "no unusable public QR is advertised");
    const method = await viaProxy(seen.fake, 8443, "/api/auth/method");
    assert.equal(method.status, 200);
    assert.equal(method.json.eligible, true, "the private QR reaches an eligible private sign-in route");
    const windowFile = path.join(seen.root, ".reach/quick/pairing-window.json");
    const windowBefore = JSON.parse(fs.readFileSync(windowFile, "utf8"));
    const serve = (await keyedSessions(seen.fake)).serve;
    const key = serve.args.at(-1).match(KEYED)[2];
    assertNoKey(key, seen.root, text);
    await seen.fake.setStatus({ funnelEnabled: true });
    await until(() => scanTerminalQRs(reach.output()).includes(`https://${HOST}`), "the browser QR after Funnel approval", 20000);
    assert.equal(JSON.parse(fs.readFileSync(windowFile, "utf8")).until, windowBefore.until, "recovery does not extend the original pairing window");
    const recovered = JSON.parse(fs.readFileSync(path.join(seen.root, ".reach/host-status.json"), "utf8"));
    assert.equal(recovered.browserLink.ready, true);
    assert.equal(recovered.link, `https://${HOST}`);
    assertNoKey(key, seen.root, reach.output());
  });
}

for (const [name, options, why] of [
  ["the peer check can't start", { problem: "Tailscale's Windows service isn't running." }, /Tailscale's Windows service isn't running\./],
  ["Tailscale runs in userspace", { scenario: { TUN: false } }, /without its network adapter here \(userspace networking\)/],
  ["an older Tailscale daemon", { scenario: { daemonVersion: "1.90.0" } }, /Tailscale 1\.90\.0 is older than 1\.104; update Tailscale\./],
  ["an older Tailscale command line", { scenario: { cliVersion: "1.90.0" } }, /Tailscale's command line \(1\.90\.0\) is older than 1\.104/],
  ["its folders can't be made private", { folders: "Reach's folder C:\\reach can be changed by other people on this PC, so browser sign-in stays off." }, /Reach's folder C:\\reach can be changed by other people on this PC/],
])
  test(`Windows set up with your account, ${name}: explains the browser failure without a private QR; no key, no Funnel`, asWindows, async (t) => {
    const { seen, started } = keyedReach(t, { ...options, ready: /No public internet tunnel is enabled/ });
    const reach = await started;
    const text = reach.output();
    assert.match(text, /Reach: browser sign-in is off on this PC for now: /);
    assert.match(text, why);
    assert.doesNotMatch(text, /Pairing code: \d{4} \d{4}/);
    assert.match(text, /A private QR would require the phone app, so none is shown/);
    const sessions = await seen.fake.sessions();
    assert.equal(sessions.length, 1);
    assert.doesNotMatch(sessions[0].args.at(-1), /\/r-/);
    assert.match(sessions[0].args.at(-1), /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.ok(!(await seen.fake.read()).calls.some(([command]) => command === "funnel"), "no public link");
    const status = JSON.parse(fs.readFileSync(path.join(seen.root, ".reach", "host-status.json"), "utf8"));
    assert.equal(status.tailscaleApproval, false);
    assert.match(status.signInOff, why);
  });

test("Windows without account settings: pairing codes and private helper folders, without a sign-in switch", asWindows, async (t) => {
  const { seen, started } = keyedReach(t, { prefs: false, ready: /No public internet tunnel is enabled/ });
  const reach = await started;
  const text = reach.output();
  assert.doesNotMatch(text, /REACH_WINDOWS_ACCOUNT|browser sign-in is off/);
  assert.match(text, /Pairing code: \d{4} \d{4}/);
  const [session] = await seen.fake.sessions();
  assert.match(session.args.at(-1), /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.ok(!(await seen.fake.read()).calls.some(([command]) => command === "funnel"));
  const folders = JSON.parse(fs.readFileSync(path.join(seen.root, "folders.json"), "utf8"));
  assert.ok(folders.protect.length, "agent helpers are prepared even with pairing codes");
  assert.deepEqual(folders.helpers, [], "the Tailscale peer helper is not needed without account settings");
});

const UNRECOGNISED = /Reach couldn't confirm that its private route's connections come from Tailscale's own service on this PC\./;
const UNANSWERED = /Reach's check of Tailscale's connections kept failing to answer on this PC\./;
const NOTE = ".reach/sign-in-unrecognised.json";
const readNote = (root) => JSON.parse(fs.readFileSync(path.join(root, NOTE), "utf8"));
test("Windows: Tailscale's own connections taken for another program's: the route stays closed, it's noted, and Reach asks to start again", { ...asWindows, timeout: 120000 }, async (t) => {
  const { seen, started } = keyedReach(t, { unrecognised: "other", healthWaitMs: 4000, ready: /starts again with pairing codes/ });
  const reach = await started;
  await reach.exited;
  assert.match(reach.output(), new RegExp(`${UNRECOGNISED.source} It stays closed; Reach starts again with pairing codes\\.`));
  const noted = readNote(seen.root);
  assert.equal(noted.kind, "other");
  assert.equal(noted.tailscale, "1.104.0-tfake");
  assert.ok(Date.now() - noted.at < 120000);
  assert.match(reach.output(), /Reach: refused a connection to its private route \(not from Tailscale's own process\)\./);
});

// Security review, Oct 13: a check that only failed to answer (a hiccup) is
// no reason for a day of pairing codes: Reach starts again and tries once
// more; twice within an hour, pairing codes for that hour.
test("Windows: the check not answering in time once: Reach starts again to try once more; a second time within the hour, pairing codes", { ...asWindows, timeout: 120000 }, async (t) => {
  const { seen, started } = keyedReach(t, { unrecognised: "late", healthWaitMs: 4000, ready: /Reach starts again/ });
  const reach = await started;
  await reach.exited;
  assert.match(reach.output(), /Reach's check of Tailscale's connections didn't answer in time; Reach starts again and tries once more\./);
  const first = readNote(seen.root);
  assert.deepEqual([first.kind, first.count], ["late", 1]);
  const again = keyedReach(t, { unrecognised: "late", healthWaitMs: 4000, noted: readNote(seen.root), ready: /Reach starts again/ });
  const second = await again.started;
  await second.exited;
  assert.match(second.output(), new RegExp(`${UNANSWERED.source} Reach starts again with pairing codes for an hour\\.`));
  assert.equal(readNote(again.seen.root).count, 2);
});

for (const [name, noted, reason] of [
  ["today with this Tailscale (taken for another program's)", { kind: "other", count: 1, tailscale: "1.104.0-tfake", at: Date.now() - 3600000 }, UNRECOGNISED],
  ["twice unanswered within the hour", { kind: "late", count: 2, tailscale: "1.104.0-tfake", at: Date.now() - 600000 }, UNANSWERED],
])
  test(`Windows, noted ${name}: explains the browser failure without a private QR, no key, no Funnel`, asWindows, async (t) => {
    const { seen, started } = keyedReach(t, { noted, ready: /No public internet tunnel is enabled/ });
    const reach = await started;
    const text = reach.output();
    assert.match(text, new RegExp(`Reach: browser sign-in is off on this PC for now: ${reason.source}`));
    assert.doesNotMatch(text, /Pairing code: \d{4} \d{4}/);
    assert.match(text, /A private QR would require the phone app, so none is shown/);
    const sessions = await seen.fake.sessions();
    assert.equal(sessions.length, 1);
    assert.doesNotMatch(sessions[0].args.at(-1), /\/r-/);
    const status = JSON.parse(fs.readFileSync(path.join(seen.root, ".reach", "host-status.json"), "utf8"));
    assert.match(status.signInOff, reason);
  });

for (const [name, noted] of [
  ["a day later", { kind: "other", count: 1, tailscale: "1.104.0-tfake", at: Date.now() - 90000000 }],
  ["after Tailscale changed", { kind: "other", count: 1, tailscale: "1.102.0-tfake", at: Date.now() - 60000 }],
  ["with a time still to come (never held indefinitely)", { kind: "other", count: 1, tailscale: "1.104.0-tfake", at: Date.now() + 86400000 * 365 }],
  ["once unanswered (one more try)", { kind: "late", count: 1, tailscale: "1.104.0-tfake", at: Date.now() - 60000 }],
  ["twice unanswered, over an hour ago", { kind: "late", count: 2, tailscale: "1.104.0-tfake", at: Date.now() - 2 * 3600000 }],
])
  test(`Windows, noted ${name}: the keyed route is tried, and once it answers the note goes`, asWindows, async (t) => {
    const { seen, started } = keyedReach(t, { noted });
    await started;
    const { serve } = await keyedSessions(seen.fake);
    assert.match(serve.args.at(-1), KEYED);
    assert.equal(fs.existsSync(path.join(seen.root, NOTE)), false);
  });

test("Windows keyed route: another Tailscale route to its port closes it until it's gone; so does Tailscale losing its adapter", asWindows, async (t) => {
  const { seen, started } = keyedReach(t);
  const reach = await started;
  const { fake } = seen;
  const target = (await keyedSessions(fake)).serve.args.at(-1);
  const Q = Number(target.match(KEYED)[1]);
  const works = async () => {
    try {
      return (await viaProxy(fake, 8443, "/api/health")).json?.product === "Reach";
    } catch {
      return false;
    }
  };
  assert.equal(await works(), true);
  // A TCP forward to the port, however it's spelled.
  await fake.update((s) => ({ serve: { ...s.serve, TCP: { ...s.serve.TCP, 9999: { TCPForward: `127.1:${Q}` } } } }));
  await until(() => reach.output().includes("Another Tailscale route leads to Reach's private port; Reach refuses it until it's removed (tailscale serve status)."), "the route noticed", 15000);
  assert.equal(await works(), false);
  await fake.update({ serve: {} });
  await until(works, "back once it's gone", 20000);
  // Tailscale restarted into userspace networking: paused, then back.
  await fake.setStatus({ TUN: false });
  await until(() => reach.output().includes("Browser sign-in paused on this PC: Tailscale runs without its network adapter here (userspace networking). It resumes by itself once that changes."), "paused", 10000);
  assert.equal(await works(), false);
  await fake.setStatus({ TUN: true });
  await until(() => reach.output().includes("Browser sign-in restored on this PC."), "restored", 10000);
  await until(works, "working again", 20000);
});

test("Windows keyed route: both sessions ended at once, one told another client is changing the config, both come back", { ...asWindows, timeout: 180000 }, async (t) => {
  const { seen, started } = keyedReach(t);
  const reach = await started;
  const { fake, root } = seen;
  const before = await keyedSessions(fake);
  const [, , key] = before.serve.args.at(-1).match(KEYED);
  await fake.etagConflicts(1);
  process.kill(before.serve.pid, "SIGKILL");
  process.kill(before.funnel.pid, "SIGKILL");
  await until(async () => {
    const now = await keyedSessions(fake);
    return now.serve && now.funnel && now.serve.pid !== before.serve.pid && now.funnel.pid !== before.funnel.pid;
  }, "both sessions back", 90000);
  assert.ok(!fs.readdirSync(root).some((f) => f.startsWith("fake-tailscale-etag-")), "the conflict happened");
  assert.doesNotMatch(reach.output(), /Another client is changing the serve config/);
  assertNoKey(key, root, reach.output());
});
