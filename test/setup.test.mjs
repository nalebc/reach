import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  runSetup,
  needsOnboarding,
  readProgress,
  SETUP_SECTIONS,
} from "../scripts/setup.mjs";

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
  assert.deepEqual(SETUP_SECTIONS, ["account", "invites", "background"]);
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
  assert.deepEqual(result.ran, ["account", "invites", "background"]);
  assert.ok(fs.existsSync(phones), "pairings untouched");
  assert.equal(readProgress(root).done, true);
});
