import { useEffect, useState } from "react";
import { Bot, ChevronDown, Loader2, Plus, X } from "lucide-react";
import { request, post, type Peer } from "./api";
import "./openclaw-agents.css";

const base = "/api/sessions/openclaw";
type Sub = { key: string; title: string; status: "running" | "waiting" | "recent" };
type Agent = {
  id: string;
  name: string;
  emoji: string;
  isDefault: boolean;
  model: string;
  running: number;
  waiting: number;
  subagents: Sub[];
  recent: { key: string; title: string }[];
};
type Agents = { supported: boolean; agents?: Agent[]; canStopSubagents?: boolean };
type Entry = { pattern: string; lastUsedAt?: number };
type Policy = { security: string | null; ask: string | null; allowlist: Entry[] };
type Rules = {
  supported: boolean;
  hash?: string;
  all?: Policy;
  agents?: Record<string, Policy>;
  canEdit?: boolean;
};
// OpenClaw's names (exec-approvals.json), in short words.
const SECURITY: [string, string][] = [
  ["deny", "Deny"],
  ["allowlist", "Allowlist"],
  ["full", "Full"],
];
const ASK: [string, string][] = [
  ["off", "Off"],
  ["on-miss", "On miss"],
  ["always", "Always"],
];

// The Agents tab: every agent, what runs under it, approvals and rules.
export function ClawAgentsPanel({ peer, query, refresh }: { peer: Peer; query: string; refresh: number }) {
  const [data, setData] = useState<Agents | null>(null);
  const [error, setError] = useState("");
  const [open, setOpen] = useState("");
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        if (!document.hidden) {
          const result = await request<Agents>(peer, `${base}/agents`);
          if (!active) return;
          setData(result);
          setError("");
        }
      } catch (e) {
        if (active) setError((e as Error).message);
      }
      if (active) timer = setTimeout(load, 10000);
    };
    void load();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [peer, refresh]);
  const words = query.trim().toLowerCase();
  const agents = (data?.agents || []).filter((a) =>
    `${a.name} ${a.id} ${a.model}`.toLowerCase().includes(words),
  );
  if (data && !data.supported) return null;
  return (
    <section className="claw-panel claw-agents" aria-label="OpenClaw agents">
      {error && (
        <p className="claw-error" role="alert">
          {error}
        </p>
      )}
      {!data && !error && (
        <p className="claw-note" role="status">
          <Loader2 size={14} className="spin" />
          Loading agents…
        </p>
      )}
      {data && !agents.length && <p className="claw-empty">{words ? "No matches." : "No agents."}</p>}
      {agents.length > 0 && (
        <div className="claw-agents-group">
          {agents.map((a) => (
            <AgentRow
              key={a.id}
              agent={a}
              open={open === a.id}
              onToggle={() => setOpen(open === a.id ? "" : a.id)}
            />
          ))}
        </div>
      )}
      {data && (
        <ApprovalRules peer={peer} refresh={refresh} agents={data.agents || []} />
      )}
    </section>
  );
}

