import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// Unified provider registry for Anything Chat: cloud API keys (Venice, OpenAI,
// Anthropic, OpenRouter, custom OpenAI-compatible) and local/self-hosted
// inference servers (Ollama, vLLM, LM Studio). Secrets stay on this computer
// with 0600 permissions and are never returned in plaintext to browsers.

export const PROVIDER_PRESETS = [
  {
    id: "venice",
    name: "Venice",
    kind: "api",
    protocol: "openai",
    baseUrl: "https://api.venice.ai/api/v1",
    envKey: "VENICE_API_KEY",
    requiresKey: true,
    description: "Private, uncensored inference & web search via Venice API",
    defaultModels: [
      { id: "llama-3.3-70b", name: "Llama 3.3 70B" },
      { id: "deepseek-r1-671b", name: "DeepSeek R1 671B" },
      { id: "qwen3-235b", name: "Qwen 3 235B" },
    ],
  },
  {
    id: "ollama",
    name: "Ollama",
    kind: "local",
    protocol: "openai",
    baseUrl: "http://127.0.0.1:11434/v1",
    tagsUrl: "http://127.0.0.1:11434/api/tags",
    envUrl: "OLLAMA_HOST",
    requiresKey: false,
    description: "Local models running on Ollama",
    defaultModels: [],
  },
  {
    id: "vllm",
    name: "vLLM",
    kind: "local",
    protocol: "openai",
    baseUrl: "http://127.0.0.1:8000/v1",
    envUrl: "VLLM_BASE_URL",
    requiresKey: false,
    description: "High-throughput local or Tailscale vLLM server",
    defaultModels: [],
  },
  {
    id: "lmstudio",
    name: "LM Studio",
    kind: "local",
    protocol: "openai",
    baseUrl: "http://127.0.0.1:1234/v1",
    envUrl: "LMSTUDIO_BASE_URL",
    requiresKey: false,
    description: "Local LM Studio OpenAI-compatible server",
    defaultModels: [],
  },
  {
    id: "openai",
    name: "OpenAI",
    kind: "api",
    protocol: "openai",
    baseUrl: "https://api.openai.com/api/v1",
    envKey: "OPENAI_API_KEY",
    requiresKey: true,
    description: "GPT-5, GPT-4.1, and o-series models via OpenAI API",
    defaultModels: [
      { id: "gpt-4.1", name: "GPT-4.1" },
      { id: "gpt-4.1-mini", name: "GPT-4.1 mini" },
      { id: "o4-mini", name: "o4-mini" },
    ],
  },
  {
    id: "anthropic",
    name: "Anthropic",
    kind: "api",
    protocol: "anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    envKey: "ANTHROPIC_API_KEY",
    requiresKey: true,
    description: "Claude models via direct Anthropic API key",
    defaultModels: [
      { id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
      { id: "claude-opus-4-1", name: "Claude Opus 4.1" },
      { id: "claude-haiku-4-5", name: "Claude Haiku 4.5" },
    ],
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    kind: "api",
    protocol: "openai",
    baseUrl: "https://openrouter.ai/api/v1",
    envKey: "OPENROUTER_API_KEY",
    requiresKey: true,
    description: "Hundreds of models behind one OpenRouter API key",
    defaultModels: [
      { id: "anthropic/claude-sonnet-4.5", name: "Claude Sonnet 4.5" },
      { id: "openai/gpt-4.1", name: "GPT-4.1" },
      { id: "deepseek/deepseek-r1", name: "DeepSeek R1" },
    ],
  },
];

const PRESET_BY_ID = new Map(PROVIDER_PRESETS.map((p) => [p.id, p]));

export function maskSecret(value) {
  const s = typeof value === "string" ? value.trim() : "";
  if (!s) return "";
  if (s.length <= 6) return "••••";
  return `${s.slice(0, 3)}…${s.slice(-4)}`;
}

export function normalizeBaseUrl(raw, protocol = "openai") {
  const trimmed = String(raw || "").trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw Object.assign(new Error("Enter a valid http:// or https:// base URL."), { status: 400 });
  }
  if (!["http:", "https:"].includes(parsed.protocol))
    throw Object.assign(new Error("Base URL must use http:// or https://."), { status: 400 });
  return parsed.toString().replace(/\/+$/, "");
}

function normalizeOllamaBase(raw) {
  const clean = normalizeBaseUrl(raw || "http://127.0.0.1:11434");
  return clean.endsWith("/v1") ? clean : `${clean}/v1`;
}

