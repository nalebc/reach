import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUp,
  Cpu,
  Globe,
  KeyRound,
  LoaderCircle,
  SlidersHorizontal,
  Sparkles,
  X,
} from "lucide-react";
import type { Peer } from "./api";
import type { AgentSession } from "./agent-sessions";
import { startApiChat, type ChatProvider } from "./chat-providers";
import "./anything-chat.css";

const LAST_PROVIDER_KEY = "reach.anythingChat.lastProvider";
const LAST_MODEL_KEY = "reach.anythingChat.lastModel";

export default function AnythingNewChat({
  peer,
  providers,
  loading,
  onOpenProviders,
  onStarted,
  autoFocus = false,
}: {
  peer: Peer;
  providers: ChatProvider[];
  loading: boolean;
  onOpenProviders: () => void;
  onStarted: (session: AgentSession) => void;
  autoFocus?: boolean;
}) {
  const readyProviders = useMemo(
    () => providers.filter((p) => p.configured || p.reachable),
    [providers],
  );

  const [providerId, setProviderId] = useState(() => {
    try {
      return localStorage.getItem(LAST_PROVIDER_KEY) || "";
    } catch {
      return "";
    }
  });
  const [model, setModel] = useState(() => {
    try {
      return localStorage.getItem(LAST_MODEL_KEY) || "";
    } catch {
      return "";
    }
  });
  const [text, setText] = useState("");
  const [tuneOpen, setTuneOpen] = useState(false);
  const [systemPrompt, setSystemPrompt] = useState("");
  const [veniceWebSearch, setVeniceWebSearch] = useState(true);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (autoFocus) inputRef.current?.focus();
  }, [autoFocus]);

  // Keep a valid provider & model selected automatically.
  useEffect(() => {
    if (!readyProviders.length) return;
    const current = readyProviders.find((p) => p.id === providerId) || readyProviders[0];
    if (current.id !== providerId) setProviderId(current.id);
    const models = current.models || [];
    if (models.length && !models.some((m) => m.id === model)) {
      setModel(current.defaultModel || models[0].id);
    } else if (!model && current.defaultModel) {
      setModel(current.defaultModel);
    }
  }, [readyProviders, providerId, model]);

  const activeProvider = readyProviders.find((p) => p.id === providerId) || readyProviders[0] || null;
  const models = activeProvider?.models || [];
  const isVenice = activeProvider?.preset === "venice" || activeProvider?.id === "venice";

  const handleStart = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!activeProvider || !model.trim() || !text.trim() || busy) return;
    setBusy(true);
    setProblem("");
    try {
      try {
        localStorage.setItem(LAST_PROVIDER_KEY, activeProvider.id);
        localStorage.setItem(LAST_MODEL_KEY, model.trim());
      } catch {}
      const res = await startApiChat(peer, {
        providerId: activeProvider.id,
        model: model.trim(),
        text: text.trim(),
        ...(systemPrompt.trim() ? { systemPrompt: systemPrompt.trim() } : {}),
        ...(isVenice ? { veniceWebSearch } : {}),
      });
      onStarted(res.session);
    } catch (err) {
      setProblem((err as Error).message || "Could not start chat.");
      setBusy(false);
    }
  };

  if (!loading && !readyProviders.length) {
    return (
      <div className="ac-setup">
        <div className="ac-setup-icon">
          <Sparkles size={22} />
        </div>
        <h3>Connect any model</h3>
        <p>
          Add an API key (Venice, OpenAI, Anthropic, OpenRouter) or run Ollama /
          vLLM on this computer to chat with any model right here.
        </p>
        <button type="button" className="cp-primary" onClick={onOpenProviders}>
          <KeyRound size={15} /> Connect API Key or Local Model
        </button>
      </div>
    );
  }

  return (
    <form className="ac-new" onSubmit={(e) => void handleStart(e)}>
      <div className="ac-picker-row">
        <div className="ac-chips" role="tablist" aria-label="Chat provider">
          {readyProviders.map((p) => (
            <button
              key={p.id}
              type="button"
              role="tab"
              aria-selected={p.id === activeProvider?.id}
              className={`ac-chip ${p.id === activeProvider?.id ? "active" : ""}`}
              onClick={() => {
                setProviderId(p.id);
                setModel(p.defaultModel || p.models[0]?.id || "");
              }}
            >
              {p.kind === "local" ? <Cpu size={13} /> : <Sparkles size={13} />}
              <span>{p.name}</span>
            </button>
          ))}
          <button
            type="button"
            className="ac-chip add"
            onClick={onOpenProviders}
          >
            + Providers
          </button>
        </div>
      </div>

      {activeProvider && (
        <div className="ac-model-row">
          <label className="ac-model-select">
            <span>Model</span>
            {models.length > 0 ? (
              <select
                aria-label="Model"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                disabled={busy}
              >
                {models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
            ) : (
              <input
                type="text"
                aria-label="Model"
                value={model}
                placeholder="Model name (e.g. llama-3.3-70b)"
                onChange={(e) => setModel(e.target.value)}
                disabled={busy}
              />
            )}
          </label>
          {isVenice && (
            <button
              type="button"
              className={`ac-pill ${veniceWebSearch ? "on" : ""}`}
              aria-pressed={veniceWebSearch}
              onClick={() => setVeniceWebSearch((v) => !v)}
              title="Toggle Venice web search"
            >
              <Globe size={14} /> Web
            </button>
          )}
          <button
            type="button"
            className={`ac-pill ${tuneOpen || systemPrompt.trim() ? "on" : ""}`}
            aria-expanded={tuneOpen}
            aria-label="System prompt"
            onClick={() => setTuneOpen((v) => !v)}
          >
            <SlidersHorizontal size={14} />
          </button>
        </div>
      )}

      {tuneOpen && (
        <div className="ac-tune">
          <div className="ac-tune-head">
            <span>System instructions (optional)</span>
            <button
              type="button"
              className="cp-icon-btn"
              aria-label="Close instructions"
              onClick={() => setTuneOpen(false)}
            >
              <X size={14} />
            </button>
          </div>
          <textarea
            rows={2}
            value={systemPrompt}
            placeholder="Optional instructions for how this model should respond…"
            onChange={(e) => setSystemPrompt(e.target.value)}
          />
        </div>
      )}

      <div className="as-box">
        <div className="as-field">
          <textarea
            ref={inputRef}
            aria-label="Message"
            placeholder={
              activeProvider
                ? `Message ${activeProvider.name}…`
                : "Message any model…"
            }
            rows={3}
            value={text}
            disabled={busy}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void handleStart();
              }
            }}
          />
        </div>
        <div className="as-tools chat-new-tools">
          <span className="ac-hint">
            {activeProvider
              ? `${activeProvider.kind === "local" ? "Local" : "API"} · ${model || "Select model"}`
              : "Loading providers…"}
          </span>
          <span className="as-spacer" />
          <button
            type="submit"
            className={`as-send ${text.trim() && model.trim() && !busy ? "ready" : ""}`}
            aria-label="Start"
            disabled={!text.trim() || !model.trim() || busy}
          >
            {busy ? <LoaderCircle size={16} className="spin" /> : <ArrowUp size={21} />}
          </button>
        </div>
      </div>

      {problem && (
        <p className="cp-error" role="alert">
          {problem}
        </p>
      )}
    </form>
  );
}
