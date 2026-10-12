import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowDown, ArrowUp, Check, ChevronDown, ChevronRight, Eye, Hammer, ListChecks, Loader2, Pause, Plus, RotateCcw, Search, SkipForward, Trash2, Workflow as WorkflowIcon, Wrench } from "lucide-react";
import { post, request, type Peer } from "./api";
import ChatSheet from "./ChatSheet";
import { AgentLogo, type AgentLogos } from "./agent-logos";
import { agentLabel, projectName } from "./agent-sessions";
import "./workflows.css";

// Workflows (docs/WORKFLOWS.md; server/agent-sessions/workflows.mjs): a plan
// of tasks for one folder, each Codex's or Claude Code's, a build or a
// review, run in order by the Mac. Written here or drafted by a planner
// chat, saved as you edit; nothing runs until Run. Laid out as ChatGPT lays
// out its lists: clear task rows, labeled editing controls, and an explicit
// choice between making changes and reviewing only.

type ChatRef = { agent: string; id: string; title?: string };
export type WorkflowTaskState = "waiting" | "starting" | "working" | "done" | "stopped" | "skipped" | "uncertain";
export type WorkflowTask = {
  id: string;
  title: string;
  agent: string;
  kind: "build" | "review";
  together: boolean;
  // What to do (a workflow read in full; the chat list's copy leaves it out).
  task?: string;
  state: WorkflowTaskState;
  chat?: ChatRef;
  // Its earlier chats, each try's (newest last).
  tries?: ChatRef[];
  problem?: string;
  // What it finished with, in brief, and the files it changed.
  summary?: string;
  files?: string[];
  startedAt?: number;
  updatedAt?: number;
};
export type Workflow = {
  id: string;
  state: "draft" | "running" | "paused" | "done" | "stopped";
  title: string;
  cwd: string;
  problem: string;
  createdAt: number;
  updatedAt: number;
  planner?: { agent: string; id: string; title: string; working: boolean; problem?: string };
  edited?: boolean;
  // The planner's newer plan, when you'd edited since its last one.
  proposal?: { title: string; tasks: TaskDraft[] };
  tasks: WorkflowTask[];
};
// A task as the editor holds it (with its id once the Mac has it).
export type TaskDraft = { id?: string; key?: string; title: string; agent: string; kind: "build" | "review"; task: string; together: boolean };

const BASE = "/api/sessions/workflows";
const at = (id: string, rest = "") => `${BASE}/${encodeURIComponent(id)}${rest}`;
// "key" only keeps a new row's identity on this screen; the Mac never sees it.
const bare = (tasks?: TaskDraft[]) => tasks?.map(({ key: _key, ...rest }) => rest);
export const createWorkflow = (peer: Peer, body: { title?: string; cwd: string; tasks?: TaskDraft[] }) =>
  post<{ workflow: Workflow }>(peer, BASE, body.tasks ? { ...body, tasks: bare(body.tasks) } : body);
export const planWorkflow = (
  peer: Peer,
  body: { agent: string; cwd: string; text: string; images?: string[]; model?: string; effort?: string; speed?: string },
) => post<{ workflow: Workflow; threadId: string }>(peer, `${BASE}/plan`, body);
const editWorkflow = (peer: Peer, id: string, body: { title?: string; tasks?: TaskDraft[] }) =>
  post<{ workflow: Workflow }>(peer, at(id), body.tasks ? { ...body, tasks: bare(body.tasks) } : body);
type Action = "run" | "stop" | "resume" | "proposal" | "again" | "remove";
const workflowAction = (peer: Peer, id: string, action: Action) =>
  post<{ workflow?: Workflow; stopped?: boolean; removed?: boolean }>(peer, at(id, `/${action}`));
const taskAction = (peer: Peer, id: string, task: string, action: "retry" | "skip" | "done") =>
  post<{ workflow: Workflow }>(peer, at(id, `/tasks/${encodeURIComponent(task)}/${action}`));

const MAX_TASKS = 20;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const finished = (s?: WorkflowTaskState) => s === "done" || s === "skipped";
const troubled = (s?: WorkflowTaskState) => s === "stopped" || s === "uncertain";
const atWork = (s?: WorkflowTaskState) => s === "working" || s === "starting";
const named = (title: string, n: number) => title.trim() || `Task ${n}`;
// Tasks in steps: one that starts with the one above joins its step.
function stepsOf<T extends { together: boolean }>(tasks: T[]) {
  const out: { n: number; rows: { task: T; i: number }[] }[] = [];
  tasks.forEach((task, i) => (i > 0 && task.together && out.length ? out.at(-1)!.rows.push({ task, i }) : out.push({ n: out.length + 1, rows: [{ task, i }] })));
  return out;
}

