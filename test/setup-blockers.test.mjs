import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { protectedFolder, backgroundService } from "../scripts/background-service.mjs";

// First-run matrix H12, B2, B3 and the other setup blockers a new person can
// hit before their phone ever connects.
const temp = (t) =>
  fs.mkdtemp(path.join(os.tmpdir(), "reach-setup-")).then((dir) => {
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    return dir;
  });

test("H12: Documents, Desktop, Downloads and iCloud Drive are where macOS keeps background services out", () => {
  const home = "/Users/someone";
  const mac = { home, platform: "darwin", realpath: (p) => p };
  assert.equal(protectedFolder("/Users/someone/Documents/reach", mac), "Documents");
  assert.equal(protectedFolder("/Users/someone/Desktop/code/reach", mac), "Desktop");
  assert.equal(protectedFolder("/Users/someone/Downloads/reach-main", mac), "Downloads");
  assert.equal(protectedFolder("/Users/someone/Library/Mobile Documents/com~apple~CloudDocs/reach", mac), "iCloud Drive");
  assert.equal(protectedFolder("/Users/someone/reach", mac), "");
  assert.equal(protectedFolder("/Users/someone/Documentsx/reach", mac), "", "only the folder itself");
  assert.equal(protectedFolder("/Users/someone/Documents/reach", { ...mac, platform: "linux" }), "", "only macOS");
  // A link to it is still it.
  assert.equal(
    protectedFolder("/Users/someone/code/reach", { ...mac, realpath: (p) => p.replace("/Users/someone/code", "/Users/someone/Documents") }),
    "Documents",
  );
});

