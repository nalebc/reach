import { useEffect, useRef, useState } from "react";
import {
  Bot,
  Check,
  ChevronDown,
  Folder,
  Monitor,
  ShieldCheck,
  Terminal,
} from "lucide-react";
import { post, request, type Peer } from "./api";
import { scopeLabel } from "./scope-words";
import type { NeedItem } from "./NeedsYou";
import ScreenPopup from "./ScreenPopup";
import "./agent-admissions.css";
import AppLogo from "./AppLogo";
import { AgentAvatar } from "./agent-ui";

export type AgentAdmission = {
  requestId: string;
  clientId: string;
  name: string;
  scopes: string[];
  roots: string[];
  browser: boolean;
  preset?: "full" | "apps" | "files" | "readonly";
  apps?: { id: string; name?: string }[];
  hidden?: { id: string; name?: string }[];
  write?: boolean;
  screen?: "off" | "view" | "scroll" | "ask" | "apps";
  appAccess?: { id: string; name?: string; mode: "view" | "control" }[];
  terminalIds?: string[];
  commandRequests?: boolean;
  restrictedTerminal?: boolean;
  terminalApproval?: boolean;
  scriptApproval?: boolean;
  requestedAt: number;
  expiresAt: number;
  accessExpiresAt: number;
  verificationCode: string;
  browserTransport?: "funnel" | "tailnet";
  nodeName?: string;
  nodeId?: string;
};
const exact = (value: string) =>
  JSON.stringify(value).replace(
    /[\u007f-\u009f\u200e\u200f\u2028-\u202e\u2066-\u2069]/g,
    (character) =>
      `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
const labels: Record<string, string> = {
  device: "Read shared computer details",
  "browser:read": "Read selected browser resources",
  "browser:scroll": "Scroll the shared screen",
  "browser:request": "Send requests to the owner",
  "browser:write": "Edit shared files",
  "browser:screen": "View allowed app windows",
  "browser:control": "Control allowed app windows",
  "browser:open": "Open allowed apps",
  "browser:shell": "Run shell commands as your user",
};
const presetNames = {
  full: "Full control",
  apps: "Apps",
  files: "Files",
  readonly: "Read only",
};
const readable = (value: string) => exact(value).slice(1, -1);

export function useAgentAdmissions(
  peer: Peer,
  enabled: boolean,
  changes?: string,
) {
  const [admissions, setAdmissions] = useState<AgentAdmission[]>([]);
  const [opened, setOpened] = useState<AgentAdmission | null>(null);
  let fingerprint: string | undefined;
  try {
    fingerprint = changes ? JSON.parse(changes).agentAdmissions : undefined;
  } catch {}
  useEffect(() => {
    setAdmissions([]);
    setOpened(null);
  }, [peer.url, peer.token, enabled]);
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    let fetching = false;
    const refresh = async () => {
      if (fetching) return;
      fetching = true;
      try {
        const result = await request<AgentAdmission[]>(
          peer,
          "/api/agents/admissions",
          { signal: controller.signal },
        );
        if (controller.signal.aborted) return;
        const list = Array.isArray(result)
          ? result.filter((r) => r.expiresAt > Date.now())
          : [];
        setAdmissions(list);
        setOpened((old) =>
          old && !list.some((r) => r.requestId === old.requestId) ? null : old,
        );
      } catch {
        if (!controller.signal.aborted) {
          setAdmissions([]);
          setOpened(null);
        }
      } finally {
        fetching = false;
      }
    };
    void refresh();
    // The Mac tells of a change on the live connection (the fingerprint
    // above): read at once then, and only as a safety net otherwise.
    const timer = setInterval(() => void refresh(), fingerprint ? 60000 : 3000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [peer.url, peer.token, enabled, fingerprint]);
  const selected = enabled ? opened : null;
  const items: NeedItem[] = enabled
    ? admissions.map((admission) => ({
        key: `agent-admission:${admission.requestId}`,
        icon: <Bot size={22} />,
        title: `${admission.name} wants to connect`,
        detail: `First agent connection · code ${admission.verificationCode}`,
        actions: [
          {
            label: "Review connection",
            primary: true,
            opens: true,
            run: () => setOpened(admission),
          },
        ],
      }))
    : [];
  return {
    items,
    review: selected ? (
      <AgentAdmissionReview
        key={`${peer.id}:${selected.requestId}`}
        peer={peer}
        admission={selected}
        onClose={() => setOpened(null)}
        onResolved={() => {
          setAdmissions((list) =>
            list.filter((r) => r.requestId !== selected.requestId),
          );
          setOpened(null);
        }}
      />
    ) : null,
  };
}

export function AgentAdmissionReview({
  peer,
  admission,
  onClose,
  onResolved,
}: {
  peer: Peer;
  admission: AgentAdmission;
  onClose: () => void;
  onResolved: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [now, setNow] = useState(Date.now());
  const [finished, setFinished] = useState(false);
  const [codeMatches, setCodeMatches] = useState(false);
  const pending = useRef(false);
  const expired = admission.expiresAt <= now || finished;
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const decide = async (decision: "approve" | "deny") => {
    if (pending.current || expired || (decision === "approve" && !codeMatches))
      return;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await post<{ status?: string; error?: string }>(
        peer,
        `/api/agents/admissions/${encodeURIComponent(admission.requestId)}`,
        { decision },
      );
      if (["expired", "revoked", "failed"].includes(result.status || "")) {
        setFinished(true);
        setError(
          result.error ||
            "This connection request is no longer available. Ask the agent to use a new invitation.",
        );
      } else onResolved();
    } catch (e) {
      setError((e as Error).message);
      if (
        [401, 403, 404, 409, 410].includes(
          (e as { status?: number }).status || 0,
        )
      )
        setFinished(true);
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  const screen = {
    off: "No screen access",
    view: "View only",
    scroll: "View and scroll; scrolling does not need approval",
    ask: "Every screen input needs your approval",
    apps: "Only selected app windows. Other apps stay hidden.",
  };
  const preset = admission.browser ? admission.preset : undefined;
  const canEditFiles = admission.scopes.some((scope) =>
    (admission.browser ? ["browser:write"] : ["files", "files:write"]).includes(
      scope,
    ),
  );
  const canRun = admission.scopes.some((scope) =>
    ["exec", "terminal", "apps:drive", "browser:shell"].includes(scope),
  );
  const canViewScreen = admission.scopes.includes("browser:screen");
  const canControlScreen = admission.scopes.includes("browser:control");
  const canOpenApps = admission.scopes.includes("browser:open");
  const seconds = Math.max(0, Math.ceil((admission.expiresAt - now) / 1000));
  const countdown = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  const ends = Number.isFinite(admission.accessExpiresAt)
    ? new Date(admission.accessExpiresAt).toLocaleTimeString([], {
        hour: "numeric",
        minute: "2-digit",
      })
    : "invitation expiry";
  const endsToday =
    new Date(admission.accessExpiresAt).toDateString() ===
    new Date(now).toDateString();
  const until = !Number.isFinite(admission.accessExpiresAt)
    ? "Until invitation expiry"
    : endsToday
      ? `Until ${ends}`
      : `Until ${new Date(admission.accessExpiresAt).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`;
  return (
    <ScreenPopup
      title="Agent connection"
      onClose={onClose}
      className="agent-admission-review"
    >
      <div className="admission-scroll">
        <section className="admission-identity">
          <AgentAvatar name={readable(admission.name)} size={56} />
          <h3>
            Let <bdi>{readable(admission.name)}</bdi> connect?
          </h3>
          <p>
            {admission.browser ? "AI browser" : "Command-line agent"}
            <span aria-hidden="true"> · </span>
            <bdi>{peer.name}</bdi>
          </p>
        </section>

        <section
          className={`admission-code-card${codeMatches ? " is-confirmed" : ""}`}
          aria-label="Confirm the connection"
        >
          <p>Compare this code with the agent’s code</p>
          <output
            className="agent-verification-code"
            aria-label="Connection verification code"
          >
            <span>{admission.verificationCode.slice(0, 3)}</span>
            <span>{admission.verificationCode.slice(3)}</span>
          </output>
          <label className="agent-code-confirmation">
            <input
              type="checkbox"
              checked={codeMatches}
              disabled={busy || expired}
              onChange={(e) => setCodeMatches(e.target.checked)}
            />
            <span className="admission-checkbox" aria-hidden="true">
              <Check size={14} strokeWidth={2.5} />
            </span>
            <span>The code matches the agent I invited</span>
          </label>
        </section>

        <section className="admission-access" aria-label="Invited permissions">
          <div className="admission-section-heading">
            <h4>Access you’re allowing</h4>
            <span>{until}</span>
          </div>
          {preset && <p>Preset: {presetNames[preset]}</p>}
          <ul className="admission-access-list">
            {admission.roots.length > 0 && (
              <li>
                <Folder size={18} aria-hidden="true" />
                <div>
                  <strong>
                    {canEditFiles ? "Read and edit files" : "Read files"}
                  </strong>
                  <ul
                    className="agent-admission-resources"
                    aria-label="Shared folders"
                  >
                    {admission.roots.map((root) => (
                      <li key={root}>
                        <bdi>{readable(root)}</bdi>
                      </li>
                    ))}
                  </ul>
                </div>
                <span className="admission-permission-tag">
                  {canEditFiles ? "Read & write" : "Read only"}
                </span>
              </li>
            )}
            {admission.browser ? (
              <>
                {preset && (canViewScreen || canControlScreen) && (
                  <li>
                    <Monitor size={18} aria-hidden="true" />
                    <div>
                      <strong>
                        {canControlScreen ? "Screen control" : "Screen"}
                      </strong>
                      <small>
                        {canControlScreen
                          ? "View and control allowed app windows"
                          : "View only"}
                      </small>
                      {preset === "apps" ? (
                        <>
                          <small>
                            Only selected app windows. Control includes actions
                            in their signed-in accounts.
                          </small>
                          <ul
                            className="agent-admission-resources"
                            aria-label="Shared apps"
                          >
                            {(admission.apps || []).map((app) => (
                              <li key={app.id} className="admission-app">
                                <span className="admission-app-logo">
                                  <AppLogo
                                    peer={peer}
                                    appId={app.id}
                                    name={app.name || app.id}
                                  />
                                </span>
                                <bdi>{readable(app.name || app.id)}</bdi>
                              </li>
                            ))}
                          </ul>
                        </>
                      ) : (
                        <small>
                          Protected and hidden windows are excluded from the
                          shared screen.
                        </small>
                      )}
                      {!!admission.hidden?.length && (
                        <ul
                          className="agent-admission-resources"
                          aria-label="Hidden apps"
                        >
                          {admission.hidden.map((app) => (
                            <li key={app.id}>
                              Hidden: <bdi>{readable(app.name || app.id)}</bdi>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  </li>
                )}
                {preset && canOpenApps && (
                  <li>
                    <Monitor size={18} aria-hidden="true" />
                    <div>
                      <strong>
                        {preset === "apps" ? "Open selected apps" : "Open apps"}
                      </strong>
                    </div>
                  </li>
                )}
                {preset && admission.scopes.includes("browser:shell") && (
                  <li>
                    <Terminal size={18} aria-hidden="true" />
                    <div>
                      <strong>Shell commands</strong>
                      <small>
                        Runs with your operating-system permissions.
                      </small>
                    </div>
                  </li>
                )}
                {admission.screen && admission.screen !== "off" && (
                  <li>
                    <Monitor size={18} aria-hidden="true" />
                    <div>
                      <strong>
                        {admission.screen === "apps"
                          ? "App access"
                          : admission.screen === "ask"
                            ? "Screen control"
                            : "Screen"}
                      </strong>
                      <small>{screen[admission.screen]}</small>
                      {admission.screen === "apps" && (
                        <>
                          {!!admission.appAccess?.length ? (
                            <ul
                              className="agent-admission-resources"
                              aria-label="Shared apps"
                            >
                              {admission.appAccess.map((app) => (
                                <li key={app.id} className="admission-app">
                                  <span className="admission-app-logo">
                                    <AppLogo
                                      peer={peer}
                                      appId={app.id}
                                      name={app.name || app.id}
                                    />
                                  </span>
                                  <bdi>
                                    {readable(
                                      app.name ||
                                        app.id
                                          .split("/")
                                          .at(-1)
                                          ?.replace(/\.app$/, "") ||
                                        app.id,
                                    )}
                                  </bdi>{" "}
                                  ·{" "}
                                  {app.mode === "control"
                                    ? "View & control"
                                    : "View only"}
                                </li>
                              ))}
                            </ul>
                          ) : (
                            <small>
                              No apps shared yet. The agent can ask for access.
                            </small>
                          )}
                          {admission.appAccess?.some(
                            (app) => app.mode === "control",
                          ) && (
                            <small>
                              Control allows actions inside that app, including
                              its signed-in accounts.
                            </small>
                          )}
                          <small>
                            Approve more apps on your phone or another verified
                            device; Reach on this Mac is locked during this
                            invitation.
                          </small>
                        </>
                      )}
                    </div>
                  </li>
                )}
                {!!admission.terminalIds?.length && (
                  <li>
                    <Terminal size={18} aria-hidden="true" />
                    <div>
                      <strong>Terminal output</strong>
                      <small>
                        {admission.terminalIds.length} selected{" "}
                        {admission.terminalIds.length === 1
                          ? "terminal"
                          : "terminals"}{" "}
                        · Read only
                      </small>
                    </div>
                  </li>
                )}
                {admission.restrictedTerminal && (
                  <li>
                    <Terminal size={18} aria-hidden="true" />
                    <div>
                      <strong>Terminal commands</strong>
                      <small>
                        {admission.scriptApproval
                          ? "Read commands run directly. Approve each other command or script once, inside the shared folder. No network, sudo or helper processes. All commands are logged."
                          : admission.terminalApproval
                            ? "Read commands run directly. Supported file changes need your approval. Every command stays inside the shared folders and is logged. Scripts and sudo are blocked."
                            : "Read-only commands run directly inside shared folders and are logged. Scripts, sudo and file changes are blocked."}
                      </small>
                    </div>
                  </li>
                )}
                {admission.commandRequests && (
                  <li>
                    <ShieldCheck size={18} aria-hidden="true" />
                    <div>
                      <strong>Ask you to handle commands</strong>
                      <small>Reach never executes these requests.</small>
                    </div>
                  </li>
                )}
              </>
            ) : (
              admission.scopes
                .filter(
                  (s) =>
                    !["device", "files", "files:read", "files:write"].includes(
                      s,
                    ),
                )
                .map((scope) => (
                  <li key={scope}>
                    <ShieldCheck size={18} aria-hidden="true" />
                    <div>
                      <strong>{scopeLabel(scope)}</strong>
                    </div>
                  </li>
                ))
            )}
          </ul>
          {admission.browser &&
            !preset &&
            !admission.roots.length &&
            (!admission.screen || admission.screen === "off") &&
            !admission.terminalIds?.length &&
            !admission.commandRequests &&
            !admission.restrictedTerminal && (
              <p className="admission-no-resources">
                Shared computer details only.
              </p>
            )}
          {canRun && (
            <p className="agent-admission-warning">
              Commands can act as your user beyond shared folders, including
              sensitive files. This connection does not require separate
              approval for each command.
              {admission.scopes.includes("browser:shell") &&
                " Protected screen and file-tool checks are guardrails, not a sandbox for shell commands."}
            </p>
          )}
        </section>

        <details className="admission-more">
          <summary>
            Connection details
            <ChevronDown size={15} aria-hidden="true" />
          </summary>
          <p>
            The invitation name does not prove which app or person opened the
            link. Compare the code with the agent you invited.
          </p>
          <dl className="agent-admission-details">
            {admission.browserTransport === "funnel" ? (
              <>
                <dt>Connection</dt>
                <dd>Temporary Tailscale Funnel</dd>
                <dt>Browser identity</dt>
                <dd>Bound to this browser</dd>
              </>
            ) : (
              <>
                <dt>Connecting device</dt>
                <dd>
                  {admission.nodeName
                    ? readable(admission.nodeName)
                    : "Unavailable"}
                </dd>
                <dt>Device identity</dt>
                <dd>
                  {admission.nodeId
                    ? readable(admission.nodeId)
                    : "Unavailable"}
                </dd>
              </>
            )}
            <dt>Access ends</dt>
            <dd>
              {Number.isFinite(admission.accessExpiresAt)
                ? new Date(admission.accessExpiresAt).toLocaleString()
                : "At the invitation’s expiry"}
            </dd>
          </dl>
          {!!admission.terminalIds?.length && (
            <>
              <h4>Selected terminal output</h4>
              <ul className="agent-admission-resources">
                {admission.terminalIds.map((id) => (
                  <li key={id}>
                    <code>{exact(id)}</code>
                  </li>
                ))}
              </ul>
            </>
          )}
          <h4>Permission details</h4>
          <ul className="agent-admission-permissions">
            {admission.scopes.map((scope) => (
              <li key={scope}>
                {labels[scope] ||
                  (scopeLabel(scope) === scope
                    ? "Permission"
                    : scopeLabel(scope))}{" "}
                <code>{exact(scope)}</code>
              </li>
            ))}
          </ul>
        </details>
      </div>
      <footer className="admission-footer">
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <p className={`admission-status${expired ? " is-expired" : ""}`}>
          {expired ? (
            "Request expired. Ask the agent to reconnect with a new invite."
          ) : (
            <>
              <span>You can end access anytime</span>
              <span>Expires in {countdown}</span>
            </>
          )}
        </p>
        <div className="agent-admission-actions">
          <button
            className="admission-deny"
            disabled={busy || expired}
            onClick={() => void decide("deny")}
          >
            Deny
          </button>
          <button
            className="admission-approve"
            disabled={busy || expired || !codeMatches}
            onClick={() => void decide("approve")}
          >
            {busy ? "Responding…" : "Approve connection"}
          </button>
        </div>
      </footer>
    </ScreenPopup>
  );
}
