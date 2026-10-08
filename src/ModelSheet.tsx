import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronLeft, ChevronRight, ChevronsUpDown, Loader2, X } from "lucide-react";
import { effortLabel, type AgentModel, type AgentName } from "./agent-sessions";
import { dragToClose } from "./sheet-drag";
import "./model-sheet.css";

// The model and its effort, picked as each app has you pick them (their
// phone apps, Oct 6). Claude: a "Select model" sheet, the models in one card
// with what each is for, and Effort as its own row that opens its levels.
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
  working?: boolean;
  onRetry?: () => void;
  onPick: (choice: ModelChoice) => void;
  onClose: () => void;
};

export const currentModel = (models: AgentModel[], model: string | null) =>
  model
    ? models.find((m) => m.id === model) || models.find((m) => m.resolvedModel === model && !m.isDefault) || models.find((m) => m.resolvedModel === model)
    : models.find((m) => m.isDefault) || models[0];
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

function Status({ busy, error, working, empty, onRetry }: { busy?: boolean; error?: string; working?: boolean; empty: boolean; onRetry?: () => void }) {
  return (
    <>
      {working && <p className="ms-note">Applies to the next turn. The current reply keeps its model.</p>}
      {busy && <p className="ms-note" role="status">{empty ? "Loading models…" : "Changing model…"}</p>}
      {error && <p className="ms-note ms-error" role="alert">{error}</p>}
      {!busy && empty && onRetry && (
        <button className="ms-retry" onClick={onRetry}>Try loading models again</button>
      )}
    </>
  );
}

// The row tapped shows it's being changed (a spinner where its check goes)
// until the agent confirms: a tap that seemed to do nothing, Oct 6.
function Mark({ checked, pending }: { checked: boolean; pending: boolean }) {
  return pending ? <Loader2 size={18} className="spin ms-check" /> : checked ? <Check size={20} className="ms-check" /> : null;
}
function ModelRows({ models, current, busy, onPick }: { models: AgentModel[]; current?: AgentModel; busy?: boolean; onPick: (m: AgentModel) => void }) {
  const [tapped, setTapped] = useState("");
  return (
    <div className="ms-card" role="radiogroup" aria-label="Models">
      {models.map((m) => (
        <button key={m.id} role="radio" aria-checked={m.id === current?.id} aria-busy={busy && tapped === m.id} disabled={busy} onClick={() => (setTapped(m.id), onPick(m))}>
          <span className="ms-text">
            <span>{m.name}</span>
            {m.description && <small>{m.description}</small>}
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
  const level = effort || current?.defaultEffort || null;
  return (
    <Sheet agent={agent} label={page === "models" ? "Select model" : "Effort"} className="ms-claude" onClose={onClose}>
      <header className="ms-head" data-sheet-grab>
        {page === "models" ? (
          <button className="ms-round" aria-label="Close" onClick={onClose}><X size={20} /></button>
        ) : (
          <button className="ms-round" aria-label="Back" onClick={() => setPage("models")}><ChevronLeft size={22} /></button>
        )}
        <h2>{page === "models" ? "Select model" : "Effort"}</h2>
      </header>
      <Status {...props} empty={!models.length} />
      {page === "models" ? (
        <>
          <ModelRows models={models} current={current} busy={busy} onPick={(m) => onPick({ model: m.id, effort: effortFor(m, effort) })} />
          {!!current?.efforts.length && (
            <button className="ms-card ms-row" disabled={busy} onClick={() => setPage("effort")}>
              <span>Effort</span>
              <span className="ms-value">{level ? levelName(level, agent) : "Default"}</span>
              <ChevronRight size={18} className="ms-chevron" />
            </button>
          )}
        </>
      ) : (
        <div className="ms-card" role="radiogroup" aria-label="Effort">
          {(current?.efforts || []).map((e) => (
            <button
              key={e}
              role="radio"
              aria-checked={e === level}
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
                {current?.effortNotes?.[e] && <small>{current.effortNotes[e]}</small>}
              </span>
              <Mark checked={e === level} pending={!!busy && tapped === e} />
            </button>
          ))}
        </div>
      )}
    </Sheet>
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
      <ModelRows models={models} current={current} busy={busy} onPick={(m) => onPick({ model: m.id, effort: effortFor(m, effort) })} />
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
  const level = effort || current?.defaultEffort || null;
  const efforts = current?.efforts || [];
  return (
    <div className={`ms-strip ${agent}`} role="group" aria-label="Model and effort">
      <button className="ms-strip-label" onClick={onConfigure}>
        <strong>{current?.name || model || "Model"}</strong> {level && <span>{levelName(level, agent)}</span>}
        <ChevronRight size={18} />
      </button>
      {efforts.length > 1 && (
        // The track fills up to the level in use, its knob on it.
        <div className="ms-dots" role="radiogroup" aria-label="Effort" style={{ "--fill": efforts.indexOf(level || "") + 1 } as React.CSSProperties}>
          {efforts.map((e, i) => (
            <button
              key={e}
              role="radio"
              aria-checked={e === level}
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
