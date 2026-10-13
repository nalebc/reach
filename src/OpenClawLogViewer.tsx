import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { Check, Copy, LoaderCircle, RefreshCw, Search } from "lucide-react";
import { request, type Peer } from "./api";
import { clawBase } from "./OpenClawControls";
import { ClawDialog } from "./OpenClawDialog";
import FileTextPreview from "./FileTextPreview";
type Line = { time: number; level: string; source: string; text: string };
const format = (line: Line) =>
  [
    line.time ? new Date(line.time).toLocaleTimeString() : "",
    line.level.toUpperCase(),
    line.source ? `[${line.source}]` : "",
    line.text,
  ]
    .filter(Boolean)
    .join(" ");

export function ClawLogViewer({
  peer,
  output,
  onClose,
}: {
  peer: Peer;
  output?: { title: string; lines: string[] };
  onClose: () => void;
}) {
  const [lines, setLines] = useState<Line[]>([]);
  const [errors, setErrors] = useState(false);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(!output);
  const [problem, setProblem] = useState("");
  const [supported, setSupported] = useState(true);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState("");
  const [updated, setUpdated] = useState("");
  const controller = useRef<AbortController | null>(null);
  const load = useCallback(async () => {
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    setBusy(true);
    setProblem("");
    try {
      const result = await request<{ supported: boolean; lines?: Line[] }>(
        peer,
        `${clawBase}/health/logs${errors ? "?errors=1" : ""}`,
        { signal: abort.signal },
      );
      if (abort.signal.aborted) return;
      setSupported(result.supported);
      setLines(result.lines || []);
      setUpdated(
        new Date().toLocaleTimeString([], {
          hour: "numeric",
          minute: "2-digit",
        }),
      );
    } catch (error) {
      if (!abort.signal.aborted) setProblem((error as Error).message);
    } finally {
      if (!abort.signal.aborted) setBusy(false);
    }
  }, [peer, errors]);
  useEffect(() => {
    if (!output) void load();
    return () => controller.current?.abort();
  }, [load, output]);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(timer);
  }, [copied]);
  const allLines = output?.lines || lines.map(format);
  const shown = query
    ? allLines.filter((line) =>
        line.toLowerCase().includes(query.toLowerCase()),
      )
    : allLines;
  const text = shown.join("\n");
  const copy = () => {
    setCopyError("");
    if (!navigator.clipboard?.writeText) {
      setCopyError("Select the text to copy it on this browser.");
      return;
    }
    navigator.clipboard.writeText(text).then(
      () => setCopied(true),
      () => setCopyError("Couldn’t copy. Select the text to copy it instead."),
    );
  };
  return (
    <ClawDialog
      title={output?.title || "Gateway logs"}
      subtitle={
        output
          ? "OpenClaw · Command output"
          : `OpenClaw · ${updated ? `Updated ${updated}` : "Recent activity"}`
      }
      onClose={onClose}
      className="claw-log-preview"
      tools={
        <>
          <button
            className={`files-tool ${copied ? "is-done" : ""}`}
            disabled={!text || busy}
            aria-label={copied ? "Copied" : "Copy text"}
            onClick={copy}
          >
            {copied ? <Check size={19} /> : <Copy size={19} />}
          </button>
          {!output && (
            <button
              className="files-tool"
              disabled={busy}
              aria-label="Refresh logs"
              onClick={() => void load()}
            >
              <RefreshCw size={19} className={busy ? "spin" : ""} />
            </button>
          )}
        </>
      }
    >
      <div className="claw-log-tools">
        {!output && (
          <div className="claw-log-filter" role="group" aria-label="Log filter">
            <button
              aria-pressed={!errors}
              onClick={() => {
                setErrors(false);
              }}
            >
              All
            </button>
            <button
              aria-pressed={errors}
              onClick={() => {
                setErrors(true);
              }}
            >
              Errors
            </button>
          </div>
        )}
        <label className="claw-log-search">
          <Search size={16} />
          <input
            aria-label="Find in logs"
            placeholder="Find in logs"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
      </div>
      {copyError && (
        <p className="claw-viewer-notice" role="alert">
          {copyError}
        </p>
      )}
      {busy && text && (
        <p className="claw-viewer-notice" role="status">
          Refreshing logs…
        </p>
      )}
      <div className="file-viewer-body" aria-busy={busy}>
        {busy && !text ? (
          <div className="claw-viewer-empty" role="status">
            <LoaderCircle className="spin" size={24} />
            <p>Loading logs…</p>
          </div>
        ) : problem ? (
          <div className="claw-viewer-empty" role="alert">
            <p>{problem}</p>
            <button className="claw-button" onClick={() => void load()}>
              Try again
            </button>
          </div>
        ) : !supported ? (
          <p>This Gateway does not provide logs.</p>
        ) : !text ? (
          <p>
            {query
              ? "No matching lines."
              : errors
                ? "No errors in the recent logs."
                : "No output recorded yet."}
          </p>
        ) : (
          <FileTextPreview
            text={text}
            name={output ? "openclaw-output.log" : "gateway.log"}
          />
        )}
      </div>
    </ClawDialog>
  );
}
