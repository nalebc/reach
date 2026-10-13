import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronLeft, ChevronRight, ChevronsUpDown, LoaderCircle } from "lucide-react";
import { effortLabel, type AgentModel, type AgentName } from "./agent-sessions";
import { dragToClose } from "./sheet-drag";
import "./model-sheet.css";

// The model and its effort, picked as each app has you pick them (their
// phone apps, Oct 6). Claude: a small menu over the composer as ChatGPT draws
// its model picker (Oct 8: the sheet was far too big for a model): one
// compact row per model, its purpose in one short line, and Effort as its own
// row that turns the same menu into its levels.
// Codex: the model and effort as words over the composer with a row of dots
// to slide the effort, and the models in a "Configure" sheet with Done.
// Before, every model and then every effort sat in one list.

export type ModelChoice = { model?: string; effort?: string; speed?: string };
type Props = {
  agent: AgentName;
  models: AgentModel[];
  model: string | null;
  effort: string | null;
  // Codex's speed for the next message (Configure's Speed row).
  speed?: string | null;
  busy?: boolean;
  error?: string;
  // The Mac's own word on a pick it took but hasn't made yet ("queued").
  notice?: string;
  working?: boolean;
  // The Claude app's Ultracode, on for this chat (shown, not a toggle).
  ultracode?: boolean;
  onRetry?: () => void;
  // Sends the refused pick once more (a tap; never by itself).
  onAgain?: () => void;
  onPick: (choice: ModelChoice) => void;
  onClose: () => void;
  // Codex: over its greyed-out models, what unlocks them (an update to its
  // service: KeepInSync.tsx SyncLine).
  footer?: ReactNode;
};

// A chat may use a model the connection's picker no longer lists. Its real
// selection must never turn into the catalog's default just by opening it.
// The Claude app names a variant with a suffix ("claude-opus-5-5[1m]", its
// 1M context window) that Claude Code's catalog doesn't list: the same model.
const byId = (models: AgentModel[], model: string) =>
  models.find((m) => m.id === model) || models.find((m) => m.resolvedModel === model && !m.isDefault) || models.find((m) => m.resolvedModel === model);
export const currentModel = (models: AgentModel[], model: string | null) =>
  model
    ? byId(models, model) || (/\[[^\]]+\]$/.test(model) ? byId(models, model.replace(/\[[^\]]+\]$/, "")) : undefined)
    : models.find((m) => m.isDefault) || models[0];
export const modelDisplayName = (model: string) => {
  const parts = /^gpt-([\d.]+)-(.+)$/i.exec(model);
  return parts
    ? `GPT-${parts[1]} ${parts[2].split("-").map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" ")}`
    : model;
};
// Keeps the effort when the new model has it, else the model's own default.
export const effortFor = (m: AgentModel, effort: string | null) =>
  effort && m.efforts.includes(effort) ? effort : m.defaultEffort || undefined;
// Claude Code's levels in Claude's words ("Extra high", not "Extra").
const levelName = (e: string, agent: AgentName) =>
  agent === "claude" && e === "xhigh" ? "Extra high" : effortLabel(e, agent);

// A bottom sheet over the chat, closed by its ✕/Done, the dimmed chat, or a
// pull down.
function Sheet({ agent, label, className, onClose, children }: { agent: AgentName; label: string; className: string; onClose: () => void; children: React.ReactNode }) {
  const sheet = useRef<HTMLDivElement>(null);
  useEffect(() => (sheet.current ? dragToClose(sheet.current, onClose) : undefined), [onClose]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onClose]);
  return createPortal(
    <div className={`ms-layer ${agent}`}>
      <div className="ms-scrim" onClick={onClose} />
      <div ref={sheet} className={`ms-sheet ${className}`} role="dialog" aria-modal="true" aria-label={label}>
        <span className="sheet-handle" aria-hidden="true" />
        {children}
      </div>
    </div>,
    // A sheet open over a chat (a new chat's) first: the chat stays under it.
    document.querySelector(".reach-chat-sheet") || document.querySelector(".as-page, .chat-home") || document.body,
  );
}

