import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { streamChatCompletion } from "./stream.mjs";

// Persistent direct-model chat sessions (Venice, OpenAI, Anthropic, Ollama,
// vLLM, LM Studio, custom OpenAI-compatible). Stored as JSON under
// <dataDir>/anything-chats/ and shaped identically to AgentSession/SessionItem
// so they live naturally alongside Codex and Claude chats in one unified UI.

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(temp, file);
}

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function titleFromText(text) {
  const line = String(text || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!line) return "New chat";
  return line.length > 64 ? `${line.slice(0, 63)}…` : line;
}

function loadImages(imageIds, readImage) {
  if (!Array.isArray(imageIds) || !imageIds.length || typeof readImage !== "function") return [];
  const out = [];
  for (const id of imageIds.slice(0, 6)) {
    const file = readImage(id);
    if (!file || !file.path || !fs.existsSync(file.path)) continue;
    try {
      const buf = fs.readFileSync(file.path);
      const mediaType = file.mime || "image/png";
      const base64 = buf.toString("base64");
      out.push({ id, mediaType, base64, dataUrl: `data:${mediaType};base64,${base64}` });
    } catch {}
  }
  return out;
}

export function createApiChats({
  dataDir,
  providers,
  readImage = null,
  fetchImpl = fetch,
  now = Date.now,
} = {}) {
  const dir = path.join(dataDir, "anything-chats");
  const active = new Map(); // id -> { controller }
  const subscribers = new Map(); // id -> Set<() => void>
  const listListeners = new Set();

  const fileOf = (id) => {
    if (!/^[a-zA-Z0-9_-]{4,80}$/.test(String(id || "")))
      throw Object.assign(new Error("Invalid chat ID."), { status: 400 });
    return path.join(dir, `${id}.json`);
  };

  const notifyList = () => {
    for (const fn of listListeners) {
      try {
        fn();
      } catch {}
    }
  };

  const notifySession = (id) => {
    const set = subscribers.get(id);
    if (!set) return;
    for (const fn of set) {
      try {
        fn();
      } catch {}
    }
  };

  const readRecord = (id) => {
    const rec = readJsonSafe(fileOf(id));
    if (!rec) throw Object.assign(new Error("Chat not found."), { status: 404 });
    return rec;
  };

  const saveRecord = (rec) => {
    writeJsonAtomic(fileOf(rec.id), rec);
    notifySession(rec.id);
    notifyList();
  };

  const toSession = (rec) => {
    const lastText = [...(rec.items || [])]
      .reverse()
      .find((i) => (i.role === "assistant" || i.role === "user") && i.kind === "text" && i.text)?.text;
    return {
      agent: "api",
      id: rec.id,
      title: rec.title || "New chat",
      cwd: "",
      branch: "",
      origin: "reach",
      inApp: false,
      updatedAt: rec.updatedAt || rec.createdAt || 0,
      createdAt: rec.createdAt || 0,
      status: active.has(rec.id) ? "running" : rec.status === "error" ? "error" : "idle",
      preview: String(lastText || "").replace(/\s+/g, " ").trim().slice(0, 140),
      archived: Boolean(rec.archived),
      model: rec.model || null,
      providerId: rec.providerId || "",
      providerName: rec.providerName || "",
      providerKind: rec.providerKind || "api",
      systemPrompt: rec.systemPrompt || "",
      temperature: typeof rec.temperature === "number" ? rec.temperature : null,
      veniceWebSearch: Boolean(rec.veniceWebSearch),
    };
  };

  const runTurn = (rec, provider, model, images) => {
    const controller = new AbortController();
    active.set(rec.id, { controller });
    rec.status = "running";
    rec.updatedAt = now();

    const turnId = `turn-${crypto.randomBytes(4).toString("hex")}`;
    const thinkingId = `${turnId}-think`;
    const replyId = `${turnId}-text`;
    let thinkingItem = null;
    const replyItem = {
      id: replyId,
      role: "assistant",
      kind: "text",
      text: "",
      detail: `${provider.name} · ${model}`,
      status: "running",
      at: now(),
      turnId,
    };
    rec.items.push(replyItem);
    saveRecord(rec);

    // Build conversation history from completed user & assistant text messages.
    const history = [];
    for (const item of rec.items) {
      if (item.id === replyId || item.id === thinkingId) continue;
      if (item.kind !== "text") continue;
      if (item.role === "user" || item.role === "assistant") {
        history.push({ role: item.role, text: item.text || "" });
      }
    }
    if (images.length && history.length && history.at(-1).role === "user") {
      history[history.length - 1].images = images;
    }

    let lastFlush = 0;
    const flushLive = (force = false) => {
      const t = now();
      if (!force && t - lastFlush < 60) return;
      lastFlush = t;
      rec.updatedAt = t;
      writeJsonAtomic(fileOf(rec.id), rec);
      notifySession(rec.id);
    };

    void (async () => {
      try {
        await streamChatCompletion({
          provider,
          model,
          messages: history,
          systemPrompt: rec.systemPrompt || "",
          temperature: typeof rec.temperature === "number" ? rec.temperature : undefined,
          veniceWebSearch: Boolean(rec.veniceWebSearch),
          signal: controller.signal,
          fetchImpl,
          onThinking: (_delta, full) => {
            if (!thinkingItem) {
              thinkingItem = {
                id: thinkingId,
                role: "assistant",
                kind: "thinking",
                text: full,
                status: "running",
                at: now(),
                turnId,
              };
              const idx = rec.items.indexOf(replyItem);
              rec.items.splice(idx >= 0 ? idx : rec.items.length, 0, thinkingItem);
            } else {
              thinkingItem.text = full;
            }
            flushLive();
          },
          onText: (_delta, full) => {
            replyItem.text = full;
            flushLive();
          },
        });
        if (thinkingItem) thinkingItem.status = "done";
        replyItem.status = "done";
        rec.status = "idle";
      } catch (err) {
        if (thinkingItem) thinkingItem.status = "done";
        if (controller.signal.aborted) {
          replyItem.status = "done";
          if (!replyItem.text.trim()) {
            const idx = rec.items.indexOf(replyItem);
            if (idx >= 0) rec.items.splice(idx, 1);
          }
          rec.status = "idle";
        } else {
          replyItem.status = "error";
          if (!replyItem.text.trim()) {
            const idx = rec.items.indexOf(replyItem);
            if (idx >= 0) rec.items.splice(idx, 1);
          }
          rec.items.push({
            id: `${turnId}-err`,
            role: "system",
            kind: "error",
            text: err?.message || "The model request failed.",
            at: now(),
            turnId,
          });
          rec.status = "error";
        }
      } finally {
        active.delete(rec.id);
        rec.updatedAt = now();
        saveRecord(rec);
      }
    })();
  };

  return {
    list() {
      if (!fs.existsSync(dir)) return [];
      const out = [];
      for (const name of fs.readdirSync(dir)) {
        if (!name.endsWith(".json")) continue;
        const rec = readJsonSafe(path.join(dir, name));
        if (rec?.id) out.push(toSession(rec));
      }
      return out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    },

    read(id, { limit = 200, before } = {}) {
      const rec = readRecord(id);
      const items = Array.isArray(rec.items) ? rec.items : [];
      const max = Math.min(Math.max(Number(limit) || 200, 1), 500);
      const end = before != null ? Math.min(Math.max(Number(before) || 0, 0), items.length) : items.length;
      const start = Math.max(0, end - max);
      return {
        session: toSession(rec),
        items: items.slice(start, end),
        before: start > 0 ? String(start) : null,
      };
    },

    start({
      providerId,
      model,
      text,
      images = [],
      systemPrompt = "",
      temperature,
      veniceWebSearch = false,
    } = {}) {
      const body = String(text || "").trim();
      if (!body && !images.length)
        throw Object.assign(new Error("Enter a message to start chatting."), { status: 400 });
      const provider = providers.getInternal(String(providerId || ""));
      if (!provider)
        throw Object.assign(new Error("Pick a connected provider first."), { status: 400 });
      const chosenModel = String(model || provider.defaultModel || "").trim();
      if (!chosenModel)
        throw Object.assign(new Error("Pick a model first."), { status: 400 });

      const id = `chat-${crypto.randomBytes(6).toString("hex")}`;
      const ts = now();
      const loadedImages = loadImages(images, readImage);
      const rec = {
        id,
        title: titleFromText(body || "Image chat"),
        providerId: provider.id,
        providerName: provider.name,
        providerKind: provider.kind === "local" ? "local" : "api",
        model: chosenModel,
        systemPrompt: typeof systemPrompt === "string" ? systemPrompt.slice(0, 8000) : "",
        temperature:
          typeof temperature === "number" && Number.isFinite(temperature)
            ? Math.max(0, Math.min(2, temperature))
            : null,
        veniceWebSearch: Boolean(veniceWebSearch),
        createdAt: ts,
        updatedAt: ts,
        archived: false,
        status: "running",
        items: [
          {
            id: `u-${crypto.randomBytes(4).toString("hex")}`,
            role: "user",
            kind: "text",
            text: body,
            ...(loadedImages.length ? { images: loadedImages.length } : {}),
            at: ts,
          },
        ],
      };
      runTurn(rec, provider, chosenModel, loadedImages);
      return { session: toSession(rec) };
    },

    send(
      id,
      { text, images = [], providerId, model, systemPrompt, temperature, veniceWebSearch } = {},
    ) {
      const rec = readRecord(id);
      if (active.has(id))
        throw Object.assign(new Error("Wait for the current reply to finish or stop it first."), {
          status: 409,
        });
      const body = String(text || "").trim();
      if (!body && !images.length)
        throw Object.assign(new Error("Enter a message."), { status: 400 });

      const targetProviderId = String(providerId || rec.providerId || "");
      const provider = providers.getInternal(targetProviderId);
      if (!provider)
        throw Object.assign(new Error("Selected provider is no longer configured."), { status: 400 });
      const chosenModel = String(model || rec.model || provider.defaultModel || "").trim();
      if (!chosenModel)
        throw Object.assign(new Error("Pick a model first."), { status: 400 });

      rec.providerId = provider.id;
      rec.providerName = provider.name;
      rec.providerKind = provider.kind === "local" ? "local" : "api";
      rec.model = chosenModel;
      if (typeof systemPrompt === "string") rec.systemPrompt = systemPrompt.slice(0, 8000);
      if (typeof temperature === "number" && Number.isFinite(temperature))
        rec.temperature = Math.max(0, Math.min(2, temperature));
      if (typeof veniceWebSearch === "boolean") rec.veniceWebSearch = veniceWebSearch;

      const loadedImages = loadImages(images, readImage);
      rec.items.push({
        id: `u-${crypto.randomBytes(4).toString("hex")}`,
        role: "user",
        kind: "text",
        text: body,
        ...(loadedImages.length ? { images: loadedImages.length } : {}),
        at: now(),
      });
      runTurn(rec, provider, chosenModel, loadedImages);
      return { session: toSession(rec) };
    },

    stop(id) {
      const running = active.get(id);
      if (running) running.controller.abort();
      return { stopped: Boolean(running) };
    },

    setModel(id, { providerId, model, systemPrompt, temperature, veniceWebSearch } = {}) {
      const rec = readRecord(id);
      if (providerId) {
        const provider = providers.getInternal(String(providerId));
        if (!provider)
          throw Object.assign(new Error("Unknown provider."), { status: 404 });
        rec.providerId = provider.id;
        rec.providerName = provider.name;
        rec.providerKind = provider.kind === "local" ? "local" : "api";
      }
      if (typeof model === "string" && model.trim()) rec.model = model.trim();
      if (typeof systemPrompt === "string") rec.systemPrompt = systemPrompt.slice(0, 8000);
      if (temperature === null) rec.temperature = null;
      else if (typeof temperature === "number" && Number.isFinite(temperature))
        rec.temperature = Math.max(0, Math.min(2, temperature));
      if (typeof veniceWebSearch === "boolean") rec.veniceWebSearch = veniceWebSearch;
      rec.updatedAt = now();
      saveRecord(rec);
      return { session: toSession(rec) };
    },

    rename(id, title) {
      const rec = readRecord(id);
      const next = String(title || "").trim().slice(0, 120);
      if (!next) throw Object.assign(new Error("Enter a chat title."), { status: 400 });
      rec.title = next;
      rec.updatedAt = now();
      saveRecord(rec);
      return { session: toSession(rec) };
    },

    archive(id, archived = true) {
      const rec = readRecord(id);
      rec.archived = Boolean(archived);
      rec.updatedAt = now();
      saveRecord(rec);
      return { session: toSession(rec) };
    },

    remove(id) {
      const running = active.get(id);
      if (running) running.controller.abort();
      const file = fileOf(id);
      if (fs.existsSync(file)) fs.unlinkSync(file);
      notifyList();
      return { deleted: true };
    },

    subscribe(id, listener) {
      if (!subscribers.has(id)) subscribers.set(id, new Set());
      subscribers.get(id).add(listener);
      return () => {
        const set = subscribers.get(id);
        if (!set) return;
        set.delete(listener);
        if (!set.size) subscribers.delete(id);
      };
    },

    onListChange(listener) {
      listListeners.add(listener);
      return () => listListeners.delete(listener);
    },

    close() {
      for (const { controller } of active.values()) controller.abort();
      active.clear();
    },
  };
}
