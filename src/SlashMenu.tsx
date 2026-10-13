import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { LoaderCircle, X } from "lucide-react";
import { post, request, type Peer } from "./api";
import type { AgentName, AgentSession } from "./agent-sessions";
import "./slash-menu.css";

// "/" in a chat's composer, as each agent's own app offers it: the agent's
// own commands (Codex's skills too), filtered as you type, picked with a tap
// or with ↑↓ and Enter/Tab, Esc or a tap outside it (and the box) to close.
// The list comes from the agent on the Mac (server/agent-sessions/commands.mjs),
// never a list kept here.
// Claude Code runs a command as the message itself; Codex's own commands
// run in the chat on the Mac, and a skill goes with the message, as a chip.
export type SlashCommand = {
  name: string;
  title?: string;
  description: string;
  hint: string;
  group?: "skills";
  action?: "run" | "insert" | "model" | "new";
};
type Card = { title: string; rows: { label: string; value: string; resetsAt?: number }[]; empty?: string };
type Ran = { ok?: boolean; card?: Card; title?: string; session?: AgentSession };

// Per chat (its folder decides skills and the folder's own commands); asked
// again after a minute, so a new skill or an updated agent shows up.
const lists = new Map<string, { at: number; value: Promise<SlashCommand[]> }>();
export function chatCommands(peer: Peer, agent: AgentName, id: string) {
  const key = `${peer.url} ${agent} ${id}`;
  const kept = lists.get(key);
  if (kept && Date.now() - kept.at < 60000) return kept.value;
  const value = request<{ commands: SlashCommand[] }>(
    peer,
    `/api/sessions/commands?agent=${agent}&id=${encodeURIComponent(id)}`,
  ).then((r) => r.commands || []);
  lists.set(key, { at: Date.now(), value });
  value.catch(() => lists.delete(key));
  return value;
}
export const runSlashCommand = (peer: Peer, s: { agent: AgentName; id: string }, name: string, args = "") =>
  post<Ran>(peer, `/api/sessions/${s.agent}/${encodeURIComponent(s.id)}/commands`, { name, args });

// What's typed so far while the box holds only "/word" (no space yet).
export const slashQuery = (text: string) => /^\/([^\s/]*)$/.exec(text)?.[1] ?? null;

// Matching commands: names starting with what's typed first, then the rest
// that contain it (in a name or, for Codex, its title).
export function matchCommands(list: SlashCommand[], query: string) {
  const q = query.toLowerCase();
  const starts: SlashCommand[] = [];
  const contains: SlashCommand[] = [];
  for (const c of list) {
    const name = c.name.toLowerCase();
    const title = (c.title || "").toLowerCase();
    if (name.startsWith(q) || title.startsWith(q)) starts.push(c);
    else if (q && (name.includes(q) || title.includes(q))) contains.push(c);
  }
  return [...starts, ...contains];
}

// "/name args" naming a listed command (not a skill): send may do it
// instead of sending the text (Codex's own commands, a new chat, the model).
export function slashIntent(text: string, list: SlashCommand[] | null) {
  const m = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!m || !list) return null;
  const command = list.find((c) => c.name === m[1] && !c.group);
  return command ? { command, args: (m[2] || "").trim() } : null;
}

