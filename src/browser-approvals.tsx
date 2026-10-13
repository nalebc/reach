import { useEffect, useRef, useState } from "react";
import { requestDeadline } from "./request-deadline";
import { Bot, Eye, ShieldCheck } from "lucide-react";
import AppLogo from "./AppLogo";
import "./agent-ui.css";
import "./agent-sheets.css";
import { post, request, type Peer } from "./api";
import type { NeedItem } from "./NeedsYou";
import ScreenPopup from "./ScreenPopup";
import "./browser-approvals.css";

export type BrowserAction =
  | {
      type: "click";
      x: number;
      y: number;
      button: "left" | "right";
      count: 1 | 2;
    }
  | { type: "text"; text: string }
  | {
      type: "key";
      key:
        | "enter"
        | "backspace"
        | "tab"
        | "escape"
        | "left"
        | "right"
        | "up"
        | "down";
    }
  | { type: "scroll"; direction: "up" | "down"; amount: number }
  | { type: "command"; command: string }
  | { type: "terminal"; command: string; root: number; cwd?: string }
  | { type: "terminal-change"; command: string; root: number; cwd?: string }
  | { type: "terminal-script"; command: string; root: number; cwd?: string };
export type BrowserBatchAction = { type: "batch"; actions: BrowserAction[] };
export type BrowserRequestStep = {
  action: BrowserAction;
  status: "pending" | "executing" | "executed" | "failed" | "skipped";
  output?: string;
  error?: string;
  folder?: string;
  directory?: string;
  completedAt?: number;
};
export type BrowserAppAccessAction = { type: "app-access"; appId: string; appName: string; mode: "view" | "control" };
export type BrowserRequest = {
  id: string;
  clientId: string;
  name: string;
  action: BrowserAction | BrowserBatchAction | BrowserAppAccessAction;
  steps?: BrowserRequestStep[];
  completedCount?: number;
  attemptedCount?: number;
  reason: string;
  status: string;
  createdAt: number;
  expiresAt: number;
  sessionExpiresAt?: number;
  error?: string;
  output?: string;
  approval?: "automatic" | "owner" | "session";
  folder?: string;
  directory?: string;
  completedAt?: number;
};

