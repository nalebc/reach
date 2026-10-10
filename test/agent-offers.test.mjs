import test from "node:test";
import assert from "node:assert/strict";
import { codexModes, createCodexSessions } from "../server/agent-sessions/codex.mjs";
import { codexTurnMode } from "../server/agent-sessions/codex-live.mjs";
import { claudeModes } from "../server/agent-sessions/claude-host.mjs";
import { createAgentSessions } from "../server/agent-sessions/index.mjs";

// Claude Code 2.1.289's own --help, as printed.
const HELP = `  --permission-mode <mode>              Permission mode to use for the session
                                        (choices: "acceptEdits", "auto",
                                        "bypassPermissions", "manual",
                                        "dontAsk", "plan")
  --plugin-dir <path>                   Load plugins from a directory`;

test("Codex's permission menu is built from what Codex offers now, in its app's order and words", () => {
  const all = [{ id: ":read-only", allowed: true }, { id: ":workspace", allowed: true }, { id: ":danger-full-access", allowed: true }];
  assert.deepEqual(codexModes(all).map((m) => m.label), ["Ask for approval", "Approve for me", "Full access", "Read only"]);
  // Not allowed here (managed policy), or "Approve for me" switched off: not offered.
  assert.deepEqual(
    codexModes([...all.slice(0, 2), { id: ":danger-full-access", allowed: false }], { guardian: false }).map((m) => m.id),
    ["auto", "read-only"],
  );
  // A profile Codex adds later shows under its own name, and runs as that profile.
  const [added] = codexModes([{ id: ":network-only", allowed: true, description: "Internet, no files" }]);
  assert.deepEqual(added, { id: "profile::network-only", label: "Network only", note: "Internet, no files" });
  assert.deepEqual(codexTurnMode(added.id), { approvalPolicy: "on-request", permissions: ":network-only", approvalsReviewer: "user" });
  assert.deepEqual(codexTurnMode("full-access"), { approvalPolicy: "never", permissions: ":danger-full-access", approvalsReviewer: "user" });
  assert.deepEqual(codexTurnMode("profile:$(rm -rf)"), {});
  assert.deepEqual(codexTurnMode(null), {});
});

test("Codex's models, efforts with its own descriptions, speeds and modes come from Codex itself", async () => {
  const calls = [];
  const daemon = {
    rpc: async (method) => {
      calls.push(method);
      if (method === "model/list")
        return {
          data: [
            {
              id: "gpt-7",
              displayName: "GPT-7",
              description: "Next",
              supportedReasoningEfforts: [
                { reasoningEffort: "low", description: "Fast responses" },
                { reasoningEffort: "ultra", description: "Maximum reasoning with automatic task delegation" },
              ],
              defaultReasoningEffort: "low",
              inputModalities: ["text"],
              serviceTiers: [{ id: "priority", name: "Fast", description: "2x speed, increased usage" }],
              isDefault: true,
            },
            { id: "old", hidden: true, supportedReasoningEfforts: [] },
          ],
        };
      if (method === "permissionProfile/list")
        return { data: [{ id: ":workspace", allowed: true }, { id: ":danger-full-access", allowed: true }] };
      if (method === "experimentalFeature/list") return { data: [{ name: "guardian_approval", enabled: false }] };
      return {};
    },
    onNotification() {},
  };
  const codex = createCodexSessions({ daemon, appState: () => ({ mode: "full-access" }) });
  const offered = await codex.models();
  assert.deepEqual(offered.models, [
    {
      id: "gpt-7",
      name: "GPT-7",
      description: "Next",
      efforts: ["low", "ultra"],
      effortNotes: { low: "Fast responses", ultra: "Maximum reasoning with automatic task delegation" },
      defaultEffort: "low",
      images: false,
      isDefault: true,
      speeds: [{ id: "priority", name: "Fast", note: "2x speed, increased usage" }],
      // The speed Codex uses unless one is picked (Configure › Speed).
      defaultSpeed: null,
    },
  ]);
  assert.deepEqual(offered.modes.map((m) => m.label), ["Ask for approval", "Full access", "Custom (config.toml)"]);
  assert.equal(offered.mode, "full-access");
  assert.deepEqual(calls.sort(), ["experimentalFeature/list", "model/list", "permissionProfile/list"]);
});

