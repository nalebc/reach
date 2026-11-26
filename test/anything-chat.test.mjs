import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createChatProviders, maskSecret } from "../server/chat-providers/registry.mjs";
import { createThinkSplitter, streamChatCompletion } from "../server/chat-providers/stream.mjs";
import { createApiChats } from "../server/chat-providers/sessions.mjs";

function sseResponse(chunks) {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

test("maskSecret hides API keys and registry stores secrets with 0600 permissions without returning plaintext", async () => {
  assert.equal(maskSecret("sk-test-1234567890abcd"), "sk-…abcd");
  assert.equal(maskSecret("short"), "••••");
  assert.equal(maskSecret(""), "");

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-chat-providers-"));
  try {
    const fetchImpl = async (url) => {
      if (String(url).includes("11434/api/tags")) {
        return new Response(
          JSON.stringify({ models: [{ name: "llama3.2:latest", size: 2_000_000_000 }] }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (String(url).includes("api.venice.ai/api/v1/models")) {
        return new Response(
          JSON.stringify({ data: [{ id: "llama-3.3-70b" }, { id: "deepseek-r1-671b" }] }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("not found", { status: 404 });
    };

    const registry = createChatProviders({ dataDir, env: {}, fetchImpl });
    const saved = registry.upsert({
      preset: "venice",
      apiKey: "venice-secret-key-9999",
    });
    assert.equal(saved.id, "venice");
    assert.equal(saved.hasKey, true);
    assert.equal(saved.keyHint, "ven…9999");
    assert.equal("apiKey" in saved, false, "public view never exposes raw API key");

    const list = await registry.list({ discover: true, refresh: true });
    const venice = list.find((p) => p.id === "venice");
    const ollama = list.find((p) => p.id === "ollama");
    assert.ok(venice?.configured && venice.modelCount === 2);
    assert.ok(ollama?.reachable && ollama.models[0].id === "llama3.2:latest", "local Ollama auto-detected");

    const stat = fs.statSync(path.join(dataDir, "chat-providers.json"));
    if (process.platform !== "win32") {
      assert.equal(stat.mode & 0o777, 0o600, "provider secrets file is 0600");
    }
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("createThinkSplitter splits reasoning blocks across chunk boundaries", () => {
  let text = "";
  let thinking = "";
  const splitter = createThinkSplitter(
    (t) => (text += t),
    (t) => (thinking += t),
  );
  for (const chunk of ["<thi", "nk>step 1 ", "step 2</th", "ink>Final ", "answer!"]) {
    splitter.push(chunk);
  }
  splitter.flush();
  assert.equal(thinking, "step 1 step 2");
  assert.equal(text, "Final answer!");
});

test("streamChatCompletion streams Venice OpenAI-compatible SSE with venice_parameters and Anthropic SSE", async () => {
  let veniceBody = null;
  const veniceRes = await streamChatCompletion({
    provider: {
      id: "venice",
      preset: "venice",
      protocol: "openai",
      baseUrl: "https://api.venice.ai/api/v1",
      apiKey: "test-key",
    },
    model: "deepseek-r1-671b",
    messages: [{ role: "user", text: "Hello" }],
    veniceWebSearch: true,
    fetchImpl: async (_url, init) => {
      veniceBody = JSON.parse(init.body);
      return sseResponse([
        'data: {"choices":[{"delta":{"reasoning_content":"pondering"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"Hi "}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"there!"}}]}\n\n',
        "data: [DONE]\n\n",
      ]);
    },
  });
  assert.equal(veniceBody.venice_parameters.enable_web_search, "auto");
  assert.equal(veniceRes.thinking, "pondering");
  assert.equal(veniceRes.text, "Hi there!");

  const anthropicRes = await streamChatCompletion({
    provider: {
      id: "anthropic",
      preset: "anthropic",
      protocol: "anthropic",
      baseUrl: "https://api.anthropic.com/v1",
      apiKey: "test-key",
    },
    model: "claude-sonnet-4-5",
    messages: [{ role: "user", text: "Hi" }],
    fetchImpl: async () =>
      sseResponse([
        'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"plan"}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello from Claude API"}}\n\n',
      ]),
  });
  assert.equal(anthropicRes.thinking, "plan");
  assert.equal(anthropicRes.text, "Hello from Claude API");
});

test("createApiChats persists sessions, streams replies, and supports mid-chat switching between Venice and vLLM", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-anything-chats-"));
  try {
    const calledUrls = [];
    const fetchImpl = async (url, init) => {
      calledUrls.push(String(url));
      const body = init?.body ? JSON.parse(init.body) : {};
      return sseResponse([
        `data: {"choices":[{"delta":{"content":"Reply from ${body.model}"}}]}\n\n`,
        "data: [DONE]\n\n",
      ]);
    };
    const providers = createChatProviders({ dataDir, env: {}, fetchImpl });
    providers.upsert({ preset: "venice", apiKey: "v-key" });
    providers.upsert({ preset: "vllm", baseUrl: "http://127.0.0.1:8000/v1" });

    const chats = createApiChats({ dataDir, providers, fetchImpl });
    const started = chats.start({
      providerId: "venice",
      model: "llama-3.3-70b",
      text: "Explain tailnets briefly",
    });
    assert.equal(started.session.agent, "api");
    assert.equal(started.session.providerId, "venice");

    // Wait for background stream to finish
    await new Promise((r) => setTimeout(r, 60));
    let page = chats.read(started.session.id);
    assert.equal(page.session.status, "idle");
    assert.equal(page.items.at(-1).text, "Reply from llama-3.3-70b");

    // Switch mid-chat to local vLLM
    chats.send(started.session.id, {
      providerId: "vllm",
      model: "qwen2.5-coder-32b",
      text: "Now write a shell snippet",
    });
    await new Promise((r) => setTimeout(r, 60));
    page = chats.read(started.session.id);
    assert.equal(page.session.providerId, "vllm");
    assert.equal(page.session.providerKind, "local");
    assert.equal(page.items.at(-1).text, "Reply from qwen2.5-coder-32b");
    assert.ok(calledUrls[0].includes("api.venice.ai"));
    assert.ok(calledUrls[1].includes("127.0.0.1:8000/v1"));

    chats.rename(started.session.id, "Tailnet notes");
    assert.equal(chats.list()[0].title, "Tailnet notes");
    chats.remove(started.session.id);
    assert.equal(chats.list().length, 0);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