// A small menu just above the button that opened it, as ChatGPT's model
// picker: no dimmed chat, closed by a tap anywhere else or Escape.
const MENU_WIDTH = 300;
// The model button last pressed: the menu belongs to it, wherever it is (a
// chat's composer, or New chat's over it).
let trigger: Element | null = null;
if (typeof document !== "undefined")
  document.addEventListener(
    "pointerdown",
    (e) => { trigger = (e.target as Element | null)?.closest?.(".as-model, .chat-model") || trigger; },
    true,
  );
function anchorOf() {
  const pressed = trigger instanceof HTMLElement && trigger.isConnected && trigger.offsetParent ? trigger : null;
  return pressed || [...document.querySelectorAll<HTMLElement>(".as-model, .chat-model")].reverse().find((b) => b.offsetParent) || null;
}
function Menu({ agent, label, className, onClose, children }: { agent: AgentName; label: string; className: string; onClose: () => void; children: React.ReactNode }) {
  const [place, setPlace] = useState<React.CSSProperties>({});
  useLayoutEffect(() => {
    // Measured in the same coordinates as the button (its client rect): the
    // menu's bottom edge 8px above it. Followed every frame while open, so
    // the keyboard, a growing composer, a resize or a rotation never leave
    // it behind (a resize event comes before the chat has moved: Oct 8).
    let last = "";
    let frame = 0;
    const measure = () => {
      const box = anchorOf()?.getBoundingClientRect();
      const width = Math.min(MENU_WIDTH, window.innerWidth - 24);
      const next: React.CSSProperties =
        !box || !box.width
          ? { width, left: (window.innerWidth - width) / 2, top: window.innerHeight - 96, maxHeight: Math.max(160, window.innerHeight - 120) }
          : {
              width,
              left: Math.max(12, Math.min(box.right - width, window.innerWidth - width - 12)),
              top: box.top - 8,
              maxHeight: Math.max(160, Math.min(440, box.top - 20)),
            };
      const key = JSON.stringify(next);
      if (key !== last) {
        last = key;
        setPlace(next);
      }
    };
    const follow = () => {
      measure();
      frame = requestAnimationFrame(follow);
    };
    measure();
    frame = requestAnimationFrame(follow);
    return () => cancelAnimationFrame(frame);
  }, []);
  useEffect(() => {
    // Escape closes this menu only: caught before the New chat sheet under
    // it (which closes on Escape too) can hear it.
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [onClose]);
  return createPortal(
    <div className={`ms-layer ms-pop ${agent}`}>
      <div className="ms-scrim" onClick={onClose} />
      <div className={`ms-sheet ms-menu ${className}`} style={place} role="dialog" aria-modal="true" aria-label={label}>
        {children}
      </div>
    </div>,
    document.querySelector(".reach-chat-sheet") || document.querySelector(".as-page, .chat-home") || document.body,
  );
}

function Status({ busy, error, notice, working, empty, onRetry, onAgain, changing = "model", quiet = false }: { busy?: boolean; error?: string; notice?: string; working?: boolean; empty: boolean; onRetry?: () => void; onAgain?: () => void; changing?: "model" | "effort"; quiet?: boolean }) {
  return (
    <>
      {working && <p className="ms-note">Applies to the next turn. The current reply keeps its {changing}.</p>}
      {/* quiet: the menu says it in its header line instead, without moving. */}
      {busy && !quiet && <p className="ms-note" role="status">{empty ? "Loading models…" : `Changing ${changing}…`}</p>}
      {error && <p className="ms-note ms-error" role="alert">{error}</p>}
      {notice && !error && <p className="ms-note" role="status">{notice}</p>}
      {/* A refused pick: the same pick again, not a fresh model list (MODELS-3). */}
      {error && onAgain ? (
        <button className="ms-retry" disabled={busy} onClick={onAgain}>Try again</button>
      ) : onRetry && (
        <button className="ms-retry" disabled={busy} onClick={onRetry}>{empty ? "Try loading models again" : "Refresh model list"}</button>
      )}
    </>
  );
}

// The row tapped shows it's being changed (a spinner where its check goes)
// until the agent confirms: a tap that seemed to do nothing, Oct 6.
function Mark({ checked, pending }: { checked: boolean; pending: boolean }) {
  return pending ? <LoaderCircle size={18} className="spin ms-check" /> : checked ? <Check size={20} className="ms-check" /> : null;
}
function ModelRows({ models, model, current, busy, onPick }: { models: AgentModel[]; model: string | null; current?: AgentModel; busy?: boolean; onPick: (m: AgentModel) => void }) {
  const [tapped, setTapped] = useState("");
  const unlisted = model && !current ? model : null;
  return (
    <div className="ms-card" role="radiogroup" aria-label="Models">
      {unlisted && (
        <button className="ms-current-unlisted" role="radio" aria-checked="true" disabled>
          <span className="ms-text">
            <span>{modelDisplayName(unlisted)}</span>
            <small>{busy ? "Current model" : "Current model · Not in this connection’s model list"}</small>
          </span>
          <Check size={20} className="ms-check" />
        </button>
      )}
      {models.map((m) => (
        <button key={m.id} role="radio" aria-checked={m.id === current?.id} aria-busy={busy && tapped === m.id} disabled={busy || m.unconfirmed} onClick={() => (setTapped(m.id), onPick(m))}>
          <span className="ms-text">
            <span>{m.name}</span>
            {m.unconfirmed ? <small>Not in this connection’s model list</small> : m.description && <small>{m.description}</small>}
          </span>
          <Mark checked={m.id === current?.id} pending={!!busy && tapped === m.id} />
        </button>
      ))}
    </div>
  );
}

// Claude: "Select model", then Effort › its levels.
export function ClaudeModelSheet(props: Props) {
  const { agent, models, model, effort, busy, onPick, onClose } = props;
  const [page, setPage] = useState<"models" | "effort">("models");
  const [tapped, setTapped] = useState("");
  const current = currentModel(models, model);
  // The chat's own level only: an unknown one is "Default", never the
  // catalog's default shown as if picked (Oct 9).
  const level = effort || null;
  const levels = current?.efforts || [];
  const ultracode = props.ultracode === true;
  return (
    <Menu agent={agent} label={page === "models" ? "Model" : "Effort"} className="ms-claude" onClose={onClose}>
      <header className="ms-menu-head">
        {page === "effort" && (
          <button className="ms-back" aria-label="Back" onClick={() => setPage("models")}><ChevronLeft size={18} /></button>
        )}
        <h2>{page === "models" ? "Model" : "Effort"}</h2>
        {busy && (
          <span className="ms-menu-status" role="status">
            {!models.length ? "Loading…" : page === "effort" ? "Changing effort…" : "Changing model…"}
          </span>
        )}
      </header>
      {/* Refreshing helps only when the list is missing something. */}
      <Status {...props} onRetry={!models.length || props.error || (model && !current) ? props.onRetry : undefined} empty={!models.length} changing={page === "effort" ? "effort" : "model"} quiet />
      {page === "models" ? (
        <>
          {/* An unknown level stays unnamed: the model alone, never the
              catalog's default sent as if picked. */}
          <ModelRows models={models} model={model} current={current} busy={busy} onPick={(m) => onPick({ model: m.id, ...(level ? { effort: effortFor(m, level) } : {}) })} />
          {!!current?.efforts.length && (
            <button className="ms-card ms-row" disabled={busy} onClick={() => setPage("effort")}>
              <span>Effort</span>
              <span className="ms-value">{[level ? levelName(level, agent) : !ultracode && "Default", ultracode && level !== "ultracode" && levelName("ultracode", agent)].filter(Boolean).join(" · ")}</span>
              <ChevronRight size={16} className="ms-chevron" />
            </button>
          )}
        </>
      ) : (
        <div className="ms-card" role="radiogroup" aria-label="Effort">
          {levels.map((e) => (
            <button
              key={e}
              role="radio"
              aria-checked={e === level || (ultracode && e === "ultracode")}
              aria-busy={busy && tapped === e}
              disabled={busy}
              onClick={() => {
                // The level alone: the model stays as it is (a Claude app
                // chat changes only its effort). The page stays, its row
                // turning, until it's changed (the sheet closes) or the
                // reason it wasn't shows above.
                setTapped(e);
                onPick({ effort: e });
              }}
            >
              <span className="ms-text">
                <span>{levelName(e, agent)}</span>
                {current?.effortNotes?.[e] ? <small>{current.effortNotes[e]}</small> : !level && e === current?.defaultEffort && <small>Default</small>}
              </span>
              <Mark checked={e === level || (ultracode && e === "ultracode")} pending={!!busy && tapped === e} />
            </button>
          ))}
          {/* The chat's own level or Ultracode where the list has none: in
              its own words, never dropped (a level newer than the list);
              once, when the level is Ultracode itself. */}
          {[...new Set([level && !levels.includes(level) ? level : "", ultracode && !levels.includes("ultracode") ? "ultracode" : ""])].filter(Boolean).map((e) => (
            <button key={e} role="radio" aria-checked="true" disabled>
              <span className="ms-text">
                <span>{levelName(e, agent)}</span>
              </span>
              <Check size={20} className="ms-check" />
            </button>
          ))}
        </div>
      )}
    </Menu>
  );
}

// Codex: "Configure", the models and Done.
export function CodexConfigureSheet(props: Props) {
  const { agent, models, model, effort, busy, onPick, onClose } = props;
  const current = currentModel(models, model);
  return (
    <Sheet agent={agent} label="Configure" className="ms-codex" onClose={onClose}>
      <header className="ms-head" data-sheet-grab>
        <h2>Configure</h2>
      </header>
      <Status {...props} empty={!models.length} />
      {props.footer}
      <ModelRows models={models} model={model} current={current} busy={busy} onPick={(m) => onPick({ model: m.id, effort: effortFor(m, effort) })} />
      {!!current?.speeds?.length && <SpeedRow speeds={current.speeds} speed={props.speed || current.defaultSpeed || "default"} onPick={(id) => onPick({ speed: id })} />}
      <button className="ms-done" onClick={onClose}>Done</button>
    </Sheet>
  );
}

// Codex's "Speed  Standard ⌃⌄": the phone's own menu (a native select laid
// over the row), as the app's pop-up. It applies from the next message.
function SpeedRow({ speeds: tiers, speed, onPick }: { speeds: { id: string; name: string; note?: string }[]; speed: string; onPick: (id: string) => void }) {
  // Codex lists only its extra tiers ("Fast"); standard is "default" in its
  // protocol, and always first, as in the app.
  const speeds = [{ id: "default", name: "Standard" }, ...tiers.filter((t) => t.id !== "default")];
  const name = (id: string) => speeds.find((t) => t.id === id)?.name || id;
  return (
    <label className="ms-card ms-row ms-select">
      <span>Speed</span>
      <span className="ms-value">{name(speed)}</span>
      <ChevronsUpDown size={16} className="ms-chevron" />
      <select aria-label="Speed" value={speed} onChange={(e) => onPick(e.target.value)}>
        {speeds.map((s) => (
          <option key={s.id} value={s.id}>{name(s.id)}</option>
        ))}
      </select>
    </label>
  );
}

// Codex, over the composer: "GPT-5.5 Light ›" (opens Configure) and the
// effort as dots, the one in use a pill; a tap on a dot picks that level.
export function CodexEffortStrip({ agent, models, model, effort, busy, onPick, onConfigure }: Pick<Props, "agent" | "models" | "model" | "effort" | "busy" | "onPick"> & { onConfigure: () => void }) {
  const current = currentModel(models, model);
  // The knob sits on the default when the chat names no level, its word
  // "Default": never the default's name as if picked (Oct 9).
  const level = effort || current?.defaultEffort || null;
  const efforts = current?.efforts || [];
  return (
    <div className={`ms-strip ${agent}`} role="group" aria-label="Model and effort">
      <button className="ms-strip-label" onClick={onConfigure}>
        <strong>{current?.name || (model ? modelDisplayName(model) : "Model")}</strong> {level && <span>{effort ? levelName(effort, agent) : "Default"}</span>}
        <ChevronRight size={18} />
      </button>
      {efforts.length > 1 && (
        // The track fills up to the level in use, its knob on it.
        <div className="ms-dots" role="radiogroup" aria-label="Effort" style={{ "--fill": efforts.indexOf(level || "") + 1 } as React.CSSProperties}>
          {efforts.map((e, i) => (
            <button
              key={e}
              role="radio"
              aria-checked={e === effort}
              className={i <= efforts.indexOf(level || "") ? "filled" : ""}
              aria-label={levelName(e, agent)}
              title={current?.effortNotes?.[e]}
              disabled={busy}
              onClick={() => e !== level && onPick({ model: current!.id, effort: e })}
            >
              <span />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
