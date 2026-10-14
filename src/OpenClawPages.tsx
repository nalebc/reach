import { ChatCompanion } from "./ChatCompanion";
import { useEffect, useState } from "react";
import {
  AtSign,
  Bot,
  CalendarClock,
  Gamepad2,
  Hash,
  LoaderCircle,
  MessageCircle,
  MessageSquare,
  Plus,
  RotateCw,
  Send,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { post, request, type Peer } from "./api";
import { channelName, usePolling } from "./openclaw-polling";
import { ClawPageTop, ClawRow, ClawSubPage, useClawBack } from "./OpenClawRow";
import { AddChannelForm, OpenSetup, ScheduleForm, WhatsAppLink, type ScheduleDraft } from "./OpenClawSetup";
import { ClawScheduleMore } from "./OpenClawScheduleMore";
import { ClawHealthPill } from "./OpenClawHealth";
import { ClawSpendPill } from "./OpenClawSpend";

// Scheduled and Customize, as the ChatGPT app has them: tasks as cards under
// Active/Paused pills with suggestions in dashed cards, and settings as rows
// in rounded groups. Each thing opens as a page in place, with back (Oct 13:
// no sheets for these); nothing is a wall of text.

const base = "/api/sessions/openclaw";
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const LAST_RUN: Record<string, string> = { ok: "Done", error: "Failed", skipped: "Skipped", running: "Running" };

type Job = {
  id: string;
  name: string;
  agentId: string;
  enabled: boolean;
  schedule: string;
  nextRunAt: number;
  lastRunAt: number;
  status: string;
  error: string;
  // Why a skipped run was skipped, in Reach's words.
  note?: string;
  // OpenClaw's own monitor: it refuses pause, edit and delete.
  managed?: boolean;
  // OpenClaw's heartbeat: turned on and off in its config instead.
  heartbeat?: boolean;
  delivery: string;
};
type Jobs = {
  jobs?: Job[];
  canEdit?: boolean;
  canAdd?: boolean;
  canRun?: boolean;
  canRemove?: boolean;
  canSwitchHeartbeat?: boolean;
  hasMore?: boolean;
  nextOffset?: number;
  version?: string;
};
type Channel = { channel: string; accountId: string; name: string; status: string; error: string };
type Channels = { channels?: Channel[]; canLinkWhatsApp?: boolean; version?: string };

const clock = (h: number, m: number) =>
  new Date(2000, 0, 1, h, m).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
// "3:23 PM", "tomorrow 8:00 AM", or "Oct 12, 9:00 AM".
const when = (ms: number) => {
  const at = new Date(ms);
  const days = Math.round((new Date(at).setHours(0, 0, 0, 0) - new Date().setHours(0, 0, 0, 0)) / 86400000);
  const time = at.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (days === 0) return time;
  if (days === 1) return `tomorrow ${time}`;
  if (days === -1) return `yesterday ${time}`;
  return at.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
};

// "0 8 * * *" → "Daily at 8:00 AM"; anything else stays as written.
export function repeatWords(expr: string) {
  const every = /^\d{1,2} \*\/(\d{1,2}) \* \* \*$/.exec(expr.trim().replace(/\s+/g, " "));
  if (every) return `Every ${every[1]} hours`;
  const m = /^(\d{1,2}) (\d{1,2}|\*) \* \* (\*|1-5|[0-7])$/.exec(expr.trim().replace(/\s+/g, " "));
  if (!m) return expr;
  const [, min, hour, week] = m;
  if (hour === "*") return week === "*" ? "Every hour" : expr;
  const at = clock(Number(hour), Number(min));
  if (week === "*") return `Daily at ${at}`;
  if (week === "1-5") return `Weekdays at ${at}`;
  return `${DAY_NAMES[Number(week) % 7]}s at ${at}`;
}

// A picture for a task, from its name, as ChatGPT gives its tasks one.
const PICTURES: [RegExp, string][] = [
  [/morning|brief|news|digest/i, "☀️"],
  [/mail|inbox/i, "📬"],
  [/job|career|opening|hiring/i, "💼"],
  [/week|plan|review|report/i, "🗂️"],
  [/calendar|meeting|agenda/i, "📅"],
  [/gym|run|walk|health/i, "🏃"],
  [/money|spend|budget|bill/i, "💰"],
  [/remind/i, "⏰"],
];
const pictureFor = (name: string) => PICTURES.find(([re]) => re.test(name))?.[1] || "🗓️";

const SUGGESTIONS: (ScheduleDraft & { line: string })[] = [
  {
    name: "Morning briefing",
    line: "A short roundup of my day and the news I care about.",
    message: "Give me a short morning briefing: today's weather, my calendar, and the news on topics I care about.",
    repeat: "daily",
    time: "08:00",
  },
  {
    name: "Inbox check",
    line: "Scan my email and tell me what needs my attention.",
    message: "Scan my unread email and tell me only what needs my attention.",
    repeat: "weekdays",
    time: "12:00",
  },
  {
    name: "Weekly plan",
    line: "Every Monday, plan my week from my calendar.",
    message: "Look at my calendar and open tasks and draft a plan for this week.",
    repeat: "weekly",
    time: "09:00",
    day: 1,
  },
];

export function ClawScheduled({ peer, refresh, onBack }: { peer: Peer; refresh: number; onBack: () => void }) {
  const [revision, setRevision] = useState(0);
  const [offset, setOffset] = useState(0);
  const [tab, setTab] = useState<"active" | "paused">("active");
  const [openId, setOpenId] = useState("");
  const [draft, setDraft] = useState<ScheduleDraft | null>(null);
  const { data, error } = usePolling<Jobs>(
    peer,
    `${base}/automations?${new URLSearchParams({ offset: String(offset), query: "" })}`,
    10000,
    refresh + revision,
  );
  const changed = () => setRevision((n) => n + 1);
  const jobs = data?.jobs || [];
  const shown = jobs.filter((j) => (tab === "active" ? j.enabled : !j.enabled));
  const named = new Set(jobs.map((j) => j.name.trim().toLowerCase()));
  const suggestions = tab === "active" && data?.canAdd ? SUGGESTIONS.filter((s) => !named.has(s.name.toLowerCase())) : [];
  const opened = jobs.find((j) => j.id === openId);
  useClawBack(!!draft || !!opened, () => {
    setDraft(null);
    setOpenId("");
  }, "reachClawSub");
  if (draft)
    return (
      <ClawSubPage title="New task" backLabel="Back to Scheduled" onBack={() => setDraft(null)}>
        <ScheduleForm
          peer={peer}
          initial={draft}
          onAdded={() => {
            setDraft(null);
            setTab("active");
            changed();
          }}
        />
      </ClawSubPage>
    );
  if (opened)
    return (
      <ClawSubPage title={opened.name} backLabel="Back to Scheduled" onBack={() => setOpenId("")}>
        <TaskDetail
          peer={peer}
          job={opened}
          data={data!}
          onChanged={changed}
          onRemoved={() => {
            setOpenId("");
            changed();
          }}
        />
      </ClawSubPage>
    );
  return (
    <section className="claw-page" aria-label="OpenClaw schedules">
      <ClawPageTop title="Scheduled" onBack={onBack} backLabel="Back to OpenClaw" />
      <div className="claw-segments" role="group" aria-label="Show tasks">
        {(
          [
            ["active", "Active"],
            ["paused", "Paused"],
          ] as const
        ).map(([value, label]) => (
          <button key={value} type="button" aria-pressed={tab === value} onClick={() => setTab(value)}>
            {label}
          </button>
        ))}
      </div>
      {error && (
        <p className="claw-error" role="alert">
          {error}
        </p>
      )}
      {!data && !error && (
        <p className="claw-note" role="status">
          <LoaderCircle size={14} className="spin" />
          Loading tasks…
        </p>
      )}
      {shown.length > 0 && (
        <div className="claw-tasks">
          {shown.map((job) => (
            <button type="button" className="claw-task" key={job.id} onClick={() => setOpenId(job.id)}>
              <span className="claw-task-picture" aria-hidden="true">
                {pictureFor(job.name)}
              </span>
              <span className="claw-task-text">
                <strong>{job.name}</strong>
                <span>
                  {repeatWords(job.schedule)}
                  {job.enabled && job.nextRunAt ? ` · next ${when(job.nextRunAt)}` : ""}
                </span>
                {job.status === "error" && <span className="claw-task-alert">Last run failed</span>}
                {job.status === "running" && <span className="claw-task-live">Running now</span>}
              </span>
            </button>
          ))}
        </div>
      )}
      {data && !shown.length && !suggestions.length && (
        <div className="claw-empty-state">
          <span className="claw-empty-icon" aria-hidden="true">
            <CalendarClock size={18} />
          </span>
          <strong>{tab === "active" ? "No tasks yet" : "Nothing paused"}</strong>
          <p>{tab === "active" ? "OpenClaw can do things for you at set times." : "Paused tasks show here."}</p>
        </div>
      )}
      {suggestions.length > 0 && (
        <>
          <h2 className="claw-label">Recommended</h2>
          <div className="claw-tasks">
            {suggestions.map((s) => (
              <button type="button" className="claw-task suggested" key={s.name} onClick={() => setDraft(s)}>
                <span className="claw-task-picture" aria-hidden="true">
                  {pictureFor(s.name)}
                </span>
                <span className="claw-task-text">
                  <strong>{s.name}</strong>
                  <span>{s.line}</span>
                </span>
              </button>
            ))}
          </div>
        </>
      )}
      {(offset > 0 || data?.hasMore) && (
        <div className="claw-settings-actions">
          <button className="claw-secondary" disabled={!offset} onClick={() => setOffset(Math.max(0, offset - 50))}>
            Previous
          </button>
          <button className="claw-secondary" disabled={!data?.hasMore} onClick={() => setOffset(data?.nextOffset || offset + 50)}>
            More tasks
          </button>
        </div>
      )}
      {data?.canAdd && (
        <button type="button" className="claw-fab" onClick={() => setDraft({ name: "", message: "" })}>
          New task
        </button>
      )}
    </section>
  );
}

function TaskDetail({
  peer,
  job,
  data,
  onChanged,
  onRemoved,
}: {
  peer: Peer;
  job: Job;
  data: Jobs;
  onChanged: () => void;
  onRemoved: () => void;
}) {
  const [busy, setBusy] = useState("");
  const [problem, setProblem] = useState("");
  const [ran, setRan] = useState(false);
  // Deleting asks once: the button turns red until a second tap (or 4 s).
  const [removing, setRemoving] = useState(false);
  useEffect(() => {
    if (!removing) return;
    const timer = setTimeout(() => setRemoving(false), 4000);
    return () => clearTimeout(timer);
  }, [removing]);
  const act = async (what: string, path: string, body: object) => {
    if (busy) return false;
    setBusy(what);
    setProblem("");
    try {
      await post(peer, `${base}/${path}`, body);
      return true;
    } catch (e) {
      setProblem((e as Error).message);
      return false;
    } finally {
      setBusy("");
    }
  };
  // A failure in the last day shows in ClawScheduleMore instead.
  const recentFailure = job.status === "error" && Date.now() - job.lastRunAt < 86400000;
  const switchable = !!job.heartbeat && !!data.canSwitchHeartbeat;
  return (
    <div className="claw-detail">
      <ul className="claw-facts">
        <li>
          <span>Repeats</span>
          <strong>{repeatWords(job.schedule)}</strong>
        </li>
        {job.enabled && !!job.nextRunAt && (
          <li>
            <span>Next run</span>
            <strong>{when(job.nextRunAt)}</strong>
          </li>
        )}
        {!!job.lastRunAt && (
          <li>
            <span>Last run</span>
            <strong>
              {when(job.lastRunAt)} · {LAST_RUN[job.status] || job.status}
            </strong>
          </li>
        )}
        <li>
          <span>Sends to</span>
          <strong>{channelName(job.delivery)}</strong>
        </li>
        <li>
          <span>Agent</span>
          <strong>{job.agentId}</strong>
        </li>
      </ul>
      {job.error && !recentFailure && <p className="claw-error">{job.error}</p>}
      {job.note && <p className="claw-note">{job.note}</p>}
      {job.managed && !switchable && <p className="claw-note">OpenClaw manages this one. Change it in OpenClaw.</p>}
      <ClawScheduleMore peer={peer} job={job} canEdit={!!data.canEdit && !job.managed} onChanged={onChanged} />
      {problem && (
        <p className="claw-error" role="alert">
          {problem}
        </p>
      )}
      <div className="claw-pill-row">
        {data.canRun && (
          <button
            type="button"
            className="claw-pill strong"
            aria-label={`Run ${job.name} now`}
            disabled={!!busy || job.status === "running"}
            onClick={async () => {
              if (await act("run", "automations/run", { id: job.id })) {
                setRan(true);
                onChanged();
              }
            }}
          >
            {busy === "run" && <LoaderCircle size={14} className="spin" />}
            {ran ? "Started" : "Run now"}
          </button>
        )}
        {data.canEdit && !job.managed && (
          <button
            type="button"
            className="claw-pill"
            aria-label={`${job.enabled ? "Pause" : "Resume"} ${job.name}`}
            disabled={!!busy}
            onClick={async () => {
              if (await act("pause", "automations", { id: job.id, enabled: !job.enabled })) onChanged();
            }}
          >
            {busy === "pause" && <LoaderCircle size={14} className="spin" />}
            {job.enabled ? "Pause" : "Resume"}
          </button>
        )}
        {switchable && (
          <button
            type="button"
            className="claw-pill"
            aria-label={`Turn ${job.enabled ? "off" : "on"} ${job.name}`}
            disabled={!!busy}
            onClick={async () => {
              if (await act("pause", "automations/heartbeat", { id: job.id, on: !job.enabled })) onChanged();
            }}
          >
            {busy === "pause" && <LoaderCircle size={14} className="spin" />}
            {job.enabled ? "Turn off" : "Turn on"}
          </button>
        )}
        {data.canRemove && !job.managed && (
          <button
            type="button"
            className={`claw-pill danger${removing ? " claw-delete-ask" : ""}`}
            aria-label={removing ? `Tap again to delete ${job.name}` : `Delete ${job.name}`}
            disabled={!!busy}
            onClick={async () => {
              if (!removing) return setRemoving(true);
              setRemoving(false);
              if (await act("remove", "automations/remove", { id: job.id })) onRemoved();
            }}
          >
            {busy === "remove" && <LoaderCircle size={14} className="spin" />}
            {removing ? "Tap again to delete" : "Delete"}
          </button>
        )}
      </div>
    </div>
  );
}

// Each messaging app's picture and colour, as the ChatGPT app tints its rows.
const APP_LOOK: Record<string, [typeof AtSign, string]> = {
  whatsapp: [MessageCircle, "green"],
  imessage: [MessageCircle, "green"],
  telegram: [Send, "blue"],
  discord: [Gamepad2, "indigo"],
  slack: [Hash, "plum"],
  signal: [MessageSquare, "blue"],
};
const appIcon = (channel: string) => {
  const [Icon, tint] = APP_LOOK[channel] || [AtSign, "gray"];
  return { icon: <Icon size={19} />, tint };
};
const STATUS_WORD: Record<string, string> = {
  connected: "Connected",
  disconnected: "Disconnected",
  unconfigured: "Connect",
  unknown: "Unknown",
};

export function ClawCustomize({
  peer,
  refresh,
  onBack,
  onOpen,
  deviceRequests,
  onReviewDevice,
  onChanged,
}: {
  peer: Peer;
  refresh: number;
  onBack: () => void;
  onOpen: (page: "agents" | "skills") => void;
  deviceRequests: number;
  onReviewDevice: () => void;
  onChanged: () => void;
}) {
  const [revision, setRevision] = useState(0);
  const [sheet, setSheet] = useState<"" | "add" | "link" | "relink" | `app:${string}`>("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const { data, error } = usePolling<Channels>(peer, `${base}/channels`, 10000, refresh + revision);
  const changed = () => setRevision((n) => n + 1);
  const channels = data?.channels || [];
  const whatsapp = channels.find((c) => c.channel === "whatsapp");
  const unlinked = !!data?.canLinkWhatsApp && (!whatsapp || whatsapp.status === "unconfigured");
  const listed = channels.filter((c) => !(unlinked && c === whatsapp));
  const openApp = channels.find((c) => sheet === `app:${c.channel}:${c.accountId}`);
  const back = () => setSheet("");
  useClawBack(sheet === "link" || sheet === "relink" || sheet === "add" || !!openApp, back, "reachClawSub");
  if (sheet === "link" || sheet === "relink")
    return (
      <ClawSubPage title="WhatsApp" backLabel="Back to Customize" onBack={back}>
        <WhatsAppLink peer={peer} relink={sheet === "relink"} onCancel={back} onDone={changed} />
      </ClawSubPage>
    );
  if (sheet === "add")
    return (
      <ClawSubPage title="Add a messaging app" backLabel="Back to Customize" onBack={back}>
        <AddChannelForm
          peer={peer}
          onAdded={() => {
            back();
            changed();
          }}
        />
        <div className="claw-group">
          <OpenSetup peer={peer} section="channels" row sub="Signal, iMessage, Matrix…">
            Other apps
          </OpenSetup>
        </div>
      </ClawSubPage>
    );
  if (openApp)
    return (
      <ClawSubPage title={channelName(openApp.channel)} backLabel="Back to Customize" onBack={back}>
        <ul className="claw-facts">
          <li>
            <span>Account</span>
            <strong>{openApp.name}</strong>
          </li>
          <li>
            <span>Status</span>
            <strong className={openApp.status === "connected" ? "" : "alert"}>
              {STATUS_WORD[openApp.status] || openApp.status}
            </strong>
          </li>
        </ul>
        {openApp.error && <p className="claw-error">{openApp.error}</p>}
        {openApp.channel === "whatsapp" &&
          data?.canLinkWhatsApp &&
          ["disconnected", "unknown"].includes(openApp.status) && (
            <div className="claw-pill-row">
              <button type="button" className="claw-pill strong" onClick={() => setSheet("relink")}>
                Link again with a new QR
              </button>
            </div>
          )}
      </ClawSubPage>
    );
  return (
    <section className="claw-page" aria-label="Customize OpenClaw">
      <ClawPageTop
        title="Customize"
        onBack={onBack}
        backLabel="Back to OpenClaw"
        action={
          <button
            type="button"
            className="claw-round"
            aria-label="Refresh channel status"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setProblem("");
              try {
                await request(peer, `${base}/channels?refresh=1`);
                changed();
                onChanged();
              } catch (e) {
                setProblem((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? <LoaderCircle size={18} className="spin" /> : <RotateCw size={18} />}
          </button>
        }
      />
      <ChatCompanion title="Make OpenClaw yours">Set up your agents, skills and connections.</ChatCompanion>
      {(error || problem) && (
        <p className="claw-error" role="alert">
          {error || problem}
        </p>
      )}
      <div className="claw-group">
        <ClawRow icon={<Bot size={19} />} tint="purple" label="Agents" onClick={() => onOpen("agents")} />
        <ClawRow icon={<Sparkles size={19} />} tint="amber" label="Skills" onClick={() => onOpen("skills")} />
        <ClawSpendPill peer={peer} refresh={refresh} row />
      </div>
      <div className="claw-group" role="group" aria-label="Messaging apps">
        {!data && !error && (
          <p className="claw-note claw-group-note" role="status">
            <LoaderCircle size={14} className="spin" />
            Loading apps…
          </p>
        )}
        {unlinked && (
          <ClawRow
            {...appIcon("whatsapp")}
            label="WhatsApp"
            value="Connect"
            tone="action"
            ariaLabel="Connect WhatsApp"
            onClick={() => setSheet("link")}
          />
        )}
        {listed.map((c) => (
          <ClawRow
            key={`${c.channel}:${c.accountId}`}
            {...appIcon(c.channel)}
            label={channelName(c.channel)}
            sub={c.name}
            value={STATUS_WORD[c.status] || c.status}
            tone={c.status === "connected" ? "" : c.status === "unconfigured" ? "action" : "alert"}
            onClick={() => setSheet(`app:${c.channel}:${c.accountId}`)}
          />
        ))}
        <ClawRow
          icon={<Plus size={19} />}
          tint="gray"
          label="Add a messaging app"
          onClick={() => setSheet("add")}
        />
      </div>
      <div className="claw-group">
        <ClawHealthPill peer={peer} refresh={refresh} onChanged={onChanged} row />
        {!!deviceRequests && (
          <ClawRow
            icon={<ShieldCheck size={19} />}
            tint="amber"
            label="Device requests"
            value={String(deviceRequests)}
            tone="alert"
            ariaLabel={`Review ${deviceRequests} device ${deviceRequests === 1 ? "request" : "requests"}`}
            onClick={onReviewDevice}
          />
        )}
      </div>
    </section>
  );
}
