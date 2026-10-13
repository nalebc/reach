import { useEffect, useState } from "react";
import { LoaderCircle } from "lucide-react";
import { request, post, type Peer } from "./api";
import { clawBase, useClawCatalog } from "./OpenClawControls";
import { cronFor } from "./OpenClawSetup";
import "./openclaw-schedules.css";

export type ClawJob = {
  id: string;
  name: string;
  agentId: string;
  enabled: boolean;
  schedule: string;
  nextRunAt: number;
  lastRunAt: number;
  status: string;
  error: string;
  note?: string;
  managed?: boolean;
  heartbeat?: boolean;
  delivery: string;
};
type Run = {
  at: number;
  status: "ok" | "error" | "skipped" | "unknown";
  durationMs: number;
  tokens: number;
  model: string;
  error: string;
  note?: string;
  deliveryError: string;
  chat: { key: string; title: string } | null;
};
type RawJob = {
  id: string;
  name: string;
  agentId: string;
  target: "main" | "isolated";
  schedule: { kind: string; expr?: string; tz?: string };
  kind: "agentTurn" | "systemEvent";
  message: string;
  editable: boolean;
  delivery: { mode: "none" | "announce" | "webhook"; channel: string; accountId: string; to?: string };
};
type Channel = { channel: string; accountId: string; name: string; status: string };
type Repeat = "daily" | "weekdays" | "weekly" | "hourly" | "custom" | "keep";

