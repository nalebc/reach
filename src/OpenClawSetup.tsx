import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { post, type Peer } from "./api";
import { clawBase, useClawCatalog } from "./OpenClawControls";
import { ClawWizard } from "./OpenClawWizard";
import { ClawAddProvider } from "./OpenClawOnboard";

// Advanced setup uses OpenClaw's structured questions inside Reach.
export function OpenSetup({ peer, children }: {
  peer: Peer;
  section: "model" | "channels" | "skills";
  children: string;
}) {
  const [open, setOpen] = useState(false);
  return <>
    <button type="button" className="claw-secondary" onClick={() => setOpen(true)}>{children}</button>
    {open && <ClawWizard key={`${peer.id}:${peer.url}:${peer.token}`} peer={peer} onClose={() => setOpen(false)} />}
  </>;
}

// The model a chat wants isn't offered: OpenClaw offers only models it has
// a key for and allows. A provider's key goes in here (Oct 8: all setup in
// Reach); allowing another model stays in OpenClaw's own setup.
export function AddModelPrompt({ peer }: { peer: Peer }) {
  const [open, setOpen] = useState(false);
  if (!open)
    return (
      <button type="button" className="claw-link" onClick={() => setOpen(true)}>
        Model not listed? Add one
      </button>
    );
  return (
    <div className="claw-missing" role="group" aria-label="Add a model to OpenClaw">
      <ClawAddProvider peer={peer} onDone={() => setOpen(false)} onCancel={() => setOpen(false)} />
      <div className="claw-settings-actions">
        <OpenSetup peer={peer} section="model">
          More model options
        </OpenSetup>
      </div>
    </div>
  );
}

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
type Repeat = "daily" | "weekdays" | "weekly" | "hourly" | "custom";
export function cronFor(repeat: Repeat, time: string, day: number, custom: string) {
  const [h, m] = (time || "09:00").split(":").map((n) => Number(n) || 0);
  if (repeat === "hourly") return `${m} * * * *`;
  if (repeat === "daily") return `${m} ${h} * * *`;
  if (repeat === "weekdays") return `${m} ${h} * * 1-5`;
  if (repeat === "weekly") return `${m} ${h} * * ${day}`;
  return custom.trim().replace(/\s+/g, " ");
}

