import { useEffect, useRef, useState } from "react";
import {
  Activity,
  ArrowUpCircle,
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  FileText,
  Loader2,
  RotateCw,
  Wrench,
} from "lucide-react";
import { post, request, type Peer } from "./api";
import { clawBase } from "./OpenClawControls";
import { ClawDialog } from "./OpenClawDialog";

type Action = "doctor" | "repair" | "update" | "restart";
export type ClawJob = {
  id?: string;
  action: Action;
  status: "running" | "done" | "failed" | "skipped" | "awaiting_approval";
  phase?: string;
  recovery?: {
    kind: "node" | "repair";
    title: string;
    description: string;
    available: boolean;
    steps: string[];
  };
  message?: string;
  lines: string[];
  startedAt?: number;
  finishedAt?: number;
};
const actions = {
  doctor: {
    label: "Check health",
    short: "Find problems",
    icon: Activity,
    active: "Checking health…",
    description:
      "Check OpenClaw’s settings and services. OpenClaw may migrate older settings as part of this check.",
  },
  restart: {
    label: "Restart",
    short: "Reconnect Gateway",
    icon: RotateCw,
    active: "Restarting Gateway…",
    description:
      "Restart the OpenClaw Gateway. Active conversations may be interrupted while it reconnects.",
  },
  repair: {
    label: "Apply repairs",
    short: "Fix settings & services",
    icon: Wrench,
    active: "Applying repairs…",
    description:
      "Apply OpenClaw’s recommended repairs to settings and services. Active conversations may be interrupted.",
  },
  update: {
    label: "Update OpenClaw",
    short: "Install configured release",
    icon: ArrowUpCircle,
    active: "Updating OpenClaw…",
    description:
      "Install the version from OpenClaw’s configured release channel, then restart its Gateway. If dependencies or additional repairs are needed, Reach will show the required changes for your approval. This can take several minutes and interrupt conversations. An older configured version may cause a downgrade.",
  },
};
const generic =
  /couldn.t finish.*try again|couldn.t finish.*review the details/i;