// JSON quoting exposes line breaks and control keys; escape directional controls
// as well so a proposed command cannot visually reorder or hide its contents.
const quotedInput = (value: string) =>
  JSON.stringify(value).replace(
    /[\u007f-\u009f\u200e\u200f\u2028-\u202e\u2066-\u2069]/g,
    (character) =>
      `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
export function browserActionWords(action: BrowserAction | BrowserBatchAction | BrowserAppAccessAction): string {
  switch (action.type) {
    case "app-access":
      return `${action.mode === "control" ? "View and control" : "View"} ${action.appName}`;
    case "batch":
      return `${action.actions.length} actions, once: ${action.actions.map(browserActionWords).join(" → ")}`;
    case "click":
      return `${action.count === 2 ? "Double-click" : action.button === "right" ? "Right-click" : "Click"} the marked point`;
    case "text":
      return `Type text: ${quotedInput(action.text)}`;
    case "key":
      return `Press ${action.key}`;
    case "scroll":
      return `Scroll ${action.direction}, amount ${action.amount}`;
    case "command":
    case "terminal":
    case "terminal-script":
    case "terminal-change":
      return quotedInput(action.command);
  }
}


const commandAction = (action: BrowserAction | BrowserBatchAction | BrowserAppAccessAction) =>
  action.type === "command" || action.type === "terminal" || action.type === "terminal-change" || action.type === "terminal-script" ||
  (action.type === "batch" && action.actions.every((step) => step.type === "terminal"));

function BatchSteps({ item, progress = false }: { item: BrowserRequest; progress?: boolean }) {
  if (item.action.type !== "batch") return null;
  return (
    <ol className="browser-batch-steps" aria-label={progress ? "Batch action results" : "Exact action sequence"}>
      {item.action.actions.map((action, index) => {
        const step = item.steps?.[index];
        return (
          <li key={index}>
            {progress && <span className="browser-step-status">{step?.status || "pending"}</span>}
            <pre>{action.type === "click" ? browserActionWords(action).replace("the marked point", `point ${index + 1}`) : browserActionWords(action)}</pre>
            {action.type === "terminal" && (
              <p className="browser-batch-location">
                Shared folder: <code>{quotedInput(step?.folder || `Folder ${action.root + 1}`)}</code><br />
                Working folder: <code>{quotedInput(`/${action.cwd || ""}`)}</code>
              </p>
            )}
            {step?.output !== undefined && (
              <pre className="browser-output" aria-label={`Action ${index + 1} output`}>
                {step.output || "Command completed with no output."}
              </pre>
            )}
            {step?.directory !== undefined && (
              <p className="browser-batch-location">Resulting working folder: <code>{quotedInput(`/${step.directory}`)}</code></p>
            )}
            {step?.error && <p className="error">{step.error}</p>}
          </li>
        );
      })}
    </ol>
  );
}

export function useBrowserApprovals(
  peer: Peer,
  enabled: boolean,
  changes?: string,
) {
  const [requests, setRequests] = useState<BrowserRequest[]>([]);
  const [opened, setOpened] = useState<BrowserRequest | null>(null);
  let fingerprint: string | undefined;
  try {
    fingerprint = changes ? JSON.parse(changes).browserRequests : undefined;
  } catch {}
  useEffect(() => {
    setRequests([]);
    setOpened(null);
  }, [peer.url, peer.token, enabled]);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    let pending = false;
    const controller = new AbortController();
    const refresh = async () => {
      if (pending) return;
      pending = true;
      const deadline = requestDeadline(controller.signal);
      try {
        const list = await request<BrowserRequest[]>(
          peer,
          "/api/agents/browser-requests",
          { signal: deadline.signal },
        );
        if (live) {
          const current = Array.isArray(list)
            ? list.filter(
                (r) => (r.status === "pending" && r.expiresAt > Date.now()) ||
                  (["batch", "terminal-change"].includes(r.action.type) && r.status === "executing"),
              )
            : [];
          setRequests(current);
          setOpened((old) => old
            ? (Array.isArray(list) ? list.find((r) => r.id === old.id) : null) ||
              { ...old, status: "ended" }
            : old);
        }
      } catch {
        // Never retain an actionable prompt after losing access to its owner API.
        if (live) {
          setRequests([]);
          setOpened(null);
        }
      } finally {
        deadline.dispose();
        pending = false;
      }
    };
    void refresh();
    // The Mac tells of a change on the live connection (the fingerprint
    // above): read at once then, and only as a safety net otherwise.
    const timer = setInterval(() => void refresh(), fingerprint ? 60000 : 3000);
    return () => {
      live = false;
      controller.abort();
      clearInterval(timer);
    };
  }, [peer.url, peer.token, enabled, fingerprint]);
  const selected = enabled ? opened : null;
  const items: NeedItem[] = enabled
    ? requests.map((r) => ({
        key: `browser:${r.id}`,
        icon: r.action.type === "app-access"
          ? <AppLogo peer={peer} appId={r.action.appId} name={r.action.appName} size={30} />
          : <Bot size={22} />,
        title: `${r.name} ${r.status === "executing" ? "is running approved actions" : r.action.type === "command" ? "needs a command handled" : "needs your approval"}`,
        detail: browserActionWords(r.action),
        actions: [
          { label: r.status === "executing" ? "View progress" : "Review request", primary: true, opens: true, run: () => setOpened(r) },
        ],
      }))
    : [];
  return {
    items,
    review: selected ? (
      <BrowserApprovalReview
        key={selected.id}
        peer={peer}
        item={selected}
        onClose={() => setOpened(null)}
        onResolved={() => {
          setRequests((list) => list.filter((r) => r.id !== selected.id));
          setOpened(null);
        }}
      />
    ) : null,
  };
}

type ApprovalReviewProps = {
  peer: Peer;
  item: BrowserRequest;
  onClose: () => void;
  onResolved: () => void;
};

export function BrowserApprovalReview(props: ApprovalReviewProps) {
  return props.item.action.type === "app-access"
    ? <BrowserAppApprovalReview key={props.item.id} {...props} />
    : <BrowserInputApprovalReview {...props} />;
}

function BrowserAppApprovalReview({ peer, item, onClose, onResolved }: ApprovalReviewProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [now, setNow] = useState(Date.now());
  const sending = useRef(false);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  if (item.action.type !== "app-access") return null;
  const action = item.action;
  const expired = item.status !== "pending" || item.expiresAt <= now;
  const decide = async (decision: "approve" | "deny") => {
    if (sending.current || expired || (decision === "approve" && action.mode === "control")) return;
    sending.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await post<BrowserRequest>(peer,
        `/api/agents/browser-requests/${encodeURIComponent(item.id)}`, { decision });
      if (result.status === "executed" || result.status === "denied") onResolved();
      else setError(result.error || "This request has ended. Ask the agent to request access again.");
    } catch (e) { setError((e as Error).message); }
    finally { sending.current = false; setBusy(false); }
  };
  return (
    <ScreenPopup title={`Allow ${item.name} to use ${action.appName}?`} onClose={onClose} className="browser-approval browser-app-approval ag-sheet">
      <div className="ag-app-ask">
        <span className="ag-app-ask-logo">
          <AppLogo peer={peer} appId={action.appId} name={action.appName} />
        </span>
        <p className="ag-app-ask-mode">
          <Eye size={14} /> {action.mode === "control" ? "View and control" : "View only"} · <strong>{action.appName}</strong>
        </p>
        {item.reason && (
          <blockquote className="ag-said">
            <small>{item.name} says</small>
            <span className="browser-request-reason">{item.reason}</span>
          </blockquote>
        )}
        <p className="browser-approval-note">{action.mode === "control"
          ? "App control requires an isolated environment. This older control request cannot be approved."
          : "The agent can see this app’s windows and content. It cannot click or type in them."}</p>
        <p className="browser-approval-note">{item.sessionExpiresAt
          ? `Access ends at ${new Date(item.sessionExpiresAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}.`
          : "Access ends with this invitation."} A new invitation starts fresh.</p>
        {expired && <p role="status" className="ag-note is-warn">This request has ended.</p>}
        {error && <p className="error" role="alert">{error}</p>}
      </div>
      <div className="ag-sheet-actions">
        <button className="ag-secondary" disabled={busy || expired} onClick={() => void decide("deny")}>Deny</button>
        <button className="ag-primary" disabled={busy || expired || action.mode === "control"} onClick={() => void decide("approve")}>
          <ShieldCheck size={16} /> {busy ? "Responding…" : "Allow for this session"}
        </button>
      </div>
    </ScreenPopup>
  );
}

function BrowserInputApprovalReview({
  peer,
  item: incomingItem,
  onClose,
  onResolved,
}: {
  peer: Peer;
  item: BrowserRequest;
  onClose: () => void;
  onResolved: () => void;
}) {
  const [outcome, setOutcome] = useState<BrowserRequest | null>(null);
  const [rememberedForSession, setRememberedForSession] = useState(false);
  const item = outcome?.status === "executing" && incomingItem.status !== "pending"
    ? incomingItem
    : outcome || incomingItem;
  const batch = item.action.type === "batch" ? item.action : null;
  const executing = item.status === "executing";
  const [busy, setBusy] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState("");
  const [snapshotImage, setSnapshotImage] = useState<{
    url: string;
    source: string;
  } | null>(null);
  const [loadedSnapshot, setLoadedSnapshot] = useState("");
  const snapshotSource = JSON.stringify([peer.url, peer.token, item.id]);
  const snapshot =
    snapshotImage?.source === snapshotSource ? snapshotImage.url : "";
  const snapshotReady = !!snapshot && loadedSnapshot === snapshot;
  const [finished, setFinished] = useState(false);
  const [now, setNow] = useState(Date.now());
  const pending = useRef(false);
  const script = item.action.type === "terminal-script";
  const terminalChange = item.action.type === "terminal-change" || script;
  const restrictedTerminal = item.action.type === "terminal" ||
    !!batch?.actions.every((action) => action.type === "terminal");
  const command = commandAction(item.action);
  const expired =
    item.expiresAt <= now || item.status !== "pending" || finished;
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    setSnapshotImage(null);
    setLoadedSnapshot("");
    setError("");
    if (command) return;
    const controller = new AbortController();
    let image = "";
    void fetch(
      `${peer.url}/api/agents/browser-requests/${encodeURIComponent(item.id)}/screen`,
      {
        headers: { Authorization: `Bearer ${peer.token}` },
        cache: "no-store",
        redirect: "error",
        signal: controller.signal,
      },
    )
      .then(async (response) => {
        if (!response.ok)
          throw Error(
            "The request's screen snapshot could not be loaded. Deny this request and ask for a new one.",
          );
        const blob = await response.blob();
        if (controller.signal.aborted) return;
        image = URL.createObjectURL(blob);
        setSnapshotImage({ url: image, source: snapshotSource });
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError((e as Error).message);
      });
    return () => {
      controller.abort();
      if (image) URL.revokeObjectURL(image);
    };
  }, [peer.url, peer.token, item.id, command, snapshotSource]);
  const decide = async (decision: "approve" | "approve-session" | "deny" | "handled") => {
    if (
      pending.current ||
      expired ||
      (["approve", "approve-session"].includes(decision) &&
        !restrictedTerminal && !terminalChange &&
        (!snapshotReady || command))
    )
      return;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await post<BrowserRequest>(
        peer,
        `/api/agents/browser-requests/${encodeURIComponent(item.id)}`,
        { decision, ...(batch && decision === "approve" ? { reviewedBatch: true } : {}), ...(terminalChange && ["approve", "approve-session"].includes(decision) ? script ? { reviewedScript: true } : { reviewedTerminalChange: true } : {}) },
      );
      if (decision === "approve-session" && result.status === "executed") setRememberedForSession(true);
      if (batch || terminalChange) {
        setOutcome({ ...item, ...result });
        setFinished(result.status !== "pending" && result.status !== "executing");
        if (result.error) setError(result.error);
        return;
      }
      if (["failed", "revoked", "expired"].includes(result.status)) {
        setFinished(true);
        setError(
          result.error ||
            `The action was not completed (${result.status}). Ask the assistant to send a fresh request.`,
        );
        return;
      }
      onResolved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  const stopBatch = async () => {
    if (stopping || (!batch && !terminalChange)) return;
    setStopping(true);
    try {
      const result = await post<BrowserRequest>(peer,
        `/api/agents/browser-requests/${encodeURIComponent(item.id)}`, { decision: "deny" });
      setOutcome({ ...item, ...result });
      setFinished(true);
    } catch (e) { setError((e as Error).message); }
    finally { setStopping(false); }
  };
  return (
    <ScreenPopup
      title={`${item.name}: ${batch ? `review ${batch.actions.length} actions` : restrictedTerminal || terminalChange ? "review terminal command" : command ? "handle on computer" : "review screen action"}`}
      onClose={onClose}
      className="browser-approval ag-sheet ag-review"
    >
      <p>
        {batch
          ? restrictedTerminal
            ? "Run these exact read-only commands once, in order, in the folders shown. Commands cannot change files, run scripts, or use sudo."
            : "Run these exact inputs once, in order. They can operate any app, including Terminal."
          : script
          ? "Run this command once inside the shared folder. No network, administrator access or helper processes."
          : terminalChange
          ? "This command changes files inside the shared folder shown below. Approval runs only this exact command once and never grants access to other folders. Scripts, sudo, and unrestricted shells remain blocked."
          : restrictedTerminal
          ? "Reach verified this against its read-only command allowlist. Approve once to run it in the shared folder below and return the output. It cannot change files, run scripts, use sudo, or type into your existing terminals."
          : command
            ? "Handle on computer. Review this exact command and run it yourself only if you want to. Mark handled tells the assistant you are finished; it does not execute anything."
            : "Approve from your phone. Screen actions can operate any app, including Terminal. Typing or Enter can execute commands in Terminal. Approve only if the target and full text are intended."}
      </p>
      {(restrictedTerminal || terminalChange) && !batch && (
        <>
          <h3>Shared folder</h3>
          <pre aria-label="Command folder">
            {quotedInput(item.folder || "")}
          </pre>
        </>
      )}
      <h3>{batch ? "Exact action sequence" : command ? "Requested command" : "Exact input"}</h3>
      {batch ? <BatchSteps item={item} progress={busy || item.status !== "pending"} /> : (
        <pre aria-label={command ? "Requested command" : "Exact input"}>
          {browserActionWords(item.action)}
        </pre>
      )}
      {((command && !script) || item.action.type === "text" || batch?.actions.some((action) => action.type === "text")) && (
        <p className="browser-approval-note">
          Quoted exactly. Escapes such as \\n and \\u202e make hidden characters
          visible.
        </p>
      )}
      {!terminalChange && <><h3>Assistant’s reason (untrusted explanation)</h3>
      <p className="browser-request-reason">{item.reason}</p></>}
      {!command && (
        <>
          <div className="browser-approval-snapshot">
            {snapshot ? (
              <img
                key={snapshot}
                src={snapshot}
                alt="Screen when this action was requested"
                onLoad={(e) => {
                  if (
                    e.currentTarget.naturalWidth > 0 &&
                    e.currentTarget.naturalHeight > 0
                  ) {
                    setLoadedSnapshot(snapshot);
                  } else {
                    setLoadedSnapshot("");
                    setError(
                      "The request's screen snapshot could not be displayed. Deny this request and ask for a new one.",
                    );
                  }
                }}
                onError={() => {
                  setLoadedSnapshot("");
                  setError(
                    "The request's screen snapshot could not be displayed. Deny this request and ask for a new one.",
                  );
                }}
              />
            ) : (
              <p role="status">Loading request snapshot…</p>
            )}
            {snapshotReady && (batch?.actions || [item.action]).map((action, index) => action.type === "click" && (
              <span
                key={index}
                className="browser-click-marker"
                role="img"
                aria-label={batch ? `Action ${index + 1}: click target x=${action.x}, y=${action.y}` : `Click target x=${action.x}, y=${action.y}`}
                style={{
                  left: `${action.x * 100}%`,
                  top: `${action.y * 100}%`,
                }}
              >{batch ? index + 1 : null}</span>
            ))}
          </div>
          <p className="browser-approval-note">
            {batch
              ? "Reach checks this screen before the first action. Later actions run on the resulting screen. Approval expires within 60 seconds; remaining actions expire 20 seconds after starting."
              : "Captured when requested. A changed screen requires a new request. No ongoing permission is granted."}
          </p>
        </>
      )}
      {batch && restrictedTerminal && <p className="browser-approval-note">Approval expires within 5 minutes; remaining commands expire 30 seconds after starting.</p>}
      {batch && <details className="browser-batch-limits">
        <summary>How this approval works</summary>
        <p className="browser-approval-note">The batch stops on the first failure, cancellation, pause, revoked access, or expiry. Completed actions are not undone; an input already sent may finish. No ongoing permission is granted.</p>
        {!restrictedTerminal && <p className="browser-approval-note">The screen may change between the listed actions. Reach does not classify clicks or typing as safe or dangerous.</p>}
      </details>}
      {batch && (busy || item.status !== "pending") && (
        <p role="status">{item.completedCount || 0} of {batch.actions.length} actions completed · {executing || busy ? "Running approved sequence" : item.status}</p>
      )}
      <p className="browser-approval-note">
        {batch && (executing || busy)
          ? "Only the listed actions are approved. You can stop the remaining actions at any time."
          : batch && finished
            ? "This sequence has ended. Running more actions requires a new request."
            : terminalChange && finished
              ? (item.status === "executed" ? rememberedForSession ? "Command completed. This command is approved until this session ends." : "Command completed." : `Command ${item.status}.`)
            : expired
              ? "This request has expired or is no longer pending."
              : `Expires ${new Date(item.expiresAt).toLocaleTimeString()} (${Math.max(0, Math.ceil((item.expiresAt - now) / 1000))}s remaining).`}
      </p>
      {terminalChange && item.output !== undefined && <pre className="browser-output">{item.output || "Command completed."}</pre>}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {terminalChange && !expired && <p className="browser-approval-note">Session approval remembers only this exact command and folder. It ends with this invitation; a new invite starts fresh.</p>}
      <div className="browser-approval-actions">
        {terminalChange && <button className="button secondary" disabled={busy || expired} onClick={() => void decide("approve-session")}>Always approve this session</button>}
        {(batch || terminalChange) && (executing || busy) && (
          <button className="button secondary" disabled={stopping} onClick={() => void stopBatch()}>
            {stopping ? "Stopping…" : terminalChange ? "Stop command" : "Stop remaining actions"}
          </button>
        )}
        <button
          className="button secondary"
          disabled={busy || expired}
          onClick={() => void decide("deny")}
        >
          Deny
        </button>
        <button
          className="button"
          disabled={busy || expired || (!command && !snapshotReady)}
          onClick={() =>
            void decide(command && !restrictedTerminal && !terminalChange ? "handled" : "approve")
          }
        >
          <ShieldCheck size={16} />{" "}
          {busy
            ? "Responding…"
            : batch
              ? `Approve ${batch.actions.length} actions once`
              : restrictedTerminal || terminalChange
              ? "Approve once"
              : command
                ? "Mark handled"
                : "Approve once"}
        </button>
      </div>
    </ScreenPopup>
  );
}

export function BrowserActionRequests({
  peer,
  screen,
  commands,
  restrictedTerminal = false,
  roots = [],
  activeKind,
  onError,
}: {
  peer: Peer;
  screen: boolean;
  commands: boolean;
  restrictedTerminal?: boolean;
  roots?: { name: string; path: string; index: number }[];
  activeKind?: "screen" | "command";
  onError: (error: unknown) => void;
}) {
  const [selectedType, setType] = useState<
    Exclude<BrowserAction["type"], "terminal" | "terminal-change" | "terminal-script">
  >(screen ? "click" : "command");
  const showScreen = screen && activeKind !== "command";
  const showCommands = commands && activeKind !== "screen";
  const type =
    activeKind === "command"
      ? "command"
      : activeKind === "screen" && selectedType === "command"
        ? "click"
        : selectedType;
  const [root, setRoot] = useState(0);
  const commandRoot = roots.some((item) => item.index === root)
    ? root
    : (roots[0]?.index ?? 0);
  const [x, setX] = useState("0.5");
  const [y, setY] = useState("0.5");
  const [button, setButton] = useState<"left" | "right">("left");
  const [count, setCount] = useState<1 | 2>(1);
  const [screenText, setScreenText] = useState("");
  const [commandText, setCommandText] = useState("");
  const text = type === "command" ? commandText : screenText;
  const setText = type === "command" ? setCommandText : setScreenText;
  const [key, setKey] =
    useState<Extract<BrowserAction, { type: "key" }>["key"]>("enter");
  const [direction, setDirection] = useState<"up" | "down">("down");
  const [amount, setAmount] = useState(3);
  const [screenReason, setScreenReason] = useState("");
  const [commandReason, setCommandReason] = useState("");
  const reason = type === "command" ? commandReason : screenReason;
  const setReason = type === "command" ? setCommandReason : setScreenReason;
  const [records, setRecords] = useState<BrowserRequest[]>([]);
  const [screenBatch, setScreenBatch] = useState<BrowserAction[]>([]);
  const [terminalBatch, setTerminalBatch] = useState<BrowserAction[]>([]);
  const batch = type === "command" ? terminalBatch : screenBatch;
  const setBatch = type === "command" ? setTerminalBatch : setScreenBatch;
  const canBatch = type !== "command" || restrictedTerminal;
  useEffect(() => { setScreenBatch([]); setTerminalBatch([]); }, [peer.url, peer.token]);
  const [directories, setDirectories] = useState<Record<number, { path: string; at: number }>>({});
  useEffect(() => { setDirectories({}); }, [peer.url, peer.token]);
  useEffect(() => {
    setDirectories((previous) => {
      const next = { ...previous };
      for (const record of records) {
        const results = record.action.type === "batch" ? record.steps || [] : [record];
        for (const result of results) {
          if (result.status === "executed" && result.action.type === "terminal" &&
              result.directory !== undefined && result.completedAt !== undefined &&
              result.completedAt > (next[result.action.root]?.at ?? 0))
            next[result.action.root] = { path: result.directory, at: result.completedAt };
        }
      }
      return next;
    });
  }, [records]);
  const cwd = directories[commandRoot]?.path || "";
  const [busy, setBusy] = useState(false);
  const [screenMessage, setScreenMessage] = useState("");
  const [commandMessage, setCommandMessage] = useState("");
  const message = type === "command" ? commandMessage : screenMessage;
  const setMessage = type === "command" ? setCommandMessage : setScreenMessage;
  const pending = useRef(false);
  const failure = useRef(onError);
  failure.current = onError;
  useEffect(() => {
    let live = true;
    let reading = false;
    const controller = new AbortController();
    const refresh = async () => {
      if (reading) return;
      reading = true;
      try {
        const list = await request<BrowserRequest[]>(
          peer,
          "/api/browser/requests",
          { signal: controller.signal },
        );
        if (live) setRecords(Array.isArray(list) ? list : []);
      } catch (e) {
        if (live) failure.current(e);
      } finally {
        reading = false;
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 3000);
    return () => {
      live = false;
      controller.abort();
      clearInterval(timer);
    };
  }, [peer.url, peer.token]);
  const actionValid = type === "click"
    ? x !== "" && y !== "" && Number.isFinite(Number(x)) && Number.isFinite(Number(y)) && Number(x) >= 0 && Number(x) <= 1 && Number(y) >= 0 && Number(y) <= 1
    : type === "scroll" ? Number.isInteger(amount) && amount >= 1 && amount <= 5
    : type === "text" || type === "command" ? !!text
    : true;
  const draftAction = (): BrowserAction => {
    let action: BrowserAction;
    if (type === "click")
      action = { type, x: Number(x), y: Number(y), button, count };
    else if (type === "text") action = { type, text };
    else if (type === "command")
      action = restrictedTerminal
        ? { type: "terminal", command: text, root: commandRoot, ...(cwd ? { cwd } : {}) }
        : { type, command: text };
    else if (type === "key") action = { type, key };
    else action = { type, direction, amount };
    return action;
  };
  const send = async () => {
    if (pending.current || !reason.trim() || (!batch.length && !actionValid) ||
        (type === "command" ? !showCommands : !showScreen)) return;
    const action: BrowserAction | BrowserBatchAction = canBatch && batch.length
      ? { type: "batch", actions: batch }
      : draftAction();
    pending.current = true;
    setBusy(true);
    setMessage("");
    try {
      const record = await post<BrowserRequest>(peer, "/api/browser/requests", {
        ...action,
        reason: reason.trim(),
      });
      setRecords((list) => [record, ...list.filter((r) => r.id !== record.id)]);
      if (action.type === "batch") setBatch([]);
      setMessage(
        "Request sent. Wait for the owner’s response below before continuing.",
      );
    } catch (e) {
      failure.current(e);
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  const visibleRecords = records.filter(
    (record) =>
      !activeKind ||
      (commandAction(record.action)
        ? activeKind === "command"
        : activeKind === "screen"),
  );
  if (!showScreen && !showCommands) return null;
  return (
    <section className="browser-card" aria-labelledby="browser-requests-title">
      <div className="browser-section-heading">
        <h2 id="browser-requests-title">
          <ShieldCheck size={18} /> Ask the owner
        </h2>
      </div>
      <p className="browser-policy">
        {showScreen
          ? "Ask for one input or group up to 5 exact actions for one approval. A batch runs once in order, stops on failure, and grants no ongoing control. Check the updated screen after it finishes. "
          : ""}
        {showCommands
          ? restrictedTerminal
            ? 'Allowed: pwd, cd folder, cd .., ls [folder], cat file, head [-n N] file, tail [-n N] file, wc [-l|-w|-c] file, grep "literal text" file. Paths are relative to your working folder and stay inside the shared folder. Commands need owner approval, individually or in an exact batch of up to 5. Download shared files from the Files tab. No sudo, deletion, writes, shell syntax, scripts or keystrokes.'
            : "Commands are requests for the owner to handle on the computer. They never execute from this workspace, including sudo."
          : ""}
      </p>
      <form
        className="browser-request-form"
        aria-label="Request an action"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <label>
          Action
          <select
            aria-label="Requested action"
            value={type}
            onChange={(e) => {
              setType(e.target.value as typeof type);
            }}
          >
            {showScreen && (
              <>
                <option value="click">Click</option>
                <option value="text">Type text</option>
                <option value="key">Press a key</option>
                <option value="scroll">Scroll</option>
              </>
            )}
            {showCommands && (
              <option value="command">
                {restrictedTerminal
                  ? "Run a restricted command"
                  : "Ask owner to handle a command"}
              </option>
            )}
          </select>
        </label>
        {type === "click" && (
          <>
            <p className="browser-policy">
              Coordinates on the shared display: 0 is left/top; 1 is
              right/bottom.
            </p>
            <div className="browser-request-fields">
              <label>
                X coordinate
                <input
                  aria-label="X coordinate"
                  type="number"
                  min="0"
                  max="1"
                  step="any"
                  required={!batch.length}
                  value={x}
                  onChange={(e) => setX(e.target.value)}
                />
              </label>
              <label>
                Y coordinate
                <input
                  aria-label="Y coordinate"
                  type="number"
                  min="0"
                  max="1"
                  step="any"
                  required={!batch.length}
                  value={y}
                  onChange={(e) => setY(e.target.value)}
                />
              </label>
              <label>
                Mouse button
                <select
                  aria-label="Mouse button"
                  value={button}
                  onChange={(e) => setButton(e.target.value as typeof button)}
                >
                  <option value="left">Left</option>
                  <option value="right">Right</option>
                </select>
              </label>
              <label>
                Click count
                <select
                  aria-label="Click count"
                  value={count}
                  onChange={(e) => setCount(Number(e.target.value) as 1 | 2)}
                >
                  <option value="1">Once</option>
                  <option value="2">Twice</option>
                </select>
              </label>
            </div>
          </>
        )}
        {type === "command" && restrictedTerminal && (
          <label>
            Shared folder
            <select
              aria-label="Command folder"
              value={commandRoot}
              onChange={(e) => setRoot(Number(e.target.value))}
            >
              {roots.map((item) => (
                <option key={item.index} value={item.index}>
                  {item.name} — {item.path}
                </option>
              ))}
            </select>
            <span aria-label="Working folder">Working folder: /{cwd}</span>
          </label>
        )}
        {(type === "text" || type === "command") && (
          <label>
            {type === "command" ? "Exact command" : "Exact text"}
            <textarea
              aria-label={type === "command" ? "Exact command" : "Exact text"}
              required={!batch.length}
              rows={4}
              maxLength={type === "command" ? 4000 : 2000}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
          </label>
        )}
        {type === "key" && (
          <label>
            Key
            <select
              aria-label="Requested key"
              value={key}
              onChange={(e) => setKey(e.target.value as typeof key)}
            >
              {[
                "enter",
                "backspace",
                "tab",
                "escape",
                "left",
                "right",
                "up",
                "down",
              ].map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
          </label>
        )}
        {type === "scroll" && (
          <div className="browser-request-fields">
            <label>
              Direction
              <select
                aria-label="Scroll direction"
                value={direction}
                onChange={(e) =>
                  setDirection(e.target.value as typeof direction)
                }
              >
                <option value="up">Up</option>
                <option value="down">Down</option>
              </select>
            </label>
            <label>
              Amount
              <input
                aria-label="Scroll amount"
                type="number"
                min="1"
                max="5"
                step="1"
                required={!batch.length}
                value={amount}
                onChange={(e) => setAmount(Number(e.target.value))}
              />
            </label>
          </div>
        )}
        {canBatch && (
          <div className="browser-batch-builder">
            <button type="button" className="button secondary small"
              disabled={busy || !actionValid || batch.length >= 5}
              onClick={() => setBatch((list) => list.length < 5 ? [...list, draftAction()] : list)}>
              Add to batch
            </button>
            {batch.length > 0 && (
              <>
                <h3>Review batch <span>{batch.length}/5</span></h3>
                <ol className="browser-batch-draft" aria-label="Batch draft">
                  {batch.map((action, index) => (
                    <li key={index}>
                      <div>
                        <pre>{browserActionWords(action)}</pre>
                        {action.type === "terminal" && <small>Folder: {roots.find((item) => item.index === action.root)?.path || `Folder ${action.root + 1}`} · Working folder: /{action.cwd || ""}</small>}
                      </div>
                      <button type="button" className="button secondary small" disabled={busy}
                        aria-label={`Remove action ${index + 1}`} onClick={() => setBatch((list) => list.filter((_, i) => i !== index))}>Remove</button>
                    </li>
                  ))}
                </ol>
                <p className="browser-policy">Only these listed actions will be sent, in this order. {type === "command" ? "Each command uses its listed working folder; cd does not change later commands in the batch." : "The owner reviews the starting screen. Later actions use the resulting screen."}</p>
              </>
            )}
          </div>
        )}
        <label>
          Why this action is needed
          <textarea
            aria-label="Reason for request"
            required
            maxLength={1000}
            rows={2}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </label>
        <button
          className="button"
          disabled={
            busy ||
            !reason.trim() ||
            (!batch.length && !actionValid)
          }
        >
          {busy ? "Requesting…" : batch.length && canBatch ? `Request approval for ${batch.length} actions` : "Request owner approval"}
        </button>
      </form>
      {message && <p role="status">{message}</p>}
      <h3>Request history</h3>
      <div role="log" aria-label="Action request history" aria-live="polite">
        {!visibleRecords.length && (
          <p className="browser-policy">No requests yet.</p>
        )}
        <ol className="browser-request-history">
          {visibleRecords.map((r) => (
            <li key={r.id}>
              <strong>
                {r.status === "pending" ? "Waiting for owner" : r.status}
              </strong>
              {r.action.type === "batch" ? (
                <>
                  <p>{r.completedCount || 0} of {r.action.actions.length} actions completed</p>
                  <BatchSteps item={r} progress />
                  {r.status === "cancelled" && <p className="browser-policy">Remaining actions stopped. Completed actions are not undone.</p>}
                </>
              ) : <pre>{browserActionWords(r.action)}</pre>}
              <p className="browser-request-reason">{r.reason}</p>
              <small>
                Expires {new Date(r.expiresAt).toLocaleTimeString()}
              </small>
              {r.error && <p className="error">{r.error}</p>}
              {r.output !== undefined && (
                <pre className="browser-output" aria-label="Command output">
                  {r.output || "Command completed with no output."}
                </pre>
              )}
              {(r.status === "pending" || (["batch", "terminal-change"].includes(r.action.type) && r.status === "executing")) && (
                <button
                  className="button secondary small"
                  onClick={async () => {
                    try {
                      const result = await request<Partial<BrowserRequest>>(
                        peer,
                        `/api/browser/requests/${encodeURIComponent(r.id)}`,
                        { method: "DELETE" },
                      );
                      setRecords((list) =>
                        list.map((record) =>
                          record.id === r.id
                            ? { ...record, ...result, status: result.status || "cancelled" }
                            : record,
                        ),
                      );
                    } catch (e) {
                      failure.current(e);
                    }
                  }}
                >
                  {r.status === "executing" ? "Stop remaining actions" : "Cancel request"}
                </button>
              )}
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