// Where a workflow stands, in a few words.
export function workflowLine(w: Workflow) {
  const n = w.tasks.length;
  const done = w.tasks.filter((t) => finished(t.state)).length;
  if (w.state === "draft") return w.planner?.working && !n ? "Planning…" : plural(n, "task");
  if (w.state === "running") return `Running · ${done} of ${n}`;
  if (w.state === "paused") return `Paused · ${done} of ${n}`;
  if (w.state === "done") return `Done · ${plural(n, "task")}`;
  return `Stopped · ${done} of ${n}`;
}
// A task in words (what a screen reader says for its row).
function taskLine(t: { agent: string; kind: string; together: boolean; state?: WorkflowTaskState; files?: string[] }, n: number) {
  if (!t.state || (t.state === "waiting" && !n)) return `${agentLabel(t.agent)} · ${t.kind === "review" ? "Review only" : "Make changes"}${t.together && n > 1 ? " · with previous" : ""}`;
  if (t.state === "waiting") return `${agentLabel(t.agent)} · Waiting`;
  if (t.state === "starting") return "Starting…";
  if (t.state === "working") return t.kind === "review" ? "Reviewing…" : "Working…";
  if (t.state === "done") return t.files?.length ? `Done · ${plural(t.files.length, "file")}` : "Done";
  if (t.state === "skipped") return "Skipped";
  if (t.state === "uncertain") return "Check its chat";
  return "Stopped";
}
// The word at the right of its row.
function taskValue(t: { kind: string; state?: WorkflowTaskState }) {
  if (!t.state) return t.kind === "review" ? "Review only" : "Make changes";
  if (atWork(t.state))
    return (
      <>
        <Loader2 size={13} className="spin" /> {t.kind === "review" ? "Reviewing" : "Working"}
      </>
    );
  return { waiting: "Waiting", done: "Done", skipped: "Skipped", stopped: "Stopped", uncertain: "Check" }[t.state] || "";
}

// One workflow as the Mac has it: read when it opens, when its line in the
// chat list changes (stamp), and every few seconds while it shows. What an
// action answers is the newest there is; a read sent before it is dropped.
function useWorkflow(peer: Peer, id: string, stamp?: number, first?: Workflow | null) {
  const [workflow, setWorkflow] = useState<Workflow | null>(first && first.id === id ? first : null);
  const [failure, setFailure] = useState("");
  const version = useRef("");
  const seq = useRef(0);
  const load = useRef(async () => {});
  load.current = async () => {
    if (document.hidden) return;
    const mine = ++seq.current;
    try {
      const r = await request<(Workflow & { version: string }) | { unchanged: true; version: string }>(
        peer,
        at(id, version.current ? `?known=${encodeURIComponent(version.current)}` : ""),
      );
      if (mine !== seq.current) return;
      setFailure("");
      if ("unchanged" in r) return;
      version.current = r.version;
      setWorkflow(r);
    } catch (e) {
      if (mine === seq.current) setFailure((e as Error).message);
    }
  };
  useEffect(() => {
    version.current = "";
    void load.current();
    const timer = setInterval(() => void load.current(), 4000);
    const shown = () => void load.current();
    document.addEventListener("visibilitychange", shown);
    return () => {
      seq.current++;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", shown);
    };
  }, [peer.url, peer.token, id]);
  useEffect(() => {
    if (stamp) void load.current();
  }, [stamp]);
  const take = (w: Workflow) => {
    seq.current++;
    version.current = "";
    setWorkflow(w);
  };
  return { workflow, failure, take };
}

const toDraft = ({ id, title, agent, kind, task, together }: WorkflowTask): TaskDraft => ({ id, title, agent, kind, task: task || "", together });
// The tasks that have started, and those before them, stay as they are.
const lockedCount = (w: Workflow) => (w.state === "draft" ? 0 : w.tasks.reduce((n, t, i) => (t.state !== "waiting" ? i + 1 : n), 0));

// Starting points for a draft with no tasks yet: the agents placed, what to
// build left for you to say. Codex and Claude Code take the code; OpenClaw,
// when it's here, the cheap research first.
function starters(agents: string[]) {
  if (!agents.length) return [];
  const coders = agents.filter((x) => x !== "openclaw");
  const a = coders[0] || agents[0] || "codex";
  const b = coders.find((x) => x !== a) || a;
  const task = (agent: string, kind: "build" | "review", title: string, words = "", together = false): TaskDraft => ({ title, agent, kind, task: words, together });
  return [
    ...(agents.includes("openclaw")
      ? [
          {
            key: "research",
            icon: <Search size={18} />,
            title: "Research, then build",
            line: `${agentLabel("openclaw")} researches · ${agentLabel(a)} builds`,
            tasks: [task("openclaw", "build", "Research"), task(a, "build", "Build", "Build it, using the research above.")],
          },
        ]
      : []),
    {
      key: "review",
      icon: <Hammer size={18} />,
      title: "Build, then review",
      line: `${agentLabel(a)} builds · ${agentLabel(b)} reviews`,
      tasks: [task(a, "build", "Build"), task(b, "review", "Review", "Review what the build changed.")],
    },
    {
      key: "fix",
      icon: <Wrench size={18} />,
      title: "Build, review, fix",
      line: `${agentLabel(b)} reviews · ${agentLabel(a)} fixes`,
      tasks: [task(a, "build", "Build"), task(b, "review", "Review", "Review what the build changed."), task(a, "build", "Fix", "Fix what the review found.")],
    },
    {
      key: "two",
      icon: <Eye size={18} />,
      title: "Two reviews",
      line: `${agentLabel(a)} and ${agentLabel(b)} together`,
      tasks: [task(a, "review", "Review"), task(b, "review", "Second review", "", true)],
    },
  ];
}

