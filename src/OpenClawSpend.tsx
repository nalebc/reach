import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { DollarSign, Loader2, TriangleAlert } from "lucide-react";
import { post, request, type Peer } from "./api";
import ChatSheet from "./ChatSheet";
import { clawBase } from "./OpenClawControls";
import { OpenSetup } from "./OpenClawSetup";
import { ClawAddProvider } from "./OpenClawOnboard";
import { ClawRow } from "./OpenClawRow";
import "./openclaw-spend.css";

// What OpenClaw spends: a pill per chat, a pill on the status line, and a
// sheet with the budget and which models do the background work.

type Spend =
  | { supported: false }
  | {
      supported: true;
      scope: "all" | "default";
      today: number;
      month: number;
      days30: number;
      agentDays?: number;
      partial: boolean;
      agents: { id: string; cost: number }[] | null;
      limits: { name: string; windows: { label: string; usedPercent: number }[] }[];
      budget: number;
    };
type Model = { id: string; name: string; provider: string };
type Routing =
  | { supported: false }
  | {
      supported: true;
      version: string;
      readOnly: boolean;
      model: string;
      heartbeat: { model: string; every: string };
      agents: { id: string; model: string; heartbeat: { model: string; every: string } | null }[];
      models: Model[];
      cheapest: string;
      jobs: { id: string; name: string; model: string }[];
      cache: { every: string; ttlMinutes: number; canKeepLonger: boolean } | null;
      openRouter: boolean;
    };
type Ready<T> = Extract<T, { supported: true }>;

export const usd = (n: number) =>
  n > 0 && n < 0.01 ? "<$0.01" : `$${n >= 100 ? Math.round(n) : n.toFixed(2)}`;
// Warning at 80 % of the monthly budget, and over it.
export const budgetState = (month: number, budget: number) =>
  budget > 0 ? (month >= budget ? "over" : month >= budget * 0.8 ? "near" : "") : "";
const short = (id: string) => id.split("/").pop() || id;

