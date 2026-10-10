import { useEffect, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  RotateCw,
  Send,
  TriangleAlert,
  X,
} from "lucide-react";
import { bytes } from "./api";
import {
  collectFinishedDownloads,
  dismiss,
  useTransfers,
  type Transfer,
} from "./transfers";
import "./transfer-tray.css";

const verbs = {
  upload: ["Uploading", "Uploaded"],
  download: ["Downloading", "Downloaded"],
  send: ["Sending", "Sent"],
} as const;
const percent = (done: number, total: number) =>
  total ? Math.min(100, Math.floor((done / total) * 100)) : 0;
const timeLeft = (t: Transfer) => {
  if (!t.rate || t.rate < 1) return "";
  const seconds = (t.total - t.done) / t.rate;
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))} s left`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min left`;
  return `${(seconds / 3600).toFixed(1)} h left`;
};
function detail(t: Transfer) {
  const size = t.kind === "send" ? t.total / 2 : t.total;
  const done = t.kind === "send" ? t.done / 2 : t.done;
  if (t.state === "failed") return t.error || "Stopped";
  if (t.state === "canceled") return "Cancelled";
  if (t.state === "done")
    return size ? `${verbs[t.kind][1]} · ${bytes(size)}` : verbs[t.kind][1];
  if (t.state === "waiting") return "Waiting for the connection…";
  return [
    `${bytes(done)} of ${bytes(size)}`,
    t.rate ? `${bytes(Math.round(t.rate))}/s` : "",
    timeLeft(t),
  ]
    .filter(Boolean)
    .join(" · ");
}

// Every upload and download in progress, in one small pill that expands.
export default function TransferTray() {
  const transfers = useTransfers();
  const [open, setOpen] = useState(false);
  // iPhone app: downloads that finished while Reach was closed.
  useEffect(() => void collectFinishedDownloads(), []);
  if (!transfers.length) return null;
  const active = transfers.filter(
    (t) => t.state === "running" || t.state === "waiting",
  );
  const failed = transfers.filter((t) => t.state === "failed");
  const done = active.reduce((n, t) => n + t.done, 0),
    total = active.reduce((n, t) => n + t.total, 0);
  const finished = transfers.filter((t) => t.state === "done");
  const kind = (active[0] || failed[0] || finished[0] || transfers[0]).kind;
  const finishedOfKind = finished.filter((t) => t.kind === kind);
  const Icon = kind === "upload" ? ArrowUp : kind === "send" ? Send : ArrowDown;
  const summary = active.length
    ? `${verbs[kind][0]} ${active.length === 1 ? active[0].name : `${active.length} files`}`
    : failed.length
      ? `${failed.length === 1 ? failed[0].name : `${failed.length} transfers`} stopped`
      : finishedOfKind.length
        ? `${verbs[kind][1]} ${finishedOfKind.length === 1 ? finishedOfKind[0].name : `${finishedOfKind.length} files`}`
        : "Transfers";
  return (
    <section
      className={`transfer-tray ${open ? "is-open" : ""} ${failed.length && !active.length ? "is-failed" : ""}`}
      aria-label="Transfers"
    >
      {open && (
        <ul className="transfer-list">
          {transfers.map((t) => (
            <li key={t.id} className={`is-${t.state}`}>
              <span className="transfer-name">{t.name}</span>
              <span className="transfer-detail">{detail(t)}</span>
              <span className="transfer-actions">
                {t.state === "done" && t.action && (
                  <button className="transfer-action" onClick={t.action.run}>
                    {t.action.label}
                  </button>
                )}
                {t.state === "failed" && t.retry && (
                  <button aria-label={`Try ${t.name} again`} onClick={t.retry}>
                    <RotateCw size={15} />
                  </button>
                )}
                {t.state === "running" || t.state === "waiting" ? (
                  <button aria-label={`Cancel ${t.name}`} onClick={t.cancel}>
                    <X size={15} />
                  </button>
                ) : (
                  <button
                    aria-label={`Clear ${t.name}`}
                    onClick={() => dismiss(t.id)}
                  >
                    <X size={15} />
                  </button>
                )}
              </span>
              {(t.state === "running" || t.state === "waiting") && (
                <i style={{ width: `${percent(t.done, t.total)}%` }} />
              )}
            </li>
          ))}
        </ul>
      )}
      <button
        className="transfer-summary"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="transfer-icon">
          {active.length ? (
            <Icon size={15} />
          ) : failed.length ? (
            <TriangleAlert size={15} />
          ) : (
            <Check size={15} />
          )}
        </span>
        <span className="transfer-text" role="status">
          {summary}
        </span>
        {active.length > 0 && (
          <span className="transfer-percent">{percent(done, total)}%</span>
        )}
        <ChevronDown size={16} className="transfer-chevron" />
        {active.length > 0 && (
          <i
            className="transfer-bar"
            style={{ width: `${percent(done, total)}%` }}
          />
        )}
      </button>
    </section>
  );
}
