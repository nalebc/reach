import { useEffect, useMemo, useRef, useState } from "react";
import { ExternalLink, Loader2, Plus, RefreshCw, Search, Trash2 } from "lucide-react";
import { post, request, type Peer } from "./api";
import { agentLabel } from "./agent-sessions";
import { AgentLogo, type AgentLogos } from "./agent-logos";
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
};
type Server = { name: string; url: string | null; remote: boolean; state: State };
type CatalogEntry = {
  id: string;
  name: string;
  description: string;
  url: string;
  auth: "token" | "oauth";
  tokenUrl?: string;
};
type AgentConnectors = {
  agent: ConnectorAgent;
  installed: boolean;
  native: Native[];
  servers: Server[];
  manageUrl: string | null;
  catalog: CatalogEntry[];
  signIn?: boolean;
};
type LoginView = {
  state: "idle" | "starting" | "link" | "checking" | "done" | "failed" | "cancelled";
  url: string | null;
  error: string | null;
};
type AddResult = { name: string; results: { agent: ConnectorAgent; ok: boolean; error?: string }[] };

// One agent's side of a connector: a server in its settings, one of the
// claude.ai account's connectors, or one of ChatGPT's apps (Codex).
type Cell =
  | { kind: "server"; name: string; state: State; remote: boolean }
  | { kind: "native"; name: string; state: State }
  | { kind: "app"; id: string; state: State; enabled: boolean; connectUrl: string | null };
// A service (GitHub, Linear, …) across the agents.
type Item = {
  key: string;
  name: string;
  detail: string | null;
  entry: CatalogEntry | null;
  cells: Partial<Record<ConnectorAgent, Cell>>;
};

const AGENTS: ConnectorAgent[] = ["claude", "codex", "gemini"];
const STATE_WORDS: Record<State, string> = {
  connected: "Connected",
  "needs-auth": "Sign in",
  failed: "Can't connect",
  off: "Off",
  added: "Added",
  available: "Not connected",
};
const route = (path: string, params: Record<string, string>) => `${path}?${new URLSearchParams(params).toString()}`;
const keyOf = (name: string) => name.trim().toLowerCase();

// Every agent's connectors folded into one list of services: the catalog's,
// then whatever the agents already have, matched by name.
export function connectorItems(data: Partial<Record<ConnectorAgent, AgentConnectors>>): Item[] {
  const items = new Map<string, Item>();
  const catalog = AGENTS.map((a) => data[a]?.catalog).find(Boolean) || [];
  for (const entry of catalog)
    items.set(entry.id, { key: entry.id, name: entry.name, detail: entry.description, entry, cells: {} });
  const find = (name: string) =>
    items.get(keyOf(name)) || [...items.values()].find((i) => keyOf(i.name) === keyOf(name));
  const item = (name: string, detail: string | null) => {
    const found = find(name);
    if (found) return found;
    const made: Item = { key: keyOf(name), name, detail, entry: null, cells: {} };
    items.set(made.key, made);
    return made;
  };
  for (const agent of AGENTS) {
    const info = data[agent];
    if (!info?.installed) continue;
    for (const n of info.native) {
      // ChatGPT's apps not linked yet count only for the catalog's services.
      if (n.state === "available" && !find(n.name)) continue;
      const it = item(n.name, n.description || null);
      it.cells[agent] =
        agent === "codex"
          ? { kind: "app", id: n.id, state: n.state, enabled: n.enabled !== false, connectUrl: n.connectUrl || null }
          : { kind: "native", name: n.id, state: n.state };
    }
    // A server of the same name as a native one is the agent's own choice;
    // the server is what Reach manages.
    for (const s of info.servers) {
      const it = item(s.name, s.url);
      const had = it.cells[agent];
      if (!had || had.state === "available") it.cells[agent] = { kind: "server", name: s.name, state: s.state, remote: s.remote };
    }
  }
  const used = (i: Item) => Object.values(i.cells).some((c) => c && c.state !== "available");
  return [...items.values()].sort(
    (a, b) => Number(used(b)) - Number(used(a)) || Number(!!b.entry) - Number(!!a.entry) || a.name.localeCompare(b.name),
  );
}