export type ScheduleDraft = { name: string; message: string; repeat?: Repeat; time?: string; day?: number };
export function ScheduleForm({
  peer,
  onAdded,
  onCancel,
  initial,
}: {
  peer: Peer;
  onAdded: () => void;
  onCancel: () => void;
  // A suggestion tapped on Scheduled: its words, still editable.
  initial?: ScheduleDraft;
}) {
  const { catalog } = useClawCatalog(peer);
  const [name, setName] = useState(initial?.name || "");
  const [message, setMessage] = useState(initial?.message || "");
  const [repeat, setRepeat] = useState<Repeat>(initial?.repeat || "daily");
  const [time, setTime] = useState(initial?.time || "09:00");
  const [day, setDay] = useState(initial?.day ?? 1);
  const [custom, setCustom] = useState("");
  const [agentId, setAgentId] = useState("");
  const [announce, setAnnounce] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "";
  const expr = cronFor(repeat, time, day, custom);
  const ready = name.trim() && message.trim() && expr.split(" ").length === 5;
  return (
    <form
      className="claw-settings claw-schedule-form"
      aria-label="New OpenClaw schedule"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!ready || busy) return;
        setBusy(true);
        setProblem("");
        try {
          await post(peer, `${clawBase}/automations/new`, {
            name,
            message,
            expr,
            ...(repeat !== "custom" && tz ? { tz } : {}),
            ...(agentId ? { agentId } : {}),
            announce,
          });
          onAdded();
        } catch (e) {
          setProblem((e as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <label>
        Name
        <input
          aria-label="Schedule name"
          maxLength={120}
          placeholder="Morning briefing"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      <label>
        What OpenClaw does each time
        <textarea
          aria-label="What OpenClaw does each time"
          rows={3}
          placeholder="Summarize my unread messages"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
        />
      </label>
      <div className="claw-settings-fields">
        <label>
          Repeats
          <select
            aria-label="How often"
            value={repeat}
            onChange={(e) => setRepeat(e.target.value as Repeat)}
          >
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
            <input
              aria-label="Cron expression"
              placeholder="0 9 * * 1-5"
              value={custom}
              onChange={(e) => setCustom(e.target.value)}
            />
          </label>
        ) : (
          <label>
            {repeat === "hourly" ? "Minute" : "Time"}
            <input
              aria-label="Time"
              type="time"
              value={time}
              onChange={(e) => setTime(e.target.value)}
            />
          </label>
        )}
      </div>
      {catalog && catalog.agents.length > 1 && (
        <label>
          Agent
          <select
            aria-label="Schedule agent"
            value={agentId || catalog.defaultAgentId}
            onChange={(e) => setAgentId(e.target.value)}
          >
            {catalog.agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <label className="claw-check">
        <input
          type="checkbox"
          checked={announce}
          onChange={(e) => setAnnounce(e.target.checked)}
        />
        Also send the result to the channel I last used
      </label>
      <p className="claw-note">
        {repeat === "custom" ? "Runs in the Gateway's time zone." : tz ? `Times are in ${tz}.` : ""}
      </p>
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
          {busy ? <Loader2 size={15} className="spin" /> : null}Add schedule
        </button>
      </div>
    </form>
  );
}

// WhatsApp links by a QR scanned in WhatsApp → Linked devices on the phone
// that has it, so one shown on that same phone needs another screen (the
// Mac's Reach, or a second device).
export function WhatsAppLink({
  peer,
  relink = false,
  onDone,
  onCancel,
}: {
  peer: Peer;
  relink?: boolean;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [step, setStep] = useState<"" | "confirm" | "starting" | "qr" | "linked">(
    relink ? "confirm" : "",
  );
  const [qr, setQr] = useState("");
  const [note, setNote] = useState("");
  const [problem, setProblem] = useState("");
  const alive = useRef(true);
  useEffect(() => () => void (alive.current = false), []);
  const start = async () => {
    setStep("starting");
    setProblem("");
    try {
      const r = await post<{ qr: string; message: string }>(
        peer,
        `${clawBase}/channels/whatsapp/link`,
        relink ? { relink: true } : {},
      );
      if (!alive.current) return;
      if (!r.qr) {
        setProblem(r.message || "OpenClaw didn't give a QR. Try again.");
        setStep("");
        return;
      }
      setQr(r.qr);
      setNote(r.message);
      setStep("qr");
    } catch (e) {
      if (!alive.current) return;
      setProblem((e as Error).message);
      setStep("");
    }
  };
  useEffect(() => {
    if (step === "") void start();
  }, []);
  // While the QR shows: OpenClaw is asked, a while at a time, if it was scanned.
  useEffect(() => {
    if (step !== "qr") return;
    let stopped = false;
    void (async () => {
      for (let i = 0; i < 9 && !stopped; i++) {
        try {
          const r = await post<{ connected: boolean; message: string }>(
            peer,
            `${clawBase}/channels/whatsapp/wait`,
            {},
          );
          if (stopped || !alive.current) return;
          if (r.connected) {
            setStep("linked");
            onDone();
            return;
          }
          if (/expired|failed|logged out|No active/i.test(r.message)) {
            setProblem(r.message);
            setStep("");
            setQr("");
            return;
          }
        } catch (e) {
          if (stopped || !alive.current) return;
          setProblem((e as Error).message);
          return;
        }
      }
      if (!stopped && alive.current) {
        setProblem("The QR expired. Get a new one to try again.");
        setStep("");
        setQr("");
      }
    })();
    return () => {
      stopped = true;
    };
  }, [step]);
  return (
    <div className="claw-missing claw-whatsapp" role="group" aria-label="Link WhatsApp">
      {step === "confirm" ? (
        <>
          <p>
            Linking again logs WhatsApp out of OpenClaw first, then shows a new
            QR. OpenClaw stops answering on WhatsApp until it's scanned.
          </p>
          <div className="claw-settings-actions">
            <button type="button" className="claw-secondary" onClick={onCancel}>
              Cancel
            </button>
            <button type="button" className="claw-primary" onClick={() => void start()}>
              Log out and link again
            </button>
          </div>
        </>
      ) : step === "starting" ? (
        <p className="claw-note" role="status">
          <Loader2 size={14} className="spin" /> Getting a QR from OpenClaw…
        </p>
      ) : step === "qr" ? (
        <>
          <img src={qr} alt="WhatsApp link QR code" width={240} height={240} />
          <p>
            On the phone with WhatsApp: Settings → Linked devices → Link a
            device, then scan this code.
          </p>
          <p className="claw-note">
            Is WhatsApp on this phone? Open this page in Reach on your Mac (or
            another device) and scan it from there.{note ? ` ${note}` : ""}
          </p>
          <p className="claw-note" role="status">
            <Loader2 size={14} className="spin" /> Waiting for the scan…
          </p>
          <div className="claw-settings-actions">
            <button type="button" className="claw-secondary" onClick={onCancel}>
              Close
            </button>
          </div>
        </>
      ) : step === "linked" ? (
        <p role="status">WhatsApp is linked. OpenClaw answers there now.</p>
      ) : (
        <>
          {problem && (
            <p className="claw-error" role="alert">
              {problem}
            </p>
          )}
          <div className="claw-settings-actions">
            <button type="button" className="claw-secondary" onClick={onCancel}>
              Close
            </button>
            <button type="button" className="claw-primary" onClick={() => void start()}>
              Get a new QR
            </button>
          </div>
        </>
      )}
    </div>
  );
}

// A messaging app added by its bot token, in Reach: OpenClaw checks it,
// keeps it, and starts the channel. Other apps (Signal, Matrix, iMessage…)
// still use OpenClaw's own setup.
const TOKEN_APPS = {
  telegram: {
    name: "Telegram",
    how: "In Telegram, message @BotFather, send /newbot, and copy the token it gives you.",
    fields: [["token", "Bot token", "123456789:AA…"]],
  },
  discord: {
    name: "Discord",
    how: "In the Discord Developer Portal: your app → Bot → Reset Token, and turn on Message Content Intent.",
    fields: [["token", "Bot token", "MTA…"]],
  },
  slack: {
    name: "Slack",
    how: "In your Slack app: turn on Socket Mode, then copy the Bot User OAuth Token and an app-level token with connections:write.",
    fields: [
      ["botToken", "Bot token", "xoxb-…"],
      ["appToken", "App token", "xapp-…"],
    ],
  },
} as const;
type TokenApp = keyof typeof TOKEN_APPS;

export function AddChannelForm({
  peer,
  onAdded,
  onCancel,
}: {
  peer: Peer;
  onAdded: () => void;
  onCancel: () => void;
}) {
  const [app, setApp] = useState<TokenApp>("telegram");
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const [added, setAdded] = useState("");
  const spec = TOKEN_APPS[app];
  const ready = spec.fields.every(([key]) => (values[key] || "").trim().length >= 8);
  if (added)
    return (
      <div className="claw-missing" role="status">
        <p>{added} is added. OpenClaw is connecting it now; Refresh in a moment to see it connected.</p>
        <div className="claw-settings-actions">
          <button type="button" className="claw-primary" onClick={onAdded}>
            Done
          </button>
        </div>
      </div>
    );
  return (
    <form
      className="claw-settings claw-schedule-form claw-channel-form"
      aria-label="Add a messaging app to OpenClaw"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!ready || busy) return;
        setBusy(true);
        setProblem("");
        try {
          await post(peer, `${clawBase}/channels/add`, {
            channel: app,
            ...Object.fromEntries(spec.fields.map(([key]) => [key, (values[key] || "").trim()])),
          });
          setValues({});
          setAdded(spec.name);
        } catch (e) {
          setProblem((e as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <div className="claw-app-choice" role="radiogroup" aria-label="Messaging app">
        {(Object.keys(TOKEN_APPS) as TokenApp[]).map((key) => (
          <button
            key={key}
            type="button"
            role="radio"
            aria-checked={app === key}
            className={app === key ? "on" : ""}
            onClick={() => {
              setApp(key);
              setValues({});
              setProblem("");
            }}
          >
            {TOKEN_APPS[key].name}
          </button>
        ))}
      </div>
      <p className="claw-note">{spec.how}</p>
      {spec.fields.map(([key, label, placeholder]) => (
        <label key={key}>
          {label}
          <input
            aria-label={`${spec.name} ${label.toLowerCase()}`}
            type="password"
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            placeholder={placeholder}
            value={values[key] || ""}
            onChange={(e) => setValues((v) => ({ ...v, [key]: e.target.value }))}
          />
        </label>
      ))}
      <p className="claw-note">The token goes to OpenClaw on your computer. Reach doesn't keep it.</p>
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
          {busy ? <Loader2 size={15} className="spin" /> : null}Add {spec.name}
        </button>
      </div>
    </form>
  );
}
