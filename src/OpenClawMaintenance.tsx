import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { post, request, type Peer } from "./api";
import { clawBase } from "./OpenClawControls";

type Action = "doctor" | "repair" | "update";
type Job = {
  action: Action;
  status: "running" | "done" | "failed" | "skipped";
  message?: string;
  lines: string[];
};
const labels = { doctor: "Check health", repair: "Apply repairs", update: "Update OpenClaw" };
const descriptions = {
  doctor: "Check OpenClaw for problems. OpenClaw may also migrate older settings automatically.",
  repair: "Apply OpenClaw's recommended repairs to its settings and services. This may interrupt active conversations.",
  update: "Update using OpenClaw's configured release channel, then restart its Gateway. Active conversations may be interrupted. If that channel points to an older version, OpenClaw will install that version.",
};

export function ClawMaintenance({ peer, onChanged, disabled = false }: {
  peer: Peer; onChanged: () => void; disabled?: boolean;
}) {
  const [job, setJob] = useState<Job | null>(null);
  const [choice, setChoice] = useState<Action | null>(null);
  const [sending, setSending] = useState(false);
  const [problem, setProblem] = useState("");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const result = await request<{ job: Job | null }>(peer, `${clawBase}/health/maintenance`, { signal: abort.signal });
        if (abort.signal.aborted) return;
        setJob(result.job);
        setProblem("");
        if (result.job?.status === "running") timer = setTimeout(load, 2000);
      } catch (e) {
        if (!abort.signal.aborted) {
          setProblem((e as Error).message);
          timer = setTimeout(load, 5000);
        }
      }
    };
    void load();
    return () => { abort.abort(); clearTimeout(timer); };
  }, [peer.id, peer.url, peer.token, retry]);
  const running = sending || job?.status === "running";
  return (
    <div className="claw-maintenance">
      <div className="claw-health-actions">
        {(["doctor", "repair", "update"] as const).map((action) => (
          <button key={action} type="button" className="claw-secondary" disabled={disabled || running}
            onClick={() => { setChoice(action); setProblem(""); }}>{labels[action]}</button>
        ))}
      </div>
      {choice && !running && (
        <div className="claw-missing" role="group" aria-label={labels[choice]}>
          <p>{descriptions[choice]}</p>
          <div className="claw-settings-actions">
            <button type="button" className="claw-secondary" onClick={() => setChoice(null)}>Cancel</button>
            <button type="button" className="claw-primary" disabled={disabled || sending} onClick={async () => {
              setSending(true);
              setProblem("");
              try {
                const result = await post<{ job: Job }>(peer, `${clawBase}/health/${choice}`, { confirm: true });
                setJob(result.job);
                setChoice(null);
              } catch (e) { setProblem((e as Error).message); }
              finally { setSending(false); setRetry((n) => n + 1); }
            }}>Continue</button>
          </div>
        </div>
      )}
      {job && (
        <div className="claw-missing">
          <p role="status">{job.status === "running" ? <><Loader2 size={14} className="spin" /> {labels[job.action]}… You can close this panel and return later.</> : job.message}</p>
          {job.lines.length > 0 && <details><summary>Details</summary>
            <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", maxHeight: 260, overflow: "auto" }}>{job.lines.join("\n")}</pre>
          </details>}
          {job.status !== "running" && <button type="button" className="claw-secondary" onClick={onChanged}>Refresh health</button>}
        </div>
      )}
      {problem && <p className="claw-error" role="alert">{problem}</p>}
    </div>
  );
}
