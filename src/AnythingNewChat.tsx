import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUp,
  Check,
  Cpu,
  Globe,
  KeyRound,
  LoaderCircle,
  Plus,
  RefreshCw,
  SlidersHorizontal,
  Sparkles,
  X,
} from "lucide-react";
import type { Peer } from "./api";
import { previewUrl, uploadImage, type AgentSession } from "./agent-sessions";
import {
  quickConnectProvider,
  startApiChat,
  type ChatProvider,
} from "./chat-providers";
import "./anything-chat.css";

const LAST_PROVIDER_KEY = "reach.anythingChat.lastProvider";
const LAST_MODEL_KEY = "reach.anythingChat.lastModel";

type Attachment = { key: number; url: string; id?: string; error?: string };

export default function AnythingNewChat({
  peer,
  providers,
  loading,
  preferredProviderId,
  onReloadProviders,
  onOpenProviders,
  onStarted,
  autoFocus = false,
}: {
  peer: Peer;
  providers: ChatProvider[];
  loading: boolean;
  preferredProviderId?: string;
  onReloadProviders?: (refresh?: boolean) => Promise<void> | void;
  onOpenProviders: () => void;
  onStarted: (session: AgentSession) => void;
  autoFocus?: boolean;
}) {
  const readyProviders = useMemo(
    () => providers.filter((p) => p.configured || p.reachable),
    [providers],
  );

  const [providerId, setProviderId] = useState(() => {
    if (preferredProviderId) return preferredProviderId;
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
  const [images, setImages] = useState<Attachment[]>([]);
  const [tuneOpen, setTuneOpen] = useState(false);
  const [inlineKeyOpen, setInlineKeyOpen] = useState(false);
  const [quickKey, setQuickKey] = useState("");
  const [keyBusy, setKeyBusy] = useState(false);
  const [keyNotice, setKeyNotice] = useState("");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [veniceWebSearch, setVeniceWebSearch] = useState(true);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const filePicker = useRef<HTMLInputElement>(null);
  const imgSeq = useRef(0);

  useEffect(() => {
    if (preferredProviderId) {
      const target = readyProviders.find((p) => p.id === preferredProviderId);
      setProviderId(preferredProviderId);
      if (target) setModel(target.defaultModel || target.models[0]?.id || "");
    }
  }, [preferredProviderId, readyProviders]);

  useEffect(() => {
    if (autoFocus) inputRef.current?.focus();
  }, [autoFocus]);

  useEffect(() => {
    return () => {
      for (const img of images) URL.revokeObjectURL(img.url);
    };
  }, []);

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
  const uploading = images.some((i) => !i.id && !i.error);

  const addFiles = (files: File[]) => {
    for (const file of files) {
      if (!file.type.startsWith("image/") && !/\.(heic|heif)$/i.test(file.name)) continue;
      const key = ++imgSeq.current;
      setImages((list) => [...list, { key, url: URL.createObjectURL(file) }]);
      uploadImage(peer, file, file.name || "image").then(
        (id) => setImages((list) => list.map((i) => (i.key === key ? { ...i, id } : i))),
        (e) => setImages((list) => list.map((i) => (i.key === key ? { ...i, error: (e as Error).message } : i))),
      );
    }
  };

  const handleQuickKey = async (e: React.FormEvent) => {
    e.preventDefault();
    const raw = quickKey.trim();
    if (!raw || keyBusy) return;
    setKeyBusy(true);
    setProblem("");
    setKeyNotice("");
    try {
      const res = await quickConnectProvider(peer, { key: raw });
      setQuickKey("");
      setInlineKeyOpen(false);
      setProviderId(res.provider.id);
      setModel(res.provider.defaultModel || res.models[0]?.id || "");
      setKeyNotice(`${res.provider.name} connected · ${res.modelCount} models ready`);
      await onReloadProviders?.(true);
      inputRef.current?.focus();
    } catch (err) {
      setProblem((err as Error).message || "Could not connect that key.");
    } finally {
      setKeyBusy(false);
    }
  };

  const handleStart = async (e?: React.FormEvent) => {
    e?.preventDefault();
    const readyImgs = images.filter((i) => i.id).map((i) => i.id!);
    if (!activeProvider || !model.trim() || (!text.trim() && !readyImgs.length) || busy || uploading) return;
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
        ...(readyImgs.length ? { images: readyImgs } : {}),
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
        <h3>1-Click API Key or Local Model</h3>
        <p>
          Paste any API key (Venice, OpenAI, Claude, DeepSeek, Groq, OpenRouter, Hugging Face) or local URL — Reach detects the provider and loads your models automatically.
        </p>
        <form className="ac-inline-key" onSubmit={(e) => void handleQuickKey(e)}>
          <input
            type="password"
            autoComplete="off"
            aria-label="Paste API key or local URL"
            placeholder="Paste API key or http://127.0.0.1:11434…"
            value={quickKey}
            onChange={(e) => setQuickKey(e.target.value)}
          />
          <button type="submit" className="cp-primary" disabled={keyBusy || !quickKey.trim()}>
            {keyBusy ? <LoaderCircle size={14} className="spin" /> : <><Check size={14} /> Connect</>}
          </button>
        </form>
        <div className="ac-setup-actions">
          {onReloadProviders && (
            <button type="button" className="ac-pill" onClick={() => void onReloadProviders(true)}>
              <RefreshCw size={13} /> Scan local Ollama / vLLM
            </button>
          )}
          <button type="button" className="ac-pill" onClick={onOpenProviders}>
            <KeyRound size={13} /> All provider presets
          </button>
        </div>
        {problem && (
          <p className="cp-error" role="alert">
            {problem}
          </p>
        )}
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
            className={`ac-chip add ${inlineKeyOpen ? "active" : ""}`}
            onClick={() => setInlineKeyOpen((v) => !v)}
          >
            + Paste Key
          </button>
          <button
            type="button"
            className="ac-chip add"
            onClick={onOpenProviders}
          >
            All Providers
          </button>
        </div>
      </div>

      {inlineKeyOpen && (
        <div className="ac-inline-key-box">
          <input
            type="password"
            autoComplete="off"
            aria-label="Paste API key or local URL"
            placeholder="Paste any API key (Venice, OpenAI, Claude, Groq…) or URL"
            value={quickKey}
            onChange={(e) => setQuickKey(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void handleQuickKey(e);
              }
            }}
          />
          <button
            type="button"
            className="cp-primary"
            disabled={keyBusy || !quickKey.trim()}
            onClick={(e) => void handleQuickKey(e)}
          >
            {keyBusy ? <LoaderCircle size={14} className="spin" /> : "Connect"}
          </button>
        </div>
      )}

      {keyNotice && (
        <p className="cp-status" role="status">
          {keyNotice}
        </p>
      )}

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
          {images.length > 0 && (
            <div className="as-attachments">
              {images.map((i) => (
                <span key={i.key} className={`as-thumb ${i.error ? "bad" : ""}`} title={i.error}>
                  <img src={previewUrl(i.url)} alt="" />
                  {!i.id && !i.error && <LoaderCircle size={16} className="spin" />}
                  <button
                    type="button"
                    aria-label="Remove image"
                    onClick={() => {
                      URL.revokeObjectURL(i.url);
                      setImages((list) => list.filter((x) => x.key !== i.key));
                    }}
                  >
                    <X size={12} />
                  </button>
                </span>
              ))}
            </div>
          )}
          <textarea
            ref={inputRef}
            aria-label="Message"
            placeholder={
              activeProvider
                ? `Message ${activeProvider.name} (${model || "model"})…`
                : "Message any model…"
            }
            rows={3}
            value={text}
            disabled={busy}
            onChange={(e) => setText(e.target.value)}
            onPaste={(e) => {
              const files = [...e.clipboardData.files];
              if (!files.length) return;
              if (!e.clipboardData.getData("text/plain")) e.preventDefault();
              addFiles(files);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void handleStart();
              }
            }}
          />
        </div>
        <div className="as-tools chat-new-tools">
          <button
            type="button"
            className="as-icon"
            aria-label="Add images"
            title="Add images"
            disabled={busy}
            onClick={() => filePicker.current?.click()}
          >
            <Plus size={18} />
          </button>
          <input
            ref={filePicker}
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={(e) => {
              addFiles([...(e.target.files || [])]);
              e.target.value = "";
            }}
          />
          <span className="ac-hint">
            {activeProvider
              ? `${activeProvider.kind === "local" ? "Local" : "API"} · ${activeProvider.name} · ${model || "Select model"}`
              : "Loading providers…"}
          </span>
          <span className="as-spacer" />
          <button
            type="submit"
            className={`as-send ${(text.trim() || images.some((i) => i.id)) && model.trim() && !busy && !uploading ? "ready" : ""}`}
            aria-label="Start"
            disabled={(!text.trim() && !images.some((i) => i.id)) || !model.trim() || busy || uploading}
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
