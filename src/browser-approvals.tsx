import { useEffect, useRef, useState } from "react";
import { Bot, ShieldCheck } from "lucide-react";
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
  | { type: "terminal"; command: string; root: number; cwd?: string };
export type BrowserRequest = {
  id: string;
  clientId: string;
  name: string;
  action: BrowserAction;
  reason: string;
  status: string;
  createdAt: number;
  expiresAt: number;
  error?: string;
  output?: string;
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
export function browserActionWords(action: BrowserAction): string {
  switch (action.type) {
    case "click":
      return `${action.count === 2 ? "Double-click" : "Click"} ${action.button} button at x=${action.x}, y=${action.y} (${Math.round(action.x * 100)}% across, ${Math.round(action.y * 100)}% down)`;
    case "text":
      return `Type text: ${quotedInput(action.text)}`;
    case "key":
      return `Press ${action.key}`;
    case "scroll":
      return `Scroll ${action.direction}, amount ${action.amount}`;
    case "command":
    case "terminal":
      return quotedInput(action.command);
  }
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
      try {
        const list = await request<BrowserRequest[]>(
          peer,
          "/api/agents/browser-requests",
          { signal: controller.signal },
        );
        if (live) {
          const current = Array.isArray(list)
            ? list.filter(
                (r) => r.status === "pending" && r.expiresAt > Date.now(),
              )
            : [];
          setRequests(current);
          setOpened((old) =>
            old && !current.some((r) => r.id === old.id)
              ? { ...old, status: "ended" }
              : old,
          );
        }
      } catch {
        // Never retain an actionable prompt after losing access to its owner API.
        if (live) {
          setRequests([]);
          setOpened(null);
        }
      } finally {
        pending = false;
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 3000);
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
        icon: <Bot size={22} />,
        title: `${r.name} ${r.action.type === "command" ? "needs a command handled" : "needs your approval"}`,
        detail: browserActionWords(r.action),
        actions: [
          { label: "Review request", primary: true, opens: true, run: () => setOpened(r) },
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

export function BrowserApprovalReview({
  peer,
  item,
  onClose,
  onResolved,
}: {
  peer: Peer;
  item: BrowserRequest;
  onClose: () => void;
  onResolved: () => void;
}) {
  const [busy, setBusy] = useState(false);
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
  const restrictedTerminal = item.action.type === "terminal";
  const command = item.action.type === "command" || restrictedTerminal;
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
  const decide = async (decision: "approve" | "deny" | "handled") => {
    if (
      pending.current ||
      expired ||
      (decision === "approve" &&
        !restrictedTerminal &&
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
        { decision },
      );
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
  return (
    <ScreenPopup
      title={`${item.name}: ${restrictedTerminal ? "review terminal command" : command ? "handle on computer" : "review screen action"}`}
      onClose={onClose}
      className="browser-approval"
    >
      <p>
        {restrictedTerminal
          ? "Reach verified this against its read-only command allowlist. Approve once to run it in the shared folder below and return the output. It cannot change files, run scripts, use sudo, or type into your existing terminals."
          : command
            ? "Handle on computer. Review this exact command and run it yourself only if you want to. Mark handled tells the assistant you are finished; it does not execute anything."
            : "Approve from your phone. Screen actions can operate any app, including Terminal. Typing or Enter can execute commands in Terminal. Approve only if the target and full text are intended."}
      </p>
      {restrictedTerminal && (
        <>
          <h3>Shared folder</h3>
          <pre aria-label="Command folder">
            {quotedInput(item.folder || "")}
          </pre>
        </>
      )}
      <h3>{command ? "Requested command" : "Exact input"}</h3>
      <pre aria-label={command ? "Requested command" : "Exact input"}>
        {browserActionWords(item.action)}
      </pre>
      {(command || item.action.type === "text") && (
        <p className="browser-approval-note">
          Quoted exactly. Escapes such as \\n and \\u202e make hidden characters
          visible.
        </p>
      )}
      <h3>Assistant’s reason (untrusted explanation)</h3>
      <p className="browser-request-reason">{item.reason}</p>
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
            {snapshotReady && item.action.type === "click" && (
              <span
                className="browser-click-marker"
                role="img"
                aria-label={`Click target x=${item.action.x}, y=${item.action.y}`}
                style={{
                  left: `${item.action.x * 100}%`,
                  top: `${item.action.y * 100}%`,
                }}
              />
            )}
          </div>
          <p className="browser-approval-note">
            Captured when requested. A changed screen requires a new request. No
            ongoing permission is granted.
          </p>
        </>
      )}
      <p className="browser-approval-note">
        {expired
          ? "This request has expired or is no longer pending."
          : `Expires ${new Date(item.expiresAt).toLocaleTimeString()} (${Math.max(0, Math.ceil((item.expiresAt - now) / 1000))}s remaining).`}
      </p>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <div className="browser-approval-actions">
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
            void decide(command && !restrictedTerminal ? "handled" : "approve")
          }
        >
          <ShieldCheck size={16} />{" "}
          {busy
            ? "Responding…"
            : restrictedTerminal
              ? "Approve and run once"
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
    Exclude<BrowserAction["type"], "terminal">
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
  const [directories, setDirectories] = useState<Record<number, { path: string; at: number }>>({});
  useEffect(() => { setDirectories({}); }, [peer.url, peer.token]);
  useEffect(() => {
    setDirectories((previous) => {
      const next = { ...previous };
      for (const record of records) {
        if (record.status === "executed" && record.action.type === "terminal" &&
            record.directory !== undefined && record.completedAt !== undefined &&
            record.completedAt > (next[record.action.root]?.at ?? 0))
          next[record.action.root] = { path: record.directory, at: record.completedAt };
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
  const send = async () => {
    if (
      pending.current ||
      !reason.trim() ||
      (type === "command" ? !showCommands : !showScreen)
    )
      return;
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
    pending.current = true;
    setBusy(true);
    setMessage("");
    try {
      const record = await post<BrowserRequest>(peer, "/api/browser/requests", {
        ...action,
        reason: reason.trim(),
      });
      setRecords((list) => [record, ...list.filter((r) => r.id !== record.id)]);
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
      (["command", "terminal"].includes(record.action.type)
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
          ? "Every screen input requires a separate approval in Reach. Request one action, wait for its result, then check the updated screen before continuing. "
          : ""}
        {showCommands
          ? restrictedTerminal
            ? 'Allowed: pwd, cd folder, cd .., ls [folder], cat file, head [-n N] file, tail [-n N] file, wc [-l|-w|-c] file, grep "literal text" file. Paths are relative to your working folder and stay inside the shared folder. Each command needs owner approval. Download shared files from the Files tab. No sudo, deletion, writes, shell syntax, scripts or keystrokes.'
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
                  required
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
                  required
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
              required
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
                required
                value={amount}
                onChange={(e) => setAmount(Number(e.target.value))}
              />
            </label>
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
            ((type === "text" || type === "command") && !text)
          }
        >
          {busy ? "Requesting…" : "Request owner approval"}
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
              <pre>{browserActionWords(r.action)}</pre>
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
              {r.status === "pending" && (
                <button
                  className="button secondary small"
                  onClick={async () => {
                    try {
                      await request(
                        peer,
                        `/api/browser/requests/${encodeURIComponent(r.id)}`,
                        { method: "DELETE" },
                      );
                      setRecords((list) =>
                        list.map((record) =>
                          record.id === r.id
                            ? { ...record, status: "cancelled" }
                            : record,
                        ),
                      );
                    } catch (e) {
                      failure.current(e);
                    }
                  }}
                >
                  Cancel request
                </button>
              )}
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
