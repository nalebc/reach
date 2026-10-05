import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  runSetup,
  needsOnboarding,
  readProgress,
  linkProblem,
  SETUP_SECTIONS,
} from "../scripts/setup.mjs";

// A tailnet ready for the phone's HTTPS link.
const READY = {
  BackendState: "Running",
  CurrentTailnet: { MagicDNSEnabled: true },
  CertDomains: ["mac.tail1.ts.net"],
};

// The guided first-run setup: a flow that saves each step, resumes after a
// stop, re-runs a single section, and never bothers a computer already set up.

function scene(answers = {}) {
  const asked = [];
  const select = async ({ message, choices }) => {
    asked.push(message);
    const want = answers[message];
    const value =
      want ?? choices.find((c) => c.recommended)?.value ?? choices[0].value;
    if (!choices.some((c) => c.value === value))
      throw Error(`No such choice ${value} for ${message}`);
    return value;
  };
  const print = () => {};
  return { asked, select, print, ask: async () => "" };
}
function deps(scene, extra = {}) {
  const ran = { configure: 0, tailscale: 0, invites: 0 };
  return {
    ran,
    print: scene.print,
    select: scene.select,
    ask: scene.ask,
    platform: "darwin",
    ensureTailscale: async () => (ran.tailscale++, { BackendState: "Running" }),
    configure: async () => (ran.configure++, { owner: { login: "me@x.test" } }),
    setupInvites: async () => (ran.invites++, undefined),
    status: async () => READY,
    open: async () => {},
    sleep: async () => {},
    ...extra,
  };
}
const tmp = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-setup-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

test("a fresh run walks every step in order and records each as it finishes", async (t) => {
  const root = tmp(t);
  const s = scene();
  const d = deps(s);
  const result = await runSetup(root, { deps: d });
  assert.deepEqual(s.asked, [
    "Set up invite links now?",
    "Keep Reach running after you close this terminal?",
  ]);
  assert.equal(d.ran.tailscale, 1);
  assert.equal(d.ran.configure, 1);
  assert.equal(d.ran.invites, 0, "declined, so invites setup never runs");
  assert.equal(result.launch, "foreground");
  const progress = readProgress(root);
  assert.equal(progress.done, true);
  assert.deepEqual(progress.steps, {
    account: "done",
    link: "done",
    invites: "skipped",
    background: "foreground",
  });
  // A finished setup is not offered again.
  assert.equal(needsOnboarding(root), false);
});

test("choosing invites now runs the invite setup; background install is signalled", async (t) => {
  const root = tmp(t);
  const s = scene({
    "Set up invite links now?": "now",
    "Keep Reach running after you close this terminal?": "background",
  });
  const d = deps(s);
  const result = await runSetup(root, { deps: d });
  assert.equal(d.ran.invites, 1);
  assert.equal(result.launch, "background");
  // The device identity exists so invite keys can be named before Reach runs.
  assert.ok(
    fs.existsSync(path.join(root, ".reach", "quick", "device.json")),
    "device.json was created for invites",
  );
  assert.equal(readProgress(root).steps.invites, "done");
});

test("an interrupted setup resumes at the first unfinished step", async (t) => {
  const root = tmp(t);
  // First attempt stops right after the account step (Ctrl+C at invites).
  const first = deps(scene(), {
    setupInvites: async () => {
      throw Error("Cancelled. Nothing was saved.");
    },
    select: async ({ message, choices }) => {
      if (message === "Set up invite links now?") return "now";
      return choices[0].value;
    },
  });
  await assert.rejects(runSetup(root, { deps: first }), (e) => e.paused);
  assert.equal(readProgress(root).steps.account, "done");
  assert.ok(!readProgress(root).done, "not finished yet");
  assert.equal(needsOnboarding(root), true, "still unfinished");

  // Second attempt skips the done account step and finishes the rest.
  const s = scene();
  const d = deps(s);
  const result = await runSetup(root, { deps: d });
  assert.equal(d.ran.tailscale, 0, "account already done, not re-run");
  assert.equal(d.ran.configure, 0);
  assert.deepEqual(s.asked, [
    "Set up invite links now?",
    "Keep Reach running after you close this terminal?",
  ]);
  assert.equal(result.launch, "foreground");
  assert.equal(readProgress(root).done, true);
});