// One row of a step: the task's agent, its name, a word on the right; a tap
// opens what's under it. Open for editing, its name is the field itself.
function Row({
  n,
  task,
  logos,
  open,
  onToggle,
  title,
  children,
}: {
  n: number;
  task: { title: string; agent: string; kind: "build" | "review"; together: boolean; state?: WorkflowTaskState; files?: string[] };
  logos: AgentLogos;
  open: boolean;
  onToggle: () => void;
  // The name's field, when the open row edits it.
  title?: ReactNode;
  children?: ReactNode;
}) {
  const s = task.state;
  return (
    <div className={`wf-item ${s || "draft"} ${open ? "open" : ""}`}>
      {open && title ? (
        <div className="wf-item-main">
          <AgentLogo agent={task.agent} logos={logos} size={24} />
          <span className="wf-item-copy">{title}</span>
          <button className="wf-icon" aria-label={`Close task ${n}`} onClick={onToggle}>
            <ChevronDown size={18} />
          </button>
        </div>
      ) : (
        <button className="wf-item-main" aria-expanded={open} aria-label={`Task ${n}: ${named(task.title, n)}, ${taskLine(task, n)}`} onClick={onToggle}>
          <AgentLogo agent={task.agent} logos={logos} size={24} />
          <span className="wf-item-copy">
            <span className="wf-item-title">{named(task.title, n)}</span>
            <span className="wf-item-detail">{agentLabel(task.agent)} · {task.kind === "review" ? "Review only" : "Make changes"}</span>
          </span>
          {s && <span className={`wf-item-value ${s}`}>{taskValue(task)}</span>}
          {open ? <ChevronDown size={18} className="wf-item-chevron" aria-hidden="true" /> : <ChevronRight size={18} className="wf-item-chevron" aria-hidden="true" />}
        </button>
      )}
      {open && children && <div className="wf-item-body">{children}</div>}
    </div>
  );
}

// The steps: a labelled, rounded section each, its tasks as rows.
function Steps<T extends { together: boolean }>({ tasks, row }: { tasks: T[]; row: (task: T, i: number) => ReactNode }) {
  return (
    <>
      {stepsOf(tasks).map((step) => (
        <section key={step.n} className="wf-step" aria-label={`Step ${step.n}`}>
          <h3 className="wf-label">
            Step {step.n}
            {step.rows.length > 1 && " · together"}
          </h3>
          <div className="wf-group">{step.rows.map(({ task, i }) => row(task, i))}</div>
        </section>
      ))}
    </>
  );
}

// Instructions stay behind a preview until explicitly opened.
function TaskInstructions({ value, n, review, onChange }: { value: string; n: number; review: boolean; onChange: (text: string) => void }) {
  const [expanded, setExpanded] = useState(false);
  const fieldId = `workflow-instructions-${n}`;
  return <div className="wf-instructions">
    <button type="button" className="wf-instructions-toggle" aria-expanded={expanded}
      aria-controls={fieldId} aria-label={`${expanded ? "Hide" : "Show"} task ${n} instructions`}
      onClick={() => setExpanded(!expanded)}>
      <span>Instructions</span><span>{expanded ? "Hide" : "Edit"} <ChevronDown size={16} aria-hidden="true" /></span>
    </button>
    {expanded ? <textarea id={fieldId} className="wf-edit-text" rows={6} value={value}
      placeholder={review ? "What should the agent check?" : "What should the agent do?"}
      aria-label={`Task ${n}: what to do`} onChange={(e) => onChange(e.target.value)} />
      : <button id={fieldId} type="button" className="wf-instructions-preview"
        aria-label={`Edit task ${n} instructions`} onClick={() => setExpanded(true)}>
        {value || "Add instructions…"}
      </button>}
  </div>;
}