// Connectors: GitHub, Linear, … for Claude Code, Codex and Gemini CLI at once,
// each kept in that agent's own settings on the computer (so its app and
// terminal have them too). An agent with its own version (ChatGPT's GitHub
// app for Codex) keeps it.
export default function Connectors({ peer, logos }: { peer: Peer; logos: AgentLogos }) {
  const word = computerWord(peer.platform);
  const [data, setData] = useState<Partial<Record<ConnectorAgent, AgentConnectors>>>({});
  const [errors, setErrors] = useState<Partial<Record<ConnectorAgent, string>>>({});
  const [open, setOpen] = useState<string | null>(null);
  const [signIn, setSignIn] = useState<{ agent: ConnectorAgent; name: string } | null>(null);
  const [note, setNote] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const load = (which: ConnectorAgent, fresh = false) =>
    request<AgentConnectors>(peer, route("/api/sessions/connectors", { agent: which, ...(fresh ? { fresh: "1" } : {}) }))
      .then((r) => {
        setData((d) => ({ ...d, [which]: r }));
        setErrors((e) => ({ ...e, [which]: "" }));
      })
      .catch((e) => setErrors((all) => ({ ...all, [which]: (e as Error).message })));
  const reload = async (fresh = true, which: ConnectorAgent[] = AGENTS) => {
    await Promise.all(which.map((a) => load(a, fresh)));
  };
  useEffect(() => {
    setData({});
    setErrors({});
    void reload(false);
  }, [peer.id, peer.url, peer.token]);
  const installed = AGENTS.filter((a) => data[a]?.installed);
  const checking = AGENTS.filter((a) => !data[a] && !errors[a]);
  const items = useMemo(() => connectorItems(data), [data]);
  const used = items.filter((i) => installed.some((a) => i.cells[a] && i.cells[a]!.state !== "available"));
  const more = items.filter((i) => !used.includes(i));

  const row = (it: Item) => (
    <ConnectorRow
      key={it.key}
      peer={peer}
      word={word}
      logos={logos}
      item={it}
      agents={installed}
      data={data}
      open={open === it.key}
      onToggle={() => setOpen(open === it.key ? null : it.key)}
      signIn={signIn}
      setSignIn={setSignIn}
      onChanged={async (message, which) => {
        if (message) setNote(message);
        await reload(true, which);
      }}
    />
  );

  return (
    <div className="connectors">
      <p className="connectors-intro">
        Add a service once and{" "}
        {installed.length > 1 ? installed.map(agentLabel).join(", ").replace(/, ([^,]*)$/, " and $1") : "your agents"} can
        all use it. It's saved in each agent's own settings on your {word}, so its app and terminal have it too.
      </p>
      {checking.length > 0 && !installed.length && <Spinner label="Looking for agents…" />}
      {!checking.length && !installed.length && (
        <p className="connectors-empty">
          Claude Code, Codex or Gemini CLI isn't installed on this {word}. Set one up from Chat first.
        </p>
      )}
      {AGENTS.filter((a) => errors[a]).map((a) => (
        <ErrorLine key={a} error={`${agentLabel(a)}: ${errors[a]}`} />
      ))}
      {note && (
        <p className="connectors-flash" role="status">
          {note}
        </p>
      )}
      {installed.length > 0 && (
        <>
          <section className="connectors-group" aria-label="Connected">
            <h2>
              Connected
              {checking.length > 0 && (
                <span className="connectors-checking">
                  <Loader2 size={12} className="spin" /> Checking {checking.map(agentLabel).join(", ")}…
                </span>
              )}
              <button
                className="connectors-refresh"
                aria-label="Check again"
                disabled={refreshing}
                onClick={async () => {
                  setRefreshing(true);
                  await reload(true);
                  setRefreshing(false);
                }}
              >
                <RefreshCw size={14} className={refreshing ? "spin" : undefined} />
              </button>
            </h2>
            {used.length ? <ul className="connectors-list">{used.map(row)}</ul> : <p className="connectors-empty">Nothing yet. Add one below.</p>}
          </section>
          <section className="connectors-group" aria-label="Add a connector">
            <h2>Add</h2>
            <ul className="connectors-list">
              {more.map(row)}
              <CustomServer
                peer={peer}
                word={word}
                logos={logos}
                agents={installed}
                open={open === "+custom"}
                onToggle={() => setOpen(open === "+custom" ? null : "+custom")}
                onAdded={async (message) => {
                  setOpen(null);
                  setNote(message);
                  await reload(true);
                }}
              />
            </ul>
            {data.codex?.installed && <AppSearch peer={peer} />}
            <div className="connectors-links">
              {installed.map((a) =>
                data[a]?.manageUrl ? (
                  <a key={a} href={data[a]!.manageUrl!} target="_blank" rel="noopener noreferrer">
                    {a === "claude" ? "More on claude.ai" : "All ChatGPT apps"} <ExternalLink size={11} />
                  </a>
                ) : null,
              )}
            </div>
            <p className="connectors-note">New chats have them. A chat that's already open picks them up once restarted.</p>
          </section>
        </>
      )}
    </div>
  );
}

