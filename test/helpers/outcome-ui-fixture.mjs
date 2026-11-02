import { outcomeFixture } from "./outcome-fixture.mjs";
// Synthetic UI data only. Digests are identifiers, not runner validation.
export const uiDigest = (character) => `sha256:${character.repeat(64)}`;
export const outcomeWorkflowFixture = () => ({
  id: "wf-outcome",
  title: "Synthetic outcome",
  state: "done",
  cwd: "/work/fixture",
  createdAt: 1,
  updatedAt: 1,
  tasks: [
    {
      id: "builder",
      title: "Repair calculation",
      task: "Repair the seeded app",
      agent: "codex",
      kind: "build",
      together: false,
      state: "done",
      chat: { agent: "codex", id: "build-chat" },
    },
    {
      id: "reviewer",
      title: "Independent review",
      agent: "claude",
      kind: "review",
      together: false,
      state: "done",
      chat: { agent: "claude", id: "review-chat" },
    },
  ],
  outcome: {
    phase: "ready",
    acceptance: { eligible: true, status: "not_accepted" },
  },
});
export const outcomeReceiptFixture = () => ({
  evidenceDigest: uiDigest("d"),
  evidenceVersion: 1,
  evidenceFrozen: true,
  collectedAt: 1000,
  provenance: {
    workflowId: "wf-outcome",
    taskId: "builder",
    attempt: 1,
    provider: "codex",
    turnId: "build-turn",
    contractRevision: 1,
  },
  summary: "All done <script>untrusted()</script>",
  unknowns: ["concurrent_edits_unknown", "artifact_binding_unavailable"],
  truncated: false,
  historyIncomplete: false,
  changes: [
    {
      files: "src/total.ts",
      diff: "-return 0;\n+return a + b;\n<script>untrusted()</script>",
      truncated: false,
      itemId: "change-1",
    },
  ],
  commands: [
    {
      command: "synthetic-test",
      output: "test output <img src=x onerror=untrusted()>",
      exitCode: null,
      status: "completed",
      outputCompleteness: "unknown",
    },
  ],
});
export const outcomeResultFixture = () => {
  const contract = outcomeFixture();
  return {
    schemaVersion: 1,
    version: 12,
    phase: "ready",
    planDigest: uiDigest("b"),
    contract,
    contractRevision: 1,
    contractDigest: uiDigest("c"),
    resultRevision: 1,
    resultDigest: uiDigest("e"),
    evidenceRevision: 3,
    evidenceDigest: uiDigest("f"),
    updatedAt: 2000,
    execution: {
      deadlineAt: 1800000,
      startedAt: 1000,
      observations: [],
      baseline: [{ checkId: "unit", status: "failed", exitCode: 1 }],
      counts: { builds: 1, checks: 2, reviews: 1 },
    },
    preparation: null,
    unresolved: [],
    taskCompletion: { completed: 2, skipped: 0, uncertain: 0 },
    checks: [
      {
        checkId: "unit",
        source: "independent_runner",
        status: "passed",
        exitCode: 0,
        complete: true,
        candidateDigest: uiDigest("e"),
        profileDigest: contract.checks[0].definitionDigest,
        logDigest: uiDigest("a"),
      },
    ],
    review: {
      source: "reviewer_judgment",
      inputDigest: uiDigest("b"),
      receiptDigest: uiDigest("a"),
      report: { status: "clear", findings: [] },
      chat: { agent: "claude", id: "review-chat" },
    },
    results: [outcomeReceiptFixture()],
    historyIncomplete: false,
    truncated: false,
    acceptance: { eligible: true, status: "not_accepted" },
    plan: {
      builder: { agent: "codex" },
      independentChecker: contract.checks,
      reviewer: contract.review,
      branches: [
        {
          id: "builder",
          title: "Builder",
          agent: "codex",
          condition: "initial",
        },
        {
          id: "reviewer",
          title: "Independent review",
          agent: "claude",
          condition: "initial",
        },
      ],
      scope: contract.allowedArtifacts,
      limits: contract.limits,
    },
  };
};