// Editing: the tasks still to start, with instructions, an agent picker,
// task mode, scheduling, and ordering controls. Saved a moment
// after each change; started tasks stay as they are, above.
function Editor({
  peer,
  workflow,
  agents,
  logos,
  onSaved,
  children,
}: {
  peer: Peer;
  workflow: Workflow;
  agents: string[];
  logos: AgentLogos;
  onSaved: (w: Workflow) => void;
  // What goes under it, given a way to save first and to rename.
  children: (flush: () => Promise<boolean>, saving: boolean, rename: () => void) => ReactNode;
}) {
  const locked = lockedCount(workflow);
  const [title, setTitle] = useState(workflow.title);
  const [tasks, setTasks] = useState<TaskDraft[]>(() => workflow.tasks.slice(locked).map(toDraft));
  // The open task: a new draft's first, while it has no words yet.
  const [open, setOpen] = useState(() => (workflow.tasks.length && !workflow.tasks.some((t) => t.task) ? locked : -1));
  const [renaming, setRenaming] = useState(false);
  const latest = useRef({ title, tasks, workflow });
  latest.current = { title, tasks, workflow };
  // Changes made here, and how many of them the Mac has.
  const edits = useRef(0);
  const newKeys = useRef(0);
  const saved = useRef(0);
  // The workflow as this editor's own last save left it.
  const ours = useRef(0);
  const [saving, setSaving] = useState(false);
  const pendingSave = useRef<Promise<boolean> | null>(null);
  const [problem, setProblem] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // The Mac's copy, when nothing here waits to be saved: a planner's plan
  // arriving, a task starting. Your own save coming back only names new tasks.
  useEffect(() => {
    if (edits.current !== saved.current) return;
    // A copy older than this editor's own last save (its effect ran late,
    // after a newer save came back) is never put over the newer edits.
    if (workflow.updatedAt < ours.current) return;
    const theirs = workflow.tasks.slice(lockedCount(workflow)).map(toDraft);
    if (workflow.updatedAt === ours.current) {
      setTasks((mine) => mine.map((t, i) => (t.id ? t : { ...t, id: theirs[i]?.id })));
      return;
    }
    setTitle(workflow.title);
    setTasks(theirs);
  }, [workflow.updatedAt, workflow.state]);
  const save = async (): Promise<boolean> => {
    clearTimeout(timer.current);
    if (pendingSave.current) {
      if (!(await pendingSave.current)) return false;
      return save();
    }
    const mark = edits.current;
    if (mark === saved.current) return true;
    const { title, tasks, workflow: w } = latest.current;
    // Running, a new task goes in once it says what to do (it could start at once).
    if (w.state !== "draft" && tasks.some((t) => !t.task.trim())) {
      setProblem("Say what each new task should do.");
      return false;
    }
    const lockedNow = w.tasks.slice(0, lockedCount(w));
    const gone = new Set(lockedNow.map((t) => t.id));
    setSaving(true);
    const pending = (async () => {
      try {
        const r = await editWorkflow(peer, w.id, { title, tasks: [...lockedNow.map(toDraft), ...tasks.filter((t) => !t.id || !gone.has(t.id))] });
        saved.current = mark;
        setProblem("");
        ours.current = r.workflow.updatedAt;
        onSaved(r.workflow);
        return true;
      } catch (e) {
        setProblem((e as Error).message);
        return false;
      }
    })();
    pendingSave.current = pending;
    const ok = await pending;
    pendingSave.current = null;
    setSaving(false);
    if (ok && mark !== edits.current) schedule();
    return ok && mark === edits.current;
  };
  const schedule = () => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => void save(), 700);
  };
  // Closed with a change still to save: saved on the way out.
  useEffect(
    () => () => {
      clearTimeout(timer.current);
      if (edits.current !== saved.current) void save();
    },
    [],
  );
  const changeTasks = (next: TaskDraft[], show = open) => {
    edits.current++;
    setTasks(next.map((t) => (t.id || t.key ? t : { ...t, key: `k${++newKeys.current}` })));
    setOpen(show);
    schedule();
  };
  const change = (i: number, patch: Partial<TaskDraft>) => changeTasks(tasks.map((x, n) => (n === i ? { ...x, ...patch } : x)));
  const move = (i: number, by: number) => {
    const next = [...tasks];
    [next[i], next[i + by]] = [next[i + by], next[i]];
    changeTasks(next, locked + i + by);
  };
  const add = () =>
    changeTasks(
      [...tasks, { title: "", agent: agents.includes(tasks.at(-1)?.agent || "") ? tasks.at(-1)!.agent : agents[0], kind: "build", task: "", together: false }],
      locked + tasks.length,
    );
  const lockedTasks = workflow.tasks.slice(0, locked);
  const all: (WorkflowTask | TaskDraft)[] = [...lockedTasks, ...tasks];
  const empty = !all.length;
  return (
    <>
      {renaming && (
        <input
          className="wf-rename"
          autoFocus
          value={title}
          maxLength={80}
          placeholder="Workflow name"
          aria-label="Workflow name"
          onBlur={() => setRenaming(false)}
          onKeyDown={(e) => e.key === "Enter" && setRenaming(false)}
          onChange={(e) => {
            edits.current++;
            setTitle(e.target.value);
            schedule();
          }}
        />
      )}
      <Steps
        tasks={all}
        row={(t, index) => {
          const n = index + 1;
          if (index < locked) return <Row key={(t as WorkflowTask).id} n={n} task={t as WorkflowTask} logos={logos} open={false} onToggle={() => {}} />;
          const i = index - locked;
          const draft = t as TaskDraft;
          return (
            <Row
              key={draft.key || draft.id || `new:${i}`}
              n={n}
              task={draft}
              logos={logos}
              open={open === index}
              onToggle={() => setOpen(open === index ? -1 : index)}
              title={
                <label className="wf-title-field"><span>Task name</span><input
                  className="wf-edit-title"
                  value={draft.title}
                  maxLength={80}
                  placeholder={`Task ${n}`}
                  aria-label={`Task ${n} title`}
                  onChange={(e) => change(i, { title: e.target.value })}
                /></label>
              }
            >
              <label className="wf-agent-field">
                <span>Agent</span>
                <span className="wf-agent-select">
                  <AgentLogo agent={draft.agent} logos={logos} size={20} />
                  <select aria-label={`Task ${n} agent`} value={draft.agent}
                    onChange={(e) => change(i, { agent: e.target.value })}>
                    {[...new Set([draft.agent, ...agents])].map((agent) => <option key={agent} value={agent} disabled={!agents.includes(agent)}>{agentLabel(agent)}{!agents.includes(agent) ? " (unavailable)" : ""}</option>)}
                  </select>
                  <ChevronDown size={16} aria-hidden="true" />
                </span>
              </label>
              <fieldset className="wf-task-mode">
                <legend>Agent should…</legend>
                <div className="wf-mode-options">
                  <button type="button" aria-label="Make changes" aria-pressed={draft.kind === "build"} onClick={() => change(i, { kind: "build" })}>
                    <Hammer size={18} aria-hidden="true" />
                    <strong>Make changes</strong>
                    {draft.kind === "build" && <Check size={15} className="wf-mode-check" aria-hidden="true" />}
                  </button>
                  <button type="button" aria-label="Review only" aria-pressed={draft.kind === "review"} onClick={() => change(i, { kind: "review" })}>
                    <Eye size={18} aria-hidden="true" />
                    <strong>Review only</strong>
                    {draft.kind === "review" && <Check size={15} className="wf-mode-check" aria-hidden="true" />}
                  </button>
                </div>
                <p className="wf-mode-help">{draft.kind === "review"
                  ? "Inspect and report. No changes requested."
                  : draft.agent === "openclaw" ? "Carry out the task using its tools." : "Do the task and edit files as needed."}</p>
              </fieldset>
              {n > 1 && (
                <label className="wf-parallel">
                  <span><strong>Start with previous task</strong><small>Otherwise, wait for its result.</small></span>
                  <input type="checkbox" role="switch" checked={draft.together} aria-label={`Start task ${n} with the one above`} onChange={(e) => change(i, { together: e.target.checked })} />
                </label>
              )}
              <div className="wf-task-tools">
                <span>Task {n} of {all.length}</span>
                <span className="wf-chips-end">
                  <button className="wf-icon" aria-label={`Move task ${n} up`} disabled={i === 0} onClick={() => move(i, -1)}>
                    <ArrowUp size={16} />
                  </button>
                  <button className="wf-icon" aria-label={`Move task ${n} down`} disabled={i === tasks.length - 1} onClick={() => move(i, 1)}>
                    <ArrowDown size={16} />
                  </button>
                  <button className="wf-icon" aria-label={`Remove task ${n}`} onClick={() => changeTasks(tasks.filter((_, x) => x !== i), -1)}>
                    <Trash2 size={16} />
                  </button>
                </span>
              </div>
              <TaskInstructions value={draft.task} n={n} review={draft.kind === "review"} onChange={(task) => change(i, { task })} />
            </Row>
          );
        }}
      />
      {!agents.length && <p className="wf-problem">No agents are available. Connect or sign in to an agent to add tasks.</p>}
      {empty && workflow.state === "draft" && (
        <>
          <h3 className="wf-label">Start from</h3>
          {starters(agents).map((s) => (
            <button key={s.key} className="wf-dashed" onClick={() => changeTasks(s.tasks, 0)}>
              <span className="wf-dashed-icon" aria-hidden="true">
                {s.icon}
              </span>
              <span className="wf-dashed-copy">
                <strong>{s.title}</strong>
                <small>{s.line}</small>
              </span>
            </button>
          ))}
        </>
      )}
      <button className="wf-dashed add" disabled={!agents.length || all.length >= MAX_TASKS} onClick={add}>
        <span className="wf-dashed-icon" aria-hidden="true">
          <Plus size={18} />
        </span>
        <span className="wf-dashed-copy">
          <strong>{all.length >= MAX_TASKS ? `${MAX_TASKS} tasks at most` : empty ? "Empty task" : "Add task"}</strong>
        </span>
      </button>
      {problem && <p className="wf-problem">{problem}</p>}
      {children(save, saving, () => setRenaming(true))}
    </>
  );
}

