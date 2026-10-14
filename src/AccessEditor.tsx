import { useEffect, useState } from "react";
import { usePageVisible } from "./page-visible";
import { ChevronDown, Folder, Monitor, ShieldCheck, Sparkles, SquareTerminal, Terminal, UserRound } from "lucide-react";
import { post, request, type Device, type Peer } from "./api";
import { FolderBrowser, placeFolder, type PickedFolder } from "./FolderBrowser";
import { ErrorLine } from "./ui";
import SubPage from "./SubPage";
import "./access-editor.css";
import AppLogo from "./AppLogo";
import { AccessRow, AgentAvatar, AppPicker, AppStack, Choices, Switch, SwitchLine, type PickerApp } from "./agent-ui";
import { PRESET_WORDS, type Preset } from "./BrowserInvite";
import { scopeLabel } from "./scope-words";
import { BrowserApprovalReview, browserActionWords, type BrowserRequest } from "./browser-approvals";

export const presetSummary = (policy: NonNullable<EditableAccess["policy"]>) => {
  const preset = policy.preset as Preset;
  const apps = (policy.apps || []).map((app) => app.name || app.id.split("/").at(-1)?.replace(/\.app$/, "") || app.id);
  return preset === "apps" ? `Apps: ${apps.join(", ") || "none"}`
    : preset === "files" ? `Files: ${policy.write ? "read and edit" : "read only"}`
      : `${PRESET_WORDS[preset]?.title || preset}${preset !== "full" && policy.hidden?.length ? ` · ${policy.hidden.length} hidden ${policy.hidden.length === 1 ? "app" : "apps"}` : ""}`;
};
export function accessSummary(client: EditableAccess) {
  if (client.scopes?.includes("admin")) return "Full access";
  if (client.policy?.browser && client.policy.preset) return presetSummary(client.policy);
  if (client.policy?.browser) {
    const policy = client.policy;
    return [
      policy.roots?.length ? "Read files" : "",
      policy.screen && policy.screen !== "off" ? ({ view: "View screen", scroll: "View and scroll", ask: "Screen actions with approval", apps: "Selected app windows" }[policy.screen]) : "",
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
  // Its mascot, as the computer drew it (server/mascots.mjs).
  mascot?: number;
  kind?: string;
  scopes?: string[];
  expiresAt?: number;
  status?: string;
  needsInvitation?: boolean;
  guestRoots?: string[];
  guestApps?: string[];
  browserTransport?: string;
  policy?: {
    invite?: boolean;
    browser?: unknown;
    roots?: string[];
    terminalIds?: string[];
    screen?: string;
    appAccess?: { id: string; name?: string; mode: "view" | "control" }[];
    // Always: no end date; it ends when unused for a week.
    standing?: boolean;
    // Preset sessions.
    preset?: string;
    apps?: { id: string; name?: string; bundleId?: string }[];
    write?: boolean;
    hidden?: { id: string; name?: string }[];
    restrictedTerminal?: boolean;
    terminalApproval?: boolean;
    scriptApproval?: boolean;
    commandRequests?: boolean;
  };
};
export const appScopedAccess = (client: EditableAccess) => !!client.policy?.browser && client.policy.screen === "apps";
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
    const at = placeFolder(full, device.roots);
    return {
      root: at?.root ?? -1,
      path: at?.path ?? "",
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

type AccessEditorProps = {
  peer: Peer;
  device: Device;
  client: EditableAccess;
  onClose: () => void;
  onSaved: (removed?: boolean) => void;
};
export default function AccessEditor(props: AccessEditorProps) {
  if (props.client.policy?.browser && props.client.policy.preset) return <PresetAccessEditor {...props} />;
  return appScopedAccess(props.client) ? <AppSessionAccess {...props} /> : <GeneralAccessEditor {...props} />;
}

// A preset agent: change its preset, apps, folders, editing or hidden apps.
// Taking the Mac (Full control, Apps), or raising Apps into unrestricted Full
// control, needs a new invitation from the phone.
type PresetApp = { id: string; name: string; bundleId: string; running: boolean; protected: boolean; reason?: string; runsCommands?: boolean };
function PresetAccessEditor({ peer, device, client, onClose, onSaved }: AccessEditorProps) {
  const current = (client.policy?.preset || "readonly") as Preset;
  const mayTakeMac = current === "full" || current === "apps";
  const needsInvitation = (next: Preset) => (next === "full" && current !== "full") || (next === "apps" && !mayTakeMac);
  const [preset, setPreset] = useState<Preset>(current);
  const [apps, setApps] = useState<string[]>((client.policy?.apps || []).map((app) => app.id));
  const [folders, setFolders] = useState(() => existingFolders(client, device));
  const [write, setWrite] = useState(client.policy?.write === true);
  const [hidden, setHidden] = useState<string[]>((client.policy?.hidden || []).map((app) => app.id));
  const [catalog, setCatalog] = useState<PresetApp[] | null>(null);
  const [openRow, setOpenRow] = useState<string | null>(null);
  const [until, setUntil] = useState(localTime(client.expiresAt || Date.now()));
  const [expiryChanged, setExpiryChanged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    request<{ presetApps?: PresetApp[] }>(peer, "/api/agents/browser-options")
      .then((result) => active && setCatalog(result.presetApps || []))
      .catch((e) => active && setError(e.message));
    return () => { active = false; };
  }, [peer.url, peer.token]);
  const pickerApps: PickerApp[] = (catalog || []).map((app) => ({ id: app.id, name: app.name, protected: app.protected, reason: app.reason, ...(app.runsCommands ? { note: "Runs commands as you" } : {}) }));
  const hideable: PickerApp[] = (catalog || []).filter((app) => !app.protected).map((app) => ({ id: app.id, name: app.name }));
  const named = (ids: string[]) => ids.map((id) => ({ id, name: catalog?.find((app) => app.id === id)?.name }));
  const missing = preset === "apps" && !apps.length ? "Pick at least one app." : preset === "files" && !folders.length ? "Pick at least one folder." : "";
  const toggleRow = (row: string) => setOpenRow((value) => (value === row ? null : row));
  const save = async () => {
    if (busy || missing) return;
    setBusy(true); setError("");
    try {
      await post(peer, `/api/guests/${encodeURIComponent(client.id)}/access`, {
        preset,
        folders: preset === "apps" || preset === "full" ? [] : folders.map(({ root, path }) => ({ root, path })),
        ...(preset === "apps" ? { apps: apps.map((id) => ({ id })) } : {}),
        ...(preset === "files" ? { write } : {}),
        ...(preset === "readonly" ? { hidden: hidden.map((id) => ({ id })) } : {}),
        ...(expiryChanged ? { expiresAt: new Date(until).getTime() } : {}),
      });
      onSaved();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  const remove = async () => {
    if (!confirm(`Remove ${client.name}’s access now?`)) return;
    setBusy(true); setError("");
    try { await request(peer, `/api/clients/${encodeURIComponent(client.id)}`, { method: "DELETE" }); onSaved(true); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  const chosen = named(apps), hiddenApps = named(hidden);
  return (
    <SubPage title="Edit access" backLabel={`Back to ${client.name}`} onBack={() => !busy && onClose()}>
      <section className="access-editor ag-manage" aria-label="Edit agent access">
        <div className="ag-manage-who">
          <AgentAvatar name={client.name} id={client.id} drawn={client.mascot} size={48} />
          <div><strong>{client.name}</strong><small>{client.policy ? presetSummary(client.policy) : ""}</small></div>
        </div>
        <p className="ag-label">What it may do</p>
        <Choices
          name={`preset-${client.id}`}
          label="Access preset"
          value={preset}
          onChange={(next) => { setPreset(next); setError(""); if (next !== "apps") setApps([]); }}
          options={(["full", "apps", "files", "readonly"] as Preset[]).map((value) => ({
            value, title: PRESET_WORDS[value].title,
            detail: needsInvitation(value) ? "Needs a new invitation from your phone." : PRESET_WORDS[value].detail,
            disabled: needsInvitation(value),
          }))}
        />
        <div className="ag-rows">
          {preset === "apps" && (
            <AccessRow icon={<Sparkles />} label="Apps it may use" value={chosen.length ? <AppStack peer={peer} apps={chosen} /> : "Pick apps"} open={openRow === "apps"} onToggle={() => toggleRow("apps")} attention={!apps.length}>
              {catalog === null ? <p className="ag-quiet">Loading apps…</p> : <AppPicker peer={peer} apps={pickerApps} chosen={apps} onChange={setApps} chosenWords="Can use it" />}
            </AccessRow>
          )}
          {preset !== "apps" && preset !== "full" && (
            <AccessRow icon={<Folder />} label="Folders" value={folders.length ? (folders.length === 1 ? folders[0].label : `${folders.length} folders`) : preset === "files" ? "Pick folders" : "Everything you share"} open={openRow === "folders"} onToggle={() => toggleRow("folders")} attention={preset === "files" && !folders.length}>
              <FolderBrowser peer={peer} device={device} picked={folders} onChange={setFolders} />
            </AccessRow>
          )}
          {preset === "files" && (
            <div className="ag-row">
              <div className="ag-row-head ag-row-static">
                <span className="ag-row-icon"><ShieldCheck /></span>
                <span className="ag-row-label">Can edit</span>
                <span className="ag-row-value">{write ? "Changes files directly" : "Read only"}</span>
                <Switch label="Can edit files" checked={write} onChange={setWrite} />
              </div>
            </div>
          )}
          {preset === "readonly" && (
            <AccessRow icon={<Monitor />} label="Hide apps from it" value={hiddenApps.length ? <AppStack peer={peer} apps={hiddenApps} /> : "None"} open={openRow === "hidden"} onToggle={() => toggleRow("hidden")}>
              <p className="ag-quiet">Passwords and Reach are always hidden.</p>
              {catalog === null ? <p className="ag-quiet">Loading apps…</p> : <AppPicker peer={peer} apps={hideable} chosen={hidden} onChange={setHidden} chosenWords="Hidden from it" chipsLabel="Hidden apps" />}
            </AccessRow>
          )}
          <div className="ag-row">
            <label className="ag-row-head ag-row-static">
              <span className="ag-row-icon"><Terminal /></span>
              <span className="ag-row-label">Ends</span>
              <input type="datetime-local" aria-label="Access ends" className="ag-mode" value={until} onChange={(e) => { setUntil(e.target.value); setExpiryChanged(true); }} />
            </label>
          </div>
        </div>
        <ErrorLine error={error || missing} />
        <div className="ag-actions">
          <button className="ag-primary ag-small" disabled={busy || !!missing} onClick={() => void save()}>{busy ? "Saving…" : "Save"}</button>
          <button className="ag-secondary ag-small" disabled={busy} onClick={onClose}>Cancel</button>
          <button className="ag-danger ag-small" disabled={busy} onClick={() => void remove()}>End access</button>
        </div>
      </section>
    </SubPage>
  );
}
function AppSessionAccess({ peer, client, onClose, onSaved }: AccessEditorProps) {
  const [items, setItems] = useState<BrowserRequest[]>([]);
  const [grants, setGrants] = useState<{ id: string; name: string; mode: "hidden" | "view" | "control"; protected: boolean }[] | null>(null);
  const [selected, setSelected] = useState<BrowserRequest | null>(null);
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const visible = usePageVisible();
  useEffect(() => {
    const controller = new AbortController();
    let reading = false;
    const refresh = async () => {
      if (reading) return;
      reading = true;
      try {
        const [records, access] = await Promise.all([
          request<BrowserRequest[]>(peer, "/api/agents/browser-requests", { signal: controller.signal }),
          request<{ apps: NonNullable<typeof grants> }>(peer, `/api/agents/browser-app-access/${encodeURIComponent(client.id)}`, { signal: controller.signal }),
        ]);
        if (!controller.signal.aborted) {
          const current = records.filter((item) => item.clientId === client.id && item.action.type === "app-access" && item.status === "pending" && item.expiresAt > Date.now());
          setItems(current);
          setGrants(access.apps.filter((app) => app.mode !== "hidden" && !app.protected));
          setSelected((old) => old ? current.find((item) => item.id === old.id) || null : null);
          setError("");
        }
      } catch (e) {
        if (!controller.signal.aborted) { setItems([]); setGrants(null); setSelected(null); setError((e as Error).message); }
      } finally { reading = false; }
    };
    if (!visible) return () => controller.abort();
    void refresh(); const timer = setInterval(() => void refresh(), 3000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [peer.url, peer.token, client.id, revision, visible]);
  const end = async () => {
    if (busy || !confirm(`End ${client.name}’s session now?`)) return;
    setBusy(true); setError("");
    try { await request(peer, `/api/clients/${encodeURIComponent(client.id)}`, { method: "DELETE" }); onSaved(true); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  const limitApp = async (appId: string, mode: "hidden" | "view") => {
    if (busy) return;
    setBusy(true); setError("");
    try {
      await post(peer, `/api/agents/browser-app-access/${encodeURIComponent(client.id)}`, { appId, mode });
      setGrants((current) => current?.map((app) => app.id === appId ? { ...app, mode } : app).filter((app) => app.mode !== "hidden") || null);
      setRevision((value) => value + 1);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  const ends = new Date(client.expiresAt || 0).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return <>
    <SubPage title="Manage app requests" backLabel={`Back to ${client.name}`} onBack={() => !busy && onClose()}>
      <section className="access-editor ag-manage">
        <div className="ag-manage-who">
          <AgentAvatar name={client.name} id={client.id} drawn={client.mascot} size={48} />
          <div><strong>{client.name}</strong><small>{accessSummary(client)}</small></div>
        </div>
        <div>
          <p className="ag-label">Apps it can see</p>
          {grants === null ? <p className="ag-quiet">Loading app access…</p> : !grants.length ? <p className="ag-quiet">No apps yet. When it asks for one, you’ll see it here and in Needs you.</p> :
            <ul className="ag-app-list ag-manage-apps">{grants.map((app) => <li className="ag-app" key={app.id}>
              <span className="ag-app-logo"><AppLogo peer={peer} appId={app.id} name={app.name} /></span>
              <span className="ag-app-text"><strong>{app.name}</strong><small className="is-on">{app.mode === "control" ? "View & control" : "Can see its windows"}</small></span>
              <select className="ag-mode" aria-label={`${app.name} session access`} disabled={busy} value={app.mode} onChange={(event) => void limitApp(app.id, event.target.value as "hidden" | "view")}>
                {app.mode === "control" && <option value="control">View &amp; control</option>}
                <option value="view">View only</option><option value="hidden">Remove</option>
              </select>
            </li>)}</ul>}
        </div>
        {!!items.length && <div className="ag-ask">
          <p><strong>{items.length} {items.length === 1 ? "app request" : "app requests"}</strong> waiting for you</p>
          <ul>{items.map((item) => <li key={item.id}>
            {item.action.type === "app-access" && <span className="ag-chip-logo"><AppLogo peer={peer} appId={item.action.appId} name={item.action.appName} /></span>}
            <code>{browserActionWords(item.action)}</code>
            <button className="ag-primary ag-small" onClick={() => setSelected(item)}>Review request</button>
          </li>)}</ul>
        </div>}
        {!!client.policy?.roots?.length && <p className="ag-note"><Folder size={14} /> Shared folders: {client.policy.roots.join(", ")}</p>}
        <p className="ag-note">App permissions end with this invitation. Create a new invitation to change folder or terminal permissions.</p>
        <ErrorLine error={error} />
        <div className="ag-manage-end">
          <span>Session ends {ends}.</span>
          <button className="ag-danger ag-small" disabled={busy} onClick={() => void end()}>{busy ? "Ending…" : "End session"}</button>
        </div>
      </section>
    </SubPage>
    {selected && <BrowserApprovalReview peer={peer} item={selected} onClose={() => setSelected(null)} onResolved={() => { setSelected(null); setRevision((value) => value + 1); }} />}
  </>;
}

function GeneralAccessEditor({
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
  const [openRow, setOpenRow] = useState<string | null>(null);
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
                ...(full ? { fullControlVersion: 1 } : {}),
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
  if (browser) {
    const commandMode = !restricted ? "off" : terminalApproval ? "approve" : "read";
    const terminals = [
      ...(options?.terminals || []),
      ...terminalIds
        .filter((id) => !options?.terminals.some((item) => item.id === id))
        .map((id) => ({ id, name: "Unavailable terminal" })),
    ];
    const toggleRow = (row: string) => setOpenRow((current) => (current === row ? null : row));
    return (
      <SubPage title="Edit access" backLabel={`Back to ${client.name}`} onBack={() => !busy && onClose()}>
        <form
          className="access-editor ag-manage"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <div className="ag-manage-who">
            <AgentAvatar name={client.name} id={client.id} drawn={client.mascot} size={48} />
            <div>
              <strong>{client.name}</strong>
              <small>{device.name}</small>
            </div>
          </div>
          <fieldset disabled={busy} className="ag-fieldset">
            <div className="ag-rows">
              <AccessRow
                icon={<Folder />}
                label="Files"
                value={folders.length ? (folders.length === 1 ? folders[0].label : `${folders.length} folders`) : "Off"}
                open={openRow === "files"}
                onToggle={() => toggleRow("files")}
              >
                <FolderBrowser peer={peer} device={device} picked={folders} onChange={setFolders} />
              </AccessRow>
              <div className="ag-row">
                <label className="ag-row-head ag-row-static">
                  <span className="ag-row-icon"><Monitor /></span>
                  <span className="ag-row-label">Screen</span>
                  <select
                    className="ag-mode"
                    aria-label="Screen permission"
                    value={screen}
                    onChange={(e) => setScreen(e.target.value)}
                  >
                    <option value="off">No access</option>
                    <option value="view">View only</option>
                    <option value="scroll">View and scroll</option>
                    <option value="ask">Ask before actions</option>
                  </select>
                </label>
              </div>
              <AccessRow
                icon={<SquareTerminal />}
                label="Terminal output"
                value={terminalIds.length ? `${terminalIds.length} watched` : "Off"}
                open={openRow === "output"}
                onToggle={() => toggleRow("output")}
              >
                {!options && <p className="ag-quiet">Loading terminals…</p>}
                {options && !terminals.length && <p className="ag-quiet">No open terminals.</p>}
                <div className="ag-lines">
                  {terminals.map((item) => (
                    <SwitchLine
                      key={item.id}
                      label={`Watch ${item.name}`}
                      icon={<Terminal size={18} />}
                      title={item.name}
                      checked={terminalIds.includes(item.id)}
                      onChange={(on) =>
                        setTerminalIds(on ? [...terminalIds, item.id] : terminalIds.filter((id) => id !== item.id))
                      }
                    />
                  ))}
                </div>
              </AccessRow>
              <AccessRow
                icon={<ShieldCheck />}
                label="Commands"
                value={commandMode === "approve" ? "You approve" : commandMode === "read" ? "Read-only" : commands ? "Suggestions" : "Off"}
                open={openRow === "commands"}
                onToggle={() => toggleRow("commands")}
              >
                <Choices
                  name={`commands-${client.id}`}
                  label="Commands"
                  value={commandMode}
                  onChange={(value) => {
                    setRestricted(value !== "off");
                    setTerminalApproval(value === "approve");
                    if (value !== "off") setCommands(false);
                  }}
                  options={[
                    { value: "off", title: "No commands", detail: "It can’t run anything." },
                    { value: "read", title: "Read-only commands", detail: "Read commands run inside shared folders. Every command is logged." },
                    { value: "approve", title: "Ask me first", detail: "Approve each command or script once, inside shared folders. No network, sudo or helper processes." },
                  ]}
                />
                {commands && (
                  <SwitchLine
                    label="Command suggestions"
                    title="Command suggestions"
                    detail="Suggestions only; no execution."
                    checked={commands}
                    onChange={setCommands}
                  />
                )}
              </AccessRow>
            </div>
            <div className="ag-ends">
              <label htmlFor="access-until" className="ag-label">Access ends</label>
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
              <div className="ag-quick">
                {[15, 30, 60, ...(client.browserTransport === "funnel" ? [] : [240, 1440])].map((minutes) => (
                  <button
                    key={minutes}
                    type="button"
                    onClick={() => {
                      setUntil(localTime(Date.now() + minutes * 60000));
                      setExpiryChanged(true);
                    }}
                  >
                    {minutes < 60 ? `${minutes} min` : minutes === 1440 ? "1 day" : `${minutes / 60} hr`}
                  </button>
                ))}
              </div>
            </div>
          </fieldset>
          <ErrorLine error={error} />
          <div className="ag-manage-end">
            <button type="button" className="ag-danger ag-small" disabled={busy} onClick={() => void remove()}>
              Remove access
            </button>
            <button type="submit" className="ag-primary ag-small" disabled={busy}>
              {busy ? "Saving…" : "Save changes"}
            </button>
          </div>
        </form>
      </SubPage>
    );
  }
  return (
    <SubPage title="Edit access" backLabel={`Back to ${client.name}`} onBack={() => !busy && onClose()}>
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
          {!agent && full && <p>Includes every window, private data and system dialogs. Only give this to someone you trust with your computer.</p>}
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
    </SubPage>
  );
}
