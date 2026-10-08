import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { post, type Peer } from "./api";
import { clawBase, useClawCatalog } from "./OpenClawControls";

// What's missing in OpenClaw, asked for where it's missed: a schedule, a
// channel, a model. What Reach doesn't set up itself (a model's key, a bot's
// token) opens OpenClaw's own setup in a Reach terminal, typed into there.

export function OpenSetup({
  peer,
  section,
  children,
}: {
  peer: Peer;
  section: "model" | "channels";
  children: string;
}) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  return (
    <>
      <button
        type="button"
        className="claw-secondary"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setProblem("");
          try {
            const { terminal } = await post<{ terminal: { id: string } }>(
              peer,
              `${clawBase}/setup`,
              { section },
            );
            window.dispatchEvent(
              new CustomEvent("reach:open-terminal", { detail: terminal.id }),
            );
          } catch (e) {
            setProblem((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? <Loader2 size={14} className="spin" /> : null}
        {children}
      </button>
      {problem && (
        <p className="claw-error" role="alert">
          {problem}
        </p>
      )}
    </>
  );
}

// The model a chat wants isn't offered: OpenClaw offers only models it has
// a key for and allows.
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
      <p>
        OpenClaw offers only the models it has a key for and allows. Add a
        provider's key or allow another model in OpenClaw's setup, then come
        back here.
      </p>
      <code>openclaw configure --section model</code>
      <div className="claw-settings-actions">
        <button type="button" className="claw-secondary" onClick={() => setOpen(false)}>
          Not now
        </button>
        <OpenSetup peer={peer} section="model">
          Open model setup
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

export function ScheduleForm({
  peer,
  onAdded,
  onCancel,
}: {
  peer: Peer;
  onAdded: () => void;
  onCancel: () => void;
}) {
  const { catalog } = useClawCatalog(peer);
  const [name, setName] = useState("");
  const [message, setMessage] = useState("");
  const [repeat, setRepeat] = useState<Repeat>("daily");
  const [time, setTime] = useState("09:00");
  const [day, setDay] = useState(1);
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
