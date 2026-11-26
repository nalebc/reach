import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
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
    id: "llamacpp",
    name: "llama.cpp / MLX",
    kind: "local",
    protocol: "openai",
    baseUrl: "http://127.0.0.1:8080/v1",
    envUrl: "LLAMACPP_BASE_URL",
    requiresKey: false,
    description: "Local llama-server or mlx_lm.server on port 8080",
    defaultModels: [],
  },
  {
    id: "jan",
    name: "Jan",
    kind: "local",
    protocol: "openai",
    baseUrl: "http://127.0.0.1:1337/v1",
    envUrl: "JAN_BASE_URL",
    requiresKey: false,
    description: "Local Jan OpenAI-compatible server on port 1337",
    defaultModels: [],
  },
  {
    id: "exo",
    name: "Exo",
    kind: "local",
    protocol: "openai",
    baseUrl: "http://127.0.0.1:52415/v1",
    envUrl: "EXO_BASE_URL",
    requiresKey: false,
    description: "Distributed local Exo cluster on port 52415",
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
  {
    id: "xai",
    name: "xAI (Grok)",
    kind: "api",
    protocol: "openai",
    baseUrl: "https://api.x.ai/v1",
    envKey: "XAI_API_KEY",
    requiresKey: true,
    description: "Grok models via xAI API key",
    defaultModels: [
      { id: "grok-3", name: "Grok 3" },
      { id: "grok-3-mini", name: "Grok 3 Mini" },
    ],
  },
  {
    id: "groq",
    name: "Groq",
    kind: "api",
    protocol: "openai",
    baseUrl: "https://api.groq.com/openai/v1",
    envKey: "GROQ_API_KEY",
    requiresKey: true,
    description: "Ultra-fast inference via Groq API key",
    defaultModels: [
      { id: "llama-3.3-70b-versatile", name: "Llama 3.3 70B" },
    ],
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    kind: "api",
    protocol: "openai",
    baseUrl: "https://api.deepseek.com/v1",
    envKey: "DEEPSEEK_API_KEY",
    requiresKey: true,
    description: "DeepSeek Chat & Reasoner via DeepSeek API key",
    defaultModels: [
      { id: "deepseek-chat", name: "DeepSeek Chat" },
      { id: "deepseek-reasoner", name: "DeepSeek Reasoner" },
    ],
  },
  {
    id: "mistral",
    name: "Mistral",
    kind: "api",
    protocol: "openai",
    baseUrl: "https://api.mistral.ai/v1",
    envKey: "MISTRAL_API_KEY",
    requiresKey: true,
    description: "Mistral & Codestral models via Mistral API key",
    defaultModels: [
      { id: "mistral-large-latest", name: "Mistral Large" },
    ],
  },
  {
    id: "gemini-api",
    name: "Google Gemini API",
    kind: "api",
    protocol: "openai",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    envKey: "GEMINI_API_KEY",
    requiresKey: true,
    description: "Gemini models via Google AI Studio API key",
    defaultModels: [
      { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro" },
      { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash" },
    ],
  },
  {
    id: "together",
    name: "Together AI",
    kind: "api",
    protocol: "openai",
    baseUrl: "https://api.together.xyz/v1",
    envKey: "TOGETHER_API_KEY",
    requiresKey: true,
    description: "Open-weights models via Together API key",
    defaultModels: [
      { id: "meta-llama/Llama-3.3-70B-Instruct-Turbo", name: "Llama 3.3 70B Turbo" },
    ],
  },
  {
    id: "perplexity",
    name: "Perplexity",
    kind: "api",
    protocol: "openai",
    baseUrl: "https://api.perplexity.ai",
    envKey: "PERPLEXITY_API_KEY",
    requiresKey: true,
    description: "Web-grounded Sonar models via Perplexity API key",
    defaultModels: [
      { id: "sonar-pro", name: "Sonar Pro" },
      { id: "sonar", name: "Sonar" },
    ],
  },
  {
    id: "fireworks",
    name: "Fireworks AI",
    kind: "api",
    protocol: "openai",
    baseUrl: "https://api.fireworks.ai/inference/v1",
    envKey: "FIREWORKS_API_KEY",
    requiresKey: true,
    description: "Fast open models via Fireworks API key",
    defaultModels: [
      { id: "accounts/fireworks/models/deepseek-r1", name: "DeepSeek R1" },
    ],
  },
  {
    id: "cohere",
    name: "Cohere",
    kind: "api",
    protocol: "openai",
    baseUrl: "https://api.cohere.ai/compatibility/v1",
    envKey: "COHERE_API_KEY",
    requiresKey: true,
    description: "Command A & R models via Cohere API key",
    defaultModels: [
      { id: "command-a-03-2025", name: "Command A" },
    ],
  },
  {
    id: "huggingface",
    name: "Hugging Face / Experiential",
    kind: "api",
    protocol: "openai",
    baseUrl: "https://router.huggingface.co/v1",
    envKey: "HF_TOKEN",
    requiresKey: true,
    description: "Open & experiential models via Hugging Face Inference Router",
    defaultModels: [
      { id: "Qwen/Qwen2.5-72B-Instruct", name: "Qwen 2.5 72B Instruct" },
      { id: "deepseek-ai/DeepSeek-R1", name: "DeepSeek R1" },
    ],
  },
  {
    id: "cerebras",
    name: "Cerebras",
    kind: "api",
    protocol: "openai",
    baseUrl: "https://api.cerebras.ai/v1",
    envKey: "CEREBRAS_API_KEY",
    requiresKey: true,
    description: "Wafer-scale instant inference via Cerebras API key",
    defaultModels: [
      { id: "llama-3.3-70b", name: "Llama 3.3 70B" },
    ],
  },
  {
    id: "nvidia",
    name: "NVIDIA NIM",
    kind: "api",
    protocol: "openai",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    envKey: "NVIDIA_API_KEY",
    requiresKey: true,
    description: "Nemotron, DeepSeek & Llama models via NVIDIA NIM key",
    defaultModels: [
      { id: "nvidia/llama-3.3-nemotron-super-49b-v1", name: "Nemotron Super 49B" },
    ],
  },
  {
    id: "moonshot",
    name: "Kimi (Moonshot)",
    kind: "api",
    protocol: "openai",
    baseUrl: "https://api.moonshot.ai/v1",
    envKey: "MOONSHOT_API_KEY",
    requiresKey: true,
    description: "Kimi K2 models via Moonshot API key",
    defaultModels: [
      { id: "kimi-k2-0711-preview", name: "Kimi K2" },
    ],
  },
];

export function detectPresetIdFromKey(raw) {
  const k = String(raw || "").trim();
  if (!k) return null;
  if (k.startsWith("sk-ant-")) return "anthropic";
  if (k.startsWith("sk-or-")) return "openrouter";
  if (k.startsWith("gsk_")) return "groq";
  if (k.startsWith("xai-")) return "xai";
  if (k.startsWith("AIza")) return "gemini-api";
  if (k.startsWith("pplx-")) return "perplexity";
  if (k.startsWith("fw_")) return "fireworks";
  if (k.startsWith("hf_")) return "huggingface";
  if (k.startsWith("csk-")) return "cerebras";
  if (k.startsWith("nvapi-")) return "nvidia";
  if (/^(VENICE-|vn_)/i.test(k)) return "venice";
  return null;
}

const PRESET_BY_ID = new Map(PROVIDER_PRESETS.map((p) => [p.id, p]));

function cleanString(value) {
  const bytes = Uint8Array.from(Buffer.from(String(value || ""), "utf8"), (b) => b & 0xff);
  return new TextDecoder("utf-8").decode(bytes);
}

function stripTrailingSlashes(value) {
  let s = String(value || "").trim();
  while (s.endsWith("/")) s = s.slice(0, -1);
  return s;
}

function isDisallowedHost(host) {
  const h = String(host || "").toLowerCase();
  if (!h || h === "0.0.0.0" || h === "metadata" || h === "metadata.google.internal" || h === "100.100.100.200")
    return true;
  if (h.startsWith("169.254.") || h === "[fd00:ec2::254]" || h.startsWith("[fe80:"))
    return true;
  return false;
}

export function maskSecret(value) {
  const s = typeof value === "string" ? value.trim() : "";
  if (!s) return "";
  if (s.length <= 6) return "••••";
  return `${s.slice(0, 3)}…${s.slice(-4)}`;
}

export function normalizeBaseUrl(raw) {
  const trimmed = stripTrailingSlashes(raw);
  if (!trimmed) return "";
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw Object.assign(new Error("Enter a valid http:// or https:// base URL."), { status: 400 });
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
    throw Object.assign(new Error("Base URL must use http:// or https://."), { status: 400 });
  if (parsed.username || parsed.password)
    throw Object.assign(new Error("Base URL must not embed credentials."), { status: 400 });
  if (isDisallowedHost(parsed.hostname))
    throw Object.assign(new Error("That host address is not permitted."), { status: 400 });
  return stripTrailingSlashes(parsed.toString());
}

function normalizeOllamaBase(raw) {
  const clean = normalizeBaseUrl(raw || "http://127.0.0.1:11434");
  return clean.endsWith("/v1") ? clean : `${clean}/v1`;
}

export function buildSafeProviderEndpoint(provider, suffix) {
  const preset = PRESET_BY_ID.get(provider?.preset || provider?.id);
  const candidate = stripTrailingSlashes(provider?.baseUrl || preset?.baseUrl || "");
  if (preset && candidate === stripTrailingSlashes(preset.baseUrl)) {
    if (suffix === "/api/tags" && preset.tagsUrl) return preset.tagsUrl;
    return `${stripTrailingSlashes(preset.baseUrl)}${suffix}`;
  }
  const normalized = normalizeBaseUrl(candidate);
  if (!normalized)
    throw Object.assign(new Error("Provider base URL is missing."), { status: 400 });
  const parsed = new URL(normalized);
  if (parsed.search || parsed.hash || parsed.pathname.includes(".."))
    throw Object.assign(new Error("Invalid provider base URL path."), { status: 400 });
  let basePath = stripTrailingSlashes(parsed.pathname);
  if (suffix === "/api/tags" && basePath.endsWith("/v1")) {
    basePath = basePath.slice(0, -3);
  }
  const scheme = parsed.protocol === "https:" ? "https://" : "http://";
  const portNum = parsed.port ? Number.parseInt(parsed.port, 10) : 0;
  const portPart = Number.isInteger(portNum) && portNum > 0 && portNum <= 65535 ? `:${portNum}` : "";
  if (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost") {
    const safePath = cleanString(basePath);
    return `${scheme}127.0.0.1${portPart}${safePath}${suffix}`;
  }
  const safeHost = cleanString(parsed.hostname);
  const safePath = cleanString(basePath);
  return `${scheme}${safeHost}${portPart}${safePath}${suffix}`;
}

function readJsonSafe(file) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) return null;
    return JSON.parse(cleanString(fs.readFileSync(fd, "utf8")));
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }
}