const resetLabel = (ms: number) => {
  const at = new Date(ms);
  const sameDay = at.toDateString() === new Date().toDateString();
  return `resets ${sameDay ? "" : `${at.toLocaleDateString([], { weekday: "short" })} `}${at.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
};

export function useSlashMenu({
  peer,
  session,
  text,
  setText,
  field,
  focus,
  onModel,
  onNew,
  onOpen,
  onDone,
}: {
  peer: Peer;
  session: { agent: AgentName; id: string };
  text: string;
  setText: (text: string) => void;
  field: RefObject<HTMLTextAreaElement | null>;
  focus: () => void;
  onModel: () => void;
  onNew?: () => void;
  onOpen: (s: AgentSession) => void;
  onDone: () => void;
}) {
  const { agent, id } = session;
  // Gemini CLI chats are read-only here: nothing to run.
  const enabled = agent === "codex" || agent === "claude";
  const [commands, setCommands] = useState<SlashCommand[] | null>(null);
  const [active, setActive] = useState(0);
  const [closedAt, setClosedAt] = useState<string | null>(null);
  const [busy, setBusy] = useState("");
  const [result, setResult] = useState<{ name: string; card?: Card; error?: string } | null>(null);
  // A Codex skill picked from the menu: it goes with the next message.
  const [skill, setSkill] = useState<SlashCommand | null>(null);
  // A "/word" no command answers to, already pointed out once: sent as typed.
  const warned = useRef("");
  const list = useRef<HTMLDivElement>(null);
  const query = enabled ? slashQuery(text) : null;
  useEffect(() => {
    setCommands(null);
    setSkill(null);
    setResult(null);
  }, [agent, id]);
  // Asked for once the box starts with "/" (a pasted "/status" runs too).
  const wanted = enabled && text.startsWith("/");
  useEffect(() => {
    if (wanted && !commands) chatCommands(peer, agent, id).then(setCommands, () => setCommands([]));
  }, [wanted, commands, agent, id]);
  const matches = useMemo(() => (query === null || !commands ? [] : matchCommands(commands, query)), [query, commands]);
  const open = query !== null && closedAt !== text && (commands === null || matches.length > 0);
  // A phone has no Esc: a tap anywhere but the menu or the box closes it,
  // until the next letter typed.
  useEffect(() => {
    if (!open) return;
    const outside = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (target && (list.current?.contains(target) || field.current?.contains(target))) return;
      setClosedAt(text);
    };
    document.addEventListener("pointerdown", outside, true);
    return () => document.removeEventListener("pointerdown", outside, true);
  }, [open, text]);
  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    list.current?.querySelector(".sm-active")?.scrollIntoView?.({ block: "nearest" });
  }, [active]);

  const run = async (c: SlashCommand, args = "") => {
    setText("");
    setBusy(c.name);
    setResult(null);
    try {
      const r = await runSlashCommand(peer, session, c.name, args);
      if (r.session) onOpen(r.session);
      else if (r.card) setResult({ name: c.name, card: r.card });
      onDone();
    } catch (e) {
      setResult({ name: c.name, error: (e as Error).message });
    } finally {
      setBusy("");
    }
  };
  const pick = (c: SlashCommand) => {
    if (c.group === "skills") {
      setSkill(c);
      setText("");
    } else if (c.action === "run") void run(c);
    else if (c.action === "model") {
      setText("");
      onModel();
    } else if (c.action === "new") {
      setText("");
      onNew?.();
    } else setText(`/${c.name} `);
    focus();
  };
  return {
    agent,
    open,
    loading: open && commands === null,
    matches,
    active,
    setActive,
    pick,
    list,
    busy,
    result,
    dismiss: () => setResult(null),
    skill,
    clearSkill: () => setSkill(null),
    // Keys while the menu is open; true when the key was the menu's.
    onKeyDown(e: KeyboardEvent) {
      if (!open || !matches.length || e.nativeEvent.isComposing) return false;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        const step = e.key === "ArrowDown" ? 1 : -1;
        setActive((a) => (a + step + matches.length) % matches.length);
      } else if ((e.key === "Enter" && !e.shiftKey) || e.key === "Tab") pick(matches[Math.min(active, matches.length - 1)]);
      else if (e.key === "Escape") setClosedAt(text);
      else return false;
      e.preventDefault();
      return true;
    },
    // On send: one of Codex's own commands runs instead, "/clear" opens a
    // new chat (true); anything else is a message (with the picked skill).
    runOnSend(message: string) {
      const intent = slashIntent(message, commands);
      if (!intent) {
        // A typo'd command went to the agent as a message and used a turn:
        // said once; Send again sends it as typed ("/tmp is full" can be words).
        const name = /^\/([A-Za-z][\w:.-]*)(?:\s|$)/.exec(message.trim())?.[1];
        // An MCP server's prompt (/mcp__server__prompt) can come after the list.
        // Commands not loaded yet: hold this send once rather than spend a
        // turn on what may be a local command.
        if (name && commands === null && warned.current !== message) {
          warned.current = message;
          setResult({ name, error: "Still loading commands. Send again in a moment." });
          return true;
        }
        if (!name || name.startsWith("mcp__") || !commands?.length || commands.some((c) => c.name === name) || warned.current === message)
          return false;
        warned.current = message;
        const app = agent === "claude" ? "Claude Code" : "Codex";
        setResult({ name, error: `${app} has no /${name} command. Send again to send it as a message.` });
        return true;
      }
      const { command, args } = intent;
      if (command.action === "new" && onNew) {
        setText("");
        onNew();
        return true;
      }
      if (command.action === "model") {
        setText("");
        onModel();
        return true;
      }
      if (agent !== "codex" || (command.action !== "run" && command.action !== "insert")) return false;
      void run(command, args);
      return true;
    },
  };
}
export type SlashMenuState = ReturnType<typeof useSlashMenu>;

// The menu above the composer, drawn like the agent's own: Claude Code's
// "/name  hint  description" rows; the Codex app's titles with a Skills group.
export function SlashMenu({ menu }: { menu: SlashMenuState }) {
  const codex = menu.agent === "codex";
  return (
    <>
      {menu.open && (
        <div className="as-commands sm-menu" data-agent={menu.agent} role="listbox" aria-label="Commands" ref={menu.list}>
          {menu.loading && (
            <p className="sm-loading">
              <LoaderCircle size={14} className="spin" /> Loading commands…
            </p>
          )}
          {menu.matches.slice(0, 80).map((c, i) => (
            <div key={`${c.group || ""}${c.name}`} className="sm-row">
              {codex && c.group === "skills" && menu.matches[i - 1]?.group !== "skills" && <p className="sm-group">Skills</p>}
              <button
                role="option"
                aria-selected={i === menu.active}
                className={i === menu.active ? "sm-active" : undefined}
                onPointerEnter={() => menu.setActive(i)}
                // Keep the keyboard up: the box keeps its focus.
                onPointerDown={(e) => e.preventDefault()}
                onClick={() => menu.pick(c)}
              >
                {codex ? <b className="sm-title">{c.title || c.name}</b> : <b>/{c.name}</b>}
                {c.hint && <code>{c.hint}</code>}
                <span>{c.description}</span>
              </button>
            </div>
          ))}
        </div>
      )}
      {menu.busy && (
        <p className="sm-busy">
          <LoaderCircle size={14} className="spin" /> Running /{menu.busy}…
        </p>
      )}
      {menu.result && (
        <div className="sm-card" role="status">
          <div className="sm-card-head">
            <b>{menu.result.card?.title || `/${menu.result.name}`}</b>
            <button aria-label="Close" onClick={menu.dismiss}>
              <X size={14} />
            </button>
          </div>
          {menu.result.error ? (
            <p className="sm-error">{menu.result.error}</p>
          ) : menu.result.card?.rows.length ? (
            <dl>
              {menu.result.card.rows.map((r, i) => (
                <div key={`${r.label}${i}`}>
                  <dt>{r.label}</dt>
                  <dd>
                    {r.value}
                    {r.resetsAt ? <small> · {resetLabel(r.resetsAt)}</small> : null}
                  </dd>
                </div>
              ))}
            </dl>
          ) : (
            <p>{menu.result.card?.empty || "Nothing to show."}</p>
          )}
        </div>
      )}
    </>
  );
}

// A picked Codex skill, in the box as the Codex app shows it.
export function SkillChip({ menu }: { menu: SlashMenuState }) {
  if (!menu.skill) return null;
  return (
    <span className="sm-chip">
      {menu.skill.title || menu.skill.name}
      <button aria-label={`Remove ${menu.skill.title || menu.skill.name}`} onClick={menu.clearSkill}>
        <X size={12} />
      </button>
    </span>
  );
}
