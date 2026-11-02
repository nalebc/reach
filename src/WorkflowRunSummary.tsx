import { useEffect, useState } from "react";
import { LoaderCircle } from "lucide-react";
import { request, type Peer } from "./api";
import AgentMarkdown from "./AgentMarkdown";
import { agentLabel } from "./agent-sessions";
import type { Workflow, WorkflowTask } from "./Workflows";

const active = (t: WorkflowTask) => t.state === "starting" || t.state === "working";
const time = (at?: number) => at ? new Date(at).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "";

export function WorkflowRunSummary({ workflow: w, onSelect }: { workflow: Workflow; onSelect: (index: number) => void }) {
  const tasks = w.tasks.filter(t => t.selection !== "not_selected");
  const completed = tasks.filter(t => t.state === "done").length, skipped = tasks.filter(t => t.state === "skipped").length;
  const running = tasks.filter(active), waiting = tasks.filter(t => t.state === "waiting");
  const stopped = tasks.filter(t => t.state === "stopped" || t.state === "uncertain");
  const latest = w.tasks.reduce((last, t, i) => t.state === "done" && t.selection !== "not_selected" ? i : last, -1);
  const next = waiting[0];
  return <section className="wf-run-overview" aria-label="Workflow progress">
    <div aria-live="polite" aria-atomic="true">
      <h3>{w.state === "done" ? "Run completed" : w.state === "stopped" ? "Run stopped" : w.state === "paused" ? "Workflow paused" : "Workflow running"}</h3>
      <p className="wf-run-count">{completed + skipped} of {tasks.length} tasks finished</p>
      <progress aria-label="Workflow task progress" max={Math.max(1, tasks.length)} value={completed + skipped} />
      <p className="wf-run-breakdown">{completed} completed{skipped > 0 && ` · ${skipped} skipped`}{running.length > 0 && ` · ${running.length} running`}{waiting.length > 0 && ` · ${waiting.length} waiting`}{stopped.length > 0 && ` · ${stopped.length} stopped or uncertain`}</p>
    </div>
    {running.map(t => <button key={t.id} className="wf-run-current" onClick={() => onSelect(w.tasks.indexOf(t))}>
      <LoaderCircle size={16} className="spin" aria-hidden="true" /><span><strong>{t.state === "starting" ? "Starting" : "Now"}: {t.title || `Task ${w.tasks.indexOf(t) + 1}`}</strong><small>{agentLabel(t.agent)}{t.startedAt ? ` · started ${time(t.startedAt)}` : ""}</small></span>
    </button>)}
    {next && <p className="wf-run-next">{w.state === "stopped" ? "Not started" : w.state === "paused" ? "Waiting after this pause" : "Next"}: {next.title || `Task ${w.tasks.indexOf(next) + 1}`}</p>}
    {w.problem && <p className="wf-problem">{w.problem}</p>}
    {latest >= 0 && <button className="wf-pill" onClick={() => onSelect(latest)}>View latest task result</button>}
    {w.state === "done" && <p className="wf-run-note">{w.outcome ? "Task execution has finished. Checks and owner acceptance are shown separately below." : "Read each task’s report below for changes, checks and anything left to do. Completed tasks are agent reports, not independent verification."}</p>}
  </section>;
}

type TaskResult = {
  attempt?: number | null;
  attempts?: { attempt: number | null; current: boolean }[];
  omittedAttempts?: number;
  handoff?: { answer: string; files: string[]; diffs: string; source: string; truncated: boolean };
  result?: {
    summary: string; historyIncomplete: boolean; truncated: boolean;
    commands: { command: string; output: string; exitCode: number | null; status: string; truncated?: boolean }[];
    changes: { files: string; diff: string; truncated?: boolean }[];
  };
};