test("re-running one section redoes only that step and never flips done", async (t) => {
  const root = tmp(t);
  await runSetup(root, { deps: deps(scene()) });
  assert.equal(readProgress(root).done, true);
  // `reach setup invites` just redoes invites (straight in, no question).
  const s = scene();
  const d = deps(s);
  const result = await runSetup(root, { only: "invites", deps: d });
  assert.deepEqual(s.asked, []);
  assert.equal(d.ran.configure, 0);
  assert.equal(d.ran.invites, 1);
  assert.equal(readProgress(root).steps.invites, "done");
  assert.equal(readProgress(root).done, true, "still complete");
  assert.equal(result.launch, "foreground");
  await assert.rejects(
    runSetup(root, { only: "nope", deps: deps(scene()) }),
    /Unknown setup section/,
  );
  assert.deepEqual(SETUP_SECTIONS, ["account", "link", "invites", "background"]);
});

test("a computer configured before onboarding is marked done, never prompted", async (t) => {
  const root = tmp(t);
  // A valid preferences file, but no onboarding record (an older Reach).
  const prefsDir = path.join(root, ".reach");
  fs.mkdirSync(prefsDir, { recursive: true });
  fs.writeFileSync(
    path.join(prefsDir, "preferences.json"),
    JSON.stringify({
      version: 1,
      owner: { userId: "42", login: "me@x.test" },
      folders: ["/Users/me"],
      stayAwake: "always",
      httpsPort: 8443,
    }),
  );
  assert.equal(needsOnboarding(root), false);
  assert.equal(readProgress(root).done, true, "recorded so it's not re-checked");
});

test("on a non-Mac the background step is left out", async (t) => {
  const root = tmp(t);
  const s = scene();
  const result = await runSetup(root, { deps: deps(s, { platform: "linux" }) });
  assert.deepEqual(s.asked, ["Set up invite links now?"]);
  assert.equal(result.launch, "foreground");
  assert.equal(readProgress(root).steps.background, undefined);
  assert.equal(readProgress(root).done, true);
});

test("`reach setup` on a finished setup: pick one thing to change, or nothing", async (t) => {
  const root = tmp(t);
  await runSetup(root, { deps: deps(scene()) });
  // Nothing: no step runs.
  const quiet = scene();
  const none = await runSetup(root, { deps: deps(quiet) });
  assert.deepEqual(quiet.asked, ["What do you want to change?"]);
  assert.deepEqual(none.ran, []);
  // Background: only that question, then it's saved.
  const s = scene({
    "What do you want to change?": "background",
    "Keep Reach running after you close this terminal?": "background",
  });
  const changed = await runSetup(root, { deps: deps(s) });
  assert.deepEqual(s.asked, [
    "What do you want to change?",
    "Keep Reach running after you close this terminal?",
  ]);
  assert.deepEqual(changed.ran, ["background"]);
  assert.equal(changed.launch, "background");
  assert.equal(readProgress(root).done, true);
});

test("`reach setup invites` goes straight to invite setup, no now-or-later question", async (t) => {
  const root = tmp(t);
  const s = scene();
  const d = deps(s);
  const result = await runSetup(root, { only: "invites", deps: d });
  assert.deepEqual(s.asked, [], "explicitly asked for, so no question");
  assert.equal(d.ran.invites, 1);
  assert.deepEqual(result.ran, ["invites"]);
});

