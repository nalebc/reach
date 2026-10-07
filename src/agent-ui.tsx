import { useId, useMemo, useState, type ReactNode } from "react";
import { Check, ChevronDown, Lock, Search, X } from "lucide-react";
import AppLogo from "./AppLogo";
import type { Peer } from "./api";
import "./agent-ui.css";

// Shared pieces for everything an owner does with agents: inviting one,
// approving its connection, managing its access, answering its requests.
// One look throughout (agent-ui.css): calm rows, one accent, real app logos.

const hues = [152, 200, 268, 32, 330, 96];
const initial = (name: string) =>
  (name.trim().match(/[\p{L}\p{N}]/u)?.[0] || "?").toUpperCase();

// An invited agent has no app of its own: a soft orb with its initial, tinted
// by its name so two agents side by side are told apart at a glance.
export function AgentAvatar({
  name,
  size = 40,
  done = false,
}: {
  name: string;
  size?: number;
  done?: boolean;
}) {
  const hue = hues[[...name].reduce((n, c) => n + c.charCodeAt(0), 0) % hues.length];
  return (
    <span
      className={`ag-avatar${done ? " is-done" : ""}`}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.42), ["--hue" as string]: hue }}
      aria-hidden="true"
    >
      {done ? <Check size={size * 0.48} strokeWidth={2.4} /> : initial(name)}
    </span>
  );
}

// A drawer-style row that opens in place: icon, what it is, what's chosen.
export function AccessRow({
  icon,
  label,
  value,
  open,
  onToggle,
  children,
  attention = false,
}: {
  icon: ReactNode;
  label: string;
  value: ReactNode;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
  attention?: boolean;
}) {
  const id = useId();
  return (
    <div className={`ag-row${open ? " is-open" : ""}`}>
      <button
        type="button"
        className="ag-row-head"
        aria-expanded={open}
        aria-controls={id}
        onClick={onToggle}
      >
        <span className="ag-row-icon">{icon}</span>
        <span className="ag-row-label">{label}</span>
        <span className={`ag-row-value${attention ? " is-attention" : ""}`}>
          {value}
        </span>
        <ChevronDown className="ag-row-chevron" size={16} />
      </button>
      {/* Kept in the page while closed, so choices and browsing survive. */}
      <div className="ag-row-body" id={id} hidden={!open}>
        {children}
      </div>
    </div>
  );
}