export function jobMessage(job: ClawJob) {
  if (job.recovery) return job.recovery.description;
  // Updater step names (e.g. "global update") are not the cause. Surface the
  // runtime requirement even for results returned by an older Reach server.
  if (job.status === "failed") {
    const details = [job.message || "", ...job.lines].join("\n");
    const required = details.match(/requires Node ([^\n"\\]+)/i)?.[1]?.trim().replace(/\.$/, "");
    const detected = details.match(/detected Node ([\d.]+)/i)?.[1];
    if (required) return `OpenClaw requires Node ${required}.${detected ? ` This computer used Node ${detected}.` : ""} Upgrade Node on this computer, then retry the update.`;
  }
  if (job.status === "failed" && (!job.message || generic.test(job.message))) {
    return job.lines.length
      ? "OpenClaw reported a problem. Open the command output for the recorded details."
      : "No error details were returned for this attempt. Check Gateway logs for clues, or retry to capture a new result.";
  }
  return (
    job.message ||
    (job.status === "done" ? "Completed." : "Open the output for details.")
  );
}

export function ClawMaintenance({
  peer,
  onChanged,
  onViewOutput,
  onOpenLogs,
}: {
  peer: Peer;
  onChanged: () => Promise<void>;
  onViewOutput: (title: string, lines: string[]) => void;
  onOpenLogs: () => void;
}) {
  const [job, setJob] = useState<ClawJob | null>(null);
  const [choice, setChoice] = useState<Action | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(true);
  const [problem, setProblem] = useState("");
  const [retry, setRetry] = useState(0);
  const epoch = useRef(0);
  const mounted = useRef(true);
  const inFlight = useRef(false);
  const resultView = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (sending)
      resultView.current?.scrollIntoView({
        block: "nearest",
        behavior: "instant",
      });
  }, [sending]);
  const changed = useRef(onChanged);
  changed.current = onChanged;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      epoch.current++;
    };
  }, []);
  useEffect(() => {
    const abort = new AbortController();
    const version = ++epoch.current;
    let timer: ReturnType<typeof setTimeout>;
    let wasRunning = job?.status === "running";
    const load = async () => {
      try {
        const result = await request<{ job: ClawJob | null }>(
          peer,
          `${clawBase}/health/maintenance`,
          { signal: abort.signal },
        );
        if (abort.signal.aborted || version !== epoch.current) return;
        setJob(result.job);
        setProblem("");
        setLoading(false);
        if (result.job?.status === "running") {
          wasRunning = true;
          timer = setTimeout(load, 2000);
        } else if (wasRunning) void changed.current();
      } catch (error) {
        if (!abort.signal.aborted && version === epoch.current) {
          setProblem((error as Error).message);
          setLoading(false);
          timer = setTimeout(load, 5000);
        }
      }
    };
    void load();
    return () => {
      abort.abort();
      clearTimeout(timer);
    };
  }, [peer.id, peer.url, peer.token, retry]);
  const running = sending || job?.status === "running";
  const run = async (action: Action, approvedJobId?: string) => {
    if (inFlight.current) return;
    inFlight.current = true;
    epoch.current++; // A slow earlier poll must not overwrite the new attempt.
    setChoice(null);
    setReviewing(false);
    setSending(true);
    setLoading(false);
    setProblem("");
    const startedAt = Date.now();
    setJob({ action, status: "running", lines: [], startedAt });
    try {
      if (action === "restart") {
        const result = await post<{ back?: boolean }>(
          peer,
          `${clawBase}/health/restart`,
          { confirm: true },
        );
        let up = result.back !== false;
        for (let i = 0; !up && i < 20 && mounted.current; i++) {
          await new Promise((resolve) => setTimeout(resolve, 3000));
          if (!mounted.current) return;
          up = await request<{
            gateway: { supported: boolean; answered?: boolean };
          }>(peer, `${clawBase}/health`).then(
            (h) => h.gateway.supported && !!h.gateway.answered,
            () => false,
          );
        }
        if (!mounted.current) return;
        setJob({
          action,
          status: up ? "done" : "failed",
          lines: [],
          startedAt,
          finishedAt: Date.now(),
          message: up
            ? "Gateway restarted and connected."
            : "The Gateway has not reconnected yet. Open its logs to check startup errors.",
        });
        void changed.current();
      } else {
        const result = await post<{ job: ClawJob }>(
          peer,
          `${clawBase}/health/${approvedJobId ? "maintenance/continue" : action}`,
          { confirm: true, ...(approvedJobId ? { jobId: approvedJobId } : {}) },
        );
        if (!mounted.current) return;
        setJob(result.job);
        if (result.job.status === "running") setRetry((n) => n + 1);
        else void changed.current();
      }
    } catch (error) {
      if (mounted.current)
        setJob({
          action,
          status: "failed",
          lines: [],
          startedAt,
          finishedAt: Date.now(),
          message: (error as Error).message,
        });
    } finally {
      inFlight.current = false;
      if (mounted.current) setSending(false);
    }
  };
  return (
    <section className="claw-maintenance" aria-label="Gateway actions">
      {loading && (
        <p className="claw-maintenance-loading" role="status">
          <Loader2 size={15} className="spin" /> Checking recent activity…
        </p>
      )}
      {job && (
        <div
          ref={resultView}
          className={`claw-operation ${job.status}`}
          aria-live="polite"
          aria-atomic="true"
        >
          <div className="claw-operation-heading">
            {running ? (
              <Loader2 size={20} className="spin" />
            ) : job.status === "done" ? (
              <CheckCircle2 size={20} />
            ) : (
              <CircleAlert size={20} />
            )}
            <div>
              <strong>
                {running
                  ? job.phase || actions[job.action].active
                  : `${actions[job.action].label} ${job.status === "done" ? "completed" : job.status === "awaiting_approval" ? "needs approval" : job.status}`}
              </strong>
              <small>
                {running
                  ? "You can leave this view and return later."
                  : job.finishedAt
                    ? `Last attempt · ${new Date(job.finishedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`
                    : "Last attempt"}
              </small>
            </div>
          </div>
          {!running && <p>{jobMessage(job)}</p>}
          <div className="claw-operation-tools">
            {job.status === "awaiting_approval" && job.recovery?.available && job.id && (
              <button className="claw-button primary" onClick={() => setReviewing(true)}>
                Review required changes
              </button>
            )}
            {job.lines.length > 0 && (
              <button
                className="claw-button"
                onClick={() =>
                  onViewOutput(`${actions[job.action].label} output`, job.lines)
                }
              >
                <FileText size={16} /> View output
              </button>
            )}
            {!running && job.status !== "done" && job.status !== "awaiting_approval" && (
              <>
                <button className="claw-button" onClick={onOpenLogs}>
                  Open logs
                </button>
                <button
                  className="claw-button"
                  onClick={() => setChoice(job.action)}
                >
                  Try again
                </button>
              </>
            )}
          </div>
        </div>
      )}
      {problem && (
        <p className="claw-maintenance-problem" role="alert">
          Couldn’t read recent activity: {problem}{" "}
          <button
            className="claw-button"
            onClick={() => {
              setLoading(true);
              setRetry((n) => n + 1);
            }}
          >
            Retry
          </button>
        </p>
      )}
      <h2 className="claw-section-title">Actions</h2>
      <div className="claw-action-grid">
        {(Object.keys(actions) as Action[]).map((action) => {
          const entry = actions[action];
          const Icon = entry.icon;
          return (
            <button
              key={action}
              className="claw-action"
              disabled={loading || running}
              onClick={() => setChoice(action)}
              aria-label={entry.label}
            >
              <Icon size={21} />
              <span>
                <strong>{entry.label}</strong>
                <small>{entry.short}</small>
              </span>
              <ChevronRight size={15} />
            </button>
          );
        })}
      </div>
      {reviewing && job?.recovery && job.id && (
        <ClawDialog title={job.recovery.title} subtitle="Your approval is required" onClose={() => setReviewing(false)} className="claw-action-dialog">
          <div className="claw-confirm-body">
            <h2>{job.recovery.title}</h2>
            <p>{job.recovery.description}</p>
            <ol className="claw-upgrade-steps">{job.recovery.steps.map(step => <li key={step}>{step}</li>)}</ol>
            <p>Reach will continue this update after approval. The Gateway may restart; you can close this view and return to check progress.</p>
          </div>
          <footer className="claw-confirm-actions">
            <button className="claw-button" onClick={() => setReviewing(false)}>Not now</button>
            <button className="claw-button primary" onClick={() => void run("update", job.id)}>Approve and continue</button>
          </footer>
        </ClawDialog>
      )}
      {choice && (
        <ClawDialog
          title={actions[choice].label}
          subtitle="OpenClaw Gateway"
          onClose={() => setChoice(null)}
          className="claw-action-dialog"
        >
          <div className="claw-confirm-body">
            <div className="claw-confirm-symbol">
              {(() => {
                const Icon = actions[choice].icon;
                return <Icon size={30} />;
              })()}
            </div>
            <h2>
              {choice === "doctor"
                ? "Run a health check?"
                : choice === "restart"
                  ? "Restart the Gateway?"
                  : choice === "repair"
                    ? "Apply recommended repairs?"
                    : "Update OpenClaw?"}
            </h2>
            <p>{actions[choice].description}</p>
          </div>
          <footer className="claw-confirm-actions">
            <button className="claw-button" onClick={() => setChoice(null)}>
              Cancel
            </button>
            <button
              className="claw-button primary"
              onClick={() => void run(choice)}
            >
              {actions[choice].label}
            </button>
          </footer>
        </ClawDialog>
      )}
    </section>
  );
}
