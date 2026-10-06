import { useEffect, useState } from "react";
import { ChevronDown, Folder, Sparkles, UserRound } from "lucide-react";
import { post, request, type Device, type Peer } from "./api";
import { FolderBrowser, type PickedFolder } from "./FolderBrowser";
import { ErrorLine, Modal } from "./ui";
import "./access-editor.css";
import { scopeLabel } from "./scope-words";

export function accessSummary(client: EditableAccess) {
  if (client.scopes?.includes("admin")) return "Full access";
  if (client.policy?.browser) {
    const policy = client.policy;
    return [
      policy.roots?.length ? "Read files" : "",
      policy.screen && policy.screen !== "off" ? ({ view: "View screen", scroll: "View and scroll", ask: "Screen actions with approval" }[policy.screen]) : "",
      policy.terminalIds?.length ? "Terminal output" : "",
      policy.restrictedTerminal ? (policy.terminalApproval ? "Terminal with command approvals" : "Read-only terminal") : "",
      policy.commandRequests ? "Command suggestions" : "",
    ].filter(Boolean).join(" · ") || "No access";
  }
  return client.scopes?.filter((scope) => scope !== "device").map((scope) => scope === "codex" ? "AI conversations" : scopeLabel(scope)).join(" · ") || "No access";
}

export type EditableAccess = {
  id: string;
  name: string;
  kind?: string;
  scopes?: string[];
  expiresAt?: number;
  status?: string;
  guestRoots?: string[];
  guestApps?: string[];
  browserTransport?: string;
  policy?: {
    invite?: boolean;
    browser?: unknown;
    roots?: string[];
    terminalIds?: string[];
    screen?: string;
    restrictedTerminal?: boolean;
    terminalApproval?: boolean;
    scriptApproval?: boolean;
    commandRequests?: boolean;
  };
};
export const canEditAccess = (client: EditableAccess) =>
  (client.kind === "guest" ||
    (client.kind === "agent" && client.policy?.invite)) &&
  (client.expiresAt || 0) > Date.now() &&
  (!client.status || ["invited", "accepted"].includes(client.status));

function existingFolders(
  client: EditableAccess,
  device: Device,
): PickedFolder[] {
  return (client.guestRoots || client.policy?.roots || []).map((full) => {
    const normalized = (path: string) =>
      /^[A-Za-z]:[\\/]/.test(path)
        ? path.replaceAll("\\", "/").toLowerCase()
        : path;
    const root = [...device.roots]
      .sort((a, b) => b.path.length - a.path.length)
      .find(
        (r) =>
          normalized(full) === normalized(r.path) ||
          normalized(full).startsWith(
            normalized(r.path).replace(/\/$/, "") + "/",
          ),
      );
    return {
      root: root?.id ?? -1,
      path: root
        ? full
            .slice(root.path.replace(/[\\/]$/, "").length)
            .replace(/^[\\/]/, "")
            .replaceAll("\\", "/")
        : "",
      label: full.split(/[\\/]/).filter(Boolean).at(-1) || "Root",
      full,
    };
  });
}
const localTime = (time: number) => {
  const date = new Date(time);
  return new Date(time - date.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 16);
};