test("a Codex service older than the installed CLI: the CLI's newer models and config.toml's model are listed, unconfirmed, never the default", async () => {
  const model = (id, extra = {}) => ({
    id,
    displayName: id.toUpperCase(),
    supportedReasoningEfforts: [{ reasoningEffort: "medium" }, { reasoningEffort: "xhigh" }],
    defaultReasoningEffort: "medium",
    ...extra,
  });
  const fake = ({ service = "0.158.0-alpha.2.1", cli = "0.162.0-alpha.2", config = {} } = {}) => {
    const asked = [];
    return {
      asked,
      rpc: async (method) =>
        method === "model/list" ? { data: [model("gpt-6-astra", { isDefault: true }), model("gpt-6-sol")] } : {},
      onNotification() {},
      compatibility: async () => ({ status: "available", version: cli, serviceVersion: service }),
      cliModels: async (version) => {
        asked.push(version);
        return { data: [model("gpt-6.1-sol", { isDefault: true }), model("gpt-6-astra"), model("gpt-old", { hidden: true })] };
      },
      defaults: () => config,
    };
  };
  const ids = (offered) => offered.models.map((m) => `${m.id}${m.isDefault ? "*" : ""}${m.unconfirmed ? "?" : ""}`);
  let daemon = fake({ config: { model: "gpt-6.1-sol", effort: "xhigh" } });
  let offered = await createCodexSessions({ daemon, appState: () => ({}) }).models();
  assert.deepEqual(ids(offered), ["gpt-6-astra*", "gpt-6-sol", "gpt-6.1-sol?"]);
  // Its efforts are Codex's own (an open gpt-6.1-sol chat gets its dots).
  assert.deepEqual(offered.models[2].efforts, ["medium", "xhigh"]);
  assert.deepEqual(daemon.asked, ["0.162.0-alpha.2"]);
  // Same version, or one unreadable: the daemon's list only.
  for (const versions of [{ service: "0.162.0-alpha.2" }, { service: null }]) {
    daemon = fake(versions);
    assert.deepEqual(ids(await createCodexSessions({ daemon, appState: () => ({}) }).models()), ["gpt-6-astra*", "gpt-6-sol"]);
    assert.deepEqual(daemon.asked, []);
  }
  // config.toml's model, listed nowhere: by its own name, with no invented efforts.
  daemon = fake({ service: "0.162.0", config: { model: "gpt-9-new", effort: "xhigh" } });
  offered = await createCodexSessions({ daemon, appState: () => ({}) }).models();
  assert.deepEqual(ids(offered), ["gpt-6-astra*", "gpt-6-sol", "gpt-9-new?"]);
  assert.deepEqual([offered.models[2].name, offered.models[2].efforts], ["gpt-9-new", []]);
  // config.toml's model the service has: what new chats start on, at its effort.
  daemon = fake({ config: { model: "gpt-6-sol", effort: "xhigh" } });
  offered = await createCodexSessions({ daemon, appState: () => ({}) }).models();
  assert.deepEqual(ids(offered).slice(0, 2), ["gpt-6-astra", "gpt-6-sol*"]);
  assert.equal(offered.models[1].defaultEffort, "xhigh");
});

test("Codex's CLI catalog comes from a one-shot app-server that is always stopped", async () => {
  const { EventEmitter } = await import("node:events");
  const { PassThrough } = await import("node:stream");
  const { cliModelList, codexDefaults, olderVersion } = await import("../server/agent-sessions/codex-daemon.mjs");
  const run = (answer) => {
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), killed: false });
    child.kill = () => { child.killed = true; };
    child.stdin.on("data", (chunk) => {
      for (const line of String(chunk).split("\n").filter(Boolean)) {
        const m = JSON.parse(line);
        if (m.id === 1) child.stdout.write(JSON.stringify({ id: 1, result: {} }) + "\n");
        if (m.id === 2) child.stdout.write(JSON.stringify({ id: 2, ...answer }) + "\n");
      }
    });
    return child;
  };
  let child;
  const start = (answer) => (file, args) => { assert.deepEqual(args, ["app-server"]); return (child = run(answer)); };
  assert.deepEqual(await cliModelList("/codex", { start: start({ result: { data: [] } }) }), { data: [] });
  assert.ok(child.killed);
  await assert.rejects(cliModelList("/codex", { start: start({ result: { data: [{ id: "m", supportedReasoningEfforts: {} }] } }) }), { code: "AGENT_INCOMPATIBLE" });
  assert.ok(child.killed);
  await assert.rejects(cliModelList("/codex", { start: () => (child = Object.assign(run({}), { stdin: new PassThrough() })), timeout: 20 }), /did not answer/);
  assert.ok(child.killed);
  assert.equal(olderVersion("0.158.0-alpha.2.1", "0.162.0-alpha.2"), true);
  assert.equal(olderVersion("0.162.0", "0.162.0-alpha.2"), false);
  assert.equal(olderVersion(null, "0.162.0"), false);
  const os = await import("node:os");
  const fs = await import("node:fs");
  const path = await import("node:path");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "reach-codex-config-"));
  fs.writeFileSync(path.join(home, "config.toml"), 'model = "gpt-6.1-sol"\nmodel_reasoning_effort = \'xhigh\'\n[profiles.fast]\nmodel = "gpt-6-luna"\n');
  assert.deepEqual(codexDefaults(home), { model: "gpt-6.1-sol", effort: "xhigh" });
  fs.writeFileSync(path.join(home, "config.toml"), '[profiles.fast]\nmodel = "gpt-6-luna"\n');
  assert.deepEqual(codexDefaults(home), { model: null, effort: null });
  assert.deepEqual(codexDefaults(path.join(home, "missing")), {});
});

