import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createChatProviders, maskSecret } from "../server/chat-providers/registry.mjs";
import { createThinkSplitter, streamChatCompletion } from "../server/chat-providers/stream.mjs";
import { createApiChats } from "../server/chat-providers/sessions.mjs";
import { createAntigravitySessions, parseAntigravityTranscript } from "../server/agent-sessions/antigravity.mjs";

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

    // Cross-provider handoff: import a Codex/Claude conversation into Venice and continue.
    const handedOff = chats.importHistory({
      title: "Handoff from Claude",
      fromAgent: "claude",
      fromId: "claude-session-1",
      items: [
        { role: "user", kind: "text", text: "Draft a release checklist" },
        { role: "assistant", kind: "text", text: "1. Build\n2. Test" },
      ],
      providerId: "venice",
      model: "llama-3.3-70b",
      resume: true,
    });
    assert.equal(handedOff.agent, "api");
    await new Promise((r) => setTimeout(r, 60));
    const handoffPage = chats.read(handedOff.id);
    assert.equal(handoffPage.items.length, 4);
    assert.equal(handoffPage.items.at(-1).text, "Reply from llama-3.3-70b");
    chats.remove(handedOff.id);

    chats.remove(started.session.id);
    assert.equal(chats.list().length, 0);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("createAntigravitySessions reads Antigravity brain transcripts into unified Reach sessions", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "reach-ag-brain-"));
  try {
    const id = "11111111-2222-3333-4444-555555555555";
    const logDir = path.join(root, id, ".system_generated", "logs");
    fs.mkdirSync(logDir, { recursive: true });
    const lines = [
      JSON.stringify({
        step_index: 0,
        source: "USER_EXPLICIT",
        type: "USER_INPUT",
        created_at: "2026-11-26T10:00:00Z",
        content: "<USER_REQUEST>\nHelp me redesign Anything Chat\n</USER_REQUEST>",
      }),
      JSON.stringify({
        step_index: 1,
        source: "MODEL",
        type: "PLANNER_RESPONSE",
        created_at: "2026-11-26T10:00:05Z",
        model: "gemini-4-neon-medium",
        thinking: "Checking chat providers",
        content: "Here is the unified Anything Chat redesign.",
      }),
    ].join("\n");
    fs.writeFileSync(path.join(logDir, "transcript.jsonl"), lines, "utf8");

    const parsed = parseAntigravityTranscript(lines);
    assert.equal(parsed.items.length, 3);
    assert.equal(parsed.items[0].text, "Help me redesign Anything Chat");

    const ag = createAntigravitySessions({ roots: [root] });
    const listed = ag.list();
    assert.equal(listed.length, 1);
    assert.equal(listed[0].agent, "antigravity");
    assert.equal(listed[0].title, "Help me redesign Anything Chat");
    assert.equal(listed[0].model, "gemini-4-neon-medium");

    const page = ag.read(id);
    assert.equal(page.items.at(-1).text, "Here is the unified Anything Chat redesign.");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("autoConnectKey detects exact prefixes, probes ambiguous keys in parallel, and connects local URLs in 1 click", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-autoconnect-"));
  try {
    const fetchImpl = async (url, init) => {
      const auth = init?.headers?.Authorization || "";
      if (String(url).includes("api.deepseek.com/v1/models") && auth === "Bearer sk-ambiguous-deepseek-key") {
        return new Response(
          JSON.stringify({ data: [{ id: "deepseek-chat", name: "DeepSeek Chat" }] }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (String(url).includes("api.groq.com/openai/v1/models") && auth === "Bearer gsk_1234567890") {
        return new Response(
          JSON.stringify({ data: [{ id: "llama-3.3-70b-versatile" }] }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (String(url).includes("127.0.0.1:8000/v1/models")) {
        return new Response(
          JSON.stringify({ data: [{ id: "qwen2.5-coder-32b" }] }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
    };

    const registry = createChatProviders({ dataDir, env: {}, fetchImpl });

    // 1. Prefix-based instant detection
    const groqRes = await registry.autoConnectKey("gsk_1234567890");
    assert.equal(groqRes.provider.id, "groq");
    assert.equal(groqRes.modelCount, 1);

    // 2. Ambiguous sk-... key probed in parallel and matched to DeepSeek
    const dsRes = await registry.autoConnectKey("sk-ambiguous-deepseek-key");
    assert.equal(dsRes.provider.id, "deepseek");
    assert.equal(dsRes.models[0].id, "deepseek-chat");

    // 3. Direct local URL pasted into the same box
    const localRes = await registry.autoConnectKey("http://127.0.0.1:8000");
    assert.equal(localRes.provider.id, "vllm");
    assert.equal(localRes.models[0].id, "qwen2.5-coder-32b");
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("EverythingChat renders unified Anything Chat launchpad, opens Antigravity & API chats cleanly without crashes, and switches API models mid-chat", async () => {
  const { startDom, settle } = await import("./dom/harness.mjs");
  const peer = { id: "mac", name: "Studio", url: "https://reach.test", token: "t", platform: "darwin" };
  const agId = "22222222-3333-4444-5555-666666666666";
  const apiId = "chat-venice123";
  let setModelBody = null;

  const sessions = [
    {
      agent: "antigravity",
      id: agId,
      title: "Antigravity architecture review",
      cwd: "",
      branch: "",
      origin: "app",
      inApp: true,
      updatedAt: Date.now() - 1000,
      createdAt: Date.now() - 5000,
      status: "idle",
      preview: "Reviewed architecture",
      archived: false,
      model: "gemini-2.5-pro",
      providerName: "Antigravity",
    },
    {
      agent: "api",
      id: apiId,
      title: "Venice brainstorm",
      cwd: "",
      branch: "",
      origin: "reach",
      inApp: false,
      updatedAt: Date.now(),
      createdAt: Date.now() - 3000,
      rev: 2,
      status: "idle",
      preview: "Private inference rocks",
      archived: false,
      model: "llama-3.3-70b",
      providerId: "venice",
      providerName: "Venice",
      providerKind: "api",
    },
  ];

  const dom = await startDom({
    mobile: true,
    routes: {
      "/api/sessions/logos": () => ({ version: "1", logos: {} }),
      "/api/sessions/commands": () => ({ commands: [] }),
      "/api/sessions/stranded": () => ({ messages: [] }),
      "/api/sessions/activity": () => ({ chats: [], overlaps: [] }),
      "/api/chat/providers": () => ({
        providers: [
          {
            id: "venice",
            preset: "venice",
            name: "Venice",
            kind: "api",
            protocol: "openai",
            baseUrl: "https://api.venice.ai/api/v1",
            hasKey: true,
            keyHint: "ven…1234",
            requiresKey: true,
            fromEnv: false,
            autoDetected: false,
            configured: true,
            reachable: true,
            error: "",
            modelCount: 2,
            models: [
              { id: "llama-3.3-70b", name: "Llama 3.3 70B" },
              { id: "deepseek-r1-671b", name: "DeepSeek R1 671B" },
            ],
            defaultModel: "llama-3.3-70b",
            description: "Venice API",
          },
        ],
        presets: [],
      }),
      "/api/sessions/models": () => ({
        models: [
          {
            id: "venice::llama-3.3-70b",
            modelId: "llama-3.3-70b",
            providerId: "venice",
            providerName: "Venice",
            name: "Llama 3.3 70B",
            efforts: [],
            defaultEffort: null,
            images: true,
            isDefault: false,
          },
          {
            id: "ollama::qwen2.5-coder",
            modelId: "qwen2.5-coder",
            providerId: "ollama",
            providerName: "Ollama",
            name: "qwen2.5-coder",
            efforts: [],
            defaultEffort: null,
            images: false,
            isDefault: false,
          },
        ],
        mode: null,
      }),
      [`/api/sessions/antigravity/${agId}`]: () => ({
        version: "v1",
        session: sessions[0],
        items: [
          { id: "u1", role: "user", kind: "text", text: "Review our chat architecture" },
          { id: "a1", role: "assistant", kind: "text", text: "Everything is unified now." },
        ],
        before: null,
      }),
      [`/api/sessions/antigravity/${agId}/live`]: async () => {
        await settle(50);
        return { version: 1, running: false, streaming: "", status: "idle", items: 2, prompts: [], waiting: [] };
      },
      [`/api/sessions/api/${apiId}`]: () => ({
        version: "v2",
        session: sessions[1],
        items: [
          { id: "u2", role: "user", kind: "text", text: "Hi Venice" },
          { id: "a2", role: "assistant", kind: "text", text: "Private inference rocks" },
        ],
        before: null,
      }),
      [`/api/sessions/api/${apiId}/live`]: async () => {
        await settle(50);
        return { version: 2, running: false, streaming: "", status: "idle", items: 2, prompts: [], waiting: [] };
      },
      [`/api/sessions/api/${apiId}/model`]: (init) => {
        setModelBody = JSON.parse(init.body);
        return {
          applied: true,
          model: "qwen2.5-coder",
          providerId: "ollama",
          providerName: "Ollama",
          session: { ...sessions[1], providerId: "ollama", providerName: "Ollama", model: "qwen2.5-coder" },
        };
      },
    },
  });

  dom.window.HTMLDialogElement.prototype.showModal ??= function () { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close ??= function () { this.open = false; };

  let view;
  try {
    dom.window.localStorage.removeItem("reach.chatAgent");
    const { default: EverythingChat } = await dom.load("/src/EverythingChat.tsx");
    const feed = {
      sessions,
      errors: {},
      health: [
        { agent: "codex", name: "Codex", installed: true, signedIn: true, supported: true },
        { agent: "claude", name: "Claude Code", installed: true, signedIn: true, supported: true },
        { agent: "antigravity", name: "Antigravity", installed: true, signedIn: true, supported: false },
      ],
      healthChecked: true,
      failure: "",
      reload: async () => {},
      recheck: () => {},
    };
    view = await dom.render(dom.React.createElement(EverythingChat, { peer, feed }));

    // 1. Unified Anything Chat home shows both Antigravity & Venice cards + launchpad
    await dom.waitFor(() => dom.document.querySelector(".ac-hero"));
    assert.match(dom.document.body.textContent, /Anything Chat/);
    assert.match(dom.document.body.textContent, /Antigravity architecture review/);
    assert.match(dom.document.body.textContent, /Venice brainstorm/);

    // 2. Opening Antigravity chat renders transcript + Continue handoff bar without crashing
    const agCard = [...dom.document.querySelectorAll(".ac-chat-card")].find((b) =>
      b.textContent.includes("Antigravity architecture review"),
    );
    assert.ok(agCard, "Antigravity card visible");
    agCard.click();
    await dom.waitFor(() => dom.document.querySelector(".as-ag-handoff"));
    assert.match(dom.document.body.textContent, /Everything is unified now\./);
    assert.equal(dom.document.querySelector(".as-box"), null, "Antigravity session is read-only with handoff bar");

    // Go back to Anything Chat list
    dom.document.querySelector('[aria-label="Back to previous view"]').click();
    await dom.waitFor(() => dom.document.querySelector(".ac-hero"));

    // 3. Opening API (Venice) chat shows composer + mid-chat model/provider switcher
    const apiCard = [...dom.document.querySelectorAll(".ac-chat-card")].find((b) =>
      b.textContent.includes("Venice brainstorm"),
    );
    assert.ok(apiCard, "Venice card visible");
    apiCard.click();
    await dom.waitFor(() => dom.document.querySelector(".as-model"));
    assert.match(dom.document.querySelector(".as-model").textContent, /Venice · Llama 3\.3 70B/);

    // Switch mid-chat from Venice to Ollama!
    dom.document.querySelector(".as-model").click();
    const ollamaOpt = await dom.waitFor(() =>
      [...dom.document.querySelectorAll(".as-api-model-row")].find((b) => b.textContent.includes("qwen2.5-coder")),
    );
    ollamaOpt.click();
    await dom.waitFor(() => /Ollama · qwen2\.5-coder/.test(dom.document.querySelector(".as-model")?.textContent || ""));
    assert.deepEqual(setModelBody, { model: "ollama::qwen2.5-coder" });
    assert.deepEqual(dom.errors, []);
  } finally {
    await view?.unmount();
    await dom.close();
  }
});

test("createAntigravitySessions drives live agy turns, streams deltas, and Gemini/Antigravity chats reply interactively", async () => {
  const { EventEmitter } = await import("node:events");
  const { PassThrough } = await import("node:stream");
  const { startDom, typeInto } = await import("./dom/harness.mjs");

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "reach-ag-live-"));
  const spawned = [];
  const fakeSpawn = (cli, args, opts) => {
    spawned.push({ cli, args, cwd: opts.cwd });
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {};
    const convIdx = args.indexOf("--conversation");
    const convId = convIdx >= 0 ? args[convIdx + 1] : "33333333-4444-5555-6666-777777777777";
    queueMicrotask(() => {
      child.stdout.write(JSON.stringify({ event: "init", conversation_id: convId, init: { cwd: opts.cwd } }) + "\n");
      child.stdout.write(
        JSON.stringify({
          event: "step_update",
          step_update: { conversation_id: convId, step_index: 1, state: "ACTIVE", step_type: "agent_response", text_delta: "Live Gemini " },
        }) + "\n",
      );
      setTimeout(() => {
        child.stdout.write(
          JSON.stringify({
            event: "step_update",
            step_update: { conversation_id: convId, step_index: 1, state: "DONE", step_type: "agent_response", text_delta: "answer!" },
          }) + "\n",
        );
        child.stdout.write(
          JSON.stringify({
            event: "result",
            result: { conversation_id: convId, status: "SUCCESS", response: "Live Gemini answer!" },
          }) + "\n",
        );
        child.emit("close", 0);
      }, 15);
    });
    return child;
  };

  try {
    const ag = createAntigravitySessions({
      roots: [root],
      agyBin: "/usr/local/bin/agy",
      spawnImpl: fakeSpawn,
      execFileImpl: async () => ({ stdout: "gemini-4-neon-high\tGemini 4 Neon (High)\ngemini-3.8-flash-high\tGemini 3.8 Flash (High)\n" }),
    });

    assert.equal(ag.hasCli(), true);
    const catalog = await ag.models();
    assert.equal(catalog.models[0].id, "gemini-4-neon-high");

    const started = await ag.start({ text: "Hello Gemini", cwd: root, model: "gemini-4-neon-high" });
    assert.equal(started.threadId, "33333333-4444-5555-6666-777777777777");
    await new Promise((r) => setTimeout(r, 40));
    const page = ag.read(started.threadId);
    assert.equal(page.session.status, "idle");
    assert.equal(page.items.at(-1).text, "Live Gemini answer!");

    await ag.send(started.threadId, { text: "Follow up question" });
    assert.ok(spawned[1].args.includes("--conversation"));
    await new Promise((r) => setTimeout(r, 40));

    // Verify UI composer is active for both Antigravity (canReply: true) and Gemini CLI (continuing into Antigravity)
    const peer = { id: "mac", name: "Studio", url: "https://reach.test", token: "t", platform: "darwin" };
    const gemId = "44444444-5555-6666-7777-888888888888";
    const movedAgId = "55555555-6666-7777-8888-999999999999";
    let movedBody = null;
    const dom = await startDom({
      mobile: true,
      routes: {
        "/api/sessions/logos": () => ({ version: "1", logos: {} }),
        "/api/sessions/commands": () => ({ commands: [] }),
        "/api/sessions/stranded": () => ({ messages: [] }),
        "/api/sessions/activity": () => ({ chats: [], overlaps: [] }),
        "/api/chat/providers": () => ({ providers: [], presets: [] }),
        "/api/sessions/models": () => catalog,
        [`/api/sessions/gemini/${gemId}`]: () => ({
          version: "g1",
          session: { agent: "gemini", id: gemId, title: "Gemini CLI thread", cwd: "/work", origin: "cli", inApp: false, updatedAt: Date.now(), createdAt: Date.now(), status: "idle", archived: false },
          items: [{ id: "u1", role: "user", kind: "text", text: "Initial Gemini prompt" }],
          before: null,
        }),
        [`/api/sessions/gemini/${gemId}/live`]: async () => {
          await new Promise((r) => setTimeout(r, 30));
          return { version: 1, running: false, streaming: "", status: "idle", items: 1, prompts: [], waiting: [] };
        },
        [`/api/sessions/gemini/${gemId}/move`]: (init) => {
          movedBody = JSON.parse(init.body);
          return { agent: "antigravity", id: movedAgId, resumed: true };
        },
        [`/api/sessions/antigravity/${movedAgId}`]: () => ({
          version: "a1",
          session: { agent: "antigravity", id: movedAgId, title: "Gemini CLI thread", cwd: "/work", origin: "reach", inApp: true, updatedAt: Date.now(), createdAt: Date.now(), status: "idle", archived: false, model: "gemini-4-neon-high", providerName: "Antigravity" },
          items: [
            { id: "u1", role: "user", kind: "text", text: "Answer right here" },
            { id: "a1", role: "assistant", kind: "text", text: "Answered via Antigravity!" },
          ],
          before: null,
        }),
        [`/api/sessions/antigravity/${movedAgId}/live`]: async () => {
          await new Promise((r) => setTimeout(r, 30));
          return { version: 2, running: false, streaming: "", status: "idle", items: 2, prompts: [], waiting: [] };
        },
      },
    });
    let view;
    try {
      dom.window.localStorage.setItem("reach.chatAgent", "all");
      const { default: EverythingChat } = await dom.load("/src/EverythingChat.tsx");
      const feed = {
        sessions: [
          { agent: "gemini", id: gemId, title: "Gemini CLI thread", cwd: "/work", origin: "cli", inApp: false, updatedAt: Date.now(), createdAt: Date.now(), status: "idle", preview: "Initial Gemini prompt", archived: false },
        ],
        errors: {},
        health: [
          { agent: "gemini", name: "Gemini CLI", installed: true, signedIn: true, supported: true },
          { agent: "antigravity", name: "Antigravity", installed: true, signedIn: true, usable: true, supported: true, canReply: true },
        ],
        healthChecked: true,
        failure: "",
        reload: async () => {},
        recheck: () => {},
      };
      view = await dom.render(dom.React.createElement(EverythingChat, { peer, feed }));
      const gemCard = await dom.waitFor(() =>
        [...dom.document.querySelectorAll(".ac-chat-card, .chat-card")].find((el) => el.textContent.includes("Gemini CLI thread")),
      );
      gemCard.click();
      const input = await dom.waitFor(() => dom.document.querySelector('textarea[aria-label="Message"]'));
      await typeInto(input, "Answer right here");
      const sendBtn = await dom.waitFor(() => dom.document.querySelector('[aria-label="Send"]:not(:disabled)'));
      sendBtn.click();
      await dom.waitFor(() => movedBody !== null);
      assert.equal(movedBody.to, "antigravity");
      assert.equal(movedBody.text, "Answer right here");
      await dom.waitFor(() => /Answered via Antigravity!/.test(dom.document.body.textContent));
      assert.ok(dom.document.querySelector('textarea[aria-label="Message"]'), "Antigravity composer stays open for further replies");
    } finally {
      await view?.unmount();
      await dom.close();
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