// A workflow's page: its steps to edit while it's a draft, then the same
// steps as it runs; one main button for what's next.
export function WorkflowSheet({
  peer,
  id: first,
  initial = null,
  stamp,
  logos,
  agents = ["codex", "claude"],
  onOpenChat,
  onClose,
}: {
  peer: Peer;
  id: string;
  initial?: Workflow | null;
  // Its line in the chat list's copy changed: read it again.
  stamp?: number;
  logos: AgentLogos;
  // The agents that can take tasks here now.
  agents?: string[];
  onOpenChat: (chat: ChatRef) => void;
  onClose: () => void;
}) {
  const [id, setId] = useState(first);
  const { workflow, failure, take } = useWorkflow(peer, id, stamp, initial);
  const [busy, setBusy] = useState("");
  const [problem, setProblem] = useState("");
  const [asking, setAsking] = useState<"" | "stop" | "remove">("");
  const [editing, setEditing] = useState(false);
  const [open, setOpen] = useState<number | null>(null);
  const act = async (name: string, run: () => Promise<{ workflow?: Workflow }>) => {
    setBusy(name);
    setProblem("");
    try {
      const r = await run();
      if (r.workflow) take(r.workflow);
      return r;
    } catch (e) {
      setProblem((e as Error).message);
      return null;
    } finally {
      setBusy("");
    }
  };
  if (!workflow)
    return (
      <ChatSheet title="Workflow" className="workflow-sheet" onClose={onClose}>
        {failure ? (
          <p className="wf-problem">{failure}</p>
        ) : (
          <p className="wf-meta" role="status">
            <Loader2 size={14} className="spin" /> Loading…
          </p>
        )}
      </ChatSheet>
    );
  const w = workflow;
  const draft = w.state === "draft";
  const live = w.state === "running" || w.state === "paused";
  const stuck = w.tasks.some((t) => troubled(t.state));
  const planner = w.planner;
  // The row open as it runs: the one you opened, else a stopped one.
  const shown = open ?? w.tasks.findIndex((t) => troubled(t.state));
  const confirm = (question: string, yes: string, run: () => void) => (
    <div className="wf-confirm" role="group" aria-label={question}>
      <span>{question}</span>
      <button className="wf-pill" disabled={!!busy} onClick={() => setAsking("")}>
        Cancel
      </button>
      <button className="wf-pill danger" disabled={!!busy} onClick={run}>
        {busy ? <Loader2 size={14} className="spin" /> : yes}
      </button>
    </div>
  );
  const remove = () =>
    asking === "remove" ? (
      confirm(draft ? "Delete this draft?" : "Delete this workflow?", "Delete", () =>
        void act("remove", () => workflowAction(peer, w.id, "remove")).then((r) => r && onClose()),
      )
    ) : (
      <button className="wf-text-btn" disabled={!!busy} onClick={() => setAsking("remove")}>
        {draft ? "Delete draft" : "Delete"}
      </button>
    );
  return (
    <ChatSheet title={w.title || "Workflow"} className="workflow-sheet" onClose={onClose}>
      <p className="wf-meta">
        <span title={w.cwd}>{projectName(w.cwd)}</span>
        <span aria-hidden="true">·</span>
        <span>{workflowLine(w)}</span>
      </p>
      {draft && <p className="wf-plan-intro">Review, then run. Each step uses the previous results.</p>}
      {draft && planner && (
        <div className="wf-group wf-planner">
          <div className="wf-item-main">
            <AgentLogo agent={planner.agent} logos={logos} size={24} />
            <span className="wf-item-copy">
              <span className="wf-item-title">{planner.working ? "Planning…" : planner.problem ? "No plan in its reply" : `Planned by ${agentLabel(planner.agent)}`}</span>
            </span>
            {planner.working && <Loader2 size={15} className="spin wf-muted" aria-hidden="true" />}
            <button className="wf-action" onClick={() => onOpenChat({ agent: planner.agent, id: planner.id, title: planner.title })}>
              Open chat
            </button>
          </div>
        </div>
      )}
      {draft && planner?.problem && <p className="wf-problem">{planner.problem}</p>}
      {draft && w.proposal && (
        <div className="wf-group" role="status">
          <div className="wf-item-main">
            <span className="wf-item-copy">
              <span className="wf-item-title">New plan · {plural(w.proposal.tasks.length, "task")}</span>
            </span>
            <button className="wf-action" disabled={!!busy} onClick={() => void act("proposal", () => workflowAction(peer, w.id, "proposal"))}>
              Use it
            </button>
          </div>
        </div>
      )}
      {/* Paused by a task: its row says why. Otherwise (access, Reach paused), here. */}
      {w.state === "paused" && w.problem && !stuck && (
        <div className="wf-group wf-paused" role="status">
          <div className="wf-item-main">
            <Pause size={18} aria-hidden="true" />
            <span className="wf-item-copy">
              <span className="wf-item-title">{w.problem}</span>
            </span>
          </div>
        </div>
      )}
      {draft && planner?.working && !w.tasks.length ? (
        <section className="wf-step wf-skeleton" aria-label="Planning">
          <h3 className="wf-label">Steps</h3>
          <div className="wf-group">
            {[0, 1, 2].map((i) => (
              <div key={i} className="wf-item">
                <span className="wf-item-main">
                  <i className="wf-bone round" />
                  <i className="wf-bone" />
                </span>
              </div>
            ))}
          </div>
        </section>
      ) : draft || (live && editing) ? (
        <Editor key={w.id} peer={peer} workflow={w} agents={agents} logos={logos} onSaved={take}>
          {(flush, saving, rename) =>
            draft ? (
              <div className="wf-draft-actions">
                <p className="wf-save-note" role="status">{saving ? "Saving changes…" : "Changes save automatically"}</p>
                <button
                  className="wf-primary"
                  disabled={!!busy || saving || !w.tasks.length}
                  onClick={async () => {
                    if (await flush()) await act("run", () => workflowAction(peer, w.id, "run"));
                  }}
                >
                  {busy === "run" && <Loader2 size={16} className="spin" />} Run workflow
                </button>
                {problem && <p className="wf-problem">{problem}</p>}
                <div className="wf-quiet-row">
                  <button className="wf-text-btn" onClick={rename}>
                    Rename
                  </button>
                  {remove()}
                </div>
              </div>
            ) : (
              <button
                className="wf-primary"
                disabled={saving}
                onClick={async () => {
                  if (await flush()) setEditing(false);
                }}
              >
                Done
              </button>
            )
          }
        </Editor>
      ) : (
        <Steps
          tasks={w.tasks}
          row={(t, i) => (
            <Row key={t.id} n={i + 1} task={t} logos={logos} open={shown === i} onToggle={() => setOpen(shown === i ? -1 : i)}>
              {t.summary && <p className="wf-summary">{t.summary}</p>}
              {t.problem && <p className="wf-problem">{t.problem}</p>}
              <div className="wf-chips">
                {t.chat && (
                  <button className="wf-chip" onClick={() => onOpenChat(t.chat!)}>
                    Open chat
                  </button>
                )}
                {live && troubled(t.state) && (
                  <>
                    <button className="wf-chip" disabled={!!busy} onClick={() => void act("retry", () => taskAction(peer, w.id, t.id, "retry"))}>
                      <RotateCcw size={13} /> Retry
                    </button>
                    <button className="wf-chip" disabled={!!busy} onClick={() => void act("skip", () => taskAction(peer, w.id, t.id, "skip"))}>
                      <SkipForward size={13} /> Skip
                    </button>
                    {t.chat && (
                      <button
                        className="wf-chip"
                        disabled={!!busy}
                        aria-label={`Mark “${named(t.title, i + 1)}” done`}
                        onClick={() => void act("done", () => taskAction(peer, w.id, t.id, "done"))}
                      >
                        <Check size={13} /> Mark done
                      </button>
                    )}
                  </>
                )}
              </div>
            </Row>
          )}
        />
      )}
      {!draft && problem && <p className="wf-problem">{problem}</p>}
      {live &&
        !editing &&
        (asking === "stop" ? (
          confirm("Stop all tasks?", "Stop", () => void act("stop", () => workflowAction(peer, w.id, "stop")).then((r) => r && setAsking("")))
        ) : (
          <>
            {w.state === "paused" && !stuck && (
              <button className="wf-primary" disabled={!!busy} onClick={() => void act("resume", () => workflowAction(peer, w.id, "resume"))}>
                {busy === "resume" && <Loader2 size={16} className="spin" />} Continue
              </button>
            )}
            <div className="wf-footer">
              <button className="wf-pill" disabled={!!busy} onClick={() => setEditing(true)}>
                Edit
              </button>
              <button className="wf-pill" disabled={!!busy} onClick={() => setAsking("stop")}>
                Stop
              </button>
            </div>
          </>
        ))}
      {(w.state === "done" || w.state === "stopped") && (
        <>
          <button
            className="wf-primary"
            disabled={!!busy}
            onClick={async () => {
              const r = await act("again", () => workflowAction(peer, w.id, "again"));
              if (r?.workflow) {
                setOpen(null);
                setId(r.workflow.id);
              }
            }}
          >
            {busy === "again" ? <Loader2 size={16} className="spin" /> : <RotateCcw size={16} />} Run again
          </button>
          <div className="wf-quiet-row">{remove()}</div>
        </>
      )}
    </ChatSheet>
  );
}