function ollamaTagsUrl(baseUrl) {
  return baseUrl.replace(/\/v1\/?$/, "") + "/api/tags";
}

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function writePrivateJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  try {
    fs.chmodSync(temp, 0o600);
  } catch {}
  fs.renameSync(temp, file);
}

async function fetchJson(url, { headers = {}, timeoutMs = 4000, fetchImpl = fetch } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      method: "GET",
      headers,
      signal: controller.signal,
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {}
    if (!res.ok) {
      const msg =
        json?.error?.message ||
        (typeof json?.error === "string" ? json.error : "") ||
        json?.message ||
        `${res.status} ${res.statusText}`;
      throw Object.assign(new Error(msg), { status: res.status });
    }
    return json;
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchProviderModels(provider, { fetchImpl = fetch, timeoutMs = 5000 } = {}) {
  const headers = { Accept: "application/json" };
  if (provider.apiKey) {
    if (provider.protocol === "anthropic") {
      headers["x-api-key"] = provider.apiKey;
      headers["anthropic-version"] = "2023-06-01";
    } else {
      headers.Authorization = `Bearer ${provider.apiKey}`;
    }
  }
  if (provider.headers && typeof provider.headers === "object") {
    for (const [k, v] of Object.entries(provider.headers)) {
      if (typeof k === "string" && typeof v === "string" && k.trim()) headers[k.trim()] = v;
    }
  }

  // Ollama: prefer /api/tags because it works on all Ollama versions and includes sizes.
  if (provider.preset === "ollama" || provider.id === "ollama") {
    try {
      const data = await fetchJson(ollamaTagsUrl(provider.baseUrl), {
        headers,
        timeoutMs,
        fetchImpl,
      });
      if (Array.isArray(data?.models)) {
        return data.models
          .map((m) => {
            const id = String(m.name || m.model || "").trim();
            if (!id) return null;
            const sizeGb =
              typeof m.size === "number" && m.size > 0
                ? `${(m.size / 1e9).toFixed(1)} GB`
                : "";
            return {
              id,
              name: id,
              description: [m.details?.parameter_size, sizeGb].filter(Boolean).join(" · "),
            };
          })
          .filter(Boolean);
      }
    } catch {
      // Fall through to OpenAI-compatible /models.
    }
  }

  const url = `${provider.baseUrl.replace(/\/+$/, "")}/models`;
  const data = await fetchJson(url, { headers, timeoutMs, fetchImpl });
  const raw = Array.isArray(data?.data)
    ? data.data
    : Array.isArray(data?.models)
      ? data.models
      : [];
  const models = raw
    .map((m) => {
      const id = String(m?.id || m?.name || "").trim();
      if (!id) return null;
      const name = String(m?.display_name || m?.name || m?.model_spec?.name || id).trim();
      const desc =
        typeof m?.description === "string"
          ? m.description.slice(0, 120)
          : typeof m?.owned_by === "string"
            ? m.owned_by
            : "";
      return { id, name, ...(desc ? { description: desc } : {}) };
    })
    .filter(Boolean);
  if (models.length) return models;
  const preset = PRESET_BY_ID.get(provider.preset || provider.id);
  return preset?.defaultModels ? [...preset.defaultModels] : [];
}

export function createChatProviders({
  dataDir,
  env = process.env,
  fetchImpl = fetch,
  now = Date.now,
} = {}) {
  const file = path.join(dataDir, "chat-providers.json");
  let stored = readJsonSafe(file);
  if (!stored || typeof stored !== "object" || !Array.isArray(stored.providers)) {
    stored = { version: 1, providers: [] };
  }

  // Cached model lists & local auto-discovery probes (avoid hammering localhost).
  const modelCache = new Map(); // id -> { at, models, error, reachable }
  const CACHE_MS = 15000;

  const save = () => writePrivateJson(file, stored);

  const envProvider = (preset) => {
    if (preset.envKey && env[preset.envKey]?.trim()) {
      return {
        id: preset.id,
        preset: preset.id,
        name: preset.name,
        kind: preset.kind,
        protocol: preset.protocol,
        baseUrl: preset.baseUrl,
        apiKey: env[preset.envKey].trim(),
        fromEnv: true,
        enabled: true,
      };
    }
    if (preset.envUrl && env[preset.envUrl]?.trim()) {
      const baseUrl =
        preset.id === "ollama"
          ? normalizeOllamaBase(env[preset.envUrl])
          : normalizeBaseUrl(env[preset.envUrl]);
      return {
        id: preset.id,
        preset: preset.id,
        name: preset.name,
        kind: preset.kind,
        protocol: preset.protocol,
        baseUrl,
        apiKey: "",
        fromEnv: true,
        enabled: true,
      };
    }
    return null;
  };

  // Effective internal list (with secrets) merging saved providers + env defaults.
  const effectiveList = () => {
    const map = new Map();
    for (const p of stored.providers) {
      if (p?.id) map.set(p.id, { ...p });
    }
    for (const preset of PROVIDER_PRESETS) {
      if (map.has(preset.id)) continue;
      const fromEnv = envProvider(preset);
      if (fromEnv) map.set(preset.id, fromEnv);
    }
    return [...map.values()];
  };

  // Resolve a provider by id — including built-in local presets (ollama/vllm/lmstudio)
  // even when not explicitly saved yet so zero-config local inference works immediately.
  const resolveInternal = (id) => {
    const direct = effectiveList().find((p) => p.id === id);
    if (direct) return direct;
    const preset = PRESET_BY_ID.get(id);
    if (preset && preset.kind === "local") {
      return {
        id: preset.id,
        preset: preset.id,
        name: preset.name,
        kind: "local",
        protocol: preset.protocol,
        baseUrl: preset.baseUrl,
        apiKey: "",
        autoDetected: true,
        enabled: true,
      };
    }
    return null;
  };

  const toPublic = (provider, probe = null) => {
    const preset = PRESET_BY_ID.get(provider.preset || provider.id);
    const cached = probe || modelCache.get(provider.id) || null;
    const models = cached?.models?.length
      ? cached.models
      : preset?.defaultModels || [];
    const configured =
      provider.kind === "local"
        ? !!(cached?.reachable || !provider.autoDetected)
        : Boolean(provider.apiKey || !preset?.requiresKey);
    return {
      id: provider.id,
      preset: provider.preset || (preset ? preset.id : "custom"),
      name: provider.name,
      kind: provider.kind === "local" ? "local" : "api",
      protocol: provider.protocol === "anthropic" ? "anthropic" : "openai",
      baseUrl: provider.baseUrl,
      hasKey: Boolean(provider.apiKey),
      keyHint: maskSecret(provider.apiKey),
      requiresKey: preset ? preset.requiresKey : provider.kind !== "local",
      fromEnv: Boolean(provider.fromEnv),
      autoDetected: Boolean(provider.autoDetected),
      configured,
      reachable: cached ? Boolean(cached.reachable) : null,
      error: cached?.error || "",
      modelCount: models.length,
      models: models.slice(0, 80),
      defaultModel: provider.defaultModel || models[0]?.id || "",
      description: preset?.description || "",
    };
  };

  async function probeProvider(provider, { timeoutMs = 1500, refresh = false } = {}) {
    const cached = modelCache.get(provider.id);
    if (!refresh && cached && now() - cached.at < CACHE_MS) return cached;
    try {
      const models = await fetchProviderModels(provider, { fetchImpl, timeoutMs });
      const entry = { at: now(), models, reachable: true, error: "" };
      modelCache.set(provider.id, entry);
      return entry;
    } catch (err) {
      const entry = {
        at: now(),
        models: cached?.models || [],
        reachable: false,
        error: err?.name === "AbortError" ? "Timed out connecting to provider." : err?.message || "Connection failed.",
      };
      modelCache.set(provider.id, entry);
      return entry;
    }
  }

  return {
    presets: () =>
      PROVIDER_PRESETS.map(({ id, name, kind, protocol, baseUrl, requiresKey, description }) => ({
        id,
        name,
        kind,
        protocol,
        baseUrl,
        requiresKey,
        description,
      })),

    getInternal: resolveInternal,

    async list({ discover = true, refresh = false } = {}) {
      const list = effectiveList();
      const byId = new Map(list.map((p) => [p.id, p]));

      // Auto-discover local servers (Ollama, vLLM, LM Studio) in parallel with a short timeout.
      if (discover) {
        const locals = PROVIDER_PRESETS.filter((p) => p.kind === "local").map((preset) => {
          const existing = byId.get(preset.id);
          return (
            existing || {
              id: preset.id,
              preset: preset.id,
              name: preset.name,
              kind: "local",
              protocol: preset.protocol,
              baseUrl: preset.baseUrl,
              apiKey: "",
              autoDetected: true,
              enabled: true,
            }
          );
        });
        await Promise.allSettled(
          locals.map(async (local) => {
            const probe = await probeProvider(local, { timeoutMs: 1200, refresh });
            if (probe.reachable && !byId.has(local.id)) {
              byId.set(local.id, local);
            }
          }),
        );
      }

      // Probe configured API providers on refresh (or if not yet cached).
      const all = [...byId.values()];
      await Promise.allSettled(
        all
          .filter((p) => p.kind === "api" && (refresh || !modelCache.has(p.id)))
          .map((p) => probeProvider(p, { timeoutMs: 3500, refresh })),
      );

      return all.map((p) => toPublic(p));
    },

    upsert(input = {}) {
      const presetId = typeof input.preset === "string" ? input.preset.trim() : "";
      const preset = PRESET_BY_ID.get(presetId) || PRESET_BY_ID.get(String(input.id || "").trim()) || null;
      const id =
        String(input.id || "").trim() ||
        (preset ? preset.id : `custom-${crypto.randomBytes(4).toString("hex")}`);
      if (!/^[a-z0-9][a-z0-9_-]{0,48}$/i.test(id))
        throw Object.assign(new Error("Invalid provider ID."), { status: 400 });

      const existing = stored.providers.find((p) => p.id === id);
      const protocol =
        input.protocol === "anthropic"
          ? "anthropic"
          : input.protocol === "openai"
            ? "openai"
            : existing?.protocol || preset?.protocol || "openai";
      const kind =
        input.kind === "local" || input.kind === "api"
          ? input.kind
          : existing?.kind || preset?.kind || "api";
      const rawUrl = input.baseUrl !== undefined ? input.baseUrl : existing?.baseUrl || preset?.baseUrl || "";
      const baseUrl =
        preset?.id === "ollama" ? normalizeOllamaBase(rawUrl) : normalizeBaseUrl(rawUrl, protocol);
      if (!baseUrl) throw Object.assign(new Error("Base URL is required."), { status: 400 });

      const name = String(input.name || existing?.name || preset?.name || "Custom Provider").trim().slice(0, 60);
      if (!name) throw Object.assign(new Error("Provider name is required."), { status: 400 });

      // Empty string keeps existing key unless clearKey is explicitly true.
      let apiKey = existing?.apiKey || "";
      if (input.clearKey === true) apiKey = "";
      else if (typeof input.apiKey === "string" && input.apiKey.trim()) apiKey = input.apiKey.trim();

      const next = {
        id,
        preset: preset ? preset.id : existing?.preset || "custom",
        name,
        kind,
        protocol,
        baseUrl,
        apiKey,
        ...(typeof input.defaultModel === "string" && input.defaultModel.trim()
          ? { defaultModel: input.defaultModel.trim() }
          : existing?.defaultModel
            ? { defaultModel: existing.defaultModel }
            : {}),
        updatedAt: now(),
      };

      const index = stored.providers.findIndex((p) => p.id === id);
      if (index >= 0) stored.providers[index] = next;
      else stored.providers.push(next);
      modelCache.delete(id);
      save();
      return toPublic(next);
    },

    remove(id) {
      const before = stored.providers.length;
      stored.providers = stored.providers.filter((p) => p.id !== id);
      modelCache.delete(id);
      if (stored.providers.length !== before) save();
      return { removed: stored.providers.length !== before };
    },

    async test(input = {}) {
      const existing = input.id ? resolveInternal(String(input.id)) : null;
      const preset = PRESET_BY_ID.get(String(input.preset || input.id || "").trim()) || null;
      const protocol = input.protocol || existing?.protocol || preset?.protocol || "openai";
      const rawUrl = input.baseUrl || existing?.baseUrl || preset?.baseUrl || "";
      const baseUrl =
        preset?.id === "ollama" ? normalizeOllamaBase(rawUrl) : normalizeBaseUrl(rawUrl, protocol);
      const apiKey =
        typeof input.apiKey === "string" && input.apiKey.trim()
          ? input.apiKey.trim()
          : existing?.apiKey || "";
      const probeTarget = {
        id: existing?.id || preset?.id || "test",
        preset: preset?.id || existing?.preset || "custom",
        protocol,
        baseUrl,
        apiKey,
      };
      const models = await fetchProviderModels(probeTarget, { fetchImpl, timeoutMs: 8000 });
      if (existing) {
        modelCache.set(existing.id, { at: now(), models, reachable: true, error: "" });
      }
      return { ok: true, modelCount: models.length, models: models.slice(0, 80) };
    },

    async listModels(id, { refresh = false } = {}) {
      const provider = resolveInternal(id);
      if (!provider) throw Object.assign(new Error("Unknown chat provider."), { status: 404 });
      const entry = await probeProvider(provider, { timeoutMs: 8000, refresh });
      if (!entry.reachable && !entry.models.length) {
        throw Object.assign(new Error(entry.error || "Could not load models from provider."), { status: 502 });
      }
      return { models: entry.models, reachable: entry.reachable, error: entry.error };
    },
  };
}
