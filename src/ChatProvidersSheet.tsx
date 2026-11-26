import { useState } from "react";
import {
  Check,
  Cpu,
  KeyRound,
  LoaderCircle,
  Plus,
  RefreshCw,
  Sparkles,
  Trash2,
} from "lucide-react";
import type { Peer } from "./api";
import ChatSheet from "./ChatSheet";
import {
  removeChatProvider,
  saveChatProvider,
  testChatProvider,
  type ChatProvider,
  type ChatProviderPreset,
} from "./chat-providers";
import "./chat-providers.css";

type Draft = {
  id?: string;
  preset: string;
  name: string;
  kind: "api" | "local";
  protocol: "openai" | "anthropic";
  baseUrl: string;
  apiKey: string;
  hasExistingKey: boolean;
  keyHint: string;
};

const emptyCustom = (): Draft => ({
  preset: "custom",
  name: "",
  kind: "api",
  protocol: "openai",
  baseUrl: "",
  apiKey: "",
  hasExistingKey: false,
  keyHint: "",
});

function detectPresetFromKey(raw: string): string | null {
  const k = raw.trim();
  if (!k) return null;
  if (k.startsWith("sk-ant-")) return "anthropic";
  if (k.startsWith("sk-or-")) return "openrouter";
  if (k.startsWith("gsk_")) return "groq";
  if (k.startsWith("xai-")) return "xai";
  if (k.startsWith("AIza")) return "gemini-api";
  if (k.startsWith("pplx-")) return "perplexity";
  if (k.startsWith("fw_")) return "fireworks";
  if (/^(VENICE-|vn_)/i.test(k)) return "venice";
  if (k.startsWith("sk-")) return "openai";
  return null;
}