// Workflows, as ChatGPT lists its scheduled tasks: Active, Drafts and Done,
// a row each (a word on the right) that opens its page, and a pill for a
// new one. Opened from the Workflows icon at the top of Chat.
export function WorkflowsPage({
  workflows,
  logos,
  onOpen,
  onNew,
  onNewChat,
  onClose,
}: {
  workflows: Workflow[];
  logos: AgentLogos;
  onOpen: (w: Workflow) => void;
  onNew: () => void;
  onNewChat?: () => void;
  onClose: () => void;
}) {
  const groups = {
    active: workflows.filter((w) => w.state === "running" || w.state === "paused"),
    draft: workflows.filter((w) => w.state === "draft"),
    done: workflows.filter((w) => w.state === "done" || w.state === "stopped"),
  };
  const [tab, setTab] = useState<keyof typeof groups>(() => (groups.active.length ? "active" : groups.draft.length ? "draft" : "done"));
  // Waiting on you first, then the newest.
  const shown = [...groups[tab]].sort((a, b) => Number(b.state === "paused") - Number(a.state === "paused") || b.updatedAt - a.updatedAt);
  return (
    <ChatSheet title="Workflows" className="workflow-sheet workflows-page" onClose={onClose}>
      <div className="wf-create-actions">
        {onNewChat && <button className="wf-primary wf-new-chat" onClick={onNewChat}><Plus size={18} /> New chat</button>}
        <button className="wf-primary" onClick={onNew}><Plus size={18} /> New workflow</button>
      </div>
      {workflows.length ? (
        <>
          <div className="wf-tabs" role="tablist" aria-label="Workflows to show">
            {(["active", "draft", "done"] as const).map((k) => (
              <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}>
                {{ active: "Active", draft: "Drafts", done: "Done" }[k]}
              </button>
            ))}
          </div>
          {shown.length ? (
            <div className="wf-group">
              {shown.map((w) => {
                const done = w.tasks.filter((t) => finished(t.state)).length;
                const value =
                  w.state === "running"
                    ? `${done} of ${w.tasks.length}`
                    : w.state === "draft"
                      ? w.planner?.working
                        ? "Planning…"
                        : plural(w.tasks.length, "task")
                      : { paused: "Paused", done: "Done", stopped: "Stopped" }[w.state];
                return (
                  <div key={w.id} className="wf-item">
                    <button className={`wf-item-main wf-flow ${w.state}`} aria-label={`${w.title || "Workflow"}, ${value}`} onClick={() => onOpen(w)}>
                      <span className="wf-flow-icon" aria-hidden="true">
                        {w.state === "running" ? (
                          <Loader2 size={16} className="spin" />
                        ) : w.state === "paused" ? (
                          <Pause size={16} />
                        ) : w.state === "done" ? (
                          <Check size={16} />
                        ) : w.planner?.working ? (
                          <AgentLogo agent={w.planner.agent} logos={logos} size={16} />
                        ) : (
                          <ListChecks size={16} />
                        )}
                      </span>
                      <span className="wf-item-copy">
                        <span className="wf-item-title">{w.title || "Workflow"}</span>
                      </span>
                      <span className="wf-item-value">{value}</span>
                      <ChevronRight size={18} className="wf-item-chevron" aria-hidden="true" />
                    </button>
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="wf-none">{{ active: "Nothing running", draft: "No drafts", done: "Nothing finished yet" }[tab]}</p>
          )}
        </>
      ) : (
        <div className="wf-empty">
          <span className="wf-empty-icon" aria-hidden="true">
            <WorkflowIcon size={20} />
          </span>
          <strong>Start your first workflow</strong>
          <p>Agents take turns on a plan you approve.</p>
        </div>
      )}
    </ChatSheet>
  );
}

// In New chat, with Workflow picked: one line on what happens, and the way
// to write the tasks yourself.
export function WorkflowIntro({
  peer,
  agent,
  cwd,
  title,
  disabled,
  onCreated,
}: {
  peer: Peer;
  agent: string;
  cwd: string;
  // A name from what's written so far.
  title: string;
  disabled?: boolean;
  onCreated: (w: Workflow) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const write = async () => {
    setBusy(true);
    setProblem("");
    try {
      onCreated((await createWorkflow(peer, { cwd, title: title.trim().split("\n")[0].slice(0, 80) })).workflow);
    } catch (e) {
      setProblem((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="wf-intro">
      <span>{agentLabel(agent)} drafts the tasks · you review first</span>
      <button className="wf-text-btn" disabled={disabled || busy || !cwd} onClick={() => void write()}>
        {busy && <Loader2 size={13} className="spin" />} Write tasks myself
      </button>
      {problem && <p className="wf-problem">{problem}</p>}
    </div>
  );
}