function AgentRow({ agent: a, open, onToggle }: { agent: Agent; open: boolean; onToggle: () => void }) {
  const subs = a.subagents.length;
  return (
    <div className={`claw-agents-item${open ? " open" : ""}`}>
      <button className="claw-agents-row" aria-expanded={open} onClick={onToggle}>
        <span className="claw-agents-avatar" aria-hidden="true">
          {a.emoji || <Bot size={17} />}
        </span>
        <span className="claw-agents-copy">
          <span className="claw-agents-title">{a.name}</span>
          {a.model && <span className="claw-agents-sub">{a.model}</span>}
        </span>
        <span className="claw-agents-pills">
          {a.running > 0 && <span className="claw-agents-pill running">{a.running} running</span>}
          {subs > 0 && <span className="claw-agents-pill">{subs} sub</span>}
          {a.waiting > 0 && <span className="claw-agents-pill waiting">{a.waiting} waiting</span>}
        </span>
        <ChevronDown size={16} className="claw-agents-chevron" aria-hidden="true" />
      </button>
      {open && (
        <div className="claw-agents-body">
          {subs > 0 && (
            <>
              <p className="claw-agents-label">Sub-agents</p>
              <ul className="claw-agents-list" aria-label={`${a.name} sub-agents`}>
                {a.subagents.map((s) => (
                  <li key={s.key}>
                    <span className="claw-agents-line">{s.title}</span>
                    <span className={`claw-agents-pill ${s.status}`}>
                      {s.status === "recent" ? "Recent" : s.status === "waiting" ? "Waiting" : "Running"}
                    </span>
                  </li>
                ))}
              </ul>
              {/* chat.abort can't stop runs OpenClaw's `agent` method started. */}
              <p className="claw-note">Stop sub-agents in OpenClaw.</p>
            </>
          )}
          <p className="claw-agents-label">Recent</p>
          {a.recent.length ? (
            <ul className="claw-agents-list" aria-label={`${a.name} recent chats`}>
              {a.recent.map((c) => (
                <li key={c.key}>
                  <span className="claw-agents-line">{c.title}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="claw-note">No chats yet.</p>
          )}
        </div>
      )}
    </div>
  );
}

function ApprovalRules({ peer, refresh, agents }: { peer: Peer; refresh: number; agents: Agent[] }) {
  const [rules, setRules] = useState<Rules | null>(null);
  const [problem, setProblem] = useState("");
  const [scope, setScope] = useState("*");
  const [busy, setBusy] = useState("");
  // Second tap confirms: a pattern to remove, or "full".
  const [confirm, setConfirm] = useState("");
  const [draft, setDraft] = useState("");
  const [loadedAt, setLoadedAt] = useState(0);
  useEffect(() => {
    let active = true;
    request<Rules>(peer, `${base}/agents/rules`)
      .then((r) => active && (setRules(r), setProblem("")))
      .catch((e) => active && setProblem((e as Error).message));
    return () => {
      active = false;
    };
  }, [peer, refresh, loadedAt]);
  useEffect(() => {
    if (!confirm) return;
    const timer = setTimeout(() => setConfirm(""), 4000);
    return () => clearTimeout(timer);
  }, [confirm]);
  if (!rules?.supported) return problem ? <p className="claw-error" role="alert">{problem}</p> : null;
  const policy: Policy =
    (scope === "*" ? rules.all : rules.agents?.[scope]) || { security: null, ask: null, allowlist: [] };
  const edit = !!rules.canEdit && !busy;
  const save = async (id: string, change: object) => {
    if (busy) return false;
    setBusy(id);
    setProblem("");
    setConfirm("");
    try {
      setRules(await post<Rules>(peer, `${base}/agents/rules`, { hash: rules.hash, scope, ...change }));
      return true;
    } catch (e) {
      setProblem((e as Error).message);
      // Changed elsewhere: show what's there now.
      if ((e as { status?: number }).status === 409) setLoadedAt(Date.now());
      return false;
    } finally {
      setBusy("");
    }
  };
  const pills = (field: "security" | "ask", options: [string, string][]) => (
    <div className="claw-agents-modes" role="group" aria-label={field === "security" ? "Security" : "Ask"}>
      {scope !== "*" && (
        <button aria-pressed={policy[field] === null} disabled={!edit} onClick={() => policy[field] !== null && void save(field, { [field]: null })}>
          Default
        </button>
      )}
      {options.map(([value, label]) => {
        const risky = field === "security" && value === "full" && policy.security !== "full";
        return (
          <button
            key={value}
            aria-pressed={policy[field] === value}
            disabled={!edit}
            className={risky && confirm === "full" ? "confirm" : undefined}
            onClick={() => {
              if (policy[field] === value) return;
              if (risky && confirm !== "full") return setConfirm("full");
              void save(field, { [field]: value });
            }}
          >
            {risky && confirm === "full" ? "Allow all?" : label}
          </button>
        );
      })}
    </div>
  );
  return (
    <div className="claw-agents-rules" aria-label="Approval rules" role="region">
      <h2 className="claw-agents-heading">
        Approval rules
        {busy && <Loader2 size={14} className="spin" />}
      </h2>
      <div className="claw-channels" role="group" aria-label="Rules for">
        {[["*", "All agents"], ...agents.map((a) => [a.id, a.name])].map(([id, name]) => (
          <button key={id} aria-pressed={scope === id} onClick={() => (setScope(id), setConfirm(""))}>
            {name}
          </button>
        ))}
      </div>
      <p className="claw-agents-label">Security</p>
      {pills("security", SECURITY)}
      <p className="claw-agents-label">Ask</p>
      {pills("ask", ASK)}
      <p className="claw-agents-label">Allowlist</p>
      <ul className="claw-agents-list claw-agents-allow" aria-label="Allowlist">
        {policy.allowlist.map((e) => (
          <li key={e.pattern}>
            <code className="claw-agents-line">{e.pattern}</code>
            {rules.canEdit && (
              <button
                className={`claw-agents-remove${confirm === e.pattern ? " confirm" : ""}`}
                aria-label={confirm === e.pattern ? `Confirm remove ${e.pattern}` : `Remove ${e.pattern}`}
                disabled={!edit}
                onClick={() =>
                  confirm === e.pattern ? void save("remove", { remove: e.pattern }) : setConfirm(e.pattern)
                }
              >
                {confirm === e.pattern ? "Remove" : <X size={14} />}
              </button>
            )}
          </li>
        ))}
        {!policy.allowlist.length && <li className="claw-agents-none">None</li>}
      </ul>
      {rules.canEdit && (
        <form
          className="claw-agents-add"
          onSubmit={async (event) => {
            event.preventDefault();
            if (draft.trim() && (await save("add", { add: draft.trim() }))) setDraft("");
          }}
        >
          <input
            aria-label="Program path"
            placeholder="/opt/homebrew/bin/rg"
            value={draft}
            maxLength={512}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            onChange={(e) => setDraft(e.target.value)}
          />
          <button type="submit" aria-label="Add to allowlist" disabled={!edit || !draft.trim()}>
            {busy === "add" ? <Loader2 size={15} className="spin" /> : <Plus size={15} />}
          </button>
        </form>
      )}
      {problem && (
        <p className="claw-error" role="alert">
          {problem}
        </p>
      )}
    </div>
  );
}
