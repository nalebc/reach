import test, { before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { startDom, settle, replaceText } from "./dom/harness.mjs";
import { outcomeFixture } from "./helpers/outcome-fixture.mjs";
import {
  outcomeWorkflowFixture,
  outcomeResultFixture,
  outcomeReceiptFixture,
  uiDigest,
} from "./helpers/outcome-ui-fixture.mjs";

// Rendered React with synthetic HTTP data; no real browser, screen or phone.
const peer = {
  id: "computer",
  name: "Computer",
  url: "https://reach.test",
  token: "synthetic",
  platform: "darwin",
};
const workflow = {
  id: "wf-outcome",
  title: "Synthetic outcome",
  state: "draft",
  cwd: "/work/fixture",
  tasks: [],
  outcome: {
    phase: "draft",
    acceptance: { eligible: false, status: "not_accepted" },
  },
};
const fresh = () => ({
  version: 3,
  phase: "draft",
  planDigest: "plan",
  contractRevision: 1,
  contractDigest: "contract",
  resultRevision: null,
  resultDigest: null,
  evidenceRevision: 0,
  evidenceDigest: "evidence",
  execution: null,
  preparation: null,
  unresolved: [],
  acceptance: { eligible: false, status: "not_accepted" },
  plan: {
    builder: { agent: "codex" },
    independentChecker: [{ id: "unit", profileId: "synthetic-unit-v1" }],
    reviewer: { agent: "claude", scope: "Inspect all criteria" },
    branches: [
      { id: "b", title: "Builder", agent: "codex", condition: "initial" },
      {
        id: "r",
        title: "Independent review",
        agent: "claude",
        condition: "initial",
      },
      {
        id: "fix",
        title: "Conditional repair",
        agent: "codex",
        condition: "one_supported_failed_check",
      },
    ],
    scope: { allowedChangedPaths: ["src/**"] },
    limits: {
      wallSeconds: 1800,
      maxBuildAttempts: 2,
      maxTotalCheckRuns: 3,
      maxTotalReviewAttempts: 2,
    },
  },
});
let dom,
  Component,
  WorkflowSheet,
  view,
  outcome,
  sent = [],
  lost = false,
  heldWorkflow,
  opened = [];
let capabilities = { executionAvailable: true, reason: "" };
let removedDraft = false;
const base = "/api/sessions/workflows/wf-outcome";
before(async () => {
  dom = await startDom({
    routes: {
      "/api/sessions/workflows/outcome-capabilities": () => capabilities,
      [base]: (init) => {
        if (init.method === "POST") {
          const body = JSON.parse(init.body);
          sent.push({ action: "edit", body });
          heldWorkflow = {
            ...heldWorkflow,
            ...body,
            updatedAt: heldWorkflow.updatedAt + 1,
          };
          return { workflow: heldWorkflow };
        }
        return heldWorkflow;
      },
      "/api/sessions/models": () => ({ models: [] }),
      [`${base}/outcome`]: (init) => {
        if (init.method === "POST") {
          const body = JSON.parse(init.body);
          sent.push({ action: "save", body });
          if (body.expectedVersion !== (outcome?.version || 0))
            return new Response(
              JSON.stringify({
                error:
                  "The contract changed. Cancel editing and inspect the current contract.",
              }),
              { status: 409 },
            );
          outcome = {
            ...fresh(),
            contract: body.contract,
            version: (outcome?.version || 0) + 1,
          };
          heldWorkflow = { ...heldWorkflow, outcome: workflow.outcome };
        }
        return { outcome, capabilities };
      },
      [`${base}/outcome/prepare`]: (init) => {
        sent.push({ action: "prepare", body: JSON.parse(init.body) });
        outcome = {
          ...outcome,
          version: 4,
          preparation: {
            preparedDigest: "pinned-preparation",
            prepared: {
              isolation: "Synthetic isolation only",
              profiles: [
                {
                  id: "unit",
                  definition: {
                    executable: "synthetic-check",
                    args: ["--unit"],
                  },
                },
              ],
            },
          },
        };
        return { outcome };
      },
      [`${base}/outcome/run`]: (init) => {
        sent.push({ action: "run", body: JSON.parse(init.body) });
        if (lost) throw Error("Synthetic response lost");
        outcome = { ...outcome, phase: "running" };
        return { outcome };
      },
      [`${base}/outcome/accept`]: (init) => {
        const body = JSON.parse(init.body);
        sent.push({ action: "accept", body });
        if (lost) throw Error("Synthetic response lost");
        outcome = {
          ...outcome,
          version: outcome.version + 1,
          phase: "accepted",
          acceptance: {
            status: "accepted",
            eligible: false,
            decision: { at: 3000, tuple: body },
          },
        };
        return { outcome };
      },
      [`${base}/outcome/request-changes`]: (init) => {
        const body = JSON.parse(init.body);
        sent.push({ action: "request-changes", body });
        if (removedDraft) throw Error("Synthetic changes response lost");
        return {
          outcome,
          draft: { ...heldWorkflow, id: "new-draft", state: "draft" },
        };
      },
      [`${base}/outcome/operations/removed-draft-request`]: () => ({ status: "known", operation: { draftId: "new-draft" }, draftRemoved: true }),
      [`${base}/outcome/observations`]: (init) => {
        const body = JSON.parse(init.body);
        sent.push({ action: "observations", body });
        outcome = {
          ...outcome,
          version: outcome.version + 1,
          evidenceRevision: outcome.evidenceRevision + 1,
          evidenceDigest: uiDigest("a"),
          execution: {
            ...outcome.execution,
            observations: [{ ...body, at: 3000 }],
          },
        };
        return { outcome };
      },
      [`${base}/outcome/cancel`]: (init) => {
        sent.push({ action: "cancel", body: JSON.parse(init.body) });
        outcome = { ...outcome, version: outcome.version + 1 };
        return { outcome };
      },
      [`${base}/remove`]: () => { sent.push({ action: "remove" }); return { removed: true }; },
      [`${base}/tasks/builder/result`]: (init, url) => {
        sent.push({
          action: "receipt",
          attempt: url.searchParams.get("attempt"),
          authorization: init.headers.get("Authorization"),
        });
        return { result: outcomeReceiptFixture(), omittedAttempts: 0 };
      },
    },
  });
  ({ default: Component } = await dom.load("/src/WorkflowOutcome.tsx"));
  ({ WorkflowSheet } = await dom.load("/src/Workflows.tsx"));
});
after(() => dom?.close());
afterEach(async () => {
  await view?.unmount();
  dom.window.sessionStorage.clear();
  sent = [];
  lost = false;
  opened = [];
  capabilities = { executionAvailable: true, reason: "" };
  removedDraft = false;
  assert.deepEqual(dom.errors, []);
});
const button = (text) =>
  [...dom.document.querySelectorAll("button")].find((b) =>
    b.textContent.includes(text),
  );
async function open(value = fresh(), w = workflow) {
  outcome = value;
  heldWorkflow = structuredClone(w);
  view = await dom.render(
    dom.React.createElement(Component, {
      peer,
      workflow: w,
      onChanged: (w) => opened.push(w.id),
      onScreen: () => opened.push("screen"),
      onApps: () => opened.push("apps"),
      onFiles: () => opened.push("files"),
      onOpenChat: (c) => opened.push(c.id),
    }),
  );
  await settle();
}

test("before Run shows builder, separate checker/reviewer, conditional repair, scope and finite ceilings", async () => {
  await open();
  const text = dom.document.body.textContent;
  for (const expected of [
    "Builder: codex",
    "Independent checker: synthetic-unit-v1",
    "Separate reviewer: claude",
    "Conditional repair",
    "supported failed check",
    "src/**",
    "30 minutes from Run",
    "2 builds, 3 checks, 2 reviews",
  ])
    assert.ok(text.includes(expected), expected);
  assert.equal(sent.length, 0);
  button("Prepare checks").click();
  await settle();
  assert.equal(sent.length, 1);
  assert.ok(dom.document.body.textContent.includes("synthetic-check"));
  assert.ok(button("Run approved outcome plan"));
  button("Run approved outcome plan").click();
  await settle();
  assert.equal(sent[1].body.preparedDigest, "pinned-preparation");
  assert.equal(sent[1].body.expectedVersion, 4);
});

test("unconfigured runner disables preparation and profile editing without dispatching, while existing results remain inspectable", async () => {
  capabilities = { executionAvailable: false, reason: "Outcome execution requires a trusted production runner. Setup is not available yet." };
  const draft = fresh(); draft.contract = outcomeFixture();
  await open(draft);
  assert.equal(button("Prepare checks").disabled, true);
  assert.equal(button("Edit goal and success criteria").disabled, true);
  button("Prepare checks").click();
  assert.equal(sent.length, 0);
  assert.match(dom.document.body.textContent, /trusted production runner/);
  assert.equal(dom.document.querySelector('input[placeholder="sha256:…"]'), null);
  await view.unmount();
  await open(outcomeResultFixture(), outcomeWorkflowFixture());
  assert.match(dom.document.body.textContent, /Result revision 1/);
  assert.ok([...dom.document.querySelectorAll("summary")].some(v => v.textContent.includes("provider-reported diffs")));
});

test("uncertain owned work offers Retry stop with a fresh id after each resolved request", async () => {
  const value = outcomeResultFixture(); value.phase = "uncertain"; value.acceptance.eligible = false;
  value.execution.pending = { kind: "check" }; value.execution.hold = "The original check has not confirmed termination.";
  await open(value, outcomeWorkflowFixture());
  button("Retry stop").click();
  await settle();
  await dom.waitFor(() => sent.length === 1 && !button("Retry stop").disabled);
  button("Retry stop").click();
  await dom.waitFor(() => sent.length === 2);
  assert.ok(sent.every(v => v.action === "cancel"));
  assert.notEqual(sent[0].body.requestId, sent[1].body.requestId);
  assert.equal(sent[1].body.expectedVersion, sent[0].body.expectedVersion + 1);
});

test("a settled paused outcome exposes explicit deletion only when the server marks it removable", async () => {
  outcome = outcomeResultFixture(); outcome.phase = "needs_owner";
  heldWorkflow = { ...outcomeWorkflowFixture(), state: "paused", outcome: { phase: "needs_owner", removable: true, acceptance: { status: "not_accepted", eligible: false } } };
  view = await dom.render(dom.React.createElement(WorkflowSheet, { peer, id: heldWorkflow.id, initial: heldWorkflow, logos: {}, onOpenChat() {}, onClose: () => opened.push("closed") }));
  await settle();
  button("Delete").click(); await settle();
  assert.match(dom.document.body.textContent, /Delete this workflow\?/);
  button("Delete").click(); await settle();
  assert.deepEqual(sent, [{ action: "remove" }]);
  assert.deepEqual(opened, ["closed"]);
  await view.unmount();
  heldWorkflow.outcome.removable = false;
  view = await dom.render(dom.React.createElement(WorkflowSheet, { peer, id: heldWorkflow.id, initial: heldWorkflow, logos: {}, onOpenChat() {}, onClose() {} }));
  await settle();
  assert.equal(button("Delete"), undefined);
});

test("lost changes response to an explicitly deleted draft recovers without recreating it or retaining an unresolved request", async () => {
  removedDraft = true;
  const body = { requestId: "removed-draft-request", expectedVersion: 12 };
  sessionStorage.setItem(`reach-outcome-request:${peer.url}:wf-outcome`, JSON.stringify({ "request-changes": body }));
  await open(outcomeResultFixture(), outcomeWorkflowFixture());
  button("Retry retained request-changes request").click(); await settle();
  assert.match(dom.document.body.textContent, /draft was deleted. No replacement draft was created/);
  assert.deepEqual(sent, [{ action: "request-changes", body }]);
  assert.deepEqual(opened, ["wf-outcome"]);
  assert.equal(button("Retry retained request-changes request"), undefined);
});

test("lost Run responses retain the same request ID and exact approved body for explicit retry", async () => {
  await open();
  button("Prepare checks").click();
  await settle();
  lost = true;
  button("Run approved outcome plan").click();
  await settle();
  const first = sent.find((s) => s.action === "run").body;
  button("Retry retained run request").click();
  await settle();
  const runs = sent.filter((s) => s.action === "run");
  assert.equal(runs.length, 2);
  assert.deepEqual(runs[1].body, first);
});

test("successful result separates finished execution, passed checks and owner acceptance; exact Accept is explicit", async () => {
  await open(outcomeResultFixture(), outcomeWorkflowFixture());
  const text = dom.document.body.textContent;
  for (const expected of [
    "Finished execution",
    "Checks passed",
    "not accepted",
    "The seeded cases pass.",
    "No findings",
    "Evidence freshness",
    "Full independent log content is not available",
  ])
    assert.ok(text.includes(expected), expected);
  assert.equal(
    sent.length,
    0,
    "opening the result never accepts or executes it",
  );
  assert.equal(button("Accept result").disabled, false);
  for (const label of [
    "Inspect in Screen",
    "Inspect in Apps",
    "Browse Files and previews",
    "Open independent review chat",
  ])
    button(label).click();
  assert.deepEqual(opened, ["screen", "apps", "files", "review-chat"]);
  button("Accept result").click();
  await settle();
  const accepted = sent.find((s) => s.action === "accept").body;
  for (const key of [
    "contractRevision",
    "contractDigest",
    "resultRevision",
    "resultDigest",
    "evidenceRevision",
    "evidenceDigest",
  ])
    assert.equal(accepted[key], outcomeResultFixture()[key], key);
  assert.equal(accepted.expectedVersion, 12);
  assert.deepEqual(accepted.acknowledgedLimitationIds, []);
  assert.ok(dom.document.body.textContent.includes("Accepted revision 1"));
  assert.equal(button("Accept result").disabled, true);
});

test("failed result keeps execution finished, shows blocking findings, and Request changes creates a new draft", async () => {
  const failed = outcomeResultFixture();
  failed.phase = "needs_owner";
  failed.acceptance.eligible = false;
  failed.checks[0] = { ...failed.checks[0], status: "failed", exitCode: 1 };
  failed.review.report = {
    status: "findings",
    findings: [
      {
        id: "total",
        text: "<script>untrusted()</script> Total remains wrong.",
        blocking: true,
      },
    ],
  };
  failed.unresolved = [
    { id: "check_failed_unit", blocking: true },
    { id: "review_blocking", blocking: true },
  ];
  await open(failed, outcomeWorkflowFixture());
  assert.ok(dom.document.body.textContent.includes("Finished execution"));
  assert.ok(
    dom.document.body.textContent.includes("Checks have not all passed"),
  );
  assert.ok(
    dom.document.body.textContent.includes(
      "Blocking: <script>untrusted()</script>",
    ),
  );
  assert.equal(dom.document.querySelector("script"), null);
  assert.equal(button("Accept result").disabled, true);
  const note = [...dom.document.querySelectorAll("label")]
    .find((l) => l.textContent === "Requested changes")
    .querySelector("textarea");
  await replaceText(note, "Correct the total and rerun the same checks.");
  button("Request changes").click();
  await settle();
  assert.equal(
    sent.at(-1).body.note,
    "Correct the total and rerun the same checks.",
  );
  assert.equal(sent.at(-1).body.resultDigest, failed.resultDigest);
  assert.deepEqual(opened, ["new-draft"]);
});

test("incomplete and clipped evidence remains visible with unknown exits; authenticated task diffs use escaped Files reader", async () => {
  const incomplete = outcomeResultFixture();
  incomplete.phase = "needs_owner";
  incomplete.acceptance.eligible = false;
  incomplete.checks[0].exitCode = null;
  incomplete.checks[0].complete = false;
  incomplete.historyIncomplete = true;
  incomplete.truncated = true;
  incomplete.results[0].historyIncomplete = true;
  incomplete.results[0].truncated = true;
  incomplete.unresolved = [
    { id: "execution_disposition_unknown", blocking: true },
  ];
  await open(incomplete, outcomeWorkflowFixture());
  assert.equal(button("Accept result").disabled, true);
  for (const expected of [
    "history incomplete",
    "Stored evidence clipped",
    "execution disposition unknown",
    "exit unknown",
    "unknown · check unit",
    "before/after previews are not exposed",
  ])
    assert.ok(dom.document.body.textContent.includes(expected), expected);
  const details = [...dom.document.querySelectorAll("details")].find((d) =>
    d.querySelector("summary")?.textContent.includes("attempt 1"),
  );
  details.open = true;
  details.dispatchEvent(new dom.window.Event("toggle"));
  await settle();
  assert.deepEqual(
    sent.find((s) => s.action === "receipt"),
    { action: "receipt", attempt: "1", authorization: "Bearer synthetic" },
  );
  assert.ok(dom.document.body.textContent.includes("+return a + b;"));
  assert.ok(
    dom.document.body.textContent.includes(
      "Provider evidence unknowns: concurrent edits unknown",
    ),
  );
  assert.equal(dom.document.querySelector("script, iframe, img"), null);
  const wrap = details.querySelector('[aria-label="Wrap lines"]');
  wrap.click();
  await settle();
  assert.equal(wrap.getAttribute("aria-pressed"), "true");
  assert.equal(details.querySelector(".file-code-source").tabIndex, 0);
});

test("stale check and prior acceptance never look current; changed polling bundle requires explicit review and preserves owner text", async () => {
  const stale = outcomeResultFixture();
  stale.acceptance = {
    status: "stale",
    eligible: false,
    decision: { at: 1000, tuple: { resultRevision: 0 } },
  };
  stale.checks[0].candidateDigest = uiDigest("a");
  stale.unresolved = [{ id: "approval_stale", blocking: true }];
  await open(stale, outcomeWorkflowFixture());
  assert.ok(dom.document.body.textContent.includes("stale · check unit"));
  assert.ok(
    dom.document.body.textContent.includes("Previous acceptance is stale"),
  );
  assert.equal(button("Accept result").disabled, true);
  const note = [...dom.document.querySelectorAll("label")]
    .find((l) => l.textContent === "Requested changes")
    .querySelector("textarea");
  await replaceText(note, "Keep this unsaved owner note.");
  outcome = {
    ...outcomeResultFixture(),
    version: 13,
    resultRevision: 2,
    evidenceRevision: 4,
  };
  await dom.waitFor(() => button("Review current revision"), 6000);
  assert.equal(note.value, "Keep this unsaved owner note.");
  assert.equal(button("Accept result").disabled, true);
  button("Review current revision").click();
  await settle();
  assert.equal(button("Accept result").disabled, false);
  button("Accept result").click();
  await settle();
  assert.equal(sent.find((s) => s.action === "accept").body.resultRevision, 2);
});

test("accepted result records its exact revision and date without hiding criteria or evidence", async () => {
  const accepted = outcomeResultFixture();
  accepted.phase = "accepted";
  accepted.acceptance = {
    eligible: false,
    status: "accepted",
    decision: { at: 3000, tuple: { ...accepted } },
  };
  await open(accepted, outcomeWorkflowFixture());
  for (const expected of [
    "Accepted revision 1",
    "Previous owner decision: revision 1",
    "The seeded cases pass.",
    "Task-attributed diffs",
    "Recorded independent checks",
  ])
    assert.ok(dom.document.body.textContent.includes(expected), expected);
  assert.equal(button("Accept result").disabled, true);
  assert.equal(button("Request changes").disabled, false);
  assert.equal(button("Cancel outcome"), undefined);
});

test("owner observations are testimony bound to the displayed result and preserve checks separately", async () => {
  await open(outcomeResultFixture(), outcomeWorkflowFixture());
  const field = [...dom.document.querySelectorAll("label")]
    .find((l) => l.textContent.includes("— observation"))
    .querySelector("textarea");
  await replaceText(field, "The total is visible in the synthetic app.");
  field
    .closest("form")
    .dispatchEvent(
      new dom.window.Event("submit", { bubbles: true, cancelable: true }),
    );
  await settle();
  const observation = sent.find((s) => s.action === "observations").body;
  assert.equal(observation.criterionId, "appearance");
  assert.equal(observation.passed, true);
  assert.equal(observation.resultDigest, outcomeResultFixture().resultDigest);
  assert.ok(
    dom.document.body.textContent.includes("Owner observation: passed"),
  );
  assert.ok(dom.document.body.textContent.includes("Checks passed"));
  assert.ok(
    button("Review current revision"),
    "changed evidence requires fresh inspection",
  );
});

test("draft goal and criteria edits invalidate preparation, retain stable IDs and explicitly approve one repair branch", async () => {
  const initial = fresh();
  initial.contract = outcomeFixture();
  await open(initial);
  button("Edit goal").click();
  await settle();
  const form = dom.document.querySelector(
    'form[aria-label="Edit outcome goal and success criteria"]',
  );
  const labelled = (text) =>
    [...form.querySelectorAll("label")]
      .find((l) => l.textContent.startsWith(text))
      ?.querySelector("input,textarea,select");
  await replaceText(
    labelled("Goal"),
    "Restore the calculation and visible total.",
  );
  await replaceText(
    labelled("Success criterion 1"),
    "All seeded calculation cases return the expected total.",
  );
  labelled("Preapprove one repair after a supported failed check").click();
  await settle();
  assert.ok(
    form.textContent.includes(
      "2 builds, 3 checks including baseline, 2 reviews",
    ),
  );
  form.dispatchEvent(
    new dom.window.Event("submit", { bubbles: true, cancelable: true }),
  );
  await settle();
  const saved = sent.find((s) => s.action === "save").body;
  assert.equal(saved.expectedVersion, 3);
  assert.equal(saved.contract.criteria[0].id, "calculation");
  assert.equal(
    saved.contract.criteria[0].text,
    "All seeded calculation cases return the expected total.",
  );
  assert.deepEqual(saved.contract.repair, { preapproved: true, maxCycles: 1 });
  assert.ok(button("Prepare checks"), "saving requires preparation again");
});

test("ordinary workflow can attach an owner outcome only after task edits flush; creation uses version zero", async () => {
  outcome = null;
  heldWorkflow = {
    ...outcomeWorkflowFixture(),
    state: "draft",
    outcome: undefined,
    tasks: [{ ...outcomeWorkflowFixture().tasks[0], state: "waiting" }],
  };
  view = await dom.render(
    dom.React.createElement(WorkflowSheet, {
      peer,
      id: heldWorkflow.id,
      initial: heldWorkflow,
      logos: {},
      onOpenChat() {},
      onClose() {},
    }),
  );
  await settle();
  assert.ok(button("Run workflow"));
  assert.equal(dom.document.querySelector(".wf-outcome"), null);
  dom.document.querySelector(".wf-item > button.wf-item-main").click();
  await settle();
  await replaceText(
    dom.document.querySelector('[aria-label="Task 1 title"]'),
    "Owner-edited builder",
  );
  await dom.waitFor(() => !button("Add outcome goal").disabled);
  button("Add outcome goal").click();
  await settle();
  const form = dom.document.querySelector(
    'form[aria-label="Edit outcome goal and success criteria"]',
  );
  assert.ok(form);
  assert.equal(button("Run workflow"), undefined);
  const field = (label) =>
    [...form.querySelectorAll("label")]
      .find((l) => l.textContent === label)
      ?.querySelector("input,textarea");
  await replaceText(field("Goal"), "Repair the synthetic app.");
  await replaceText(field("Success criterion 1"), "The seeded cases pass.");
  await replaceText(
    field("Allowed changed paths · one relative path or pattern per line"),
    "src/**",
  );
  await replaceText(field("Check 1 profile ID"), "synthetic-unit-v1");
  await replaceText(field("Check 1 definition digest"), uiDigest("a"));
  form.dispatchEvent(
    new dom.window.Event("submit", { bubbles: true, cancelable: true }),
  );
  await settle();
  assert.equal(sent.find((s) => s.action === "save").body.expectedVersion, 0);
  assert.equal(sent[0].action, "edit");
  assert.equal(sent[0].body.tasks[0].title, "Owner-edited builder");
  assert.ok(button("Prepare checks"));
  assert.equal(
    button("Run workflow"),
    undefined,
    "outcome cannot bypass preparation via ordinary Run",
  );
});

test("lost Accept response retains the original decision tuple across a newer result", async () => {
  await open(outcomeResultFixture(), outcomeWorkflowFixture());
  lost = true;
  button("Accept result").click();
  await settle();
  const first = sent.find((s) => s.action === "accept").body;
  outcome = { ...outcome, resultRevision: 2, version: 13, evidenceRevision: 4 };
  button("Retry retained accept request").click();
  await settle();
  assert.deepEqual(sent.filter((s) => s.action === "accept")[1].body, first);
  assert.equal(button("Accept result").disabled, true);
});

test("polling never silently rebases an unsaved contract over another owner edit", async () => {
  const initial = fresh();
  initial.contract = outcomeFixture();
  await open(initial);
  button("Edit goal").click();
  await settle();
  const form = dom.document.querySelector(".wf-outcome-editor");
  await replaceText(form.querySelector("textarea"), "Unsaved owner goal.");
  outcome = {
    ...outcome,
    version: 4,
    contractRevision: 2,
    contractDigest: uiDigest("b"),
    contract: { ...outcome.contract, goal: "Newer saved goal." },
  };
  await dom.waitFor(() => button("Review current revision"), 6000);
  form.dispatchEvent(
    new dom.window.Event("submit", { bubbles: true, cancelable: true }),
  );
  await settle();
  assert.equal(sent.find((s) => s.action === "save").body.expectedVersion, 3);
  assert.equal(outcome.contract.goal, "Newer saved goal.");
  assert.equal(form.querySelector("textarea").value, "Unsaved owner goal.");
  assert.ok(
    dom.document
      .querySelector('[role="alert"]')
      .textContent.includes("contract changed"),
  );
});
