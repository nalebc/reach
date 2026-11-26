// Unified SSE streaming client for OpenAI-compatible (Venice, OpenAI,
// OpenRouter, Ollama, vLLM, LM Studio, custom) and Anthropic Messages APIs.
// Emits normalized text & thinking deltas so any model works seamlessly inside
// Reach's Anything Chat thread.

function parseSseLines(chunk, state, onEvent) {
  state.buffer += chunk;
  const lines = state.buffer.split(/\r?\n/);
  state.buffer = lines.pop() ?? "";
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      if (state.data.length) {
        onEvent(state.event, state.data.join("\n"));
        state.event = "";
        state.data = [];
      }
      continue;
    }
    if (line.startsWith(":")) continue;
    if (line.startsWith("event:")) state.event = line.slice(6).trim();
    else if (line.startsWith("data:")) state.data.push(line.slice(5).trimStart());
  }
}

// Extracts inline <think>...</think> blocks emitted by DeepSeek R1, QwQ,
// Venice reasoning models, and local Ollama/vLLM models into separate thinking
// and visible text streams.
export function createThinkSplitter(onText, onThinking) {
  let inThink = false;
  let pending = "";
  const OPEN = "<think>";
  const CLOSE = "</think>";

  const emit = (chunk) => {
    if (!chunk) return;
    if (inThink) onThinking(chunk);
    else onText(chunk);
  };

  return {
    push(delta) {
      if (!delta) return;
      pending += delta;
      while (pending.length) {
        const tag = inThink ? CLOSE : OPEN;
        const idx = pending.indexOf(tag);
        if (idx >= 0) {
          emit(pending.slice(0, idx));
          pending = pending.slice(idx + tag.length);
          inThink = !inThink;
          continue;
        }
        // Keep a short tail if it could be a partial <think> or </think> tag.
        let keep = 0;
        for (let len = Math.min(tag.length - 1, pending.length); len > 0; len--) {
          if (tag.startsWith(pending.slice(-len))) {
            keep = len;
            break;
          }
        }
        emit(pending.slice(0, pending.length - keep));
        pending = keep ? pending.slice(-keep) : "";
        break;
      }
    },
    flush() {
      if (pending) {
        emit(pending);
        pending = "";
      }
    },
  };
}

function buildOpenAiMessages(messages, systemPrompt) {
  const out = [];
  if (systemPrompt && systemPrompt.trim()) {
    out.push({ role: "system", content: systemPrompt.trim() });
  }
  for (const m of messages) {
    if (m.role !== "user" && m.role !== "assistant") continue;
    if (m.role === "user" && Array.isArray(m.images) && m.images.length) {
      const content = [];
      if (m.text) content.push({ type: "text", text: m.text });
      for (const img of m.images) {
        if (img?.dataUrl) content.push({ type: "image_url", image_url: { url: img.dataUrl } });
      }
      out.push({ role: "user", content });
    } else {
      out.push({ role: m.role, content: m.text || "" });
    }
  }
  return out;
}

function buildAnthropicMessages(messages) {
  const out = [];
  for (const m of messages) {
    if (m.role !== "user" && m.role !== "assistant") continue;
    if (m.role === "user" && Array.isArray(m.images) && m.images.length) {
      const content = [];
      for (const img of m.images) {
        if (img?.base64 && img?.mediaType) {
          content.push({
            type: "image",
            source: { type: "base64", media_type: img.mediaType, data: img.base64 },
          });
        }
      }
      if (m.text) content.push({ type: "text", text: m.text });
      out.push({ role: "user", content });
    } else {
      out.push({ role: m.role, content: m.text || "" });
    }
  }
  return out;
}

async function readErrorBody(res) {
  const text = await res.text().catch(() => "");
  try {
    const json = JSON.parse(text);
    return (
      json?.error?.message ||
      (typeof json?.error === "string" ? json.error : "") ||
      json?.message ||
      `${res.status} ${res.statusText}`
    );
  } catch {
    return text.slice(0, 300) || `${res.status} ${res.statusText}`;
  }
}

