import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { post, request, type Peer } from "./api";
import { AddModelPrompt } from "./OpenClawSetup";

export const clawBase = "/api/sessions/openclaw";
export type ClawCatalog = {
  agents: { id: string; name: string }[];
  defaultAgentId: string;
  models: { id: string; name: string; reasoning: boolean }[];
  canEdit: boolean;
  errors: string[];
};
export function useClawCatalog(peer: Peer) {
  const [catalog, setCatalog] = useState<ClawCatalog | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const abort = new AbortController();
    void request<ClawCatalog>(peer, `${clawBase}/catalog`, {
      signal: abort.signal,
    })
      .then((data) => {
        if (!abort.signal.aborted) setCatalog(data);
      })
      .catch((e) => {
        if (!abort.signal.aborted) setError(e.message);
      });
    return () => abort.abort();
  }, [peer.id, peer.url, peer.token]);
  return { catalog, error };
}

export function ClawModelControls({
  peer,
  catalog,
  model,
  thinking,
  disabled,
  onModel,
  onThinking,
}: {
  // With it, a model that isn't offered can be added (OpenClaw's setup).
  peer?: Peer;
  catalog: ClawCatalog;
  model: string;
  thinking: string;
  disabled?: boolean;
  onModel: (value: string) => void;
  onThinking: (value: string) => void;
}) {
  const models = catalog.models || [];
  const thinkingSupported =
    models.find((m) => m.id === model)?.reasoning !== false;
  return (
    <div className="claw-settings-fields">
      <label>
        Model
        <select
          aria-label="OpenClaw model"
          value={model}
          disabled={disabled || !catalog.canEdit}
          onChange={(e) => {
            onModel(e.target.value);
            if (
              models.find((m) => m.id === e.target.value)?.reasoning === false
            )
              onThinking("off");
          }}
        >
          <option value="">Agent default</option>
          {model && !models.some((m) => m.id === model) && (
            <option value={model}>{model}</option>
          )}
          {models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
        {peer && <AddModelPrompt peer={peer} />}
      </label>
      <label>
        Thinking
        <select
          aria-label="OpenClaw thinking level"
          value={thinking}
          disabled={disabled || !catalog.canEdit || !thinkingSupported}
          onChange={(e) => onThinking(e.target.value)}
        >
          <option value="">Agent default</option>
          {thinking &&
            !["off", "minimal", "low", "medium", "high"].includes(thinking) && (
              <option value={thinking}>{thinking}</option>
            )}
          {["off", "minimal", "low", "medium", "high"].map((level) => (
            <option key={level} value={level}>
              {level[0].toUpperCase() + level.slice(1)}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

type ClawSessionSettingsProps = {
  peer: Peer;
  session: {
    key: string;
    title: string;
    model: string;
    modelProvider?: string;
    thinkingLevel?: string;
  };
  disabled: boolean;
  onSaved: () => void;
  onClose: () => void;
};
export function ClawSessionSettings(props: ClawSessionSettingsProps) {
  const { peer, session } = props;
  // A different connection or chat owns a fresh draft and callback lifetime.
  const identity = JSON.stringify([peer.id, peer.url, peer.token, peer.transport, peer.sessionId, session.key]);
  return <ClawSettingsForm key={identity} {...props} />;
}
function ClawSettingsForm({ peer, session, disabled, onSaved, onClose }: ClawSessionSettingsProps) {
  const { catalog, error } = useClawCatalog(peer);
  const [initial] = useState(() => ({
    label: session.title,
    model: session.model && session.modelProvider && !session.model.startsWith(session.modelProvider + "/")
      ? `${session.modelProvider}/${session.model}` : session.model,
    thinking: session.thinkingLevel || "",
  }));
  const [label, setLabel] = useState(initial.label);
  const [model, setModel] = useState(initial.model);
  const [thinking, setThinking] = useState(initial.thinking);
  const modelChanged = model !== initial.model;
  const forceThinkingOff = modelChanged && catalog?.models.find((entry) => entry.id === model)?.reasoning === false;
  const patch = {
    ...(label !== initial.label ? { label } : {}),
    ...(modelChanged ? { model: model || null } : {}),
    ...(thinking !== initial.thinking || forceThinkingOff ? { thinkingLevel: forceThinkingOff ? "off" : thinking || null } : {}),
  };
  const changed = Object.keys(patch).length > 0;
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const active = useRef(true);
  const saving = useRef(false);
  useEffect(() => {
    active.current = true;
    return () => { active.current = false; };
  }, []);
  return (
    <form
      className="claw-settings"
      aria-label="OpenClaw chat settings"
      onSubmit={async (e) => {
        e.preventDefault();
        if (saving.current || busy || disabled || !catalog?.canEdit || !label.trim() || !changed) return;
        saving.current = true;
        setBusy(true);
        setProblem("");
        try {
          await post(peer, `${clawBase}/settings`, {
            key: session.key,
            ...patch,
          });
          // Closing this form does not undo an already dispatched write.
          // Its eventual reply must not close or overwrite a newer form.
          if (!active.current) return;
          onSaved();
          onClose();
        } catch (e) {
          if (active.current) setProblem((e as Error).message);
        } finally {
          saving.current = false;
          if (active.current) setBusy(false);
        }
      }}
    >
      <label>
        Chat name
        <input
          aria-label="OpenClaw chat name"
          maxLength={64}
          value={label}
          disabled={busy || disabled}
          onChange={(e) => setLabel(e.target.value)}
        />
      </label>
      {catalog ? (
        <ClawModelControls
          peer={peer}
          catalog={catalog}
          model={model}
          thinking={thinking}
          disabled={busy || disabled}
          onModel={setModel}
          onThinking={setThinking}
        />
      ) : (
        !error && <p className="claw-note">Loading settings…</p>
      )}
      {(problem || error) && (
        <p className="claw-error" role="alert">
          {problem || error}
        </p>
      )}
      {catalog?.errors?.map((message) => (
        <p key={message} className="claw-note">
          {message}
        </p>
      ))}
      {catalog && !catalog.canEdit && (
        <p className="claw-note">
          This Gateway does not support changing chat settings.
        </p>
      )}
      {disabled && (
        <p className="claw-note">
          Settings can be changed when this chat finishes.
        </p>
      )}
      <div className="claw-settings-actions">
        <button type="button" className="claw-secondary" onClick={onClose}>
          Cancel
        </button>
        <button
          className="claw-primary"
          disabled={busy || disabled || !catalog?.canEdit || !label.trim() || !changed}
        >
          {busy ? <Loader2 size={15} className="spin" /> : null}Save changes
        </button>
      </div>
    </form>
  );
}
