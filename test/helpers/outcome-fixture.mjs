// Synthetic contracts only; no installed agents, project contents or screens.
export const outcomeFixture = () => ({
  goal: "Repair the seeded calculation and restore its total.",
  criteria: [
    { id: "calculation", text: "The seeded cases pass.", required: true, method: "check", checkId: "unit" },
    { id: "appearance", text: "The total is visible.", required: false, method: "owner_observation" },
  ],
  allowedArtifacts: { allowedChangedPaths: ["src/**"], requiredKinds: ["source_snapshot", "diff", "check_log", "review_report"], maxFiles: 100, maxBytes: 52428800 },
  checks: [{ id: "unit", profileId: "synthetic-unit-v1", definitionDigest: `sha256:${"a".repeat(64)}`, timeoutSeconds: 300 }],
  review: { required: true, agent: "claude", separateChat: true },
  limits: { wallSeconds: 1800, buildSeconds: 900, reviewSeconds: 300, maxBuildAttempts: 1, maxTotalCheckRuns: 2, maxTotalReviewAttempts: 1 },
  repair: { preapproved: false, maxCycles: 0 },
});