// A reply split inside a character (a description's "é") read as two broken
// halves; and the first model sheet waited up to 8 s on the CLI.
test("Codex's CLI catalog keeps whole characters, and the first model sheet doesn't wait for it", async () => {
  const { EventEmitter } = await import("node:events");
  const { PassThrough } = await import("node:stream");
  const { cliModelList, createCodexDaemon } = await import("../server/agent-sessions/codex-daemon.mjs");
  const model = { id: "gpt-6.1-sol", displayName: "GPT-6.1 Sol", description: "Réfléchit — plus vite", supportedReasoningEfforts: [], defaultReasoningEffort: "medium" };
  const start = () => {
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), kill() {} });
    child.stdin.on("data", (chunk) => {
      for (const line of String(chunk).split("\n").filter(Boolean)) {
        const m = JSON.parse(line);
        if (m.id === 1) child.stdout.write(JSON.stringify({ id: 1, result: {} }) + "\n");
        if (m.id === 2) {
          const bytes = Buffer.from(JSON.stringify({ id: 2, result: { data: [model] } }) + "\n");
          const cut = bytes.indexOf(Buffer.from("é")) + 1;
          child.stdout.write(bytes.subarray(0, cut));
          setTimeout(() => child.stdout.write(bytes.subarray(cut)), 5);
        }
      }
    });
    return child;
  };
  assert.equal((await cliModelList("/codex", { start })).data[0].description, "Réfléchit — plus vite");
  let answer;
  const asked = [];
  const daemon = createCodexDaemon({
    locate: async () => "/fake/codex",
    run: async () => ({ stdout: "{}" }),
    listCliModels: (file) => (asked.push(file), new Promise((resolve) => (answer = resolve))),
  });
  const quick = (p) => Promise.race([p, new Promise((resolve) => setTimeout(() => resolve("waited"), 100))]);
  assert.equal(await quick(daemon.cliModels("0.162.0")), null, "started, not waited for");
  assert.equal(await quick(daemon.cliModels("0.162.0")), null, "still coming: asked once");
  assert.deepEqual(asked, ["/fake/codex"]);
  answer({ data: [model] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(await quick(daemon.cliModels("0.162.0")), { data: [model] });
});

// `profile = "x"` at the top: Codex starts chats on that profile's model.
test("Codex's config defaults come from the profile config.toml picks, then its top level", async () => {
  const { codexDefaults } = await import("../server/agent-sessions/codex-daemon.mjs");
  const os = await import("node:os");
  const fs = await import("node:fs");
  const path = await import("node:path");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "reach-codex-profile-"));
  const write = (text) => fs.writeFileSync(path.join(home, "config.toml"), text);
  write('profile = "fast"\nmodel = "gpt-6.1-sol"\nmodel_reasoning_effort = "xhigh"\n[profiles.slow]\nmodel = "gpt-6-astra"\n[profiles.fast]\nmodel = "gpt-6-luna"\n[profiles.fast.extra]\nmodel = "nope"\n');
  assert.deepEqual(codexDefaults(home), { model: "gpt-6-luna", effort: "xhigh" }, "the profile's model, the top level's effort");
  write("profile = 'my.fast'\nmodel = \"gpt-6.1-sol\"\n\n[profiles.\"my.fast\"]\nmodel_reasoning_effort = \"low\"\n");
  assert.deepEqual(codexDefaults(home), { model: "gpt-6.1-sol", effort: "low" });
  write('profile = "gone"\nmodel = "gpt-6.1-sol"\n[profiles.fast]\nmodel = "gpt-6-luna"\n');
  assert.deepEqual(codexDefaults(home), { model: "gpt-6.1-sol", effort: null });
});

// A project root without a folder (or not an object) dropped the whole list.
test("the Codex app's projects keep only roots that are folders", async () => {
  const daemon = {
    rpc: async (method) =>
      method === "project/list"
        ? { data: [{ id: "p1", name: "app", roots: [{ path: "/work/app" }, null, { path: 7 }, {}, { path: "" }, "x"] }, { id: "p2", roots: null }] }
        : {},
    onNotification() {},
  };
  assert.deepEqual(await createCodexSessions({ daemon, appState: () => ({}) }).projects(), [
    { id: "p1", name: "app", roots: ["/work/app"] },
    { id: "p2", name: "", roots: [] },
  ]);
});

