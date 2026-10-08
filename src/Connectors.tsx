import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, ChevronRight, ExternalLink, Loader2, Plus, RefreshCw, Search, X } from "lucide-react";
import { post, request, type Peer } from "./api";
import { agentLabel } from "./agent-sessions";
import { AgentLogo, type AgentLogos } from "./agent-logos";
import { BRAND_MARKS } from "./brand-marks";
import { computerWord } from "./pause";
import { ErrorLine, Spinner } from "./ui";
import "./connectors.css";

export type ConnectorAgent = "claude" | "codex" | "gemini";
type State = "connected" | "needs-auth" | "failed" | "off" | "added" | "available";
type Native = {
  id: string;
  name: string;
  state: State;
  detail?: string | null;
  description?: string | null;
  enabled?: boolean;
  connectUrl?: string | null;
  logo?: string | null;
};
type Server = { name: string; url: string | null; remote: boolean; state: State; logo?: string | null };
type CatalogEntry = { id: string; name: string; description: string; url: string; auth: "token" | "oauth"; tokenUrl?: string };
type AgentConnectors = {
  agent: ConnectorAgent;
  installed: boolean;
  native: Native[];
  servers: Server[];
  manageUrl: string | null;
  catalog: CatalogEntry[];
  signIn?: boolean;
};
type LoginView = { state: "idle" | "starting" | "link" | "checking" | "done" | "failed" | "cancelled"; url: string | null; error: string | null };
type AddResult = { name: string; results: { agent: ConnectorAgent; ok: boolean; error?: string }[] };

// One agent's side of a service: a server in its settings, one of the
// claude.ai account's connectors, or one of ChatGPT's apps (Codex).
type Cell =
  | { kind: "server"; name: string; state: State; remote: boolean }
  | { kind: "native"; name: string; state: State }
  | { kind: "app"; id: string; state: State; enabled: boolean; connectUrl: string | null };
// A service (GitHub, Linear, …) across the agents.
export type Item = {
  key: string;
  name: string;
  detail: string | null;
  entry: CatalogEntry | null;
  logo: string | null;
  cells: Partial<Record<ConnectorAgent, Cell>>;
};

const AGENTS: ConnectorAgent[] = ["claude", "codex", "gemini"];
const route = (path: string, params: Record<string, string>) => `${path}?${new URLSearchParams(params).toString()}`;
const keyOf = (name: string) => name.trim().toLowerCase();
const slugOf = (name: string) => name.toLowerCase().replace(/^claude\.ai\s+/, "").replace(/[^a-z0-9]/g, "");
const listed = (names: string[]) => (names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0] || "");
const usable = (c?: Cell) => !!c && (c.state === "connected" || c.state === "added");
const missing = (c?: Cell) => !c || c.state === "available";

// Every agent's connectors folded into one list of services: the catalog's,
// then whatever the agents already have, matched by name.
export function connectorItems(data: Partial<Record<ConnectorAgent, AgentConnectors>>): Item[] {
  const items = new Map<string, Item>();
  const catalog = AGENTS.map((a) => data[a]?.catalog).find(Boolean) || [];
  for (const entry of catalog)
    items.set(entry.id, { key: entry.id, name: entry.name, detail: entry.description, entry, logo: null, cells: {} });
  const find = (name: string) =>
    items.get(keyOf(name)) || [...items.values()].find((i) => keyOf(i.name) === keyOf(name) || slugOf(i.name) === slugOf(name));
  const item = (name: string, detail: string | null, logo?: string | null) => {
    const found = find(name);
    if (found) {
      found.logo ||= logo || null;
      return found;
    }
    const made: Item = { key: keyOf(name), name, detail, entry: null, logo: logo || null, cells: {} };
    items.set(made.key, made);
    return made;
  };
  for (const agent of AGENTS) {
    const info = data[agent];
    if (!info?.installed) continue;
    for (const n of info.native) {
      // ChatGPT's apps not linked yet count only for services listed here.
      if (n.state === "available" && !find(n.name)) continue;
      const it = item(n.name, n.description || null, n.logo);
      it.cells[agent] =
        agent === "codex"
          ? { kind: "app", id: n.id, state: n.state, enabled: n.enabled !== false, connectUrl: n.connectUrl || null }
          : { kind: "native", name: n.id, state: n.state };
    }
    for (const s of info.servers) {
      const it = item(s.name, s.url, s.logo);
      const had = it.cells[agent];
      if (!had || had.state === "available") it.cells[agent] = { kind: "server", name: s.name, state: s.state, remote: s.remote };
    }
  }
  return [...items.values()];
}

