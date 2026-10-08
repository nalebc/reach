import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Activity, Loader2, RotateCw } from "lucide-react";
import { post, request, type Peer } from "./api";
import ChatSheet from "./ChatSheet";
import { clawBase } from "./OpenClawControls";
import { ClawRow } from "./OpenClawRow";
import "./openclaw-health.css";

// The Gateway's health, a pill on the status line; opens logs and fixes.

type Part<T> = ({ supported: true } & T) | { supported: false };
type Health = {
  status: "ok" | "slow" | "attention";
  gateway: Part<{ answered: boolean; ms: number; version?: string }>;
  uptime: Part<{ ms: number }>;
  channels: Part<{ failing: string[] }>;
  memory: Part<{ bytes: number }>;
  storage: Part<{ dbBytes: number; walBytes: number; warn: boolean }>;
};
type Line = { time: number; level: string; source: string; text: string };

const WORD = { ok: "Healthy", slow: "Slow", attention: "Needs attention" };
// Read at most this often, whatever else changes.
const EVERY_MS = 30000;

const size = (bytes: number) =>
  bytes >= 1e9
    ? `${(bytes / 1e9).toFixed(1)} GB`
    : bytes >= 1e6
      ? `${Math.round(bytes / 1e6)} MB`
      : `${Math.max(0, Math.round(bytes / 1e3))} KB`;
