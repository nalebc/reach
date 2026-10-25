import test from "node:test";
import assert from "node:assert/strict";
import { startCleanReach } from "./helpers/clean-machine.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const unix = { skip: process.platform === "win32", timeout: 60000 };

// First-run matrix A1 and D1: a computer with none of the optional tools.
// Reach starts, says what isn't there without calling it an error, and
// keeps running while the phone keeps asking.
test(
  "a computer with no agents and no developer tools: nothing fails, nothing crashes",
  unix,
  async (t) => {
    const reach = await startCleanReach(t);

    await t.test("device: Codex not installed", async () => {
      const device = await reach.get("/api/device");
      assert.equal(device.status, 200, device.text);
      assert.equal(device.json.tools?.codex?.installed, false);
    });

    await t.test("health: nothing installed, no errors", async () => {
      const health = await reach.get("/api/sessions/health?fresh=1");
      assert.equal(health.status, 200, health.text);
      const agents = health.json.agents;
      assert.deepEqual(
        agents.filter((a) => a.installed).map((a) => a.agent),
        [],
        "nothing is installed here",
      );
      for (const agent of agents)
        assert.equal(
          agent.error,
          undefined,
          `${agent.agent} isn't installed, which isn't an error: ${agent.error}`,
        );
      assert.equal(
        agents.find((a) => a.agent === "claude").app?.installed,
        false,
        "no Claude app",
      );
    });

    await t.test("chat list: no errors", async () => {
      const list = await reach.get("/api/sessions?fresh=1");
      assert.equal(list.status, 200, list.text);
      assert.deepEqual(list.json.sessions, []);
      assert.deepEqual(
        list.json.errors,
        {},
        "a missing agent is not an error in the chat list",
      );
    });

    // Desktop pieces that need Apple's Command Line Tools say so plainly.
    if (process.platform === "darwin")
      await t.test("saved-tools setup without Command Line Tools", async () => {
        const setup = await reach.get("/api/agents/tool-setup");
        assert.ok(setup.status < 500, `${setup.status} ${setup.text}`);
        assert.doesNotMatch(setup.text, /helper/i, "no internal helper names");
        // Safari is on every Mac: the phone shows it with what's missing,
        // rather than the section quietly disappearing.
        assert.equal(setup.json.available, true);
        assert.ok(
          setup.json.browsers.some((b) => b.id === "Safari"),
          setup.text,
        );
        assert.match(setup.json.problem, /Command Line Tools/);
      });

    // The phone keeps asking (Chat open, Home open): Reach stays up.
    await t.test("stays up for 30 s of polling", async () => {
      const until = Date.now() + 30000;
      while (Date.now() < until) {
        for (const route of [
          "/api/sessions/health",
          "/api/sessions",
          "/api/terminals/agents",
          "/api/device",
        ]) {
          const answer = await reach.get(route);
          assert.ok(
            answer.status < 500,
            `${route}: ${answer.status} ${answer.text}`,
          );
        }
        assert.equal(
          reach.child.exitCode,
          null,
          `Reach stopped:\n${reach.output()}`,
        );
        await sleep(2000);
      }
      assert.doesNotMatch(
        reach.output(),
        /Unhandled|uncaught|TypeError|ReferenceError/i,
        reach.output(),
      );
    });
  },
);