test("start over runs every step again; paired phones aren't touched", async (t) => {
  const root = tmp(t);
  await runSetup(root, { deps: deps(scene()) });
  const phones = path.join(root, ".reach", "quick", "clients.json");
  fs.mkdirSync(path.dirname(phones), { recursive: true });
  fs.writeFileSync(phones, "[]");
  const s = scene({ "What do you want to change?": "over" });
  const d = deps(s);
  const result = await runSetup(root, { deps: d });
  assert.equal(d.ran.configure, 1, "account step ran again");
  assert.deepEqual(result.ran, ["account", "link", "invites", "background"]);
  assert.ok(fs.existsSync(phones), "pairings untouched");
  assert.equal(readProgress(root).done, true);
});

test("the HTTPS link step: opens Tailscale's DNS page once per missing switch, waits, goes on", async (t) => {
  const root = tmp(t);
  const states = [
    { ...READY, CurrentTailnet: { MagicDNSEnabled: false }, CertDomains: undefined },
    { ...READY, CurrentTailnet: { MagicDNSEnabled: false }, CertDomains: undefined },
    { ...READY, CertDomains: [] },
    READY,
  ];
  const opened = [];
  const printed = [];
  const s = scene();
  const result = await runSetup(root, {
    only: "link",
    deps: deps(s, {
      status: async () => states.shift() || READY,
      open: async (url) => opened.push(url),
      print: (m) => printed.push(m),
    }),
  });
  assert.deepEqual(opened, [
    "https://login.tailscale.com/admin/dns",
    "https://login.tailscale.com/admin/dns",
  ], "once for MagicDNS, once for HTTPS, not on every check");
  assert.match(printed.join("\n"), /Turn on MagicDNS/);
  assert.match(printed.join("\n"), /Turn on HTTPS certificates/);
  assert.deepEqual(s.asked, [], "nothing to answer, just a switch to flip");
  assert.deepEqual(result.ran, ["link"]);
  assert.equal(readProgress(root).steps.link, "done");
});

test("the HTTPS link step: already on means no page and no wait; still off gives up clearly", async (t) => {
  const root = tmp(t);
  const opened = [];
  await runSetup(root, { only: "link", deps: deps(scene(), { open: async (u) => opened.push(u) }) });
  assert.deepEqual(opened, []);
  assert.equal(linkProblem(READY), null);
  assert.equal(linkProblem({ CurrentTailnet: { MagicDNSEnabled: false } }), "magicdns");
  assert.equal(linkProblem({ CurrentTailnet: { MagicDNSEnabled: true } }), "https");
  await assert.rejects(
    runSetup(root, {
      only: "link",
      deps: deps(scene(), { status: async () => ({ ...READY, CertDomains: [] }), waitMs: -1 }),
    }),
    /HTTPS certificates is still off\. Turn it on at https:\/\/login\.tailscale\.com\/admin\/dns/,
  );
});

test("background first run ends with the phone: link, then approve by the code it shows", async (t) => {
  const { connectPhone } = await import("../scripts/setup.mjs");
  const root = tmp(t);
  const host = { origin: "https://mac.tail1.ts.net:8443", dataDir: "/x", service: true };
  const hosts = [null, null, host];
  const requests = [[], [], [{ id: "a1b2c3d4-0000-0000-0000-000000000000", name: "iPhone", login: "me@x.test", nodeName: "iphone" }]];
  const printed = [];
  const answers = ["wrong", "a1b2c3d4"];
  const decided = [];
  const qr = [];
  const ok = await connectPhone(root, {
    deps: {
      print: (m) => printed.push(m),
      sleep: async () => {},
      readHost: () => hosts.shift() ?? host,
      reachable: async (url) => url === "https://mac.tail1.ts.net/api/health",
      qr: { generate: (link) => qr.push(link) },
      pending: () => requests.shift() ?? [],
      ask: async () => answers.shift(),
      decide: (code) => {
        decided.push(code);
        if (code !== "a1b2c3d4") throw Error("Enter the eight-character request shown on your phone.");
        return "Device approved. Your phone will connect automatically.";
      },
    },
  });
  const text = printed.join("\n");
  assert.equal(ok, true);
  assert.match(text, /Open on your phone: https:\/\/mac\.tail1\.ts\.net\n/, "the start page, for any phone");
  assert.deepEqual(qr, ["https://mac.tail1.ts.net"]);
  assert.match(text, /New device:/);
  assert.match(text, /Enter the eight-character request/, "a wrong code says why, then asks again");
  assert.deepEqual(decided, ["wrong", "a1b2c3d4"]);
  assert.match(text, /Your phone is connected/);
});