const since = (ms: number) => {
  const m = Math.floor(ms / 60000);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h} h ${m % 60} min` : `${Math.floor(h / 24)} days`;
};
const clock = (t: number) =>
  t
    ? new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
    : "";

export function ClawHealthPill({
  peer,
  refresh,
  onChanged,
  row = false,
}: {
  peer: Peer;
  refresh?: number;
  onChanged?: () => void;
  // A row on Customize instead of a pill.
  row?: boolean;
}) {
  const [health, setHealth] = useState<Health | null>(null);
  const [open, setOpen] = useState(false);
  const readAt = useRef(0);
  const load = useCallback(
    async (force = false) => {
      if (!force && Date.now() - readAt.current < EVERY_MS) return;
      readAt.current = Date.now();
      try {
        setHealth(await request<Health>(peer, `${clawBase}/health`));
      } catch (e) {
        // A Reach without this route: no pill. A blip keeps what was read.
        if ((e as { status?: number }).status === 404) setHealth(null);
      }
    },
    [peer],
  );
  useEffect(() => {
    void load();
  }, [load, refresh]);
  useEffect(() => {
    const timer = setInterval(() => void load(), EVERY_MS * 2);
    return () => clearInterval(timer);
  }, [load]);
  if (!health) return null;
  const show = () => {
    setOpen(true);
    void load(true);
  };
  return (
    <>
      {row ? (
        <ClawRow
          icon={<Activity size={19} />}
          tint="teal"
          label="Gateway"
          value={WORD[health.status] || WORD.attention}
          tone={health.status === "ok" ? "" : "alert"}
          onClick={show}
        />
      ) : (
        <button type="button" className={`claw-health-pill ${health.status}`} onClick={show}>
          <span className="claw-health-dot" />
          {WORD[health.status] || WORD.attention}
        </button>
      )}
      {open && (
        <ChatSheet title="Gateway" className="claw-health-sheet" onClose={() => setOpen(false)}>
          <HealthSheet
            peer={peer}
            health={health}
            onRestarted={() => {
              void load(true);
              onChanged?.();
            }}
          />
        </ChatSheet>
      )}
    </>
  );
}

function HealthSheet({
  peer,
  health,
  onRestarted,
}: {
  peer: Peer;
  health: Health;
  onRestarted: () => void;
}) {
  const { gateway, uptime, memory, storage, channels } = health;
  return (
    <div className="claw-health">
      <ul className="claw-health-rows">
        <Row label="Status">
          <span className={`claw-health-word ${health.status}`}>{WORD[health.status]}</span>
        </Row>
        {gateway.supported && gateway.version && <Row label="Version">{gateway.version}</Row>}
        {gateway.supported && gateway.answered && (
          <Row label="Response">{gateway.ms < 1000 ? `${gateway.ms} ms` : `${(gateway.ms / 1000).toFixed(1)} s`}</Row>
        )}
        {uptime.supported && <Row label="Up">{since(uptime.ms)}</Row>}
        {memory.supported && <Row label="Memory">{size(memory.bytes)}</Row>}
        {storage.supported && (
          <Row label="Database">
            {storage.warn && <span className="claw-badge error">Large</span>}
            {size(storage.dbBytes)}
          </Row>
        )}
        {storage.supported && storage.walBytes > 100e6 && (
          <Row label="Of which WAL">{size(storage.walBytes)}</Row>
        )}
        {channels.supported && (
          <Row label="Channels">
            {channels.failing.length ? (
              <span className="claw-health-word attention">{channels.failing.join(", ")}</span>
            ) : (
              "All fine"
            )}
          </Row>
        )}
      </ul>
      <Fixes peer={peer} onRestarted={onRestarted} />
      <Logs peer={peer} />
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <li className="claw-health-row">
      <span>{label}</span>
      <strong>{children}</strong>
    </li>
  );
}

function Fixes({ peer, onRestarted }: { peer: Peer; onRestarted: () => void }) {
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState<"" | "restart" | "doctor" | "update">("");
  const [note, setNote] = useState("");
  const [problem, setProblem] = useState("");
  // A second tap restarts; the first only asks, for a few seconds.
  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(timer);
  }, [armed]);
  const restart = async () => {
    if (!armed) return setArmed(true);
    setArmed(false);
    setBusy("restart");
    setNote("");
    setProblem("");
    try {
      const { back } = await post<{ back?: boolean }>(peer, `${clawBase}/health/restart`, { confirm: true });
      // Not back yet: read health until the Gateway answers again.
      let up = back !== false;
      for (let i = 0; !up && i < 20; i++) {
        await new Promise((r) => setTimeout(r, 3000));
        up = await request<Health>(peer, `${clawBase}/health`).then(
          (h) => h.gateway.supported && h.gateway.answered,
          () => false,
        );
      }
      setNote(up ? "Restarted" : "Still starting");
      onRestarted();
    } catch (e) {
      setProblem((e as Error).message);
    } finally {
      setBusy("");
    }
  };
  // Doctor and Update run in a Reach terminal, answered there.
  const inTerminal = async (what: "doctor" | "update") => {
    setBusy(what);
    setNote("");
    setProblem("");
    try {
      const { terminal } = await post<{ terminal: { id: string } }>(peer, `${clawBase}/health/${what}`);
      window.dispatchEvent(new CustomEvent("reach:open-terminal", { detail: terminal.id }));
      setNote("Opened in Terminal");
    } catch (e) {
      setProblem((e as Error).message);
    } finally {
      setBusy("");
    }
  };
  return (
    <>
      <div className="claw-health-actions">
        <button
          type="button"
          className={`claw-secondary ${armed ? "armed" : ""}`}
          disabled={!!busy}
          onClick={restart}
        >
          {busy === "restart" && <Loader2 size={14} className="spin" />}
          {busy === "restart" ? "Restarting…" : armed ? "Tap to restart" : "Restart"}
        </button>
        <button type="button" className="claw-secondary" disabled={!!busy} onClick={() => inTerminal("doctor")}>
          {busy === "doctor" && <Loader2 size={14} className="spin" />}
          Doctor
        </button>
        <button type="button" className="claw-secondary" disabled={!!busy} onClick={() => inTerminal("update")}>
          {busy === "update" && <Loader2 size={14} className="spin" />}
          Update
        </button>
      </div>
      {note && <p className="claw-note claw-health-note">{note}</p>}
      {problem && (
        <p className="claw-error" role="alert">
          {problem}
        </p>
      )}
    </>
  );
}

function Logs({ peer }: { peer: Peer }) {
  const [errors, setErrors] = useState(false);
  const [lines, setLines] = useState<Line[] | null>(null);
  const [supported, setSupported] = useState(true);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const asked = useRef(0);
  const load = useCallback(async () => {
    const ask = ++asked.current;
    setBusy(true);
    setProblem("");
    try {
      const got = await request<{ supported: boolean; lines?: Line[] }>(
        peer,
        `${clawBase}/health/logs${errors ? "?errors=1" : ""}`,
      );
      if (ask !== asked.current) return;
      setSupported(got.supported);
      setLines(got.lines || []);
    } catch (e) {
      if (ask === asked.current) setProblem((e as Error).message);
    } finally {
      if (ask === asked.current) setBusy(false);
    }
  }, [peer, errors]);
  useEffect(() => {
    void load();
  }, [load]);
  // The newest line in view.
  const list = useRef<HTMLOListElement>(null);
  useEffect(() => {
    if (list.current) list.current.scrollTop = list.current.scrollHeight;
  }, [lines]);
  if (!supported) return null;
  return (
    <section className="claw-health-logs" aria-label="Logs">
      <header>
        <h3>Logs</h3>
        <div className="claw-health-filter" role="group" aria-label="Log filter">
          <button type="button" aria-pressed={!errors} onClick={() => setErrors(false)}>
            All
          </button>
          <button type="button" aria-pressed={errors} onClick={() => setErrors(true)}>
            Errors
          </button>
        </div>
        <button
          type="button"
          className="claw-health-refresh"
          aria-label="Refresh logs"
          disabled={busy}
          onClick={() => void load()}
        >
          <RotateCw size={14} className={busy ? "spin" : ""} />
        </button>
      </header>
      {problem && (
        <p className="claw-error" role="alert">
          {problem}
        </p>
      )}
      {lines && !lines.length && <p className="claw-empty">{errors ? "No errors" : "No lines"}</p>}
      {!!lines?.length && (
        <ol ref={list} className="claw-health-lines">
          {lines.map((line, i) => (
            <li key={i} className={line.level}>
              <time>{clock(line.time)}</time>
              {line.text}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
