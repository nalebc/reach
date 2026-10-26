import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentType,
  type ReactNode,
} from "react";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Globe,
  Plug,
  Plus,
  Sparkles,
  SquareTerminal,
  UserRound,
} from "lucide-react";
import "./invite-sheet.css";
import "./invite-flow.css";

// The invitation's pickers, as ChatGPT's: a row shows the choice, a tap opens
// a small menu of options (an icon, a name, one line, a check). Shared by the
// person and agent invitations so both read the same way.
export function Menu({
  label,
  children,
  wide = false,
  className = "",
}: {
  label: ReactNode;
  children: (close: () => void) => ReactNode;
  wide?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  // Near the bottom of a sheet the list opens upward, never cut off.
  const [up, setUp] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", key);
    };
  }, [open]);
  useLayoutEffect(() => {
    if (!open || !list.current || !box.current) return setUp(false);
    let clip: Element | null = box.current.parentElement;
    while (clip && !/auto|scroll|hidden/.test(getComputedStyle(clip).overflowY))
      clip = clip.parentElement;
    const room = clip?.getBoundingClientRect() || {
      top: 0,
      bottom: window.innerHeight,
    };
    const button = box.current.getBoundingClientRect();
    const height = list.current.offsetHeight + 6;
    setUp(button.bottom + height > room.bottom && button.top - height >= room.top);
  }, [open]);
  return (
    <div className={`ivt-menu ${className}`} ref={box}>
      <button
        type="button"
        className="ivt-menu-button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {label}
        <ChevronDown size={15} />
      </button>
      {open && (
        <div
          ref={list}
          className={`ivt-menu-list${wide ? " wide" : ""}${up ? " up" : ""}`}
          role="menu"
        >
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}
export function Item({
  on,
  label,
  description,
  icon,
  disabled = false,
  onClick,
}: {
  on: boolean;
  label: ReactNode;
  description?: string;
  icon?: ReactNode;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitemcheckbox"
      aria-checked={on}
      className={`ivt-item${icon ? " with-icon" : ""}`}
      disabled={disabled}
      onClick={onClick}
    >
      {icon && (
        <span className="ivt-item-icon" aria-hidden="true">
          {icon}
        </span>
      )}
      <span>
        <strong>{label}</strong>
        {description && <small>{description}</small>}
      </span>
      {on && <Check size={16} />}
    </button>
  );
}
// One line of the invitation: an icon and a name, then its choice.
export function Row({
  icon,
  label,
  children,
}: {
  icon: ReactNode;
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="ivt-row">
      <span className="ivt-setting-label">
        {icon} {label}
      </span>
      {children}
    </div>
  );
}

// A section's name, small and quiet above its group (as ChatGPT's settings).
export function Section({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="inv-section">
      <h3 className="inv-title">{title}</h3>
      {children}
    </div>
  );
}

// The one choice that matters, as a list: an icon, a name, one line and a
// check on the chosen one. Choosing never sends anything; the white pill does.
export type Choice<T extends string> = {
  value: T;
  label: string;
  description: string;
  icon: ComponentType<{ size?: number; strokeWidth?: number }>;
  disabled?: boolean;
};
export function Choices<T extends string>({
  label,
  options,
  value,
  onChange,
  disabled = false,
}: {
  label: string;
  options: Choice<T>[];
  value: T | null;
  onChange: (value: T) => void;
  disabled?: boolean;
}) {
  return (
    <div className="ivt-rows inv-choices" role="radiogroup" aria-label={label}>
      {options.map(({ value: v, label: name, description, icon: Icon, disabled: off }) => (
        <button
          type="button"
          key={v}
          role="radio"
          aria-checked={v === value}
          aria-label={name}
          className={`ivt-row inv-choice${v === value ? " is-on" : ""}`}
          disabled={disabled || off}
          onClick={() => onChange(v)}
        >
          <span className="inv-choice-icon" aria-hidden="true">
            <Icon size={20} strokeWidth={1.7} />
          </span>
          <span className="inv-choice-text">
            <strong>{name}</strong>
            <small>{description}</small>
          </span>
          <span className="inv-check" aria-hidden="true">
            {v === value && <Check size={15} strokeWidth={2.4} />}
          </span>
        </button>
      ))}
    </div>
  );
}

// The one Invite button, on Home's Access card and in Agents & people's
// header alike: the same action looks the same and says what it does,
// rather than a bare "+" on one screen and a labelled pill on the other.
export function InviteButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" className="invite-pill" aria-label={label} onClick={onClick}>
      <Plus size={17} aria-hidden="true" /> Invite
    </button>
  );
}

