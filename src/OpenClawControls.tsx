import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { post, request, type Peer } from "./api";

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
  catalog,
  model,
  thinking,
  disabled,
  onModel,
  onThinking,
}: {
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

export function ClawSessionSettings({
  peer,
  session,
  disabled,
  onSaved,
  onClose,
}: {
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
}) {
  const { catalog, error } = useClawCatalog(peer);
  const [label, setLabel] = useState(session.title);
  const [model, setModel] = useState(
    session.modelProvider &&
      !session.model.startsWith(session.modelProvider + "/")
      ? `${session.modelProvider}/${session.model}`
      : session.model,
  );
  const [thinking, setThinking] = useState(session.thinkingLevel || "");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  return (
    <form
      className="claw-settings"
      aria-label="OpenClaw chat settings"
      onSubmit={async (e) => {
        e.preventDefault();
        if (busy || disabled || !catalog?.canEdit || !label.trim()) return;
        setBusy(true);
        setProblem("");
        try {
          await post(peer, `${clawBase}/settings`, {
            key: session.key,
            label,
            model: model || null,
            thinkingLevel: thinking || null,
          });
          onSaved();
          onClose();
        } catch (e) {
          setProblem((e as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <label>
        Chat name
        <input
          aria-label="OpenClaw chat name"
          maxLength={120}
          value={label}
          disabled={busy || disabled}
          onChange={(e) => setLabel(e.target.value)}
        />
      </label>
      {catalog ? (
        <ClawModelControls
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
          disabled={busy || disabled || !catalog?.canEdit || !label.trim()}
        >
          {busy ? <Loader2 size={15} className="spin" /> : null}Save changes
        </button>
      </div>
    </form>
  );
}