function ConnectorRow({
  peer,
  word,
  logos,
  item,
  agents,
  data,
  open,
  onToggle,
  signIn,
  setSignIn,
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
  signIn: { agent: ConnectorAgent; name: string } | null;
  setSignIn: (v: { agent: ConnectorAgent; name: string } | null) => void;
  onChanged: (message: string, which?: ConnectorAgent[]) => Promise<void>;
}) {
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  // Agents without it, that Reach can add it to (Codex's own app comes from ChatGPT).
  const missing = agents.filter((a) => !item.cells[a]);
  const addable = item.entry ? missing : [];
  const act = async (key: string, work: () => Promise<unknown>) => {
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
  const remove = (agent: ConnectorAgent, name: string) =>
    act(`rm:${agent}`, async () => {
      if (!confirm(`Remove ${item.name} from ${agentLabel(agent)}?`)) return;
      await request(peer, route("/api/sessions/connectors", { agent, name }), { method: "DELETE" });
      await onChanged(`${item.name} removed from ${agentLabel(agent)}.`, [agent]);
    });
  const toggleApp = (cell: Extract<Cell, { kind: "app" }>) =>
    act("app", async () => {
      await post(peer, "/api/sessions/connectors/apps", { id: cell.id, enabled: !cell.enabled });
      await onChanged("", ["codex"]);
    });
  const signInName = (agent: ConnectorAgent) => {
    const cell = item.cells[agent];
    return cell?.kind === "server" || cell?.kind === "native" ? cell.name : null;
  };

  return (
    <li className={`connectors-item ${open ? "open" : ""}`}>
      <button className="connectors-row" aria-expanded={open} onClick={onToggle}>
        <span className="connectors-mark" aria-hidden="true">
          {item.name.slice(0, 1).toUpperCase()}
        </span>
        <span className="connectors-text">
          <strong>{item.name}</strong>
          {item.detail && <small>{item.detail}</small>}
        </span>
        <span className="connectors-chips">
          {agents.map((a) => {
            const cell = item.cells[a];
            const state = cell?.state;
            return (
              <span
                key={a}
                className={`connectors-chip ${state || "missing"}`}
                title={`${agentLabel(a)}: ${state ? STATE_WORDS[state] : "Not added"}`}
              >
                <AgentLogo agent={a} logos={logos} size={16} />
                <span className="sr-only">
                  {agentLabel(a)}: {state ? STATE_WORDS[state] : "Not added"}
                </span>
              </span>
            );
          })}
        </span>
      </button>
      {open && (
        <div className="connectors-detail">
          <ul className="connectors-agents">
            {agents.map((a) => {
              const cell = item.cells[a];
              const name = signInName(a);
              return (
                <li key={a}>
                  <span className="connectors-agent">
                    <AgentLogo agent={a} logos={logos} size={18} />
                    {agentLabel(a)}
                  </span>
                  <span className={`connectors-state ${cell?.state || "missing"}`}>
                    {!cell
                      ? "Not added"
                      : cell.kind === "app" && cell.state === "available"
                        ? "ChatGPT app, not connected"
                        : cell.kind === "app"
                          ? `ChatGPT app · ${cell.enabled ? "On" : "Off"}`
                          : cell.kind === "native"
                            ? `claude.ai · ${STATE_WORDS[cell.state]}`
                            : STATE_WORDS[cell.state]}
                  </span>
                  <span className="connectors-action">
                    {cell?.kind === "app" && cell.state === "available" && cell.connectUrl && (
                      <a className="connectors-btn" href={cell.connectUrl} target="_blank" rel="noopener noreferrer">
                        Connect <ExternalLink size={12} />
                      </a>
                    )}
                    {cell?.kind === "app" && cell.state !== "available" && (
                      <button className="connectors-btn" disabled={busy === "app"} onClick={() => void toggleApp(cell)}>
                        {cell.enabled ? "Turn off" : "Turn on"}
                      </button>
                    )}
                    {cell && cell.kind !== "app" && cell.state === "needs-auth" && name && data[a]?.signIn && (
                      <button className="connectors-btn primary" onClick={() => setSignIn({ agent: a, name })}>
                        Sign in
                      </button>
                    )}
                    {cell?.kind === "server" && cell.remote && (
                      <button
                        className="connectors-icon"
                        aria-label={`Remove ${item.name} from ${agentLabel(a)}`}
                        disabled={busy === `rm:${a}`}
                        onClick={() => void remove(a, cell.name)}
                      >
                        <Trash2 size={15} />
                      </button>
                    )}
                  </span>
                  {cell?.state === "needs-auth" && a === "gemini" && name && (
                    <p className="connectors-note">
                      Gemini CLI signs in itself: on your {word}, run <code>gemini</code>, then <code>/mcp auth {name}</code> (a Reach terminal works).
                    </p>
                  )}
                  {cell?.kind === "app" && cell.state === "available" && (
                    <p className="connectors-note">Connect it on ChatGPT, then check again here.</p>
                  )}
                  {signIn?.agent === a && name && signIn.name === name && (
                    <ConnectorSignIn
                      peer={peer}
                      agent={a}
                      name={name}
                      word={word}
                      onDone={() => {
                        setSignIn(null);
                        void onChanged(`${agentLabel(a)} is signed in to ${item.name}.`, [a]);
                      }}
                    />
                  )}
                </li>
              );
            })}
          </ul>
          <ErrorLine error={error} />
          {item.entry && addable.length > 0 && (
            <AddForm
              peer={peer}
              word={word}
              entry={item.entry}
              agents={addable}
              onAdded={async (r) => {
                const ok = r.results.filter((x) => x.ok).map((x) => x.agent);
                const bad = r.results.filter((x) => !x.ok);
                await onChanged(
                  [
                    ok.length ? `${item.name} added to ${ok.map(agentLabel).join(", ")}.` : "",
                    ...bad.map((x) => `${agentLabel(x.agent)}: ${x.error}`),
                  ]
                    .filter(Boolean)
                    .join(" "),
                  ok,
                );
                // Signing in comes next, one agent at a time.
                const first = ok.find((a) => a !== "gemini");
                if (item.entry?.auth === "oauth" && first) setSignIn({ agent: first, name: r.name });
              }}
            />
          )}
        </div>
      )}
    </li>
  );
}

// Adding a service to several agents in one go: the catalog gives its
// address; a token where it needs one (pasted, or the GitHub CLI's on the
// computer), sent once.
function AddForm({
  peer,
  word,
  entry,
  agents,
  onAdded,
}: {
  peer: Peer;
  word: string;
  entry: CatalogEntry | null;
  agents: ConnectorAgent[];
  onAdded: (r: AddResult) => Promise<void>;
}) {
  const [picked, setPicked] = useState<ConnectorAgent[]>(agents);
  const [name, setName] = useState(entry?.id || "");
  const [url, setUrl] = useState(entry?.url || "");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const needsToken = entry?.auth === "token";
  const targets = picked.filter((a) => agents.includes(a));
  const add = async (tokenFrom?: "gh") => {
    setBusy(true);
    setError("");
    try {
      const r = await post<AddResult>(peer, "/api/sessions/connectors", {
        agents: targets,
        name,
        url,
        ...(tokenFrom ? { tokenFrom } : token.trim() ? { token } : {}),
      });
      setToken("");
      await onAdded(r);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="connectors-form"
      onSubmit={(e) => {
        e.preventDefault();
        void add();
      }}
    >
      {agents.length > 1 && (
        <fieldset className="connectors-targets">
          <legend>Add to</legend>
          {agents.map((a) => (
            <label key={a}>
              <input
                type="checkbox"
                checked={picked.includes(a)}
                onChange={(e) => setPicked(e.target.checked ? [...picked, a] : picked.filter((x) => x !== a))}
              />
              {agentLabel(a)}
            </label>
          ))}
        </fieldset>
      )}
      {!entry && (
        <>
          <label>
            <span>Name</span>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="my-server" autoCapitalize="off" autoCorrect="off" spellCheck={false} />
          </label>
          <label>
            <span>Address</span>
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://…/mcp"
              inputMode="url"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
            />
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
        <p className="connectors-note">
          <a href={entry.tokenUrl} target="_blank" rel="noopener noreferrer">
            Create a token on {entry.name} <ExternalLink size={11} />
          </a>{" "}
          with access to the repositories you want. It's saved in each agent's settings on your {word}, nowhere else.
        </p>
      )}
      {entry?.auth === "oauth" && (
        <p className="connectors-note">
          You'll sign in to {entry.name} next
          {targets.includes("gemini") ? `; for Gemini CLI, run gemini on your ${word}, then /mcp auth ${entry.id}` : ""}.
        </p>
      )}
      <ErrorLine error={error} />
      <div className="connectors-form-actions">
        <button
          type="submit"
          className="connectors-btn primary"
          disabled={busy || !targets.length || (needsToken && !token.trim()) || !name.trim() || !url.trim()}
        >
          {busy ? <Loader2 size={13} className="spin" /> : <Plus size={13} />}{" "}
          {targets.length === agents.length && agents.length > 1 ? "Add to all" : "Add"}
        </button>
        {needsToken && entry?.id === "github" && (
          <button type="button" className="connectors-btn" disabled={busy || !targets.length} onClick={() => void add("gh")}>
            Use the GitHub CLI's sign-in on your {word}
          </button>
        )}
      </div>
    </form>
  );
}

function CustomServer({
  peer,
  word,
  logos,
  agents,
  open,
  onToggle,
  onAdded,
}: {
  peer: Peer;
  word: string;
  logos: AgentLogos;
  agents: ConnectorAgent[];
  open: boolean;
  onToggle: () => void;
  onAdded: (message: string) => Promise<void>;
}) {
  return (
    <li className={`connectors-item ${open ? "open" : ""}`}>
      <button className="connectors-row" aria-expanded={open} onClick={onToggle}>
        <span className="connectors-mark" aria-hidden="true">
          <Plus size={15} />
        </span>
        <span className="connectors-text">
          <strong>Another service</strong>
          <small>Any MCP server, by its https:// address</small>
        </span>
        <span className="connectors-chips">
          {agents.map((a) => (
            <span key={a} className="connectors-chip missing">
              <AgentLogo agent={a} logos={logos} size={16} />
            </span>
          ))}
        </span>
      </button>
      {open && (
        <div className="connectors-detail">
          <AddForm
            peer={peer}
            word={word}
            entry={null}
            agents={agents}
            onAdded={async (r) => {
              const ok = r.results.filter((x) => x.ok).map((x) => agentLabel(x.agent));
              const bad = r.results.filter((x) => !x.ok).map((x) => `${agentLabel(x.agent)}: ${x.error}`);
              await onAdded([ok.length ? `${r.name} added to ${ok.join(", ")}.` : "", ...bad].filter(Boolean).join(" "));
            }}
          />
        </div>
      )}
    </li>
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
    <div className="sign-in connectors-sign-in" role="group" aria-label={`Sign ${agentLabel(agent)} in to ${name}`}>
      {(!view || view.state === "starting") && !error && (
        <p>
          <Loader2 size={13} className="spin" /> Starting sign-in on your {word}…
        </p>
      )}
      {view?.state === "link" && view.url && (
        <ol>
          <li>
            <a className="sign-in-open" href={view.url} target="_blank" rel="noopener noreferrer">
              Open the sign-in page <ExternalLink size={13} />
            </a>
          </li>
          <li>
            <span>Approve it. The page it then opens won't load here: copy its address and paste it</span>
            <span className="sign-in-code">
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
                disabled={busy || !pasted.trim()}
                onClick={() =>
                  void act(() =>
                    post<LoginView>(peer, "/api/sessions/connectors/login/callback", { agent, name, url: pasted }),
                  ).then(() => setPasted(""))
                }
              >
                Continue
              </button>
            </span>
          </li>
        </ol>
      )}
      {view?.state === "checking" && (
        <p>
          <Loader2 size={13} className="spin" /> Signing in…
        </p>
      )}
      {(view?.state === "failed" || (error && !active)) && (
        <p className="bad">
          {view?.error || error || "Sign-in didn't finish."}{" "}
          <button className="sign-in-start" disabled={busy} onClick={() => void start()}>
            Try again
          </button>
        </p>
      )}
      {error && active && <p className="bad">{error}</p>}
      {active && (
        <button
          className="sign-in-cancel"
          onClick={() =>
            void act(() =>
              request<LoginView>(peer, route("/api/sessions/connectors/login", { agent, name }), { method: "DELETE" }),
            )
          }
        >
          Cancel
        </button>
      )}
    </div>
  );
}

// ChatGPT's other apps, found by name, for Codex.
function AppSearch({ peer }: { peer: Peer }) {
  const [q, setQ] = useState("");
  const [found, setFound] = useState<Native[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const query = q.trim();
    if (query.length < 2) {
      setFound(null);
      return;
    }
    const timer = setTimeout(() => {
      request<AgentConnectors>(peer, route("/api/sessions/connectors", { agent: "codex", q: query }))
        .then((r) => {
          setFound(r.native);
          setError("");
        })
        .catch((e) => setError((e as Error).message));
    }, 300);
    return () => clearTimeout(timer);
  }, [q, peer.url, peer.token]);
  return (
    <div className="connectors-search">
      <label>
        <Search size={14} aria-hidden="true" />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a ChatGPT app for Codex" aria-label="Find a ChatGPT app for Codex" />
      </label>
      <ErrorLine error={error} />
      {found && !found.length && <p className="connectors-empty">No app by that name.</p>}
      {found && found.length > 0 && (
        <ul className="connectors-results">
          {found.map((a) => (
            <li key={a.id}>
              <span className="connectors-text">
                <strong>{a.name}</strong>
                {a.description && <small>{a.description}</small>}
              </span>
              {a.state === "available" && a.connectUrl ? (
                <a className="connectors-btn" href={a.connectUrl} target="_blank" rel="noopener noreferrer">
                  Connect <ExternalLink size={12} />
                </a>
              ) : (
                <span className={`connectors-state ${a.state}`}>{STATE_WORDS[a.state]}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
