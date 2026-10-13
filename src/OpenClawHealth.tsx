import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  Activity,
  ChevronRight,
  CircleAlert,
  FileText,
  LoaderCircle,
  RefreshCw,
  Server,
} from "lucide-react";
import { request, type Peer } from "./api";
import { ClawMaintenance } from "./OpenClawMaintenance";
import { ClawDialog } from "./OpenClawDialog";
import { ClawLogViewer } from "./OpenClawLogViewer";
import { clawBase } from "./OpenClawControls";
import { ClawRow } from "./OpenClawRow";
import "./openclaw-health.css";

// The Gateway's health, a pill on the status line; opens logs and fixes.

type Part<T> = ({ supported: true } & T) | { supported: false };
type Health = {
  status: "ok" | "slow" | "attention" | "unknown";
  gateway: Part<{ answered: boolean; ms: number; version?: string }>;
  uptime: Part<{ ms: number }>;
  channels: Part<{ failing: string[] }>;
  memory: Part<{ bytes: number }>;
  storage: Part<{ dbBytes: number; walBytes: number; warn: boolean }>;
};

const WORD = {
  ok: "Healthy",
  slow: "Slow",
  attention: "Needs attention",
  unknown: "Not checked",
};
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
  const [refreshing, setRefreshing] = useState(false);
  const [problem, setProblem] = useState("");
  const [checked, setChecked] = useState("");
  const fetching = useRef(false);
  // Asked for while a read was on its way (a restart just finished): that
  // read began before the change, so another follows it.
  const again = useRef(false);
  const load = useCallback(
    async (force = false): Promise<void> => {
      if (fetching.current) {
        if (force) again.current = true;
        return;
      }
      if (!force && Date.now() - readAt.current < EVERY_MS) return;
      readAt.current = Date.now();
      fetching.current = true;
      setRefreshing(true);
      setProblem("");
      try {
        setHealth(await request<Health>(peer, `${clawBase}/health`));
        setChecked(
          new Date().toLocaleTimeString([], {
            hour: "numeric",
            minute: "2-digit",
          }),
        );
      } catch (e) {
        // A Reach without this route: no pill. A blip keeps what was read.
        if ((e as { status?: number }).status === 404) setHealth(null);
        else setProblem((e as Error).message);
      } finally {
        fetching.current = false;
        setRefreshing(false);
      }
      if (again.current) {
        again.current = false;
        return load(true);
      }
    },
    [peer],
  );
  // The first look, then each refresh the page asks for, at once.
  const asked = useRef(refresh);
  useEffect(() => {
    const forced = asked.current !== refresh;
    asked.current = refresh;
    void load(forced);
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
        <button
          type="button"
          className={`claw-health-pill ${health.status}`}
          onClick={show}
        >
          <span className="claw-health-dot" />
          {WORD[health.status] || WORD.attention}
        </button>
      )}
      {open && (
        <ClawDialog
          title="Gateway"
          subtitle={`OpenClaw · ${peer.name || "This computer"}`}
          className="claw-gateway"
          onClose={() => setOpen(false)}
          tools={
            <button
              className="files-tool"
              aria-label="Refresh health"
              disabled={refreshing}
              onClick={() => void load(true)}
            >
              <RefreshCw size={19} className={refreshing ? "spin" : ""} />
            </button>
          }
        >
          <HealthSheet
            peer={peer}
            health={health}
            refreshing={refreshing}
            checked={checked}
            problem={problem}
            onChanged={async () => {
              await load(true);
              onChanged?.();
            }}
          />
        </ClawDialog>
      )}
    </>
  );
}

function HealthSheet({
  peer,
  health,
  refreshing,
  checked,
  problem,
  onChanged,
}: {
  peer: Peer;
  health: Health;
  refreshing: boolean;
  checked: string;
  problem: string;
  onChanged: () => Promise<void>;
}) {
  const { gateway, uptime, memory, storage, channels } = health;
  const [preview, setPreview] = useState<
    { title: string; lines: string[] } | "logs" | null
  >(null);
  const issues = [
    gateway.supported && !gateway.answered ? "Gateway is not responding." : "",
    channels.supported && channels.failing.length
      ? `${channels.failing.join(", ")} ${channels.failing.length === 1 ? "needs" : "need"} attention.`
      : "",
    storage.supported && storage.warn ? "The database is unusually large." : "",
    health.status === "slow" ? "Gateway is responding slowly." : "",
  ].filter(Boolean);
  return (
    <>
      <div className="claw-gateway-body">
        <section
          className={`claw-gateway-status ${health.status}`}
          aria-label="Gateway status"
        >
          <div className="claw-status-icon">
            {health.status === "attention" ? (
              <CircleAlert size={26} />
            ) : (
              <Server size={26} />
            )}
          </div>
          <div>
            <span className="claw-eyebrow">OPENCLAW GATEWAY</span>
            <h1>{WORD[health.status]}</h1>
            <p>
              {issues.join(" ") ||
                (gateway.supported && gateway.answered
                  ? "Connected and ready for conversations."
                  : health.status === "unknown"
                    ? "Reach couldn't verify the Gateway yet."
                    : "No issues reported by available checks.")}
            </p>
          </div>
        </section>
        <div className="claw-check-time" role="status">
          {refreshing ? (
            <>
              <LoaderCircle size={13} className="spin" /> Refreshing status…
            </>
          ) : (
            `Checked ${checked}`
          )}
        </div>
        {problem && (
          <p className="claw-maintenance-problem" role="alert">
            Couldn’t refresh: {problem}. Showing the last result.
          </p>
        )}
        <dl className="claw-gateway-metrics">
          {gateway.supported && gateway.version && (
            <Metric label="Version">{gateway.version}</Metric>
          )}
          {uptime.supported && (
            <Metric label="Uptime">{since(uptime.ms)}</Metric>
          )}
          {gateway.supported && gateway.answered && (
            <Metric label="Response">
              {gateway.ms < 1000
                ? `${gateway.ms} ms`
                : `${(gateway.ms / 1000).toFixed(1)} s`}
            </Metric>
          )}
          {storage.supported && (
            <Metric label="Database">
              {size(storage.dbBytes)}
              {storage.warn && <small>Large</small>}
            </Metric>
          )}
          {memory.supported && (
            <Metric label="Memory">{size(memory.bytes)}</Metric>
          )}
          {storage.supported && storage.walBytes > 100e6 && (
            <Metric label="Database journal">{size(storage.walBytes)}</Metric>
          )}
        </dl>
        <ClawMaintenance
          peer={peer}
          onChanged={onChanged}
          onViewOutput={(title, lines) => setPreview({ title, lines })}
          onOpenLogs={() => setPreview("logs")}
        />
        <section className="claw-diagnostics">
          <h2 className="claw-section-title">Diagnostics</h2>
          <button
            className="claw-log-entry"
            onClick={() => setPreview("logs")}
            aria-label="Open logs"
          >
            <FileText size={22} />
            <span>
              <strong>Gateway logs</strong>
              <small>Read, search and copy recent activity</small>
            </span>
            <ChevronRight size={18} />
          </button>
        </section>
      </div>
      {preview && (
        <ClawLogViewer
          peer={peer}
          output={preview === "logs" ? undefined : preview}
          onClose={() => setPreview(null)}
        />
      )}
    </>
  );
}
function Metric({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}