// A platform-style switch on a real checkbox (keyboard and screen readers).
export function Switch({
  label,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  checked: boolean;
  onChange: (on: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <input
      className="ag-switch"
      type="checkbox"
      role="switch"
      aria-label={label}
      checked={checked}
      disabled={disabled}
      onChange={(e) => onChange(e.target.checked)}
    />
  );
}

// One line with a switch at the end: the whole line toggles.
export function SwitchLine({
  title,
  detail,
  icon,
  checked,
  onChange,
  disabled,
  label,
}: {
  title: ReactNode;
  detail?: ReactNode;
  icon?: ReactNode;
  checked: boolean;
  onChange: (on: boolean) => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <label className={`ag-line${disabled ? " is-disabled" : ""}`}>
      {icon && <span className="ag-line-icon">{icon}</span>}
      <span className="ag-line-text">
        <strong>{title}</strong>
        {detail && <small>{detail}</small>}
      </span>
      <Switch label={label} checked={checked} onChange={onChange} disabled={disabled} />
    </label>
  );
}

// A short list of exclusive choices as cards, each saying what it means.
export function Choices<T extends string>({
  name,
  label,
  value,
  options,
  onChange,
}: {
  name: string;
  label: string;
  value: T;
  options: { value: T; title: string; detail: string; disabled?: boolean }[];
  onChange: (value: T) => void;
}) {
  return (
    <div className="ag-choices" role="radiogroup" aria-label={label}>
      {options.map((option) => (
        <label
          key={option.value}
          className={`ag-choice${value === option.value ? " is-on" : ""}${option.disabled ? " is-disabled" : ""}`}
        >
          <input
            type="radio"
            name={name}
            value={option.value}
            aria-label={option.title}
            checked={value === option.value}
            disabled={option.disabled}
            onChange={() => onChange(option.value)}
          />
          <span className="ag-choice-dot" aria-hidden="true" />
          <span className="ag-choice-text">
            <strong>{option.title}</strong>
            <small>{option.detail}</small>
          </span>
        </label>
      ))}
    </div>
  );
}

// Pills for a small set of values (how long, how it connects).
export function Segments<T extends string | number>({
  label,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
  disabled?: boolean;
}) {
  return (
    <div className="ag-segments" role="group" aria-label={label}>
      {options.map((option) => (
        <button
          type="button"
          key={String(option.value)}
          aria-pressed={value === option.value}
          disabled={disabled}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export type PickerApp = {
  id: string;
  name: string;
  protected?: boolean;
  reason?: string;
};
const LIMIT = 40;

// The apps an agent may see, as the Mac shows them: real logos, a search
// field, chosen apps first. Apps that always stay private sit folded away
// with their reason, and show up in search so nobody wonders where they went.
export function AppPicker({
  peer,
  apps,
  chosen,
  onChange,
  disabled = false,
}: {
  peer: Peer;
  apps: PickerApp[];
  chosen: string[];
  onChange: (ids: string[]) => void;
  disabled?: boolean;
}) {
  const [query, setQuery] = useState("");
  const [all, setAll] = useState(false);
  const words = query.trim().toLowerCase();
  const eligible = useMemo(() => apps.filter((app) => !app.protected), [apps]);
  const locked = useMemo(() => apps.filter((app) => app.protected), [apps]);
  const matches = (app: PickerApp) =>
    !words || app.name.toLowerCase().includes(words);
  // A to Z, and rows never move under a finger: chosen apps show as chips.
  const listed = [...eligible]
    .sort((a, b) => a.name.localeCompare(b.name))
    .filter(matches);
  const shown = words || all ? listed : listed.slice(0, LIMIT);
  const lockedMatches = words ? locked.filter(matches) : [];
  const toggle = (id: string, on: boolean) =>
    onChange(on ? [...chosen.filter((x) => x !== id), id] : chosen.filter((x) => x !== id));
  const chosenApps = chosen
    .map((id) => apps.find((app) => app.id === id))
    .filter((app): app is PickerApp => !!app);
  const row = (app: PickerApp) => (
    <li key={app.id} className={`ag-app${app.protected ? " is-locked" : ""}`}>
      <span className="ag-app-logo">
        <AppLogo peer={peer} appId={app.id} name={app.name} />
      </span>
      <span className="ag-app-text">
        <strong>{app.name}</strong>
        {app.protected ? (
          <small>
            <Lock size={11} /> {app.reason || "Always private"}
          </small>
        ) : chosen.includes(app.id) ? (
          <small className="is-on">Can see its windows</small>
        ) : null}
      </span>
      {!app.protected && (
        <Switch
          label={`Allow ${app.name}`}
          checked={chosen.includes(app.id)}
          disabled={disabled}
          onChange={(on) => toggle(app.id, on)}
        />
      )}
    </li>
  );
  return (
    <div className="ag-apps">
      {chosenApps.length > 0 && (
        <ul className="ag-app-chips" aria-label="Allowed apps">
          {chosenApps.map((app) => (
            <li key={app.id}>
              <span className="ag-chip-logo">
                <AppLogo peer={peer} appId={app.id} name={app.name} />
              </span>
              <span>{app.name}</span>
              <button
                type="button"
                aria-label={`Remove ${app.name}`}
                disabled={disabled}
                onClick={() => toggle(app.id, false)}
              >
                <X size={13} />
              </button>
            </li>
          ))}
        </ul>
      )}
      {apps.length > 6 && (
        <label className="ag-search">
          <Search size={16} aria-hidden="true" />
          <input
            type="search"
            aria-label="Search apps"
            placeholder={`Search ${eligible.length} apps`}
            value={query}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            onChange={(e) => setQuery(e.target.value)}
          />
          {query && (
            <button type="button" aria-label="Clear search" onClick={() => setQuery("")}>
              <X size={14} />
            </button>
          )}
        </label>
      )}
      <ul className="ag-app-list" aria-label="Apps">
        {shown.map(row)}
        {lockedMatches.map(row)}
      </ul>
      {!shown.length && !lockedMatches.length && (
        <p className="ag-quiet ag-center">
          {words ? `No app called “${query.trim()}”.` : "No apps to share."}
        </p>
      )}
      {!words && !all && listed.length > LIMIT && (
        <button type="button" className="ag-link" onClick={() => setAll(true)}>
          Show all {listed.length} apps
        </button>
      )}
      {!words && locked.length > 0 && (
        <details className="ag-locked">
          <summary>
            <Lock size={14} /> Always private · {locked.length}
            <ChevronDown size={14} />
          </summary>
          <ul className="ag-app-list">{locked.map(row)}</ul>
        </details>
      )}
    </div>
  );
}

// A row of the apps an agent may see, logos first (lists and summaries).
export function AppStack({
  peer,
  apps,
  max = 4,
}: {
  peer: Peer;
  apps: { id: string; name?: string }[];
  max?: number;
}) {
  const name = (app: { id: string; name?: string }) =>
    app.name || app.id.split("/").at(-1)?.replace(/\.app$/, "") || app.id;
  return (
    <span className="ag-stack" aria-label={apps.map(name).join(", ")}>
      {apps.slice(0, max).map((app) => (
        <span className="ag-stack-logo" key={app.id}>
          <AppLogo peer={peer} appId={app.id} name={name(app)} />
        </span>
      ))}
      {apps.length > max && <span className="ag-stack-more">+{apps.length - max}</span>}
    </span>
  );
}

export const appName = (app: { id: string; name?: string }) =>
  app.name || app.id.split("/").at(-1)?.replace(/\.app$/, "") || app.id;

// A row of plain buttons instead of a dropdown: agents driving a browser by
// sight (and people on phones) pick from what they can see. One is chosen.
export function OptionButtons<T extends string | number>({
  label,
  value,
  options,
  onChange,
  disabled = false,
}: {
  label: string;
  value: T;
  options: { value: T; label: ReactNode; detail?: ReactNode; icon?: ReactNode; title?: string }[];
  onChange: (value: T) => void;
  disabled?: boolean;
}) {
  return (
    <div className="ag-options" role="radiogroup" aria-label={label}>
      {options.map((option) => (
        <button
          type="button"
          role="radio"
          key={String(option.value)}
          data-value={String(option.value)}
          aria-checked={value === option.value}
          title={option.title}
          disabled={disabled}
          onClick={() => onChange(option.value)}
        >
          {option.icon && <span className="ag-option-icon">{option.icon}</span>}
          <span className="ag-option-text">
            <strong>{option.label}</strong>
            {option.detail && <small>{option.detail}</small>}
          </span>
        </button>
      ))}
    </div>
  );
}