test("B2: ./reach install from Documents explains why and what to do, and installs nothing", async (t) => {
  const home = await temp(t);
  const root = path.join(home, "Documents", "reach");
  await fs.mkdir(root, { recursive: true });
  await assert.rejects(
    backgroundService({ command: "install" }, root, {
      platform: "darwin",
      home,
      uid: 501,
      run: () => {
        throw Error("Could not find service");
      },
    }),
    (error) => {
      assert.match(error.message, /macOS doesn't let a background service use your Documents folder/);
      assert.match(error.message, /setup background to open Reach in Terminal each time you sign in/);
      return true;
    },
  );
  await assert.rejects(fs.access(path.join(home, "Library/LaunchAgents/com.reach.companion.plist")));
});

test("B2: setup offers Terminal at sign-in instead of a background service that can't start", async (t) => {
  const { runSetup } = await import("../scripts/setup.mjs");
  const root = await temp(t);
  let offered;
  const result = await runSetup(root, {
    only: "background",
    deps: {
      platform: "darwin",
      protectedFolder: () => "Documents",
      print: () => {},
      ui: {
        select: async ({ choices }) => ((offered = choices), "login"),
        ask: async () => "",
      },
    },
  });
  assert.deepEqual(offered.map((c) => c.value), ["foreground", "login"]);
  assert.match(offered[1].description, /keeps background services out of your Documents folder/);
  assert.equal(result.launch, "login");
});

test("B3: a background Reach that keeps failing says why, instead of a five-minute wait", async (t) => {
  const { connectPhone } = await import("../scripts/setup.mjs");
  const root = await temp(t);
  const printed = [];
  let clock = 0;
  const realNow = Date.now;
  Date.now = () => realNow() + clock;
  t.after(() => (Date.now = realNow));
  const ok = await connectPhone(root, {
    deps: {
      print: (m) => printed.push(m),
      sleep: async () => void (clock += 5000),
      readHost: () => null,
      readFailure: () => "Reach: Your home path is too long for Tailscale's socket.",
    },
  });
  assert.equal(ok, false);
  const text = printed.join("\n");
  assert.match(text, /Reach couldn't start in the background: Your home path is too long/);
  assert.match(text, /companion-error\.log/);
  assert.ok(clock < 60000, `stopped within a minute (${clock} ms)`);
});

// T9: the App Store Tailscale reaches Reach only through its own app folder,
// inside the account's home: a long account name used to fail only after
// "Setup complete". A shorter name for Reach's folder fits more of them; one
// too long for even that is said during setup, with the fix.
test("T9: a long Mac account name still fits, and one too long names the fix during setup", async (t) => {
  const { serveSocketPath } = await import("../server/tailscale-auth.mjs");
  const at = (name) => {
    const home = `/Users/${name}`;
    const group = `${home}/Library/Group Containers/W5364U7YZB.group.io.tailscale.ipn.macos`;
    return () => serveSocketPath("/Users/x/reach", { platform: "darwin", home, uid: 501, exists: (p) => p === group });
  };
  // Twelve characters fit as before: the same path a computer set up earlier has.
  assert.match(at("abcdefghijkl")(), /\/r-[0-9a-f]{12}\/s$/);
  // Up to 20 now fit, with a shorter name for Reach's own folder.
  const long = at("abcdefghijklmnopqrst")();
  assert.match(long, /\/r-[0-9a-f]{6}\/s$/);
  assert.ok(Buffer.byteLength(long) < 104);
  assert.throws(at("abcdefghijklmnopqrstuvwxyz0123"), /too long for the App Store version of Tailscale.*tailscale\.com\/download\/mac/);

  const { runSetup } = await import("../scripts/setup.mjs");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "reach-setup-sock-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await assert.rejects(
    runSetup(root, {
      only: "link",
      deps: {
        print: () => {},
        socketPath: at("abcdefghijklmnopqrstuvwxyz0123"),
        status: async () => ({ BackendState: "Running", Self: { DNSName: "mac.t.ts.net." }, CertDomains: ["mac.t.ts.net"], CurrentTailnet: { MagicDNSEnabled: true } }),
        ui: { select: async () => "", ask: async () => "" },
      },
    }),
    /App Store version of Tailscale/,
  );
});

// T11: port 8443 held by an earlier Reach's route (another folder, or set up
// before .reach was deleted) says exactly how to free it; anything else on
// the port is somebody else's and is left alone.
test("T11: an earlier Reach's leftover route gets its one fix; another service is never touched", async () => {
  const { assertUnusedPort } = await import("../scripts/tailscale.mjs");
  const route = (proxy) => ({ TCP: { 8443: { HTTPS: true } }, Web: { "mac.t.ts.net:8443": { Handlers: { "/": { Proxy: proxy } } } } });
  assert.throws(
    () => assertUnusedPort(route("unix:/Users/me/Library/Group Containers/W5364U7YZB.group.io.tailscale.ipn.macos/r-0123456789ab/s"), 8443),
    /still has the route of an earlier Reach.*tailscale serve --https=8443 off/s,
  );
  assert.throws(() => assertUnusedPort(route("unix:/tmp/reach-501-abcdef/s"), 8443), /earlier Reach/);
  assert.throws(
    () => assertUnusedPort(route("http://127.0.0.1:3000"), 8443),
    (e) => /already in use \(see: tailscale serve status\)/.test(e.message) && !/serve --https=8443 off/.test(e.message),
  );
  assert.doesNotThrow(() => assertUnusedPort({}, 8443));
});

// T12: --https-port given once is kept: the next start and the invite rule
// (which names the port people's devices may reach) use it.
test("T12: --https-port is saved for later starts and the invite rule", async (t) => {
  const { rememberHttpsPort, readPreferences, applyPreferences } = await import("../scripts/configure.mjs");
  const root = await temp(t);
  await fs.mkdir(path.join(root, ".reach"), { recursive: true });
  const prefs = { version: 1, owner: { userId: "42", login: "me@x.test" }, folders: [root], stayAwake: "always", httpsPort: 8443 };
  await fs.writeFile(path.join(root, ".reach", "preferences.json"), JSON.stringify(prefs));
  assert.equal(rememberHttpsPort(root, 9443), true);
  assert.equal(rememberHttpsPort(root, 9443), false, "already saved");
  assert.equal(readPreferences(root).httpsPort, 9443);
  // A start without the flag uses it.
  assert.equal(applyPreferences({ folders: [], httpsPort: 8443 }, readPreferences(root), []).httpsPort, 9443);
  assert.equal(rememberHttpsPort(root, "9443"), false, "only a port number");
});

// H5, H13: npm failing during the first setup names its most likely fix.
test("H13: a failed first setup says what it needs: build tools, internet, space", async () => {
  const { setupFailureHint } = await import("../scripts/setup-failure.mjs");
  const gyp = "npm ERR! gyp ERR! stack Error: not found: make\nnpm ERR! node-pty@1.1.0 install: `node-gyp rebuild`";
  assert.match(setupFailureHint(gyp, "linux"), /sudo apt install build-essential python3/);
  assert.match(setupFailureHint(gyp, "darwin"), /xcode-select --install/);
  assert.match(setupFailureHint("npm ERR! code ENOTFOUND\nnpm ERR! getaddrinfo ENOTFOUND registry.npmjs.org", "linux"), /couldn't reach the internet/);
  assert.match(setupFailureHint("npm ERR! code ENOSPC", "linux"), /disk is full/);
  assert.equal(setupFailureHint("npm ERR! something else entirely", "linux"), "");
});

// D4: a Windows PC without FFmpeg streams still images; FFmpeg installed
// later gives video without restarting Reach.
test("D4: FFmpeg missing is looked for again a few minutes later; found, it's kept", async () => {
  const { windowsVideoAvailable } = await import("../server/windows-video.mjs");
  let clock = 1_000_000, asked = 0, installed = false;
  const run = async () => {
    asked++;
    if (!installed) throw Object.assign(Error("spawn ffmpeg ENOENT"), { code: "ENOENT" });
    return { stdout: " V....D libx264  libx264 H.264 / AVC" };
  };
  const now = () => clock;
  assert.equal(await windowsVideoAvailable({ run, now }), false);
  assert.equal(await windowsVideoAvailable({ run, now }), false);
  assert.equal(asked, 1, "not asked again at once");
  installed = true;
  clock += 6 * 60 * 1000;
  assert.equal(await windowsVideoAvailable({ run, now }), true, "installed meanwhile: video");
  assert.equal(await windowsVideoAvailable({ run, now }), true);
  assert.equal(asked, 2, "found once, kept");
});

// H9: started without a terminal (piped, from a script): the guided setup
// can't ask, so it says where to run it instead of hanging or guessing.
test("H9: without a terminal, setting up the account says to run it in one", async (t) => {
  const { configure } = await import("../scripts/configure.mjs");
  const root = await temp(t);
  assert.equal(!!process.stdin.isTTY, false, "tests run without a terminal");
  await assert.rejects(configure(root, { platform: "darwin" }), /configure in an interactive terminal to confirm your Tailscale account first/);
  const { ensureTailscale } = await import("../scripts/tailscale-connect.mjs");
  await assert.rejects(
    ensureTailscale({ interactive: false, status: async () => ({ BackendState: "NeedsLogin" }), appInstalled: () => false }),
    /needs you to sign in on this computer\. Run Reach in a terminal to set it up\./,
  );
});

// H10: Ctrl+C while setup waits (Tailscale signing in, the HTTPS switch):
// the same signal a terminal sends, to a process waiting as setup does, with
// the launcher's own exit handler holding its lock. Said, exit 130, lock gone.
test("H10: Ctrl+C during a setup wait says Paused, exits 130 and releases the lock", { skip: process.platform === "win32" }, async (t) => {
  const { spawn } = await import("node:child_process");
  const { once } = await import("node:events");
  const dir = await temp(t);
  const lock = path.join(dir, "launcher.lock");
  const stopped = path.join(dir, "install-stopped");
  const entry = new URL("../scripts/pause-setup.mjs", import.meta.url).href;
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import fs from "node:fs";
       import { pauseOnInterrupt } from ${JSON.stringify(entry)};
       fs.writeFileSync(${JSON.stringify(lock)}, String(process.pid));
       process.once("exit", () => fs.rmSync(${JSON.stringify(lock)}, { force: true }));
       pauseOnInterrupt({ before: () => fs.writeFileSync(${JSON.stringify(stopped)}, "1") });
       console.log("waiting");
       setInterval(() => {}, 1000);`,
    ],
    { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, REACH_COMMAND: "" } },
  );
  let out = "";
  child.stdout.on("data", (c) => (out += c));
  const exited = once(child, "exit");
  t.after(() => child.exitCode === null && child.kill("SIGKILL"));
  const deadline = Date.now() + 10000;
  while (!out.includes("waiting") && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
  await fs.access(lock);
  child.kill("SIGINT");
  const [code] = await exited;
  assert.equal(code, 130);
  assert.match(out, /Paused\. Run \.\/reach to continue your setup\./);
  await assert.rejects(fs.access(lock), "the lock went with it");
  await fs.access(stopped);

  // Once setup has moved on (stopped listening), Ctrl+C is Reach's own again.
  const { pauseOnInterrupt } = await import("../scripts/pause-setup.mjs");
  const { EventEmitter } = await import("node:events");
  const on = new EventEmitter();
  const said = [];
  const stop = pauseOnInterrupt({ on, print: (m) => said.push(m), exit: () => said.push("exit") });
  stop();
  on.emit("SIGINT");
  assert.deepEqual(said, []);
});


test("H13: a node-gyp download failure asks for internet before build tools", async () => {
  const { setupFailureHint } = await import("../scripts/setup-failure.mjs");
  for (const code of ["ENOTFOUND", "EAI_AGAIN"]) {
    const hint = setupFailureHint(`gyp ERR! stack Error: getaddrinfo ${code} nodejs.org\nnode-gyp rebuild`, "linux");
    assert.match(hint, /couldn't reach the internet/);
    assert.doesNotMatch(hint, /build-essential/);
  }
});

test("T11: Funnel on the private port names the command that turns it off", async () => {
  const { assertPrivatePort } = await import("../scripts/tailscale.mjs");
  assert.throws(() => assertPrivatePort({ AllowFunnel: { "computer.example.ts.net:8443": true } }, 8443), /tailscale funnel --https=8443 off/);
});