// A5: the Claude app is here but Claude Code (the CLI Reach replies through)
// isn't. That's "not installed", never "signed out".
test("Claude Code missing says it isn't installed, not that it's signed out", async () => {
  const { createAgentSessions } =
    await import("../server/agent-sessions/index.mjs");
  const started = [];
  const sessions = createAgentSessions({
    codex: {
      health: async () => {
        throw Object.assign(Error("Codex is not installed on this Mac."), {
          code: "AGENT_NOT_INSTALLED",
        });
      },
      list: async () => [],
    },
    claude: {
      health: async () => ({
        agent: "claude",
        installed: false,
        signedIn: false,
      }),
      list: async () => [],
      starts: async () => [],
    },
    claudeHost: {
      start: async (body) => (started.push(body), { threadId: "x" }),
      drives: () => false,
      close() {},
    },
    claudeApp: async () => ({ installed: true, signedIn: true }),
    detect: async () => [],
    platform: "darwin",
  });
  try {
    await assert.rejects(
      sessions.start("claude", { text: "hello", cwd: "/tmp" }),
      (error) => {
        assert.doesNotMatch(error.message, /signed out/i);
        assert.match(error.message, /isn't installed/);
        return true;
      },
    );
    assert.deepEqual(started, [], "nothing ran");
  } finally {
    sessions.close();
  }
});

// A7: OpenClaw's command is here but it was never set up (no config yet):
// Chat offers to set it up, without saying it wasn't found.
test("OpenClaw installed but not set up isn't reported as missing", async (t) => {
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const { createOpenClaw, localOpenClawConfig } =
    await import("../server/openclaw.mjs");
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "reach-claw-new-"));
  const claw = createOpenClaw({
    dataDir: home,
    configuration: () => localOpenClawConfig({ env: {}, home }),
  });
  t.after(async () => {
    claw.close();
    await fs.rm(home, { recursive: true, force: true });
  });
  const overview = await claw.overview();
  assert.equal(overview.connected, false);
  assert.equal(overview.notSetUp, true, "the phone shows setup, not an error");
  assert.doesNotMatch(overview.error || "", /not found/i);
});

// D1: Command Line Tools installed after Reach started: the Mac's own
// prompts reach the phone without a restart.
test("Mac prompts look again for Command Line Tools instead of giving up", async () => {
  const { createMacPrompts } = await import("../server/mac-prompts.mjs");
  const { EventEmitter } = await import("node:events");
  let tries = 0;
  const spawned = [];
  const prompts = createMacPrompts({
    dataDir: "/nonexistent",
    platform: "darwin",
    missingMs: 20,
    binary: async () => {
      if (++tries < 3)
        throw Object.assign(Error("no tools"), {
          status: 503,
          developerTools: false,
        });
      return "/bin/helper";
    },
    spawn: (file) => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stdout.setEncoding = () => {};
      child.kill = () => {};
      spawned.push(file);
      return child;
    },
  });
  prompts.start();
  const deadline = Date.now() + 2000;
  while (!spawned.length && Date.now() < deadline) await sleep(10);
  prompts.close();
  assert.equal(tries, 3);
  assert.deepEqual(spawned, ["/bin/helper"]);
});

// A1 (load): a computer without Claude Code doesn't ask its login shell on
// every health check; checking again after an install does.
test("a missing Claude Code is looked for again after a while, or at once on Check again", async () => {
  const { locateClaude, forgetClaudeMiss } =
    await import("../server/agent-sessions/index.mjs");
  let asked = 0;
  // Nothing installed in the usual places either: not this computer's own
  // ~/.local/bin/claude (the test failed on any Mac with Claude Code).
  const none = () => [];
  // A Mac's login shell is what's asked; Windows has none to ask (it reads
  // PATH, windows-agent-cli's tests), and the miss is kept alike on both.
  const mac = { platform: "darwin", locations: none };
  let clock = 1_000_000;
  const run = async () => {
    asked++;
    throw Object.assign(Error("exit 1"), { code: 1 });
  };
  forgetClaudeMiss();
  assert.equal(await locateClaude(run, { ...mac, now: () => clock }), null);
  assert.equal(await locateClaude(run, { ...mac, now: () => clock + 1000 }), null);
  assert.equal(asked, 1, "remembered for a while");
  clock += 31000;
  assert.equal(await locateClaude(run, { ...mac, now: () => clock }), null);
  assert.equal(asked, 2);
  forgetClaudeMiss();
  assert.equal(await locateClaude(run, { ...mac, now: () => clock + 1 }), null);
  assert.equal(asked, 3, "Check again asks at once");
  forgetClaudeMiss();
});