// Spend on one chat, a pill in its header.
export function ClawChatCost({ peer, sessionKey, refresh }: { peer: Peer; sessionKey: string; refresh?: number }) {
  const [cost, setCost] = useState<number | null>(null);
  useEffect(() => {
    let live = true;
    setCost(null);
    request<{ supported: boolean; cost?: number | null }>(
      peer,
      `${clawBase}/spend/chat?key=${encodeURIComponent(sessionKey)}`,
    ).then(
      (got) => live && setCost(got.supported && typeof got.cost === "number" ? got.cost : null),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [peer, sessionKey, refresh]);
  if (cost === null) return null;
  return (
    <span className="claw-chat-cost" aria-label={`Spent ${usd(cost)}`}>
      {usd(cost)}
    </span>
  );
}

// Spend across OpenClaw, a pill on the status line; opens budget and models.
export function ClawSpendPill({ peer, refresh, row = false }: { peer: Peer; refresh?: number; row?: boolean }) {
  const [spend, setSpend] = useState<Ready<Spend> | null>(null);
  const [open, setOpen] = useState(false);
  const asked = useRef(0);
  const load = useCallback(async () => {
    const ask = ++asked.current;
    try {
      const got = await request<Spend>(peer, `${clawBase}/spend`);
      if (ask === asked.current) setSpend(got.supported ? got : null);
    } catch {
      if (ask === asked.current) setSpend(null);
    }
  }, [peer]);
  // OpenClaw scans transcripts for this: read on change, not on a beat.
  useEffect(() => {
    void load();
  }, [load, refresh]);
  if (!spend) return null;
  const state = budgetState(spend.month, spend.budget);
  const show = () => {
    setOpen(true);
    void load();
  };
  return (
    <>
      {row ? (
        <ClawRow
          icon={<DollarSign size={19} />}
          tint="green"
          label="Spend"
          value={`${usd(spend.today)} today`}
          tone={state ? "alert" : ""}
          onClick={show}
        />
      ) : (
        <button type="button" className={`claw-spend-pill ${state}`} onClick={show}>
          {state && <TriangleAlert size={11} />}
          {usd(spend.today)} today
        </button>
      )}
      {open && (
        <ChatSheet title="Spend" className="claw-spend-sheet" onClose={() => setOpen(false)}>
          <SpendSheet peer={peer} spend={spend} onChanged={load} />
        </ChatSheet>
      )}
    </>
  );
}

function Row({ label, children, className = "" }: { label: ReactNode; children?: ReactNode; className?: string }) {
  return (
    <li className={`claw-spend-row ${className}`}>
      <span>{label}</span>
      {children !== undefined && <strong>{children}</strong>}
    </li>
  );
}

function SpendSheet({ peer, spend, onChanged }: { peer: Peer; spend: Ready<Spend>; onChanged: () => void }) {
  const state = budgetState(spend.month, spend.budget);
  return (
    <div className="claw-spend">
      <ul className="claw-spend-rows">
        <Row label="Today">{usd(spend.today)}</Row>
        <Row label="This month" className={state}>
          {usd(spend.month)}
          {spend.budget > 0 && <small> / {usd(spend.budget)}</small>}
        </Row>
        <Row label="30 days">{usd(spend.days30)}</Row>
        {spend.scope === "default" && <Row label={<span className="claw-badge">Default agent only</span>} />}
        {spend.partial && <Row label={<span className="claw-badge">Some turns unpriced</span>} />}
      </ul>
      {!!spend.agents?.length && (
        <section>
          <h3>Agents · {spend.agentDays || 30} days</h3>
          <ul className="claw-spend-rows">
            {spend.agents.map((a) => (
              <Row key={a.id} label={a.id}>
                {usd(a.cost)}
              </Row>
            ))}
          </ul>
        </section>
      )}
      {!!spend.limits.length && (
        <section>
          <h3>Plan limits</h3>
          <ul className="claw-spend-rows">
            {spend.limits.flatMap((p) =>
              p.windows.map((w) => (
                <Row key={`${p.name}-${w.label}`} label={`${p.name} · ${w.label}`} className={w.usedPercent >= 80 ? "near" : ""}>
                  {w.usedPercent}%
                </Row>
              )),
            )}
          </ul>
        </section>
      )}
      <Budget peer={peer} budget={spend.budget} onSaved={onChanged} />
      <Routing peer={peer} />
    </div>
  );
}

function Budget({ peer, budget, onSaved }: { peer: Peer; budget: number; onSaved: () => void }) {
  const [text, setText] = useState(budget ? String(budget) : "");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const value = text.trim() === "" ? 0 : Number(text);
  const valid = Number.isFinite(value) && value >= 0 && value <= 100000;
  const save = async () => {
    setBusy(true);
    setProblem("");
    try {
      await post(peer, `${clawBase}/spend/budget`, { monthlyUsd: value });
      onSaved();
    } catch (e) {
      setProblem((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section>
      <h3>Monthly budget</h3>
      <div className="claw-spend-budget">
        <span>$</span>
        <input
          type="number"
          inputMode="decimal"
          min={0}
          step="any"
          placeholder="None"
          aria-label="Monthly budget in dollars"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        {valid && value !== budget && (
          <button type="button" className="claw-secondary" disabled={busy} onClick={save}>
            {busy && <Loader2 size={13} className="spin" />}
            Save
          </button>
        )}
      </div>
      {problem && (
        <p className="claw-error" role="alert">
          {problem}
        </p>
      )}
    </section>
  );
}

// One "from → to" line the user confirms before anything changes.
type Change = { what: string; from: string; to: string; restart: boolean };
export function cheapChanges(r: Ready<Routing>, model: string): Change[] {
  const changes: Change[] = [];
  const hb = r.heartbeat.model || r.model;
  if (hb !== model) changes.push({ what: "Heartbeat", from: short(hb || "Default"), to: short(model), restart: true });
  for (const a of r.agents)
    if (a.heartbeat?.model && a.heartbeat.model !== model)
      changes.push({ what: `${a.id} heartbeat`, from: short(a.heartbeat.model), to: short(model), restart: true });
  for (const j of r.jobs)
    if ((j.model || r.model) !== model) changes.push({ what: j.name, from: short(j.model || r.model || "Default"), to: short(model), restart: false });
  return changes;
}

function Routing({ peer }: { peer: Peer }) {
  const [routing, setRouting] = useState<Routing | null>(null);
  const [problem, setProblem] = useState("");
  const [busy, setBusy] = useState("");
  const [draft, setDraft] = useState<{ target: "default" | "heartbeat"; model: string } | null>(null);
  const [cheap, setCheap] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [addRouter, setAddRouter] = useState(false);
  const asked = useRef(0);
  const load = useCallback(async () => {
    const ask = ++asked.current;
    try {
      const got = await request<Routing>(peer, `${clawBase}/spend/routing`);
      if (ask === asked.current) setRouting(got);
    } catch (e) {
      if (ask === asked.current) setProblem((e as Error).message);
    }
  }, [peer]);
  useEffect(() => {
    void load();
  }, [load]);
  if (!routing) return problem ? <p className="claw-error">{problem}</p> : null;
  if (!routing.supported) return null;
  const r = routing;
  const run = async (name: string, path: string, body: object, restarts = true) => {
    setBusy(name);
    setProblem("");
    setNote("");
    try {
      await post(peer, `${clawBase}/spend/routing${path}`, { ...body, version: r.version });
      setDraft(null);
      setCheap(null);
      setNote(restarts ? "Saved · Gateway restarting" : "Saved");
      // Read again once the Gateway is back.
      setTimeout(() => void load(), restarts ? 4000 : 0);
    } catch (e) {
      setProblem((e as Error).message);
    } finally {
      setBusy("");
    }
  };
  const picker = (target: "default" | "heartbeat", current: string) => {
    const value = draft?.target === target ? draft.model : current;
    const known = !value || r.models.some((m) => m.id === value);
    return (
      <select
        aria-label={target === "default" ? "Default model" : "Heartbeat model"}
        value={value}
        disabled={r.readOnly || !!busy}
        onChange={(e) => setDraft(e.target.value === current ? null : { target, model: e.target.value })}
      >
        {target === "heartbeat" && <option value="">Same as default</option>}
        {!known && <option value={value}>{short(value)}</option>}
        {r.models.map((m) => (
          <option key={m.id} value={m.id}>
            {m.name}
          </option>
        ))}
      </select>
    );
  };
  const changes = cheap === null ? [] : cheapChanges(r, cheap);
  return (
    <section>
      <h3>Models</h3>
      <ul className="claw-spend-rows">
        <Row label="Default">{picker("default", r.model)}</Row>
        <Row label={`Heartbeat${r.heartbeat.every ? ` · ${r.heartbeat.every}` : ""}`}>{picker("heartbeat", r.heartbeat.model)}</Row>
        {r.agents
          .filter((a) => a.model || a.heartbeat?.model)
          .map((a) => (
            <Row key={a.id} label={a.id}>
              {short(a.model || r.model)}
              {a.heartbeat?.model ? ` · ♥ ${short(a.heartbeat.model)}` : ""}
            </Row>
          ))}
        {r.cache && (
          <li className="claw-spend-row claw-spend-cache near">
            <span>
              <TriangleAlert size={13} /> Heartbeat {r.cache.every} misses {r.cache.ttlMinutes} min cache
            </span>
            <span className="claw-spend-fixes">
              {r.cache.canKeepLonger && (
                <button type="button" className="claw-secondary" disabled={!!busy || r.readOnly} onClick={() => run("cache", "/cache", {})}>
                  {busy === "cache" && <Loader2 size={13} className="spin" />}
                  Cache 1 h
                </button>
              )}
              <button type="button" className="claw-secondary" disabled={!!busy || r.readOnly} onClick={() => setCheap(r.cheapest || r.models[0]?.id || "")}>
                Cheaper background work
              </button>
            </span>
          </li>
        )}
        {cheap === null && (
          <li className="claw-spend-row">
            <span>Cheap background work</span>
            <button type="button" className="claw-secondary" disabled={!!busy || r.readOnly || !r.models.length} onClick={() => setCheap(r.cheapest || r.models[0]?.id || "")}>
              Set up
            </button>
          </li>
        )}
        {!r.openRouter && (
          <li className="claw-spend-row">
            <span>OpenRouter</span>
            <span className="claw-spend-fixes">
              <OpenSetup peer={peer} section="model">
                Guided setup
              </OpenSetup>
              {!addRouter && (
                <button type="button" className="claw-secondary" onClick={() => setAddRouter(true)}>
                  Add
                </button>
              )}
            </span>
          </li>
        )}
      </ul>
      {addRouter && !r.openRouter && (
        <div className="claw-spend-confirm">
          <ClawAddProvider
            peer={peer}
            provider="openrouter"
            onCancel={() => setAddRouter(false)}
            onDone={() => {
              setAddRouter(false);
              void load();
            }}
          />
        </div>
      )}
      {draft && (
        <div className="claw-spend-confirm">
          <p>
            {draft.target === "default" ? "Default" : "Heartbeat"} → {draft.model ? short(draft.model) : "same as default"} · Gateway restarts
          </p>
          <div>
            <button type="button" className="claw-secondary" disabled={!!busy} onClick={() => setDraft(null)}>
              Cancel
            </button>
            <button type="button" className="claw-primary" disabled={!!busy} onClick={() => run("model", "", draft)}>
              {busy === "model" && <Loader2 size={13} className="spin" />}
              Save
            </button>
          </div>
        </div>
      )}
      {cheap !== null && (
        <div className="claw-spend-confirm" role="dialog" aria-label="Cheap background work">
          <select aria-label="Cheap model" value={cheap} disabled={!!busy} onChange={(e) => setCheap(e.target.value)}>
            {r.models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
          {changes.length ? (
            <ul className="claw-spend-changes">
              {changes.map((c, i) => (
                <li key={i}>
                  <span>{c.what}</span>
                  <span>
                    {c.from} → <strong>{c.to}</strong>
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p>Already on {short(cheap)}</p>
          )}
          {changes.some((c) => c.restart) && <p>Gateway restarts</p>}
          <div>
            <button type="button" className="claw-secondary" disabled={!!busy} onClick={() => setCheap(null)}>
              Cancel
            </button>
            <button type="button" className="claw-primary" disabled={!!busy || !changes.length} onClick={() => run("cheap", "/cheap", { model: cheap }, changes.some((c) => c.restart))}>
              {busy === "cheap" && <Loader2 size={13} className="spin" />}
              Apply
            </button>
          </div>
        </div>
      )}
      {note && <p className="claw-note">{note}</p>}
      {problem && (
        <p className="claw-error" role="alert">
          {problem}
        </p>
      )}
    </section>
  );
}