const DAY = 86400000;
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const APPS: Record<string, string> = {
  whatsapp: "WhatsApp",
  discord: "Discord",
  telegram: "Telegram",
  slack: "Slack",
  signal: "Signal",
  imessage: "iMessage",
};
const appName = (c: string) => APPS[c] || c;
const when = (ms: number) =>
  new Date(ms).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const took = (ms: number) => {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
};
const tokens = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k tokens` : `${n} tokens`);
const STATUS = { ok: "Done", error: "Failed", skipped: "Skipped", unknown: "Unknown" };

// The form's choices from a cron expression; anything else stays custom.
function choicesFor(expr = "") {
  const m = /^(\d{1,2}) (\d{1,2}|\*) \* \* (\*|1-5|[0-7])$/.exec(expr.trim().replace(/\s+/g, " "));
  const pad = (n: string) => n.padStart(2, "0");
  if (!m) return { repeat: "custom" as Repeat, time: "09:00", day: 1 };
  const [, min, hour, week] = m;
  if (hour === "*") return week === "*" ? { repeat: "hourly" as Repeat, time: `00:${pad(min)}`, day: 1 } : { repeat: "custom" as Repeat, time: "09:00", day: 1 };
  const time = `${pad(hour)}:${pad(min)}`;
  if (week === "*") return { repeat: "daily" as Repeat, time, day: 1 };
  if (week === "1-5") return { repeat: "weekdays" as Repeat, time, day: 1 };
  return { repeat: "weekly" as Repeat, time, day: Number(week) % 7 };
}
// Five fields the server takes; "@daily" or a seconds field stay as they are.
const plain = (expr = "") => {
  const f = expr.trim().split(/\s+/);
  return f.length === 5 && f.every((x) => /^[\d*/,\-A-Za-z?]{1,40}$/.test(x));
};
const destOf = (d: RawJob["delivery"]) =>
  d.mode === "webhook"
    ? "keep"
    : d.mode !== "announce"
      ? "none"
      : !d.channel || d.channel === "last"
        ? "last"
        : `ch:${d.channel}:${d.accountId}`;

// Edit and past runs of one schedule, inside its card.
export function ClawScheduleMore({
  peer,
  job,
  canEdit,
  onChanged,
}: {
  peer: Peer;
  job: ClawJob;
  canEdit: boolean;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState<"" | "history" | "edit">("");
  const failed = job.status === "error" && job.lastRunAt > Date.now() - DAY;
  const pill = (name: "history" | "edit", label: string) => (
    <button
      type="button"
      className={`claw-sched-pill${open === name ? " on" : ""}`}
      aria-expanded={open === name}
      aria-label={`${label} ${job.name}`}
      onClick={() => setOpen(open === name ? "" : name)}
    >
      {label}
    </button>
  );
  return (
    <div className="claw-sched-more">
      {failed && (
        <div className="claw-sched-failed" role="status">
          <strong>Failed last run</strong>
          <span>{job.error || when(job.lastRunAt)}</span>
        </div>
      )}
      <div className="claw-sched-pills">
        {pill("history", "History")}
        {canEdit && pill("edit", "Edit")}
      </div>
      {open === "history" && <RunHistory peer={peer} id={job.id} />}
      {open === "edit" && (
        <EditSchedule
          peer={peer}
          id={job.id}
          onCancel={() => setOpen("")}
          onSaved={() => {
            setOpen("");
            onChanged();
          }}
        />
      )}
    </div>
  );
}

function RunHistory({ peer, id }: { peer: Peer; id: string }) {
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [more, setMore] = useState<number | null>(null);
  const [none, setNone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const load = async (offset: number, signal?: AbortSignal) => {
    setBusy(true);
    setProblem("");
    try {
      const data = await request<{ supported: boolean; runs?: Run[]; hasMore?: boolean; nextOffset?: number | null }>(
        peer,
        `${clawBase}/automations/history?id=${encodeURIComponent(id)}&offset=${offset}`,
        { signal },
      );
      if (signal?.aborted) return;
      if (!data.supported) return setNone(true);
      setRuns((old) => [...(offset ? old || [] : []), ...(data.runs || [])]);
      setMore(data.hasMore && typeof data.nextOffset === "number" ? data.nextOffset : null);
    } catch (e) {
      if (!signal?.aborted) setProblem((e as Error).message);
    } finally {
      if (!signal?.aborted) setBusy(false);
    }
  };
  useEffect(() => {
    const abort = new AbortController();
    void load(0, abort.signal);
    return () => abort.abort();
  }, [peer, id]);
  if (none) return <p className="claw-note">Not available in this OpenClaw.</p>;
  return (
    <div className="claw-sched-runs" aria-label="Past runs">
      {runs && !runs.length && <p className="claw-note">No runs yet.</p>}
      {!!runs?.length && (
        <ul>
          {runs.map((r, i) => (
            <li key={`${r.at}-${i}`}>
              <div className="claw-sched-run">
                <span className="claw-sched-when">{when(r.at)}</span>
                <span className={`claw-badge ${r.status === "error" ? "error" : r.status === "ok" ? "connected" : ""}`}>
                  {STATUS[r.status] || STATUS.unknown}
                </span>
              </div>
              <div className="claw-sched-meta">
                {!!r.durationMs && <span>{took(r.durationMs)}</span>}
                {!!r.tokens && <span>{tokens(r.tokens)}</span>}
                {r.note && <span>{r.note}</span>}
                {r.chat && <span className="claw-sched-chat">{r.chat.title}</span>}
              </div>
              {(r.error || r.deliveryError) && <p className="claw-sched-error">{r.error || r.deliveryError}</p>}
            </li>
          ))}
        </ul>
      )}
      {problem && (
        <p className="claw-error" role="alert">
          {problem}
        </p>
      )}
      {(busy || more !== null) && (
        <button type="button" className="claw-sched-pill" disabled={busy} onClick={() => more !== null && void load(more)}>
          {busy ? <LoaderCircle size={13} className="spin" /> : "More runs"}
        </button>
      )}
    </div>
  );
}

function EditSchedule({
  peer,
  id,
  onCancel,
  onSaved,
}: {
  peer: Peer;
  id: string;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const { catalog } = useClawCatalog(peer);
  const [job, setJob] = useState<RawJob | null>(null);
  const [none, setNone] = useState(false);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [name, setName] = useState("");
  const [message, setMessage] = useState("");
  const [repeat, setRepeat] = useState<Repeat>("daily");
  const [time, setTime] = useState("09:00");
  const [day, setDay] = useState(1);
  const [custom, setCustom] = useState("");
  const [tz, setTz] = useState("");
  const [agentId, setAgentId] = useState("");
  const [dest, setDest] = useState("none");
  const [to, setTo] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const deviceTz = Intl.DateTimeFormat().resolvedOptions().timeZone || "";
  useEffect(() => {
    const abort = new AbortController();
    request<{ supported: boolean; job?: RawJob }>(peer, `${clawBase}/automations/job?id=${encodeURIComponent(id)}`, {
      signal: abort.signal,
    })
      .then((data) => {
        if (abort.signal.aborted) return;
        if (!data.supported || !data.job?.editable) return setNone(true);
        const j = data.job;
        setJob(j);
        setName(j.name);
        setMessage(j.message);
        setAgentId(j.agentId);
        if (j.schedule.kind === "cron" && plain(j.schedule.expr)) {
          const c = choicesFor(j.schedule.expr);
          setRepeat(c.repeat);
          setTime(c.time);
          setDay(c.day);
          setCustom(j.schedule.expr || "");
          setTz(j.schedule.tz || "");
        } else {
          setRepeat("keep");
          setTz(deviceTz);
        }
        setDest(destOf(j.delivery));
        setTo(j.delivery.to || "");
      })
      .catch((e) => !abort.signal.aborted && setProblem(e.message));
    request<{ channels: Channel[] }>(peer, `${clawBase}/channels`, { signal: abort.signal })
      .then((data) => !abort.signal.aborted && setChannels(Array.isArray(data.channels) ? data.channels : []))
      .catch(() => {});
    return () => abort.abort();
  }, [peer, id]);

  if (none) return <p className="claw-note">Edit this one in OpenClaw.</p>;
  if (!job)
    return problem ? (
      <p className="claw-error" role="alert">
        {problem}
      </p>
    ) : (
      <p className="claw-note" role="status">
        <LoaderCircle size={14} className="spin" />
      </p>
    );

  const expr = repeat === "keep" ? "" : cronFor(repeat, time, day, custom);
  const initialDest = destOf(job.delivery);
  const live = channels.filter((c) => ["connected", "running", "unknown"].includes(c.status));
  const destOptions = [
    ...(initialDest === "keep" ? [["keep", "Webhook"]] : []),
    ["none", "Stay in OpenClaw"],
    ["last", "Last channel"],
    ...live.map((c) => [`ch:${c.channel}:${c.accountId}`, `${appName(c.channel)} · ${c.name}`]),
    ...(initialDest.startsWith("ch:") && !live.some((c) => `ch:${c.channel}:${c.accountId}` === initialDest)
      ? [[initialDest, appName(job.delivery.channel)]]
      : []),
  ];
  const zones = [...new Set([job.schedule.tz || "", deviceTz].filter(Boolean))];
  const scheduleChanged =
    repeat !== "keep" && (!(job.schedule.kind === "cron" && plain(job.schedule.expr)) || expr !== job.schedule.expr || tz !== (job.schedule.tz || ""));
  const destChanged = dest !== initialDest || (dest.startsWith("ch:") && to.trim() !== (job.delivery.to || ""));
  const ready = name.trim() && message.trim() && (repeat === "keep" || expr.split(" ").length === 5);

  return (
    <form
      className="claw-settings claw-schedule-form claw-sched-form"
      aria-label={`Edit ${job.name}`}
      onSubmit={async (e) => {
        e.preventDefault();
        if (!ready || busy) return;
        setBusy(true);
        setProblem("");
        const [, channel, accountId] = dest.split(":");
        try {
          await post(peer, `${clawBase}/automations/edit`, {
            id,
            name,
            message,
            ...(scheduleChanged ? { expr, tz } : {}),
            ...(agentId && agentId !== job.agentId ? { agentId } : {}),
            ...(destChanged && dest !== "keep"
              ? dest.startsWith("ch:")
                ? { delivery: "channel", channel, ...(accountId ? { accountId } : {}), ...(to.trim() ? { to: to.trim() } : {}) }
                : { delivery: dest }
              : {}),
          });
          onSaved();
        } catch (e) {
          setProblem((e as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <label>
        Name
        <input aria-label="Schedule name" maxLength={120} value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label>
        What to do
        <textarea aria-label="What OpenClaw does each time" rows={3} value={message} onChange={(e) => setMessage(e.target.value)} />
      </label>
      <div className="claw-settings-fields">
        <label>
          Repeats
          <select aria-label="How often" value={repeat} onChange={(e) => setRepeat(e.target.value as Repeat)}>
            {!(job.schedule.kind === "cron" && plain(job.schedule.expr)) && <option value="keep">Keep current</option>}
            <option value="daily">Every day</option>
            <option value="weekdays">Weekdays</option>
            <option value="weekly">Every week</option>
            <option value="hourly">Every hour</option>
            <option value="custom">Custom (cron)</option>
          </select>
        </label>
        {repeat === "weekly" && (
          <label>
            Day
            <select aria-label="Day" value={day} onChange={(e) => setDay(Number(e.target.value))}>
              {DAYS.map((d, i) => (
                <option key={d} value={i}>
                  {d}
                </option>
              ))}
            </select>
          </label>
        )}
        {repeat === "custom" ? (
          <label>
            Cron
            <input aria-label="Cron expression" placeholder="0 9 * * 1-5" value={custom} onChange={(e) => setCustom(e.target.value)} />
          </label>
        ) : repeat !== "keep" ? (
          <label>
            {repeat === "hourly" ? "Minute" : "Time"}
            <input aria-label="Time" type="time" value={time} onChange={(e) => setTime(e.target.value)} />
          </label>
        ) : null}
        {repeat !== "keep" && (
          <label>
            Time zone
            <select aria-label="Time zone" value={tz} onChange={(e) => setTz(e.target.value)}>
              {zones.map((z) => (
                <option key={z} value={z}>
                  {z}
                </option>
              ))}
              <option value="">Gateway's</option>
            </select>
          </label>
        )}
        {catalog && catalog.agents.length > 1 && (
          <label>
            Agent
            <select aria-label="Schedule agent" value={agentId || catalog.defaultAgentId} onChange={(e) => setAgentId(e.target.value)}>
              {catalog.agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </label>
        )}
        {job.target === "isolated" && (
          <label>
            Results
            <select aria-label="Where results go" value={dest} onChange={(e) => setDest(e.target.value)}>
              {destOptions.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        )}
        {job.target === "isolated" && dest.startsWith("ch:") && (
          <label>
            To
            <input aria-label="Recipient" maxLength={300} placeholder="Last chat" value={to} onChange={(e) => setTo(e.target.value)} />
          </label>
        )}
      </div>
      {problem && (
        <p className="claw-error" role="alert">
          {problem}
        </p>
      )}
      <div className="claw-settings-actions">
        <button type="button" className="claw-secondary" onClick={onCancel}>
          Cancel
        </button>
        <button className="claw-primary" disabled={!ready || busy}>
          {busy ? <LoaderCircle size={15} className="spin" /> : null}Save
        </button>
      </div>
    </form>
  );
}