export async function streamChatCompletion({
  provider,
  model,
  messages,
  systemPrompt = "",
  temperature,
  maxTokens,
  veniceWebSearch = false,
  signal,
  onText = () => {},
  onThinking = () => {},
  fetchImpl = fetch,
}) {
  const isAnthropic = provider.protocol === "anthropic";
  const baseUrl = provider.baseUrl.replace(/\/+$/, "");
  const url = isAnthropic ? `${baseUrl}/messages` : `${baseUrl}/chat/completions`;
  const headers = {
    "Content-Type": "application/json",
    Accept: "text/event-stream",
  };
  if (provider.apiKey) {
    if (isAnthropic) {
      headers["x-api-key"] = provider.apiKey;
      headers["anthropic-version"] = "2023-06-01";
    } else {
      headers.Authorization = `Bearer ${provider.apiKey}`;
    }
  }

  const body = isAnthropic
    ? {
        model,
        stream: true,
        max_tokens: Number.isInteger(maxTokens) && maxTokens > 0 ? maxTokens : 4096,
        ...(systemPrompt.trim() ? { system: systemPrompt.trim() } : {}),
        ...(typeof temperature === "number" && Number.isFinite(temperature) ? { temperature } : {}),
        messages: buildAnthropicMessages(messages),
      }
    : {
        model,
        stream: true,
        ...(typeof temperature === "number" && Number.isFinite(temperature) ? { temperature } : {}),
        ...(Number.isInteger(maxTokens) && maxTokens > 0 ? { max_tokens: maxTokens } : {}),
        ...(provider.preset === "venice" || provider.id === "venice"
          ? {
              venice_parameters: {
                enable_web_search: veniceWebSearch ? "auto" : "off",
                include_venice_system_prompt: false,
              },
            }
          : {}),
        messages: buildOpenAiMessages(messages, systemPrompt),
      };

  const res = await fetchImpl(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    const msg = await readErrorBody(res);
    throw Object.assign(new Error(msg), { status: res.status });
  }

  const contentType = res.headers?.get?.("content-type") || "";
  let fullText = "";
  let fullThinking = "";
  let usage = null;

  const pushText = (t) => {
    if (!t) return;
    fullText += t;
    onText(t, fullText);
  };
  const pushThinking = (t) => {
    if (!t) return;
    fullThinking += t;
    onThinking(t, fullThinking);
  };
  const splitter = createThinkSplitter(pushText, pushThinking);

  // Fallback for non-streaming JSON responses (some custom proxies ignore stream:true).
  if (contentType.includes("application/json") && !contentType.includes("text/event-stream")) {
    const json = await res.json();
    if (isAnthropic) {
      for (const block of json?.content || []) {
        if (block?.type === "thinking" && block.thinking) pushThinking(block.thinking);
        if (block?.type === "text" && block.text) pushText(block.text);
      }
    } else {
      const msg = json?.choices?.[0]?.message;
      if (typeof msg?.reasoning_content === "string") pushThinking(msg.reasoning_content);
      if (typeof msg?.reasoning === "string") pushThinking(msg.reasoning);
      if (typeof msg?.content === "string") splitter.push(msg.content);
      splitter.flush();
    }
    return { text: fullText, thinking: fullThinking, usage: json?.usage || null };
  }

  const reader = res.body?.getReader?.();
  if (!reader) throw new Error("Provider returned an empty stream.");
  const decoder = new TextDecoder();
  const state = { buffer: "", event: "", data: [] };

  const handleEvent = (_event, rawData) => {
    if (!rawData || rawData === "[DONE]") return;
    let payload;
    try {
      payload = JSON.parse(rawData);
    } catch {
      return;
    }
    if (isAnthropic) {
      if (payload.type === "content_block_delta") {
        if (payload.delta?.type === "text_delta" && payload.delta.text) pushText(payload.delta.text);
        if (payload.delta?.type === "thinking_delta" && payload.delta.thinking) pushThinking(payload.delta.thinking);
      } else if (payload.type === "error") {
        throw new Error(payload.error?.message || "Anthropic stream error.");
      } else if (payload.usage) {
        usage = payload.usage;
      }
      return;
    }
    if (payload.error) {
      throw new Error(payload.error?.message || String(payload.error));
    }
    const choice = payload.choices?.[0];
    const delta = choice?.delta;
    if (delta) {
      if (typeof delta.reasoning_content === "string" && delta.reasoning_content)
        pushThinking(delta.reasoning_content);
      else if (typeof delta.reasoning === "string" && delta.reasoning)
        pushThinking(delta.reasoning);
      if (typeof delta.content === "string" && delta.content) splitter.push(delta.content);
    }
    if (payload.usage) usage = payload.usage;
  };

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      parseSseLines(decoder.decode(value, { stream: true }), state, handleEvent);
    }
    parseSseLines(decoder.decode() + "\n\n", state, handleEvent);
    splitter.flush();
  } finally {
    reader.releaseLock?.();
  }

  return { text: fullText, thinking: fullThinking, usage };
}
