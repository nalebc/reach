// Synthetic run records shared by DOM and real-browser checks. No providers,
// Reach lifecycle, real files or owner data are involved.
export const workflowRunFixture = (state = 'done') => ({
  id: 'wf-run', title: 'Repair synthetic app', cwd: '/work/fixture', state,
  problem: '', createdAt: 1000, updatedAt: 4000,
  tasks: [
    { id: 'build', title: 'Repair calculation', task: 'Repair the synthetic total.', agent: 'codex', kind: 'build', together: false,
      state: 'done', chat: { agent: 'codex', id: 'build-chat' }, startedAt: 1000, updatedAt: 2000,
      summary: 'The seeded total is repaired.', files: ['src/total.mjs'], attempt: 1, resultAvailable: true, resultAttempts: [1] },
    { id: 'review', title: 'Review calculation', task: 'Review the repair.', agent: 'claude', kind: 'review', together: false,
      state: state === 'running' ? 'working' : 'done', chat: { agent: 'claude', id: 'review-chat' }, startedAt: 2000, updatedAt: 3000,
      summary: state === 'running' ? undefined : 'The recorded review found no further changes.',
      attempt: 2, resultAvailable: state !== 'running', resultAttempts: state === 'running' ? [] : [1, 2] },
    { id: 'docs', title: 'Optional notes', task: 'Record notes if necessary.', agent: 'codex', kind: 'review', together: false,
      state: state === 'running' ? 'waiting' : 'skipped', updatedAt: 4000 },
  ],
});

export const retainedReply = `The synthetic total now adds both inputs correctly. ${'The change stays within the requested calculation. '.repeat(9)}

The final paragraph is retained beyond the old short preview. Read the recorded checks before deciding whether further work is needed.

<script>window.workflowInjected = true</script>`;

export const workflowTaskResultFixture = (task = 'review', attempt = 2) => ({
  attempt, attempts: [{ attempt: 1, current: attempt === 1 }, ...(task === 'review' ? [{ attempt: 2, current: attempt === 2 }] : [])],
  source: 'provider_reported', omittedAttempts: 0,
  handoff: { answer: attempt === 1 && task === 'review' ? 'The earlier review requested a missing check.' : retainedReply,
    files: task === 'build' ? ['src/total.mjs'] : [], diffs: task === 'build' ? '-return a - b;\n+return a + b;' : '', source: 'task_reply', truncated: false },
  result: { schemaVersion: 1, evidenceDigest: `sha256:${'a'.repeat(64)}`, evidenceVersion: 1,
    evidenceFrozen: true, collectedAt: 3000, provenance: { workflowId: 'wf-run', taskId: task, attempt, provider: task === 'build' ? 'codex' : 'claude' },
    summary: 'Agent-reported completion.', progress: [], historyIncomplete: false, truncated: false, unknowns: [],
    commands: [{ command: 'node synthetic-check.mjs', output: 'Synthetic arithmetic check passed. <img src=x onerror=window.workflowInjected=true>', status: 'completed', exitCode: 0, outputCompleteness: 'complete', truncated: false }],
    changes: task === 'build' ? [{ files: 'src/total.mjs', diff: '-return a - b;\n+return a + b;', truncated: false }] : [],
  },
});