// Safely scan common shell profile files for exported provider env vars without
// executing any shell code. Values stay strictly in host memory / masked hints.
function readShellEnvMap(home = os.homedir()) {
  const found = {};
  if (!home) return found;
  const wanted = new Set(
    PROVIDER_PRESETS.flatMap((p) => [p.envKey, p.envUrl].filter(Boolean)),
  );
  const files = [".zshenv", ".zshrc", ".zprofile", ".bashrc", ".bash_profile", ".profile", ".env"];
  for (const name of files) {
    const file = path.join(home, name);
    let text = "";
    let fd;
    try {
      fd = fs.openSync(file, "r");
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size > 256 * 1024) continue;
      text = fs.readFileSync(fd, "utf8");
    } catch {
      continue;
    } finally {
      if (fd !== undefined) {
        try {
          fs.closeSync(fd);
        } catch {}
      }
    }
    for (const rawLine of text.split("\n")) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const body = line.startsWith("export ") ? line.slice(7).trim() : line;
      const eq = body.indexOf("=");
      if (eq <= 0) continue;
      const key = body.slice(0, eq).trim();
      if (!/^[A-Z0-9_]+$/.test(key) || !wanted.has(key) || found[key]) continue;
      let val = body.slice(eq + 1).trim();
      const spaceHash = val.indexOf(" #");
      const tabHash = val.indexOf("\t#");
      const cut =
        spaceHash >= 0 && tabHash >= 0
          ? Math.min(spaceHash, tabHash)
          : spaceHash >= 0
            ? spaceHash
            : tabHash;
      if (cut >= 0) val = val.slice(0, cut).trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      if (val && !val.includes("$")) found[key] = cleanString(val);
    }
  }
  return found;
}

function writePrivateJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  const payload = cleanString(JSON.stringify(value, null, 2) + "\n");
  fs.writeFileSync(temp, payload, { mode: 0o600 });
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
    const safeKey = cleanString(provider.apiKey);
    if (provider.protocol === "anthropic") {
      headers["x-api-key"] = safeKey;
      headers["anthropic-version"] = "2023-06-01";
    } else {
      headers.Authorization = `Bearer ${safeKey}`;
    }
  }
  if (provider.headers && typeof provider.headers === "object") {
    for (const [k, v] of Object.entries(provider.headers)) {
      if (typeof k === "string" && typeof v === "string" && k.trim()) {
        headers[cleanString(k.trim())] = cleanString(v);
      }
    }
  }

  // Ollama: prefer /api/tags because it works on all Ollama versions and includes sizes.
  if (provider.preset === "ollama" || provider.id === "ollama") {
    try {
      const tagsEndpoint = buildSafeProviderEndpoint(provider, "/api/tags");
      const data = await fetchJson(tagsEndpoint, {
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

  const url = buildSafeProviderEndpoint(provider, "/models");
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
  home = env === process.env ? os.homedir() : "",
  fetchImpl = fetch,
  now = Date.now,
} = {}) {
  const file = path.join(dataDir, "chat-providers.json");
  let stored = readJsonSafe(file);
  if (!stored || typeof stored !== "object" || !Array.isArray(stored.providers)) {
    stored = { version: 1, providers: [] };
  }
  const shellEnv = home ? readShellEnvMap(home) : {};
  const lookupEnv = (name) => (name ? env[name] || shellEnv[name] || "" : "");

  // Cached model lists & local auto-discovery probes (avoid hammering localhost).
  const modelCache = new Map(); // id -> { at, models, error, reachable }
  const CACHE_MS = 15000;

  const save = () => writePrivateJson(file, stored);

  const envProvider = (preset) => {
    const keyVal = lookupEnv(preset.envKey).trim();
    if (preset.envKey && keyVal) {
      return {
        id: preset.id,
        preset: preset.id,
        name: preset.name,
        kind: preset.kind,
        protocol: preset.protocol,
        baseUrl: preset.baseUrl,
        apiKey: keyVal,
        fromEnv: true,
        enabled: true,
      };
    }
    const urlVal = lookupEnv(preset.envUrl).trim();
    if (preset.envUrl && urlVal) {
      const baseUrl =
        preset.id === "ollama"
          ? normalizeOllamaBase(urlVal)
          : normalizeBaseUrl(urlVal);
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

    async autoConnectKey(rawInput, { preferredPreset = "" } = {}) {
      const raw = String(rawInput || "").trim();
      if (!raw) throw Object.assign(new Error("Paste an API key or server URL first."), { status: 400 });

      // Support pasting a local/remote OpenAI-compatible URL directly in the same box!
      if (/^https?:\/\//i.test(raw)) {
        const cleanUrl = normalizeBaseUrl(raw, "openai");
        const parsed = new URL(cleanUrl);
        const hostLabel = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost"
          ? `Local (${parsed.port || "http"})`
          : parsed.hostname;
        const matchedLocal = PROVIDER_PRESETS.find(
          (p) => p.kind === "local" && cleanUrl.startsWith(p.baseUrl.replace(/\/v1$/, "")),
        );
        const saved = this.upsert({
          ...(matchedLocal ? { id: matchedLocal.id, preset: matchedLocal.id, name: matchedLocal.name, kind: "local" } : { preset: "custom", name: hostLabel, kind: "local" }),
          protocol: "openai",
          baseUrl: cleanUrl.endsWith("/v1") ? cleanUrl : `${cleanUrl}/v1`,
        });
        const tested = await this.test({ id: saved.id }).catch(() => ({ modelCount: saved.modelCount || 0, models: saved.models || [] }));
        return { provider: resolveInternal(saved.id) ? toPublic(resolveInternal(saved.id)) : saved, modelCount: tested.modelCount, models: tested.models };
      }

      const exactId = detectPresetIdFromKey(raw);
      const apiPresets = PROVIDER_PRESETS.filter((p) => p.kind === "api");
      if (exactId) {
        const preset = PRESET_BY_ID.get(exactId);
        const saved = this.upsert({
          id: preset.id,
          preset: preset.id,
          name: preset.name,
          kind: "api",
          protocol: preset.protocol,
          baseUrl: preset.baseUrl,
          apiKey: raw,
        });
        const tested = await this.test({ id: saved.id }).catch(() => ({
          modelCount: preset.defaultModels?.length || 0,
          models: preset.defaultModels || [],
        }));
        return {
          provider: toPublic(resolveInternal(saved.id)),
          modelCount: tested.modelCount,
          models: tested.models,
          detectedPreset: preset.id,
        };
      }

      // Ambiguous key (e.g. sk-... or raw token used by Venice, OpenAI, DeepSeek, Mistral, Together, etc.):
      // probe candidate endpoints in parallel so the user never has to guess which provider to pick!
      const priorityOrder = [
        ...(preferredPreset ? [preferredPreset] : []),
        "venice",
        "openai",
        "deepseek",
        "openrouter",
        "anthropic",
        "mistral",
        "together",
        "groq",
        "xai",
        "fireworks",
        "perplexity",
        "cohere",
        "huggingface",
        "cerebras",
        "nvidia",
        "moonshot",
      ];
      const seen = new Set();
      const candidates = priorityOrder
        .filter((id) => !seen.has(id) && seen.add(id))
        .map((id) => PRESET_BY_ID.get(id))
        .filter(Boolean);

      const probeResults = await Promise.all(
        candidates.map(async (preset) => {
          try {
            const models = await fetchProviderModels(
              {
                id: preset.id,
                preset: preset.id,
                protocol: preset.protocol,
                baseUrl: preset.baseUrl,
                apiKey: raw,
              },
              { fetchImpl, timeoutMs: 4000 },
            );
            return models.length > 0 ? { preset, models } : null;
          } catch {
            return null;
          }
        }),
      );

      const winner = probeResults.find(Boolean);
      if (winner) {
        const saved = this.upsert({
          id: winner.preset.id,
          preset: winner.preset.id,
          name: winner.preset.name,
          kind: "api",
          protocol: winner.preset.protocol,
          baseUrl: winner.preset.baseUrl,
          apiKey: raw,
        });
        modelCache.set(saved.id, { at: now(), models: winner.models, reachable: true, error: "" });
        return {
          provider: toPublic(resolveInternal(saved.id)),
          modelCount: winner.models.length,
          models: winner.models.slice(0, 80),
          detectedPreset: winner.preset.id,
        };
      }

      // If a preferred preset was given (or fallback to Venice/OpenAI), surface a clear message.
      const fallback = PRESET_BY_ID.get(preferredPreset) || apiPresets[0];
      throw Object.assign(
        new Error(
          `Could not verify that key automatically against Venice, OpenAI, Claude, DeepSeek, or OpenRouter. Check the key or pick ${fallback?.name || "a provider"} manually.`,
        ),
        { status: 400 },
      );
    },
  };
}