test("Claude Code's modes come from its own --help, in its order and words; Auto only for models that take it", async () => {
  assert.deepEqual(claudeModes(HELP), [
    { id: "manual", label: "Manual" },
    { id: "plan", label: "Plan" },
    { id: "acceptEdits", label: "Accept edits" },
    { id: "bypassPermissions", label: "Bypass Permissions" },
    { id: "auto", label: "Auto" },
  ]);
  // A mode Claude Code adds later shows under its own id.
  assert.deepEqual(claudeModes(HELP.replace('"plan")', '"plan", "review")')).at(-1), { id: "review", label: "review" });
  // Help worded otherwise one day: the modes Reach knows, never none.
  assert.deepEqual(claudeModes("no such option").map((m) => m.id), ["manual", "plan", "acceptEdits", "bypassPermissions", "auto"]);
  // Help that didn't run: none (asked again next time).
  assert.deepEqual(claudeModes(""), []);
  const sessions = createAgentSessions({
    daemon: { rpc: async () => ({}), onNotification() {}, onRequest() {}, onClose() {} },
    codex: {},
    claude: {},
    claudeHost: {
      models: async () => [
        { value: "default", resolvedModel: "claude-opus-5-5", displayName: "Default (recommended)", description: "Opus 5.5", supportsEffort: true, supportedEffortLevels: ["low", "max"], supportsAutoMode: true, supportsFastMode: true },
        { value: "haiku", resolvedModel: "claude-haiku-4-5-20251001", displayName: "Haiku", description: "Haiku 4.5" },
      ],
      modes: async () => claudeModes(HELP),
      onRelease() {},
    },
    signIn: {},
    claudeImports: { add: async () => {}, close() {} },
    agentAsks: { close() {} },
  });
  const offered = await sessions.models("claude");
  assert.deepEqual(
    offered.models.map((m) => [m.id, m.name, m.efforts, m.autoMode, m.fast]),
    [
      ["default", "Default (recommended)", ["low", "max"], true, true],
      ["haiku", "Haiku 4.5", [], false, false],
    ],
  );
  assert.deepEqual(offered.models.map(m => m.resolvedModel), ["claude-opus-5-5", "claude-haiku-4-5-20251001"], "native session IDs must map to their catalog alias and effort options");
  // Bypass is listed, marked as one an open chat isn't switched to (the
  // mode route refuses it); a new chat may still start in it.
  assert.deepEqual(offered.modes, claudeModes(HELP).map((m) => (m.id === "bypassPermissions" ? { ...m, switchable: false } : m)));
  sessions.close();
});

test("Codex chats show and use the Codex app's current mode; Reset usage spends one reset, once asked", async () => {
  const calls = [];
  const daemon = {
    rpc: async (method, params) => {
      calls.push([method, params]);
      if (method === "account/rateLimitResetCredit/consume") return { outcome: "reset" };
      if (method === "account/read") return { account: { type: "chatgpt" } };
      if (method === "account/rateLimits/read")
        return { ordinaryUsageAllowed: false, rateLimits: { primary: { resetsAt: 1791606326 } }, rateLimitResetCredits: { availableCount: 1 } };
      return {};
    },
    onNotification() {},
  };
  const codex = createCodexSessions({ daemon, appState: () => ({ mode: "guardian-approvals", threads: { t: { approvalPolicy: "never", activePermissionProfile: { id: ":read-only" } } } }) });
  assert.equal(codex.appMode(), "guardian-approvals");
  const health = await codex.health();
  assert.equal(health.resetCredits, 1);
  assert.equal(health.usable, false);
  assert.deepEqual(calls.filter(([m]) => m.includes("consume")), [], "nothing spent by reading");
  assert.deepEqual(await codex.resetUsage(), { outcome: "reset" });
  const [[, params]] = calls.filter(([m]) => m === "account/rateLimitResetCredit/consume");
  assert.match(params.idempotencyKey, /^[0-9a-f-]{36}$/);

  // A message from the phone without a pick goes in the app's current mode.
  const sent = [];
  const sessions = createAgentSessions({
    daemon,
    codex: { appMode: () => "guardian-approvals" },
    codexLive: { send: async (id, body) => (sent.push(body), { turnId: "t1" }), drives: () => false },
    claude: {},
    claudeHost: { onRelease() {} },
    signIn: {},
    claudeImports: { add: async () => {}, close() {} },
    agentAsks: { close() {} },
  });
  await sessions.send("codex", "01a10895-1859-7022-8614-f5ef47ab1c66", { text: "hi" });
  await sessions.send("codex", "01a10895-1859-7022-8614-f5ef47ab1c66", { text: "go", mode: "full-access" });
  assert.deepEqual(sent.map((b) => b.mode), ["guardian-approvals", "full-access"]);
  await assert.rejects(sessions.resetUsage("claude"), (e) => e.status === 400);
  sessions.close();
});
