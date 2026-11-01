import { useState } from "react";

export type Criterion = {
  id: string;
  text: string;
  required: boolean;
  method: "check" | "owner_observation";
  checkId?: string;
};
export type OutcomeContract = {
  goal: string;
  criteria: Criterion[];
  allowedArtifacts: {
    allowedChangedPaths: string[];
    requiredKinds: string[];
    optionalKinds?: string[];
    maxFiles: number;
    maxBytes: number;
  };
  checks: {
    id: string;
    profileId: string;
    definitionDigest: string;
    timeoutSeconds: number;
  }[];
  review: {
    required: true;
    separateChat: true;
    agent: string;
    scope?: string;
    model?: string;
    effort?: string;
  };
  limits: {
    wallSeconds: number;
    buildSeconds: number;
    reviewSeconds: number;
    maxBuildAttempts: number;
    maxTotalCheckRuns: number;
    maxTotalReviewAttempts: number;
  };
  repair: { preapproved: boolean; maxCycles: number };
};
const emptyContract = (): OutcomeContract => ({
  goal: "",
  criteria: [
    {
      id: "criterion-1",
      text: "",
      required: true,
      method: "check",
      checkId: "check-1",
    },
  ],
  allowedArtifacts: {
    allowedChangedPaths: [],
    requiredKinds: ["source_snapshot", "diff", "check_log", "review_report"],
    optionalKinds: ["before_png", "after_png"],
    maxFiles: 100,
    maxBytes: 52428800,
  },
  checks: [
    { id: "check-1", profileId: "", definitionDigest: "", timeoutSeconds: 300 },
  ],
  review: { required: true, separateChat: true, agent: "claude" },
  limits: {
    wallSeconds: 1800,
    buildSeconds: 900,
    reviewSeconds: 300,
    maxBuildAttempts: 1,
    maxTotalCheckRuns: 2,
    maxTotalReviewAttempts: 1,
  },
  repair: { preapproved: false, maxCycles: 0 },
});