// Who is invited: the invitation's first screen. Two rows, agents first.
export type Who = "browser" | "person";
export function InviteChooser({ onPick }: { onPick: (who: Who) => void }) {
  const rows: { who: Who; icon: ReactNode; label: string; line: string }[] = [
    {
      who: "browser",
      icon: <Sparkles size={22} strokeWidth={1.7} />,
      label: "An agent",
      line: "Claude, Codex, ChatGPT or any AI",
    },
    {
      who: "person",
      icon: <UserRound size={22} strokeWidth={1.7} />,
      label: "A person",
      line: "Someone you trust, on their phone or computer",
    },
  ];
  return (
    <div className="ivt inv-who">
      <div className="ivt-rows">
        {rows.map((r) => (
          <button
            type="button"
            key={r.who}
            className={`ivt-row inv-who-row ${r.who === "person" ? "person" : "agent"}`}
            onClick={() => onPick(r.who)}
          >
            <span className="inv-who-icon" aria-hidden="true">
              {r.icon}
            </span>
            <span className="inv-choice-text">
              <strong>{r.label}</strong>
              <small>{r.line}</small>
            </span>
            <ChevronRight size={18} className="inv-go" aria-hidden="true" />
          </button>
        ))}
      </div>
      <p className="inv-foot">
        You approve everyone before they get in, and can end their access any
        time.
      </p>
    </div>
  );
}

// How an agent connects. Tools, Web page and Hosted take a preset
// (BrowserInvite); Command line takes folders (InviteSheet), offered only
// where presets aren't (a computer that isn't a Mac).
export type Via = "tools" | "page" | "hosted" | "cli";
// The agent invitation's first question, as three tiles named for what the
// agent does with its invite, wherever it runs (Muse, Grok or Codex may have
// a terminal and a chat app both): run a command (Tools), add a connector
// URL (Hosted), open a web link (Web page).
export type Place = "command" | "connector" | "link";
export const placeOf = (via: Via): Place =>
  via === "hosted" ? "connector" : via === "page" ? "link" : "command";
const PLACES: {
  place: Place;
  via: Via;
  label: string;
  line: string;
  icon: ComponentType<{ size?: number; strokeWidth?: number }>;
}[] = [
  {
    place: "command",
    via: "tools",
    label: "Command",
    line: "It runs one command in its terminal. Works for most agents.",
    icon: SquareTerminal,
  },
  {
    place: "connector",
    via: "hosted",
    label: "Connector",
    line: "You add a link as a custom connector in its settings.",
    icon: Plug,
  },
  {
    place: "link",
    via: "page",
    label: "Web link",
    line: "It opens a link in its browser and sees your screen. Slower.",
    icon: Globe,
  },
];
export function Places({
  via,
  onChange,
}: {
  via: Via;
  onChange: (via: Via) => void;
}) {
  const place = placeOf(via);
  return (
    <Section title="How does it connect?">
      <div className="inv-places" role="radiogroup" aria-label="How the agent connects">
        {PLACES.map(({ place: p, via: v, label, icon: Icon }) => (
          <button
            type="button"
            key={p}
            role="radio"
            aria-checked={p === place}
            className={`inv-place${p === place ? " is-on" : ""}`}
            onClick={() => p !== place && onChange(v)}
          >
            <Icon size={22} strokeWidth={1.7} />
            <span>{label}</span>
          </button>
        ))}
      </div>
      <p className="inv-place-line">
        {PLACES.find((p) => p.place === place)!.line}
      </p>
    </Section>
  );
}
