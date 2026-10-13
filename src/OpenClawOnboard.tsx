import { useEffect, useRef, useState, type ReactNode } from "react";
import { LoaderCircle } from "lucide-react";
import { request, post, type Peer } from "./api";
import { installAgent, type InstallPlan } from "./agent-sessions";
import { computerWord } from "./pause";
import "./openclaw-onboard.css";

// Installing and setting up OpenClaw from the phone (server/openclaw-onboard.mjs).
// Keys go to OpenClaw on the computer; Reach keeps none, here or there.
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
      <div className="claw-onboard-pills" role="radiogroup" aria-label="Provider">
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
        {onCancel && (
          <button type="button" className="claw-secondary" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
        )}
        <button type="submit" className="claw-primary" disabled={!ready || busy}>
          {busy && <LoaderCircle size={14} className="spin" />}
          {busy ? busyLabel || `${action}…` : action}
        </button>
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
    <div className="claw-onboard">
      <div className="claw-onboard-row">
        <strong>Install OpenClaw</strong>
        {step === "" || step === "failed" ? (
          <button type="button" className="claw-primary" onClick={() => void ask()}>
            {step === "failed" ? "Try again" : "Install"}
          </button>
        ) : step === "running" ? (
          <LoaderCircle size={16} className="spin" aria-label="Installing" />
        ) : null}
      </div>
      {step === "confirm" && plan && (
        <>
          <pre className="claw-onboard-command">{plan.command}</pre>
          <div className="claw-onboard-actions">
            <button type="button" className="claw-secondary" onClick={() => setStep("")}>
              Cancel
            </button>
            <button type="button" className="claw-primary" onClick={() => void run()}>
              Run on {computerWord(peer.platform)}
            </button>
          </div>
        </>
      )}
      {(step === "running" || step === "failed") && line && <code className="claw-onboard-line">{line}</code>}
      {step === "failed" && <p className="claw-error">The install stopped.</p>}
      {problem && (
        <p className="claw-error" role="alert">
          {problem}
        </p>
      )}
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
    <div className="claw-onboard">
      <div className="claw-onboard-row">
        <strong>Set up OpenClaw</strong>
      </div>
      <KeyForm
        providers={status.providers}
        // Onboarding passes OpenClaw's --accept-risk: the owner's tap here.
        action="Accept risk & set up"
        busyLabel="Setting up…"
        label="Set up OpenClaw"
        extra={<p className="claw-onboard-note">OpenClaw can run commands on this {computerWord(peer.platform)}</p>}
        send={async (provider, key) => {
          await post(peer, `${base}/onboard`, { provider, key, acceptRisk: true });
          // A failed setup keeps the form and its reason on screen.
          await finishSetup(peer);
          onDone();
        }}
      />
    </div>
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
    <div className="claw-onboard" role="status">
      <div className="claw-onboard-row">
        <strong>Setting up OpenClaw</strong>
        {!problem && <LoaderCircle size={14} className="spin" />}
      </div>
      {problem && (
        <p className="claw-error" role="alert">
          {problem}
        </p>
      )}
    </div>
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
      <div className="claw-onboard" role="status">
        <div className="claw-onboard-row">
          <strong>{added} added</strong>
          <button type="button" className="claw-primary" onClick={() => onDone?.()}>
            Done
          </button>
        </div>
      </div>
    );
  return (
    <div className="claw-onboard">
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