// One address: shown once this very Reach answers there; another service on
// 443 (or another Reach) doesn't count. The link Reach recorded wins.
test("the phone link is the one address only when this Reach answers there", async (t) => {
  const { connectPhone } = await import("../scripts/setup.mjs");
  const root = tmp(t);
  const host = { origin: "https://mac.tail1.ts.net:8443", dataDir: "/x", service: true, instance: "i1" };
  const realFetch = globalThis.fetch;
  t.after(() => (globalThis.fetch = realFetch));
  const shown = async (answer, extra = {}) => {
    const asked = [];
    globalThis.fetch = async (url) => (asked.push(String(url)), answer());
    const printed = [];
    await connectPhone(root, {
      deps: { print: (m) => printed.push(m), sleep: async () => {}, readHost: () => ({ ...host, ...extra }), qr: { generate: () => {} }, pending: () => [], waitMs: 1 },
    });
    return { link: /Open on your phone: (\S+)/.exec(printed.join("\n"))[1], asked };
  };
  const json = (v) => () => new Response(JSON.stringify(v), { status: 200 });
  const me = await shown(json({ product: "Reach", instance: "i1" }));
  assert.equal(me.link, "https://mac.tail1.ts.net");
  assert.deepEqual(me.asked, ["https://mac.tail1.ts.net/api/health"]);
  for (const answer of [
    json({ product: "Reach", instance: "someone-else" }),
    () => new Response("<!doctype html>", { status: 200 }), // any page at all
    () => Promise.reject(TypeError("no route")),
  ])
    assert.equal((await shown(answer)).link, "https://mac.tail1.ts.net:8443");
  const recorded = await shown(() => Promise.reject(TypeError("unused")), { link: "https://home.tail1.ts.net" });
  assert.equal(recorded.link, "https://home.tail1.ts.net", "the link Reach shows (linked computers share one)");
  assert.deepEqual(recorded.asked, []);
});

test("background first run: start page not reachable → private link; deny keeps waiting; gives up clearly", async (t) => {
  const { connectPhone } = await import("../scripts/setup.mjs");
  const root = tmp(t);
  const host = { origin: "https://mac.tail1.ts.net:8443", dataDir: "/x", service: true };
  const printed = [];
  let polls = 0;
  const ok = await connectPhone(root, {
    deps: {
      print: (m) => printed.push(m),
      sleep: async () => {},
      readHost: () => host,
      reachable: async () => false,
      qr: { generate: () => {} },
      pending: () => (++polls === 1 ? [{ id: "ffffffff-0000-0000-0000-000000000000", name: "Stranger", login: "x", nodeName: "x" }] : []),
      ask: async () => "deny ffffffff",
      decide: () => "Connection denied.",
      waitMs: 5,
    },
  });
  const text = printed.join("\n");
  assert.equal(ok, false);
  assert.match(text, /Open on your phone: https:\/\/mac\.tail1\.ts\.net:8443/);
  assert.match(text, /Connection denied\./);
  assert.match(text, /No phone yet\. Later: open https:\/\/mac\.tail1\.ts\.net:8443 on it, then run \.\/reach approve/);
  // Reach never started: say how to finish later.
  const none = [];
  assert.equal(
    await connectPhone(root, { deps: { print: (m) => none.push(m), sleep: async () => {}, readHost: () => null, startMs: 5 } }),
    false,
  );
  assert.match(none.join("\n"), /still starting\. When it's ready: \.\/reach status/);
});