// Only owner input enters the contract. Profile pins come from runner setup,
// never from a builder's suggested command or a fabricated default digest.
export default function WorkflowOutcomeEditor({
  initial,
  busy,
  locked,
  onSave,
  onCancel,
}: {
  initial?: OutcomeContract;
  busy: boolean;
  locked?: boolean;
  onSave: (contract: OutcomeContract) => void;
  onCancel: () => void;
}) {
  const [contract, setContract] = useState<OutcomeContract>(() =>
    structuredClone(initial || emptyContract()),
  );
  const [paths, setPaths] = useState(
    contract.allowedArtifacts.allowedChangedPaths.join("\n"),
  );
  const [problem, setProblem] = useState("");
  const patch = (p: Partial<OutcomeContract>) =>
    setContract((c) => ({ ...c, ...p }));
  const budget = (
    checks = contract.checks,
    repair = contract.repair.preapproved,
  ) => ({
    ...contract.limits,
    maxBuildAttempts: repair ? 2 : 1,
    maxTotalCheckRuns: checks.length * (repair ? 3 : 2),
    maxTotalReviewAttempts: repair ? 2 : 1,
  });
  return (
    <form
      className="wf-outcome-editor"
      aria-label="Edit outcome goal and success criteria"
      onSubmit={(e) => {
        e.preventDefault();
        if (
          !contract.criteria.some((c) => c.required && c.method === "check")
        ) {
          setProblem("Keep at least one required automated criterion.");
          return;
        }
        setProblem("");
        onSave({
          ...contract,
          allowedArtifacts: {
            ...contract.allowedArtifacts,
            allowedChangedPaths: paths
              .split("\n")
              .map((p) => p.trim())
              .filter(Boolean),
          },
        });
      }}
    >
      <fieldset disabled={busy || locked}>
        <legend>Outcome goal and success criteria</legend>
        <label>
          Goal
          <textarea
            required
            maxLength={2000}
            value={contract.goal}
            onChange={(e) => patch({ goal: e.target.value })}
          />
        </label>
        {contract.criteria.map((c, i) => (
          <fieldset className="wf-outcome-card" key={c.id}>
            <legend>Criterion {i + 1}</legend>
            <label>
              Success criterion {i + 1}
              <textarea
                required
                maxLength={2000}
                value={c.text}
                onChange={(e) =>
                  patch({
                    criteria: contract.criteria.map((v) =>
                      v.id === c.id ? { ...v, text: e.target.value } : v,
                    ),
                  })
                }
              />
            </label>
            <label>
              Evidence for criterion {i + 1}
              <select
                value={
                  c.method === "check"
                    ? `check:${c.checkId}`
                    : "owner_observation"
                }
                onChange={(e) =>
                  patch({
                    criteria: contract.criteria.map((v) =>
                      v.id === c.id
                        ? {
                            id: v.id,
                            text: v.text,
                            required: v.required,
                            method:
                              e.target.value === "owner_observation"
                                ? "owner_observation"
                                : "check",
                            ...(e.target.value === "owner_observation"
                              ? {}
                              : { checkId: e.target.value.slice(6) }),
                          }
                        : v,
                    ),
                  })
                }
              >
                {contract.checks.map((check) => (
                  <option key={check.id} value={`check:${check.id}`}>
                    Recorded check: {check.id}
                  </option>
                ))}
                <option value="owner_observation">Owner observation</option>
              </select>
            </label>
            <label className="wf-outcome-toggle">
              <input
                type="checkbox"
                checked={c.required}
                onChange={(e) =>
                  patch({
                    criteria: contract.criteria.map((v) =>
                      v.id === c.id ? { ...v, required: e.target.checked } : v,
                    ),
                  })
                }
              />
              Required criterion {i + 1}
            </label>
            <button
              type="button"
              className="wf-pill"
              disabled={contract.criteria.length === 1}
              onClick={() =>
                patch({
                  criteria: contract.criteria.filter((v) => v.id !== c.id),
                })
              }
            >
              Remove criterion {i + 1}
            </button>
          </fieldset>
        ))}
        <button
          type="button"
          className="wf-pill"
          disabled={contract.criteria.length >= 20}
          onClick={() =>
            patch({
              criteria: [
                ...contract.criteria,
                {
                  id: `criterion-${crypto.randomUUID()}`,
                  text: "",
                  required: true,
                  method: "check",
                  checkId: contract.checks[0].id,
                },
              ],
            })
          }
        >
          Add success criterion
        </button>
        <label>
          Allowed changed paths · one relative path or pattern per line
          <textarea
            required
            value={paths}
            onChange={(e) => setPaths(e.target.value)}
            placeholder="src/**"
          />
        </label>
        <p>
          Advanced setup: copy the profile ID and definition digest supplied by
          the computer's trusted runner. Reach does not yet provision profiles
          or offer a profile picker. Prepare verifies the supplied definition
          before Run; do not invent a digest or use one suggested by the builder.
        </p>
        {contract.checks.map((check, i) => (
          <fieldset className="wf-outcome-card" key={check.id}>
            <legend>Recorded check {check.id}</legend>
            <label>
              Check {i + 1} profile ID
              <input
                required
                maxLength={80}
                pattern="[A-Za-z0-9][A-Za-z0-9_-]*"
                value={check.profileId}
                onChange={(e) =>
                  patch({
                    checks: contract.checks.map((v) =>
                      v.id === check.id
                        ? { ...v, profileId: e.target.value }
                        : v,
                    ),
                  })
                }
              />
            </label>
            <label>
              Check {i + 1} definition digest
              <input
                required
                pattern="sha256:[a-f0-9]{64}"
                placeholder="sha256:…"
                value={check.definitionDigest}
                onChange={(e) =>
                  patch({
                    checks: contract.checks.map((v) =>
                      v.id === check.id
                        ? { ...v, definitionDigest: e.target.value }
                        : v,
                    ),
                  })
                }
              />
            </label>
            <label>
              Check {i + 1} timeout (seconds)
              <input
                required
                type="number"
                min={1}
                max={Math.min(300, contract.limits.wallSeconds)}
                value={check.timeoutSeconds}
                onChange={(e) =>
                  patch({
                    checks: contract.checks.map((v) =>
                      v.id === check.id
                        ? { ...v, timeoutSeconds: Number(e.target.value) }
                        : v,
                    ),
                  })
                }
              />
            </label>
            <button
              type="button"
              className="wf-pill"
              disabled={
                contract.checks.length === 1 ||
                contract.criteria.some((c) => c.checkId === check.id)
              }
              onClick={() => {
                const checks = contract.checks.filter((v) => v.id !== check.id);
                patch({ checks, limits: budget(checks) });
              }}
            >
              Remove check {i + 1}
            </button>
          </fieldset>
        ))}
        <button
          type="button"
          className="wf-pill"
          disabled={contract.checks.length >= 10}
          onClick={() => {
            const checks = [
              ...contract.checks,
              {
                id: `check-${crypto.randomUUID()}`,
                profileId: "",
                definitionDigest: "",
                timeoutSeconds: 300,
              },
            ];
            patch({ checks, limits: budget(checks) });
          }}
        >
          Add recorded check
        </button>
        <label>
          Separate reviewer
          <select
            value={contract.review.agent}
            onChange={(e) =>
              patch({ review: { ...contract.review, agent: e.target.value } })
            }
          >
            <option value="codex">Codex</option>
            <option value="claude">Claude Code</option>
          </select>
        </label>
        <label>
          Overall deadline (minutes)
          <input
            required
            type="number"
            min={1}
            max={60}
            value={contract.limits.wallSeconds / 60}
            onChange={(e) => {
              const wallSeconds = Number(e.target.value) * 60;
              patch({
                limits: {
                  ...contract.limits,
                  wallSeconds,
                  buildSeconds: Math.min(
                    contract.limits.buildSeconds,
                    wallSeconds,
                  ),
                  reviewSeconds: Math.min(
                    contract.limits.reviewSeconds,
                    wallSeconds,
                  ),
                },
                checks: contract.checks.map((c) => ({
                  ...c,
                  timeoutSeconds: Math.min(c.timeoutSeconds, wallSeconds),
                })),
              });
            }}
          />
        </label>
        <label className="wf-outcome-toggle">
          <input
            type="checkbox"
            checked={contract.repair.preapproved}
            onChange={(e) =>
              patch({
                repair: {
                  preapproved: e.target.checked,
                  maxCycles: e.target.checked ? 1 : 0,
                },
                limits: budget(contract.checks, e.target.checked),
              })
            }
          />
          Preapprove one repair after a supported failed check
        </label>
        <p>
          {contract.repair.preapproved
            ? "Builder → capture and checks → separate review. Only an eligible failed check may select one repair → fresh capture, all checks and separate review. Unknown evidence holds for you."
            : "Builder → capture and checks → separate review. Failures and unknown evidence hold for you; no repair is approved."}
        </p>
        <p>
          Maximum {contract.limits.maxBuildAttempts} builds,{" "}
          {contract.limits.maxTotalCheckRuns} checks including baseline,{" "}
          {contract.limits.maxTotalReviewAttempts} reviews. Required artifacts:{" "}
          {contract.allowedArtifacts.requiredKinds.join(", ")}. Up to{" "}
          {contract.allowedArtifacts.maxFiles} files /{" "}
          {Math.round(contract.allowedArtifacts.maxBytes / 1048576)} MiB.
        </p>
        <button className="wf-primary" type="submit">
          {busy ? "Saving outcome…" : "Save outcome goal"}
        </button>
      </fieldset>
      {problem && (
        <p role="alert" className="wf-outcome-warning">
          {problem}
        </p>
      )}
      {!locked && (
        <button
          className="wf-pill"
          type="button"
          disabled={busy}
          onClick={onCancel}
        >
          Cancel editing outcome
        </button>
      )}
    </form>
  );
}
