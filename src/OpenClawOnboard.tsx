import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check, LoaderCircle, ShieldAlert } from "lucide-react";
import { request, post, type Peer } from "./api";
import { installAgent, type InstallPlan } from "./agent-sessions";
import { computerWord } from "./pause";
import { BrandCourier } from "./ReachIdentity";
import "./openclaw-onboard.css";

// Installing and setting up OpenClaw from the phone (server/openclaw-onboard.mjs).
// Keys go to OpenClaw on the computer; Reach keeps none, here or there.
// Laid out as the ChatGPT app starts things (Oct 13): the mascot, a title,
// one line, choices as rows with a check, one white pill.
const base = "/api/sessions/openclaw";
type Setup = { state: "running" | "done" | "partial" | "failed"; provider: string; error?: string };
type Status = { installed: boolean; configured: boolean; supported: boolean; providers: string[]; setup?: Setup | null };

// Setup runs on the computer for up to 3 minutes, past a phone's request:
// look at it until it ends (a few minutes at most), then start the Gateway.
// A setup whose service didn't install may still start; if not, say why.
async function finishSetup(peer: Peer) {
  const until = Date.now() + 4 * 60_000;
  let setup: Setup | null | undefined;
  for (;;) {
    try {
      setup = (await request<Status>(peer, `${base}/onboard/status`)).setup;
    } catch {
      /* the next look tells */
    }
    if (setup && setup.state !== "running") break;
    if (Date.now() > until) throw new Error("OpenClaw is still setting up. Check again in a moment.");
    await new Promise((r) => setTimeout(r, 1500));
  }
  const end = setup as Setup;
  if (end.state !== "done" && end.state !== "partial") throw new Error(end.error || "OpenClaw didn't finish setting up.");
  try {
    await post(peer, `${base}/gateway/start`, {});
  } catch (e) {
    // Set up, with a Gateway slow to start: Start shows next.
    if (end.state === "partial") throw new Error(end.error || (e as Error).message);
  }
}
const NAMES: Record<string, string> = {
  openrouter: "OpenRouter",
  anthropic: "Anthropic",
  openai: "OpenAI",
  google: "Google",
};
const KEYED = ["openrouter", "anthropic", "openai", "google"];