// Read only the retained attempt, never the latest turn of a chat that the
// owner may have continued. Keep claims distinct from provider records.
export function WorkflowTaskResult({ peer, workflowId, task }: { peer: Peer; workflowId: string; task: WorkflowTask }) {
  const [selected, setSelected] = useState("");
  const [data, setData] = useState<TaskResult | null>(null);
  const [problem, setProblem] = useState("");
  const [loading, setLoading] = useState(false);
  const [retry, setRetry] = useState(0);
  const available = task.resultAvailable || !!task.summary || !!task.resultAttempts?.length || ["done", "stopped", "uncertain"].includes(task.state);
  const digest = task.resultEvidence?.digest;
  useEffect(() => {
    let current = true;
    setData(null); setProblem(""); setLoading(!!available);
    if (available) void request<TaskResult>(peer, `/api/sessions/workflows/${encodeURIComponent(workflowId)}/tasks/${encodeURIComponent(task.id)}/result${selected ? `?attempt=${selected}` : ""}`)
      .then(value => { if (current) setData(value); }, () => { if (current) setProblem("The retained result could not be loaded. Open the task’s chat or retry."); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [peer.url, peer.token, workflowId, task.id, task.attempt, task.updatedAt, task.resultAvailable, digest, available, selected, retry]);
  const attempts = data?.attempts?.flatMap(a => a.attempt === null ? [] : [a.attempt]) || task.resultAttempts || [];
  const answer = data?.handoff?.answer || data?.result?.summary || (!selected ? task.summary : "") || "";
  const files = data?.handoff?.files || (!selected ? task.files : []) || [];
  const commands = data?.result?.commands || [], changes = data?.result?.changes || [];
  return <section className="wf-task-result" aria-label={`Result for ${task.title || "task"}`}>
    {attempts.length > 1 && <label className="wf-result-attempt">Task attempt<select aria-label="Task attempt" value={selected} onChange={event => setSelected(event.target.value)}>
      <option value="">Latest retained result</option>{attempts.map(attempt => <option key={attempt} value={attempt}>Attempt {attempt}</option>)}
    </select></label>}
    {data?.attempt != null && <p className="wf-run-note">Attempt {data.attempt}{data.attempt !== task.attempt && task.attempt ? " · earlier attempt" : ""}</p>}
    {active(task) && <p className="wf-run-note">This task is still {task.state === "starting" ? "starting" : "working"}. Open its chat to follow the live conversation.</p>}
    {loading && <p className="wf-meta" role="status"><LoaderCircle size={14} className="spin" />Loading retained result…</p>}
    {problem && <div className="wf-result-error" role="status"><p>{problem}</p><button className="wf-pill" onClick={() => setRetry(n => n + 1)}>Retry result</button></div>}
    {answer && <>
      <h4>Task report</h4>
      <p className="wf-run-note">{data?.handoff?.source === "owner_marked_done" ? "Reply retained when the owner marked this task done." : data?.handoff?.source === "legacy" ? "Retained reply from an earlier run." : "Retained agent reply"}</p>
      <div className="wf-report-text"><AgentMarkdown text={answer} /></div>
      {(!data || data.handoff?.truncated || !data.handoff && data.result?.truncated) && <p className="wf-run-note">This is a shortened retained report. The task’s chat may contain more context.</p>}
    </>}
    {!answer && !loading && available && !problem && <p className="wf-run-note">No reply was retained for this attempt. Open its chat to inspect what happened.</p>}
    {files.length > 0 && <details className="wf-result-details"><summary>Reported changed files · {files.length}</summary><ul>{files.map((file, i) => <li key={`${file}:${i}`}><code>{file}</code></li>)}</ul></details>}
    {data?.result?.historyIncomplete && <p className="wf-run-note">Original-turn history is incomplete. This report does not establish which checks passed.</p>}
    {!!data?.omittedAttempts && <p className="wf-run-note">{data.omittedAttempts} earlier attempt records are no longer retained.</p>}
    {!!commands.length && <details className="wf-result-details"><summary>Recorded commands · {commands.length}</summary><p className="wf-run-note">Provider records for this attempt; they are not independent checks.</p>{commands.map((command, i) => <div key={i} className="wf-recorded-command">
      <pre>{command.command}</pre><p>{command.exitCode === null ? "Exit code unavailable" : `Exit code ${command.exitCode}`}</p>{command.output && <pre>{command.output}</pre>}{command.truncated && <p className="wf-run-note">Recorded output shortened.</p>}
    </div>)}</details>}
    {(changes.length > 0 || data?.handoff?.diffs) && <details className="wf-result-details"><summary>Recorded changes</summary><p className="wf-run-note">Task-attributed excerpts, not the current contents of the folder.</p>{changes.length ? changes.map((change, i) => <div key={i}><strong>{change.files}</strong><pre>{change.diff}</pre>{change.truncated && <p className="wf-run-note">Recorded diff shortened.</p>}</div>) : <pre>{data?.handoff?.diffs}</pre>}</details>}
    {task.task && <details className="wf-result-details"><summary>Task instructions</summary><div className="wf-report-text"><AgentMarkdown text={task.task} /></div></details>}
  </section>;
}
