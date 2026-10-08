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
  assert.deepEqual(offered.modes, claudeModes(HELP));
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