// Provider pills and a key field; the key is cleared once OpenClaw has it.
function KeyForm({
  providers,
  initial,
  action,
  busyLabel,
  label,
  extra,
  send,
  onCancel,
}: {
  providers: string[];
  initial?: string;
  action: string;
  busyLabel?: string;
  label: string;
  extra?: ReactNode;
  send: (provider: string, key: string) => Promise<void>;
  onCancel?: () => void;
}) {
  const [provider, setProvider] = useState(initial && providers.includes(initial) ? initial : providers[0]);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const ready = key.trim().length >= 8;
  return (
    <form
      className="claw-onboard-form"
      aria-label={label}
      onSubmit={async (e) => {
        e.preventDefault();
        if (!ready || busy) return;
        setBusy(true);
        setProblem("");
        try {
          await send(provider, key.trim());
          setKey("");
        } catch (e) {
          setProblem((e as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <div className="claw-onboard-providers" role="radiogroup" aria-label="Provider">
        {providers.map((p) => (
          <button
            key={p}
            type="button"
            role="radio"
            aria-checked={provider === p}
            className={provider === p ? "on" : ""}
            disabled={busy}
            onClick={() => {
              setProvider(p);
              setProblem("");
            }}
          >
            {NAMES[p] || p}
            <Check size={19} strokeWidth={2.4} aria-hidden="true" />
          </button>
        ))}
      </div>
      <input
        aria-label={`${NAMES[provider]} API key`}
        type="password"
        autoComplete="off"
        autoCapitalize="off"
        spellCheck={false}
        placeholder="API key"
        value={key}
        disabled={busy}
        onChange={(e) => setKey(e.target.value)}
      />
      {extra}
      {problem && (
        <p className="claw-error" role="alert">
          {problem}
        </p>
      )}
      <div className="claw-onboard-actions">
        <button type="submit" className="claw-onboard-cta" disabled={!ready || busy}>
          {busy && <LoaderCircle size={16} className="spin" />}
          {busy ? busyLabel || `${action}…` : action}
        </button>
        {onCancel && (
          <button type="button" className="claw-onboard-quiet" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}

// OpenClaw's own installer: its command first, then a Reach terminal.
function InstallRow({ peer, recheck }: { peer: Peer; recheck: () => void }) {
  const [plan, setPlan] = useState<InstallPlan | null>(null);
  const [step, setStep] = useState<"" | "confirm" | "running" | "failed">("");
  const [line, setLine] = useState("");
  const [problem, setProblem] = useState("");
  const terminal = useRef("");
  useEffect(() => {
    if (step !== "running") return;
    const timer = setInterval(async () => {
      try {
        const list = await request<{ id: string; status: string; exitCode?: number; preview?: string }[]>(peer, "/api/terminals");
        const t = list.find((x) => x.id === terminal.current);
        if (t?.preview) setLine(t.preview.trim().split("\n").pop() || "");
        if (t?.status === "running") return;
        if (!t) setLine("");
        setStep(t?.exitCode === 0 ? "" : "failed");
        recheck();
      } catch {
        /* the next look tells */
      }
    }, 2000);
    return () => clearInterval(timer);
  }, [step]);
  const ask = async () => {
    setProblem("");
    try {
      setPlan(await installAgent(peer, "openclaw"));
      setStep("confirm");
    } catch (e) {
      setProblem((e as Error).message);
    }
  };
  const run = async () => {
    setProblem("");
    try {
      const started = await installAgent(peer, "openclaw", true);
      terminal.current = started.terminal?.id || "";
      setLine("");
      setStep("running");
    } catch (e) {
      setProblem((e as Error).message);
      setStep("");
    }
  };
  return (
    <section className="claw-onboard" aria-label="Install OpenClaw">
      <OnboardHero title="Install OpenClaw" busy={step === "running"}>
        {step === "running"
          ? `Installing on your ${computerWord(peer.platform)}…`
          : `Your own AI assistant, on your ${computerWord(peer.platform)} and your messaging apps.`}
      </OnboardHero>
      {step === "confirm" && plan && <pre className="claw-onboard-command">{plan.command}</pre>}
      {(step === "running" || step === "failed") && line && <code className="claw-onboard-line">{line}</code>}
      {step === "failed" && <p className="claw-error">The install stopped.</p>}
      {problem && (
        <p className="claw-error" role="alert">
          {problem}
        </p>
      )}
      {step === "confirm" && plan ? (
        <div className="claw-onboard-actions">
          <button type="button" className="claw-onboard-cta" onClick={() => void run()}>
            Run on {computerWord(peer.platform)}
          </button>
          <button type="button" className="claw-onboard-quiet" onClick={() => setStep("")}>
            Cancel
          </button>
        </div>
      ) : step === "" || step === "failed" ? (
        <div className="claw-onboard-actions">
          <button type="button" className="claw-onboard-cta" onClick={() => void ask()}>
            {step === "failed" ? "Try again" : "Install"}
          </button>
        </div>
      ) : null}
    </section>
  );
}

// The mascot over a title and one line (a spinner while something runs).
function OnboardHero({ title, busy = false, children }: { title: string; busy?: boolean; children?: ReactNode }) {
  return (
    <div className="claw-onboard-hero">
      <span className="claw-onboard-mascot" aria-hidden="true">
        <BrandCourier active={busy} />
      </span>
      <h2>
        {title}
        {busy && <LoaderCircle size={16} className="spin" aria-label="Working" />}
      </h2>
      {children && <p>{children}</p>}
    </div>
  );
}

// No OpenClaw (or no model) on this computer: install and set it up here.
export function ClawOnboard({ peer, onDone }: { peer: Peer; onDone: () => void }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [check, setCheck] = useState(0);
  useEffect(() => {
    let live = true;
    request<Status>(peer, `${base}/onboard/status`)
      .then((s) => live && setStatus(s))
      .catch(() => live && setStatus(null));
    return () => {
      live = false;
    };
  }, [peer, check]);
  if (!status || !status.supported) return null;
  // Opened again while a setup runs (OpenClaw writes its config early).
  if (status.setup?.state === "running") return <SetupRunning peer={peer} onDone={onDone} />;
  if (status.configured) return null;
  if (!status.installed) return <InstallRow peer={peer} recheck={() => setCheck((n) => n + 1)} />;
  return (
    <section className="claw-onboard" aria-label="Set up OpenClaw">
      <OnboardHero title="Set up OpenClaw">Choose who runs its model and paste your key.</OnboardHero>
      <KeyForm
        providers={status.providers}
        // Onboarding passes OpenClaw's --accept-risk: the owner's tap here.
        action="Accept risk & set up"
        busyLabel="Setting up…"
        label="Set up OpenClaw"
        extra={
          <p className="claw-onboard-note">
            <ShieldAlert size={15} aria-hidden="true" />
            OpenClaw can run commands on this {computerWord(peer.platform)}
          </p>
        }
        send={async (provider, key) => {
          await post(peer, `${base}/onboard`, { provider, key, acceptRisk: true });
          // A failed setup keeps the form and its reason on screen.
          await finishSetup(peer);
          onDone();
        }}
      />
    </section>
  );
}

function SetupRunning({ peer, onDone }: { peer: Peer; onDone: () => void }) {
  const [problem, setProblem] = useState("");
  useEffect(() => {
    let live = true;
    finishSetup(peer)
      .then(() => live && onDone())
      .catch((e) => live && setProblem((e as Error).message));
    return () => {
      live = false;
    };
  }, [peer]);
  return (
    <section className="claw-onboard" role="status" aria-label="Setting up OpenClaw">
      <OnboardHero title="Setting up OpenClaw" busy={!problem} />
      {problem && (
        <p className="claw-error" role="alert">
          {problem}
        </p>
      )}
    </section>
  );
}

// Add a model provider's key (OpenRouter, Anthropic, OpenAI…) from the phone.
export function ClawAddProvider({
  peer,
  provider,
  onDone,
  onCancel,
}: {
  peer: Peer;
  provider?: string;
  onDone?: () => void;
  onCancel?: () => void;
}) {
  const [makeDefault, setMakeDefault] = useState(false);
  const [added, setAdded] = useState("");
  if (added)
    return (
      <div className="claw-onboard claw-onboard-key" role="status">
        <p className="claw-onboard-added">
          <Check size={18} strokeWidth={2.4} aria-hidden="true" />
          {added} added
        </p>
        <div className="claw-onboard-actions">
          <button type="button" className="claw-onboard-cta" onClick={() => onDone?.()}>
            Done
          </button>
        </div>
      </div>
    );
  return (
    <div className="claw-onboard claw-onboard-key">
      <KeyForm
        providers={KEYED}
        initial={provider}
        action="Save"
        label="Add a provider key"
        onCancel={onCancel}
        extra={
          <button
            type="button"
            role="switch"
            aria-checked={makeDefault}
            className={`claw-onboard-toggle${makeDefault ? " on" : ""}`}
            onClick={() => setMakeDefault((v) => !v)}
          >
            Use as default
          </button>
        }
        send={async (p, key) => {
          await post(peer, `${base}/providers/add`, { provider: p, key, setDefault: makeDefault });
          setAdded(NAMES[p]);
        }}
      />
    </div>
  );
}