export default function ChatProvidersSheet({
  peer,
  providers,
  presets,
  loading,
  onReload,
  onClose,
}: {
  peer: Peer;
  providers: ChatProvider[];
  presets: ChatProviderPreset[];
  loading: boolean;
  onReload: (refresh?: boolean) => Promise<void> | void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [quickKey, setQuickKey] = useState("");
  const [quickPreset, setQuickPreset] = useState("venice");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [problem, setProblem] = useState("");

  const handleQuickConnect = async (e: React.FormEvent) => {
    e.preventDefault();
    const key = quickKey.trim();
    if (!key || busy) return;
    const detected = detectPresetFromKey(key) || quickPreset;
    const preset = presets.find((p) => p.id === detected) || presets[0];
    if (!preset) return;
    setBusy(true);
    setProblem("");
    setStatus(`Connecting ${preset.name}…`);
    try {
      const saved = await saveChatProvider(peer, {
        id: preset.id,
        preset: preset.id,
        name: preset.name,
        kind: preset.kind,
        protocol: preset.protocol,
        baseUrl: preset.baseUrl,
        apiKey: key,
      });
      const tested = await testChatProvider(peer, { id: saved.provider.id });
      setQuickKey("");
      setStatus(`${preset.name} connected · ${tested.modelCount} models ready`);
      await onReload(true);
    } catch (err) {
      setProblem((err as Error).message || "Could not connect that key.");
      setStatus("");
    } finally {
      setBusy(false);
    }
  };

  const openPreset = (preset: ChatProviderPreset) => {
    const existing = providers.find((p) => p.id === preset.id);
    setProblem("");
    setStatus("");
    setDraft({
      id: existing?.id || preset.id,
      preset: preset.id,
      name: existing?.name || preset.name,
      kind: existing?.kind || preset.kind,
      protocol: existing?.protocol || preset.protocol,
      baseUrl: existing?.baseUrl || preset.baseUrl,
      apiKey: "",
      hasExistingKey: Boolean(existing?.hasKey),
      keyHint: existing?.keyHint || "",
    });
  };

  const openProvider = (p: ChatProvider) => {
    setProblem("");
    setStatus("");
    setDraft({
      id: p.id,
      preset: p.preset || "custom",
      name: p.name,
      kind: p.kind,
      protocol: p.protocol,
      baseUrl: p.baseUrl,
      apiKey: "",
      hasExistingKey: p.hasKey,
      keyHint: p.keyHint,
    });
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!draft || busy) return;
    setBusy(true);
    setProblem("");
    setStatus("Connecting & loading models…");
    try {
      const saved = await saveChatProvider(peer, {
        ...(draft.id ? { id: draft.id } : {}),
        preset: draft.preset,
        name: draft.name.trim() || "Custom Provider",
        kind: draft.kind,
        protocol: draft.protocol,
        baseUrl: draft.baseUrl.trim(),
        ...(draft.apiKey.trim() ? { apiKey: draft.apiKey.trim() } : {}),
      });
      try {
        const tested = await testChatProvider(peer, { id: saved.provider.id });
        setStatus(
          `Connected · ${tested.modelCount} ${tested.modelCount === 1 ? "model" : "models"} ready`,
        );
      } catch (testErr) {
        setProblem(
          `Saved, but connection check failed: ${(testErr as Error).message}`,
        );
        setStatus("");
      }
      await onReload(true);
      setDraft(null);
    } catch (err) {
      setProblem((err as Error).message || "Could not save provider.");
      setStatus("");
    } finally {
      setBusy(false);
    }
  };

  const handleRemove = async (id: string) => {
    if (busy) return;
    setBusy(true);
    setProblem("");
    try {
      await removeChatProvider(peer, id);
      await onReload(true);
      if (draft?.id === id) setDraft(null);
    } catch (err) {
      setProblem((err as Error).message || "Could not remove provider.");
    } finally {
      setBusy(false);
    }
  };

  const connected = providers.filter((p) => p.configured || p.reachable);

  return (
    <ChatSheet
      title="Chat Providers"
      className="cp-sheet"
      onClose={onClose}
    >
      <p className="cp-intro">
        Use any API key (Venice, OpenAI, Anthropic, OpenRouter) or local model
        server (Ollama, vLLM, LM Studio) in the same chat interface. Keys stay
        encrypted on this computer only.
      </p>

      {draft ? (
        <form className="cp-form" onSubmit={(e) => void handleSave(e)}>
          <div className="cp-form-head">
            <strong>{draft.name || "Custom OpenAI-Compatible"}</strong>
            <button
              type="button"
              className="cp-link"
              onClick={() => (setDraft(null), setShowAdvanced(false), setProblem(""), setStatus(""))}
            >
              Back
            </button>
          </div>
          {draft.kind === "api" && (
            <label className="cp-field">
              <span>
                API Key{" "}
                {draft.hasExistingKey ? (
                  <small>(saved: {draft.keyHint})</small>
                ) : null}
              </span>
              <input
                type="password"
                autoComplete="off"
                autoFocus
                value={draft.apiKey}
                placeholder={
                  draft.hasExistingKey
                    ? "Enter a new key to replace"
                    : `Paste your ${draft.name || "API"} key`
                }
                onChange={(e) => setDraft({ ...draft, apiKey: e.target.value })}
              />
            </label>
          )}
          {(draft.kind === "local" || draft.preset === "custom" || showAdvanced) && (
            <label className="cp-field">
              <span>Server URL</span>
              <input
                type="url"
                value={draft.baseUrl}
                placeholder="http://127.0.0.1:11434/v1"
                onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value })}
                required
              />
            </label>
          )}
          {(draft.preset === "custom" || showAdvanced) && (
            <label className="cp-field">
              <span>Display Name</span>
              <input
                type="text"
                value={draft.name}
                placeholder="Venice, My vLLM, Groq…"
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                required
              />
            </label>
          )}
          {draft.preset !== "custom" && (
            <button
              type="button"
              className="cp-link"
              style={{ alignSelf: "flex-start" }}
              onClick={() => setShowAdvanced((v) => !v)}
            >
              {showAdvanced ? "Hide advanced" : "Advanced URL / name"}
            </button>
          )}
          {draft.preset === "custom" && (
            <div className="cp-row">
              <label className="cp-field">
                <span>Type</span>
                <select
                  value={draft.kind}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      kind: e.target.value === "local" ? "local" : "api",
                    })
                  }
                >
                  <option value="api">Cloud API</option>
                  <option value="local">Local / Self-hosted</option>
                </select>
              </label>
              <label className="cp-field">
                <span>Protocol</span>
                <select
                  value={draft.protocol}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      protocol:
                        e.target.value === "anthropic" ? "anthropic" : "openai",
                    })
                  }
                >
                  <option value="openai">OpenAI-compatible</option>
                  <option value="anthropic">Anthropic</option>
                </select>
              </label>
            </div>
          )}
          {problem && (
            <p className="cp-error" role="alert">
              {problem}
            </p>
          )}
          {status && (
            <p className="cp-status" role="status">
              {status}
            </p>
          )}
          <div className="cp-actions">
            <button type="submit" className="cp-primary" disabled={busy}>
              {busy ? (
                <>
                  <LoaderCircle size={15} className="spin" /> Connecting…
                </>
              ) : (
                <>
                  <Check size={15} /> Connect
                </>
              )}
            </button>
          </div>
        </form>
      ) : (
        <>
          <form className="cp-quick" onSubmit={(e) => void handleQuickConnect(e)}>
            <input
              type="password"
              autoComplete="off"
              aria-label="Paste any API key"
              placeholder="Paste any API key (Venice, OpenAI, Claude, Groq…)"
              value={quickKey}
              onChange={(e) => {
                const v = e.target.value;
                setQuickKey(v);
                const detected = detectPresetFromKey(v);
                if (detected) setQuickPreset(detected);
              }}
            />
            <select
              aria-label="Provider"
              value={quickPreset}
              onChange={(e) => setQuickPreset(e.target.value)}
            >
              {presets
                .filter((p) => p.kind === "api")
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
            </select>
            <button type="submit" className="cp-primary" disabled={busy || !quickKey.trim()}>
              {busy ? <LoaderCircle size={14} className="spin" /> : "Connect"}
            </button>
          </form>
          <div className="cp-section-head">
            <span>Connected &amp; Detected</span>
            <button
              type="button"
              className="cp-icon-btn"
              aria-label="Refresh providers"
              disabled={loading}
              onClick={() => void onReload(true)}
            >
              <RefreshCw size={14} className={loading ? "spin" : ""} />
            </button>
          </div>
          {connected.length > 0 ? (
            <div className="cp-list">
              {connected.map((p) => (
                <div key={p.id} className="cp-item">
                  <button
                    type="button"
                    className="cp-item-main"
                    onClick={() => openProvider(p)}
                  >
                    <span className={`cp-dot ${p.reachable === false ? "warn" : "ok"}`} />
                    <span className="cp-item-copy">
                      <strong>{p.name}</strong>
                      <small>
                        {p.kind === "local" ? "Local" : "API"} ·{" "}
                        {p.modelCount > 0
                          ? `${p.modelCount} ${p.modelCount === 1 ? "model" : "models"}`
                          : p.error || "Ready"}
                        {p.keyHint ? ` · ${p.keyHint}` : ""}
                      </small>
                    </span>
                  </button>
                  {!p.autoDetected && !p.fromEnv && (
                    <button
                      type="button"
                      className="cp-icon-btn danger"
                      aria-label={`Remove ${p.name}`}
                      onClick={() => void handleRemove(p.id)}
                    >
                      <Trash2 size={14} />
                    </button>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <p className="cp-empty">
              No API keys or local servers connected yet. Pick one below to get
              started in seconds.
            </p>
          )}

          {problem && (
            <p className="cp-error" role="alert">
              {problem}
            </p>
          )}
          {status && (
            <p className="cp-status" role="status">
              {status}
            </p>
          )}

          <div className="cp-section-head">
            <span>Add or Configure</span>
          </div>
          <div className="cp-grid">
            {presets.map((preset) => {
              const active = providers.find(
                (p) => p.id === preset.id && (p.configured || p.reachable),
              );
              return (
                <button
                  key={preset.id}
                  type="button"
                  className={`cp-card ${active ? "connected" : ""}`}
                  onClick={() => openPreset(preset)}
                >
                  <span className="cp-card-top">
                    {preset.kind === "local" ? (
                      <Cpu size={15} />
                    ) : preset.id === "venice" ? (
                      <Sparkles size={15} />
                    ) : (
                      <KeyRound size={15} />
                    )}
                    <strong>{preset.name}</strong>
                    {active && <Check size={14} className="cp-check" />}
                  </span>
                  <small>{preset.description}</small>
                </button>
              );
            })}
            <button
              type="button"
              className="cp-card"
              onClick={() => setDraft(emptyCustom())}
            >
              <span className="cp-card-top">
                <Plus size={15} />
                <strong>Custom URL</strong>
              </span>
              <small>Any OpenAI or Anthropic compatible endpoint</small>
            </button>
          </div>
        </>
      )}
    </ChatSheet>
  );
}