export default function AccessEditor({
  peer,
  device,
  client,
  onClose,
  onSaved,
}: {
  peer: Peer;
  device: Device;
  client: EditableAccess;
  onClose: () => void;
  onSaved: (removed?: boolean) => void;
}) {
  const browser = !!client.policy?.browser;
  const agent = client.kind === "agent";
  const scopes = client.scopes || [];
  const [folders, setFolders] = useState(() => existingFolders(client, device));
  const [full, setFull] = useState(scopes.includes("admin"));
  const [write, setWrite] = useState(scopes.includes("files:write"));
  const [terminal, setTerminal] = useState(scopes.includes("terminal"));
  const [sessions, setSessions] = useState(scopes.includes("codex"));
  const [exec, setExec] = useState(scopes.includes("exec"));
  const [apps, setApps] = useState(scopes.includes("apps:open"));
  const [screen, setScreen] = useState(
    browser
      ? client.policy?.screen || "off"
      : scopes.includes("screen:control")
        ? "control"
        : scopes.includes("screen")
          ? "view"
          : "off",
  );
  const [restricted, setRestricted] = useState(
    client.policy?.restrictedTerminal === true,
  );
  const [terminalApproval, setTerminalApproval] = useState(client.policy?.terminalApproval === true);
  const [commands, setCommands] = useState(
    client.policy?.commandRequests === true,
  );
  const [terminalIds, setTerminalIds] = useState(
    client.policy?.terminalIds || [],
  );
  const [options, setOptions] = useState<{
    terminals: { id: string; name: string }[];
  } | null>(null);
  const [until, setUntil] = useState(localTime(client.expiresAt || Date.now()));
  const [expiryChanged, setExpiryChanged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!browser) return;
    let active = true;
    request(peer, "/api/agents/browser-options")
      .then((result) => active && setOptions(result))
      .catch((e) => active && setError(e.message));
    return () => {
      active = false;
    };
  }, [browser, peer.url, peer.token]);
  const save = async () => {
    setBusy(true);
    setError("");
    try {
      await post(peer, `/api/guests/${encodeURIComponent(client.id)}/access`, {
        folders: folders.map(({ root, path }) => ({ root, path })),
        ...(browser
          ? {
              screen,
              terminalIds,
              restrictedTerminal: restricted,
              terminalApproval: restricted && terminalApproval,
              scriptApproval: restricted && terminalApproval,
              commandRequests: commands,
            }
          : agent
            ? { write, exec, terminal, codex: sessions }
            : {
                full,
                write,
                terminal,
                agents: sessions,
                screen: screen === "off" ? false : screen,
                ...(apps ? { apps: client.guestApps || "all" } : {}),
              }),
        ...(expiryChanged ? { expiresAt: new Date(until).getTime() } : {}),
      });
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!confirm(`Remove ${client.name}’s access now?`)) return;
    setBusy(true);
    setError("");
    try {
      await request(peer, `/api/clients/${encodeURIComponent(client.id)}`, {
        method: "DELETE",
      });
      onSaved(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const toggle = (
    label: string,
    checked: boolean,
    change: (value: boolean) => void,
    note?: string,
  ) => (
    <label className="ae-toggle">
      <span>
        {label}
        {note && <small>{note}</small>}
      </span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => change(e.target.checked)}
      />
    </label>
  );
  return (
    <Modal title="Edit access" onClose={() => !busy && onClose()}>
      <form
        className="access-editor"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <div className="ae-person">
          {agent ? <Sparkles size={22} /> : <UserRound size={22} />}
          <div>
            <strong>{client.name}</strong>
            <small>{device.name}</small>
          </div>
        </div>
        <fieldset disabled={busy}>
          {!agent && toggle("Full access", full, setFull)}
          {!full && (
            <>
              <details className="ae-folders">
                <summary>
                  <Folder size={17} />
                  <span>Shared folders</span>
                  <small>{folders.length || "None"}</small>
                  <ChevronDown size={16} />
                </summary>
                <FolderBrowser
                  peer={peer}
                  device={device}
                  picked={folders}
                  onChange={setFolders}
                />
              </details>
              {!browser &&
                folders.length > 0 &&
                toggle("Edit files", write, setWrite)}
              {(!agent || browser) && (
                <label className="ae-select">
                  <span>Screen</span>
                  <select
                    aria-label="Screen permission"
                    value={screen}
                    onChange={(e) => {
                      setScreen(e.target.value);

                    }}
                  >
                    <option value="off">No access</option>
                    <option value="view">View only</option>
                    {browser ? (
                      <>
                        <option value="scroll">View and scroll</option>
                        <option value="ask">Ask before actions</option>
                      </>
                    ) : (
                      <option value="control">View and control</option>
                    )}
                  </select>
                </label>
              )}
              {browser ? (
                <>
                  {toggle(
                    "Terminal commands",
                    restricted,
                    (value) => {
                      setRestricted(value);
                      if (!value) setTerminalApproval(false);
                      if (value) {
                        setCommands(false);

                      }
                    },
                    "Read commands run inside shared folders. Every command is logged.",
                  )}
                  {restricted && toggle("Commands with approval", terminalApproval, setTerminalApproval, "Approve each command or script once, inside shared folders. No network, sudo or helper processes.")}
                  {commands &&
                    toggle(
                      "Command suggestions",
                      commands,
                      setCommands,
                      "Suggestions only; no execution.",
                    )}
                  <details className="ae-folders">
                    <summary>
                      <span>Terminal output</span>
                      <small>{terminalIds.length || "None"}</small>
                      <ChevronDown size={16} />
                    </summary>
                    {!options && <p className="muted">Loading terminals…</p>}
                    {options &&
                      !options.terminals.length &&
                      !terminalIds.length && (
                        <p className="muted">No open terminals.</p>
                      )}
                    {[
                      ...(options?.terminals || []),
                      ...terminalIds
                        .filter(
                          (id) =>
                            !options?.terminals.some((item) => item.id === id),
                        )
                        .map((id) => ({ id, name: "Unavailable terminal" })),
                    ].map((item) => (
                      <div key={item.id}>
                        {toggle(
                          item.name,
                          terminalIds.includes(item.id),
                          (on) =>
                            setTerminalIds(
                              on
                                ? [...terminalIds, item.id]
                                : terminalIds.filter((id) => id !== item.id),
                            ),
                        )}
                      </div>
                    ))}
                  </details>
                </>
              ) : (
                <>
                  {toggle("Terminal", terminal, setTerminal)}
                  {toggle("AI conversations", sessions, setSessions)}
                  {agent
                    ? toggle(
                        "Run commands",
                        exec,
                        setExec,
                        "Unrestricted commands run as you.",
                      )
                    : toggle("View apps", apps, setApps)}
                </>
              )}
            </>
          )}
          <div className="ae-expiry">
            <label htmlFor="access-until">Access ends</label>
            <input
              id="access-until"
              type="datetime-local"
              required
              value={until}
              onChange={(e) => {
                setUntil(e.target.value);
                setExpiryChanged(true);
              }}
            />
            <div className="ae-times">
              {[
                15,
                30,
                60,
                ...(client.browserTransport === "funnel" ? [] : [240, 1440]),
              ].map((minutes) => (
                <button
                  key={minutes}
                  type="button"
                  onClick={() => {
                    setUntil(localTime(Date.now() + minutes * 60000));
                    setExpiryChanged(true);
                  }}
                >
                  {minutes < 60
                    ? `${minutes} min`
                    : minutes === 1440
                      ? "1 day"
                      : `${minutes / 60} hr`}
                </button>
              ))}
            </div>
          </div>
        </fieldset>
        <ErrorLine error={error} />
        <div className="ae-actions">
          <button
            type="button"
            className="button ghost danger"
            disabled={busy}
            onClick={() => void remove()}
          >
            Remove access
          </button>
          <button type="submit" className="button primary" disabled={busy}>
            {busy ? "Saving…" : "Save changes"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