// The service's own mark (shipped with Reach), else the logo the computer
// fetched for it, else its first letter.
export function ConnectorLogo({ name, logo, size = 34 }: { name: string; logo?: string | null; size?: number }) {
  const mark = BRAND_MARKS[slugOf(name)];
  if (mark) {
    const rgb = parseInt(mark.hex, 16);
    const light = ((rgb >> 16) & 255) * 0.299 + ((rgb >> 8) & 255) * 0.587 + (rgb & 255) * 0.114 > 186;
    return (
      <span className="cn-logo" style={{ width: size, height: size, background: `#${mark.hex}` }} aria-hidden="true">
        <svg viewBox="0 0 24 24" width={size * 0.56} height={size * 0.56} fill={light ? "#111" : "#fff"}>
          <path d={mark.path} />
        </svg>
      </span>
    );
  }
  if (logo && /^data:image\//.test(logo))
    return (
      <span className="cn-logo image" style={{ width: size, height: size }} aria-hidden="true">
        <img src={logo} alt="" width={size * 0.64} height={size * 0.64} />
      </span>
    );
  return (
    <span className="cn-logo letter" style={{ width: size, height: size }} aria-hidden="true">
      {name.trim().slice(0, 1).toUpperCase() || "?"}
    </span>
  );
}

// Connectors: connect a service once and every agent on the computer can use
// it, each kept in that agent's own settings (so its app and terminal have it
// too). An agent with its own version (ChatGPT's GitHub app for Codex) keeps it.
export default function Connectors({ peer, logos }: { peer: Peer; logos: AgentLogos }) {
  const word = computerWord(peer.platform);
  const [data, setData] = useState<Partial<Record<ConnectorAgent, AgentConnectors>>>({});
  const [errors, setErrors] = useState<Partial<Record<ConnectorAgent, string>>>({});
  const [open, setOpen] = useState<string | null>(null);
  // Agents being signed in to a service, kept here: once connected, its row
  // moves to Connected (a new row), and the steps go on there.
  const [signing, setSigning] = useState<{ key: string; agents: ConnectorAgent[] } | null>(null);
  const [query, setQuery] = useState("");
  const [note, setNote] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  // Answers for a computer no longer shown are dropped.
  const generation = useRef(0);
  const load = (which: ConnectorAgent, fresh = false) => {
    const mine = generation.current;
    return request<AgentConnectors>(peer, route("/api/sessions/connectors", { agent: which, ...(fresh ? { fresh: "1" } : {}) }))
      .then((r) => {
        if (mine !== generation.current) return;
        setData((d) => ({ ...d, [which]: r }));
        setErrors((e) => ({ ...e, [which]: "" }));
      })
      .catch((e) => {
        if (mine === generation.current) setErrors((all) => ({ ...all, [which]: (e as Error).message }));
      });
  };
  const reload = async (which: ConnectorAgent[] = AGENTS, fresh = true) => {
    await Promise.all(which.map((a) => load(a, fresh)));
  };
  useEffect(() => {
    generation.current++;
    setData({});
    setErrors({});
    setOpen(null);
    setSigning(null);
    void reload(AGENTS, false);
  }, [peer.id, peer.url, peer.token]);
  const installed = AGENTS.filter((a) => data[a]?.installed);
  const checking = AGENTS.filter((a) => !data[a] && !errors[a]);
  const items = useMemo(() => connectorItems(data), [data]);
  const q = query.trim().toLowerCase();
  const shown = items.filter((i) => !q || i.name.toLowerCase().includes(q) || (i.detail || "").toLowerCase().includes(q));
  const connected = shown.filter((i) => installed.some((a) => !missing(i.cells[a]))).sort((a, b) => a.name.localeCompare(b.name));
  const available = shown.filter((i) => !connected.includes(i) && i.entry);

  const row = (it: Item) => (
    <Service
      key={it.key}
      peer={peer}
      word={word}
      logos={logos}
      item={it}
      agents={installed}
      data={data}
      open={open === it.key}
      onToggle={() => setOpen(open === it.key ? null : it.key)}
      onOpen={() => setOpen(it.key)}
      signing={signing?.key === it.key ? signing.agents : []}
      setSigning={(agents) => setSigning(agents.length ? { key: it.key, agents } : null)}
      onChanged={async (message, which) => {
        setNote(message);
        await reload(which);
      }}
    />
  );

  return (
    <div className="cn">
      <div className="cn-top">
        <p className="cn-intro">Connect a service once and {installed.length > 1 ? listed(installed.map(agentLabel)) : "your agents"} can all use it.</p>
        <span className="cn-agents">
          {installed.map((a) => (
            <AgentLogo key={a} agent={a} logos={logos} size={20} />
          ))}
          {checking.length > 0 && <Loader2 size={14} className="spin" aria-label="Checking agents" />}
          <button
            className="cn-icon-btn"
            aria-label="Check again"
            disabled={refreshing}
            onClick={async () => {
              setRefreshing(true);
              await reload();
              setRefreshing(false);
            }}
          >
            <RefreshCw size={15} className={refreshing ? "spin" : undefined} />
          </button>
        </span>
      </div>
      {installed.length > 0 && (
        <label className="cn-search">
          <Search size={15} aria-hidden="true" />
          <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search services" aria-label="Search services" />
          {query && (
            <button type="button" aria-label="Clear search" onClick={() => setQuery("")}>
              <X size={14} />
            </button>
          )}
        </label>
      )}
      {checking.length > 0 && !installed.length && <Spinner label="Looking for agents…" />}
      {!checking.length && !installed.length && (
        <p className="cn-empty">Claude Code, Codex or Gemini CLI isn't installed on this {word}. Set one up from Chat first.</p>
      )}
      {AGENTS.filter((a) => errors[a]).map((a) => (
        <ErrorLine key={a} error={`${agentLabel(a)}: ${errors[a]}`} />
      ))}
      {note && (
        <p className="cn-flash" role="status">
          <span>{note}</span>
          <button aria-label="Dismiss" onClick={() => setNote("")}>
            <X size={14} />
          </button>
        </p>
      )}
      {installed.length > 0 && (
        <>
          {connected.length > 0 && (
            <section className="cn-group" aria-label="Connected">
              <h2>Connected</h2>
              <ul className="cn-list">{connected.map(row)}</ul>
            </section>
          )}
          <section className="cn-group" aria-label="Add a service">
            <h2>{connected.length ? "Add more" : "Add a service"}</h2>
            <ul className="cn-list">
              {available.map(row)}
              {!q && (
                <CustomService
                  peer={peer}
                  word={word}
                  agents={installed}
                  open={open === "+custom"}
                  onToggle={() => setOpen(open === "+custom" ? null : "+custom")}
                  onAdded={async (message) => {
                    setOpen(null);
                    setNote(message);
                    await reload();
                  }}
                />
              )}
            </ul>
            {q.length >= 2 && data.codex?.installed && <AppSearch peer={peer} query={q} />}
            {q && !connected.length && !available.length && !data.codex?.installed && (
              <p className="cn-empty">Nothing by that name. Clear the search to add it by its address.</p>
            )}
          </section>
          <p className="cn-foot">
            New chats have them; one already open picks them up once restarted.
            {installed.map((a) =>
              data[a]?.manageUrl ? (
                <a key={a} href={data[a]!.manageUrl!} target="_blank" rel="noopener noreferrer">
                  {a === "claude" ? "More on claude.ai" : "All ChatGPT apps"} <ExternalLink size={11} />
                </a>
              ) : null,
            )}
          </p>
        </>
      )}
    </div>
  );
}

// What a service says at a glance: who has it, or what it waits for.
export function summary(item: Item, agents: ConnectorAgent[]) {
  const have = agents.filter((a) => usable(item.cells[a]));
  const needs = agents.filter((a) => item.cells[a]?.state === "needs-auth");
  const broken = agents.filter((a) => item.cells[a]?.state === "failed");
  if (needs.length) return { tone: "warn", text: `Sign in for ${listed(needs.map(agentLabel))}` };
  if (broken.length) return { tone: "bad", text: `Can't connect in ${listed(broken.map(agentLabel))}` };
  if (have.length && have.length === agents.length) return { tone: "ok", text: agents.length > 1 ? "All agents" : agentLabel(have[0]) };
  if (have.length) return { tone: "ok", text: listed(have.map(agentLabel)) };
  return { tone: "", text: item.detail || "" };
}

function Service({
  peer,
  word,
  logos,
  item,
  agents,
  data,
  open,
  onToggle,
  onOpen,
  signing,
  setSigning,
  onChanged,
}: {
  peer: Peer;
  word: string;
  logos: AgentLogos;
  item: Item;
  agents: ConnectorAgent[];
  data: Partial<Record<ConnectorAgent, AgentConnectors>>;
  open: boolean;
  onToggle: () => void;
  onOpen: () => void;
  // Agents being signed in, agent by agent, after connecting or when asked.
  signing: ConnectorAgent[];
  setSigning: (agents: ConnectorAgent[]) => void;
  onChanged: (message: string, which?: ConnectorAgent[]) => Promise<void>;
}) {
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const toAdd = item.entry ? agents.filter((a) => !item.cells[a]) : [];
  const anyUsed = agents.some((a) => !missing(item.cells[a]));
  const { tone, text } = summary(item, agents);
  const nameIn = (a: ConnectorAgent) => {
    const c = item.cells[a];
    return c && c.kind !== "app" ? c.name : null;
  };
  const needsSignIn = agents.filter((a) => item.cells[a]?.state === "needs-auth" && a !== "gemini" && data[a]?.signIn && nameIn(a));
  const act = async (key: string, work: () => Promise<void>) => {
    if (busy) return;
    setBusy(key);
    setError("");
    try {
      await work();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  };
  const removeAll = () =>
    act("remove", async () => {
      const servers = agents.filter((a) => {
        const c = item.cells[a];
        return c?.kind === "server" && c.remote;
      });
      if (!servers.length || !window.confirm(`Remove ${item.name} from ${listed(servers.map(agentLabel))}?`)) return;
      const failed: string[] = [];
      for (const a of servers) {
        const c = item.cells[a] as Extract<Cell, { kind: "server" }>;
        await request(peer, route("/api/sessions/connectors", { agent: a, name: c.name }), { method: "DELETE" }).catch((e) =>
          failed.push(`${agentLabel(a)}: ${(e as Error).message}`),
        );
      }
      await onChanged(failed.length ? failed.join(" ") : `${item.name} removed.`, servers);
    });
  const toggleApp = (cell: Extract<Cell, { kind: "app" }>) =>
    act("app", async () => {
      await post(peer, "/api/sessions/connectors/apps", { id: cell.id, enabled: !cell.enabled });
      await onChanged("", ["codex"]);
    });
  // The one thing to do now, on the row itself.
  const action = needsSignIn.length && !signing.length
    ? { label: "Sign in", tone: "warn", run: () => (onOpen(), setSigning(needsSignIn)) }
    : !anyUsed && toAdd.length && !open
      ? { label: "Connect", tone: "primary", run: onOpen }
      : null;

  return (
    <li className={`cn-item ${open ? "open" : ""}`}>
      <div className="cn-row">
        <button className="cn-row-main" aria-expanded={open} onClick={onToggle}>
          <ConnectorLogo name={item.name} logo={item.logo} />
          <span className="cn-text">
            <strong>{item.name}</strong>
            <small className={tone}>
              {tone === "ok" && <Check size={11} aria-hidden="true" />} {text}
            </small>
          </span>
          {!action && (open ? <ChevronDown size={15} className="cn-chev" /> : <ChevronRight size={15} className="cn-chev" />)}
        </button>
        {action && (
          <button className={`cn-btn ${action.tone}`} onClick={action.run}>
            {action.label}
          </button>
        )}
      </div>
      {open && (
        <div className="cn-detail">
          {anyUsed && (
            <ul className="cn-agent-list">
              {agents.map((a) => {
                const c = item.cells[a];
                return (
                  <li key={a}>
                    <AgentLogo agent={a} logos={logos} size={18} />
                    <span className="cn-agent-name">{agentLabel(a)}</span>
                    <span className={`cn-state ${c?.state || "missing"}`}>
                      {!c
                        ? "Not added"
                        : c.kind === "app"
                          ? c.state === "available"
                            ? "ChatGPT app · not connected"
                            : `ChatGPT app · ${c.enabled ? "on" : "off"}`
                          : c.state === "needs-auth"
                            ? "Needs sign-in"
                            : c.state === "failed"
                              ? "Can't connect"
                              : c.state === "off"
                                ? "Off"
                                : c.kind === "native"
                                  ? "From claude.ai"
                                  : "Connected"}
                    </span>
                    {c?.kind === "app" && c.state === "available" && c.connectUrl && (
                      <a className="cn-link" href={c.connectUrl} target="_blank" rel="noopener noreferrer">
                        Connect <ExternalLink size={11} />
                      </a>
                    )}
                    {c?.kind === "app" && c.state !== "available" && (
                      <button className="cn-link" disabled={!!busy} onClick={() => void toggleApp(c)}>
                        Turn {c.enabled ? "off" : "on"}
                      </button>
                    )}
                    {c?.state === "needs-auth" && a === "gemini" && nameIn(a) && (
                      <p className="cn-note">
                        Gemini CLI signs in itself: on your {word}, run <code>gemini</code>, then <code>/mcp auth {nameIn(a)}</code>.
                      </p>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          {signing.length > 0 && (
            <SignInSteps
              peer={peer}
              word={word}
              logos={logos}
              steps={signing.map((a) => ({ agent: a, name: nameIn(a) || item.entry?.id || item.key }))}
              onFinished={async () => {
                setSigning([]);
                await onChanged(`${item.name} is ready.`);
              }}
            />
          )}
          {!signing.length && toAdd.length > 0 && item.entry && (
            <ConnectForm
              peer={peer}
              word={word}
              entry={item.entry}
              agents={toAdd}
              codexApp={agents.includes("codex") && item.cells.codex?.kind === "app"}
              onAdded={async (r) => {
                const ok = r.results.filter((x) => x.ok).map((x) => x.agent);
                const bad = r.results.filter((x) => !x.ok);
                await onChanged(
                  [ok.length ? `${item.name} added for ${listed(ok.map(agentLabel))}.` : "", ...bad.map((x) => `${agentLabel(x.agent)}: ${x.error}`)]
                    .filter(Boolean)
                    .join(" "),
                  ok,
                );
                // Signing in comes next, one agent at a time.
                const next = ok.filter((a) => a !== "gemini" && data[a]?.signIn);
                if (item.entry?.auth === "oauth" && next.length) setSigning(next);
              }}
            />
          )}
          <ErrorLine error={error} />
          {anyUsed && !signing.length && agents.some((a) => item.cells[a]?.kind === "server") && (
            <button className="cn-remove" disabled={!!busy} onClick={() => void removeAll()}>
              {busy === "remove" ? <Loader2 size={13} className="spin" /> : null} Remove from all
            </button>
          )}
        </div>
      )}
    </li>
  );
}

// Connecting a service to every agent that doesn't have it yet; a token
// where it needs one (pasted, or the GitHub CLI's on the computer), sent once.
function ConnectForm({
  peer,
  word,
  entry,
  agents,
  codexApp,
  onAdded,
}: {
  peer: Peer;
  word: string;
  entry: CatalogEntry | null;
  agents: ConnectorAgent[];
  codexApp?: boolean;
  onAdded: (r: AddResult) => Promise<void>;
}) {
  const [name, setName] = useState(entry?.id || "");
  const [url, setUrl] = useState(entry?.url || "");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const needsToken = entry?.auth === "token";
  const add = async (tokenFrom?: "gh") => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const r = await post<AddResult>(peer, "/api/sessions/connectors", {
        agents,
        name: name.trim(),
        url: url.trim(),
        ...(tokenFrom ? { tokenFrom } : token.trim() ? { token: token.trim() } : {}),
      });
      setToken("");
      await onAdded(r);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const ready = !!agents.length && !!name.trim() && !!url.trim() && (!needsToken || !!token.trim());
  return (
    <form
      className="cn-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (ready) void add();
      }}
    >
      <p className="cn-note">
        For {listed(agents.map(agentLabel))}
        {codexApp ? ". Codex uses its ChatGPT app." : "."}
      </p>
      {!entry && (
        <>
          <label>
            <span>Address</span>
            <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…/mcp" inputMode="url" autoCapitalize="off" autoCorrect="off" spellCheck={false} />
          </label>
          <label>
            <span>Name</span>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="my-service" autoCapitalize="off" autoCorrect="off" spellCheck={false} />
          </label>
        </>
      )}
      {(needsToken || !entry) && (
        <label>
          <span>{needsToken ? "Personal access token" : "Token (if it needs one)"}</span>
          <input
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder={needsToken ? "github_pat_…" : "Optional"}
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
          />
        </label>
      )}
      {needsToken && entry?.tokenUrl && (
        <p className="cn-note">
          <a href={entry.tokenUrl} target="_blank" rel="noopener noreferrer">
            Create a token on {entry.name} <ExternalLink size={11} />
          </a>{" "}
          for the repositories you want. It's kept in the agents' settings on your {word}, nowhere else.
        </p>
      )}
      <ErrorLine error={error} />
      <div className="cn-form-actions">
        <button type="submit" className="cn-btn primary" disabled={busy || !ready}>
          {busy ? <Loader2 size={13} className="spin" /> : null} Connect
        </button>
        {needsToken && entry?.id === "github" && (
          <button type="button" className="cn-btn" disabled={busy} onClick={() => void add("gh")}>
            Use the GitHub CLI's sign-in
          </button>
        )}
      </div>
    </form>
  );
}

function CustomService({
  peer,
  word,
  agents,
  open,
  onToggle,
  onAdded,
}: {
  peer: Peer;
  word: string;
  agents: ConnectorAgent[];
  open: boolean;
  onToggle: () => void;
  onAdded: (message: string) => Promise<void>;
}) {
  return (
    <li className={`cn-item ${open ? "open" : ""}`}>
      <div className="cn-row">
        <button className="cn-row-main" aria-expanded={open} onClick={onToggle}>
          <span className="cn-logo letter" style={{ width: 34, height: 34 }} aria-hidden="true">
            <Plus size={16} />
          </span>
          <span className="cn-text">
            <strong>Another service</strong>
            <small>Any MCP server, by its https:// address</small>
          </span>
          {open ? <ChevronDown size={15} className="cn-chev" /> : <ChevronRight size={15} className="cn-chev" />}
        </button>
      </div>
      {open && (
        <div className="cn-detail">
          <ConnectForm
            peer={peer}
            word={word}
            entry={null}
            agents={agents}
            onAdded={async (r) => {
              const ok = r.results.filter((x) => x.ok).map((x) => agentLabel(x.agent));
              const bad = r.results.filter((x) => !x.ok).map((x) => `${agentLabel(x.agent)}: ${x.error}`);
              await onAdded([ok.length ? `${r.name} added for ${listed(ok)}.` : "", ...bad].filter(Boolean).join(" "));
            }}
          />
        </div>
      )}
    </li>
  );
}

// Signing each agent in, one after the other.
function SignInSteps({
  peer,
  word,
  logos,
  steps,
  onFinished,
}: {
  peer: Peer;
  word: string;
  logos: AgentLogos;
  steps: { agent: ConnectorAgent; name: string }[];
  onFinished: () => void;
}) {
  const [at, setAt] = useState(0);
  const finished = useRef(onFinished);
  finished.current = onFinished;
  useEffect(() => {
    if (at >= steps.length) finished.current();
  }, [at, steps.length]);
  return (
    <ol className="cn-steps">
      {steps.map((s, i) => (
        <li key={`${s.agent}:${s.name}`} className={i < at ? "done" : i === at ? "now" : ""}>
          <span className="cn-step-head">
            <AgentLogo agent={s.agent} logos={logos} size={18} />
            <span>{agentLabel(s.agent)}</span>
            {i < at && <Check size={14} aria-label="Done" />}
            {i === at && (
              <button className="cn-link" onClick={() => setAt(at + 1)}>
                Skip
              </button>
            )}
          </span>
          {i === at && <ConnectorSignIn peer={peer} agent={s.agent} name={s.name} word={word} onDone={() => setAt(i + 1)} />}
        </li>
      ))}
    </ol>
  );
}

// Signing an agent in to a service: its page opens here; once approved the
// browser lands on a localhost page that can't load on the phone, and that
// address is what the agent on the computer waits for.
function ConnectorSignIn({
  peer,
  agent,
  name,
  word,
  onDone,
}: {
  peer: Peer;
  agent: ConnectorAgent;
  name: string;
  word: string;
  onDone: () => void;
}) {
  const [view, setView] = useState<LoginView | null>(null);
  const [pasted, setPasted] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const done = useRef(onDone);
  done.current = onDone;
  const active = !!view && ["starting", "link", "checking"].includes(view.state);
  const act = async (work: () => Promise<LoginView>) => {
    setBusy(true);
    setError("");
    try {
      setView(await work());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const start = () => act(() => post<LoginView>(peer, "/api/sessions/connectors/login", { agent, name }));
  useEffect(() => {
    void start();
  }, [agent, name]);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => {
      request<LoginView>(peer, route("/api/sessions/connectors/login", { agent, name })).then(setView, () => {});
    }, 1500);
    return () => clearInterval(timer);
  }, [active, peer.url, peer.token, agent, name]);
  useEffect(() => {
    if (view?.state === "done") done.current();
  }, [view?.state]);

  return (
    <div className="cn-signin" role="group" aria-label={`Sign ${agentLabel(agent)} in to ${name}`}>
      {(!view || view.state === "starting") && !error && (
        <p>
          <Loader2 size={13} className="spin" /> Starting on your {word}…
        </p>
      )}
      {view?.state === "link" && view.url && (
        <>
          <a className="cn-btn primary" href={view.url} target="_blank" rel="noopener noreferrer">
            Open the sign-in page <ExternalLink size={13} />
          </a>
          <p className="cn-note">After approving, the page it lands on won't load here. Copy its address and paste it:</p>
          <span className="cn-paste">
            <input
              value={pasted}
              placeholder="http://localhost:…"
              aria-label="Address after signing in"
              inputMode="url"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              onChange={(e) => setPasted(e.target.value)}
            />
            <button
              className="cn-btn"
              disabled={busy || !pasted.trim()}
              onClick={() =>
                void act(() => post<LoginView>(peer, "/api/sessions/connectors/login/callback", { agent, name, url: pasted.trim() })).then(() =>
                  setPasted(""),
                )
              }
            >
              Continue
            </button>
          </span>
        </>
      )}
      {view?.state === "checking" && (
        <p>
          <Loader2 size={13} className="spin" /> Signing in…
        </p>
      )}
      {(view?.state === "failed" || view?.state === "cancelled" || (error && !active)) && (
        <p className="bad">
          {view?.state === "cancelled" ? "Cancelled." : view?.error || error || "Sign-in didn't finish."}{" "}
          <button className="cn-link" disabled={busy} onClick={() => void start()}>
            Try again
          </button>
        </p>
      )}
      {error && active && <p className="bad">{error}</p>}
      {active && (
        <button
          className="cn-link"
          onClick={() => void act(() => request<LoginView>(peer, route("/api/sessions/connectors/login", { agent, name }), { method: "DELETE" }))}
        >
          Cancel
        </button>
      )}
    </div>
  );
}

// ChatGPT's other apps, found by name, for Codex.
function AppSearch({ peer, query }: { peer: Peer; query: string }) {
  const [found, setFound] = useState<Native[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    const timer = setTimeout(() => {
      request<AgentConnectors>(peer, route("/api/sessions/connectors", { agent: "codex", q: query }))
        .then((r) => {
          if (!live) return;
          setFound(r.native);
          setError("");
        })
        .catch((e) => live && setError((e as Error).message));
    }, 300);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [query, peer.url, peer.token]);
  if (!found?.length && !error) return null;
  return (
    <div className="cn-apps">
      <h3>ChatGPT apps for Codex</h3>
      <ErrorLine error={error} />
      <ul className="cn-list">
        {(found || []).map((a) => (
          <li key={a.id} className="cn-item">
            <div className="cn-row">
              <span className="cn-row-main static">
                <ConnectorLogo name={a.name} logo={a.logo} />
                <span className="cn-text">
                  <strong>{a.name}</strong>
                  {a.description && <small>{a.description}</small>}
                </span>
              </span>
              {a.state === "available" && a.connectUrl ? (
                <a className="cn-btn primary" href={a.connectUrl} target="_blank" rel="noopener noreferrer">
                  Connect
                </a>
              ) : (
                <span className="cn-state connected">
                  <Check size={12} /> Connected
                </span>
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
