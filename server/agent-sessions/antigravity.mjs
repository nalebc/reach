import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

// Antigravity local conversation reader & live CLI runner:
// Scans Antigravity CLI and IDE brain directories (~/.gemini/antigravity-cli/brain
// and ~/.gemini/antigravity/brain) AND drives live interactive turns + new Gemini /
// Antigravity conversations via the local `agy` CLI (`--output-format stream-json`).

const execFileAsync = promisify(execFile);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const FALLBACK_MODELS = [
  { id: "gemini-4-neon-high", name: "Gemini 4 Neon (High)", isDefault: true },
  { id: "gemini-4-neon-medium", name: "Gemini 4 Neon (Medium)", isDefault: false },
  { id: "gemini-4-carbon-high", name: "Gemini 4 Carbon (High)", isDefault: false },
  { id: "gemini-4-carbon-medium", name: "Gemini 4 Carbon (Medium)", isDefault: false },
  { id: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)", isDefault: false },
];
const AGY_MODES = [
  { id: "auto", label: "Auto" },
  { id: "accept-edits", label: "Accept edits" },
  { id: "plan", label: "Plan" },
];

function cleanUserContent(raw) {
  const text = String(raw || "");
  const match = /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/i.exec(text);
  const body = match ? match[1] : text;
  const cleaned = body
    .replace(/<CONTEXT_SUMMARY>[\s\S]*?<\/CONTEXT_SUMMARY>/gi, "")
    .replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/gi, "")
    .replace(/<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/gi, "")
    .trim();
  const handoffMarker = "\n---\nNew user message:\n";
  const idx = cleaned.indexOf(handoffMarker);
  if (idx >= 0 && cleaned.startsWith("Context from earlier ")) {
    return cleaned.slice(idx + handoffMarker.length).trim();
  }
  return cleaned;
}

function titleFromText(text) {
  const line = String(text || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!line) return "Antigravity conversation";
  return line.length > 72 ? `${line.slice(0, 71)}…` : line;
}

function readOpenedTranscript(file) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) return null;
    const content = fs.readFileSync(fd, "utf8");
    return { stat, content };
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

export function parseAntigravityTranscript(source) {
  const items = [];
  let model = null;
  let createdAt = 0;
  let updatedAt = 0;
  let firstUser = "";

  for (const line of String(source || "").split("\n")) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!entry || typeof entry !== "object") continue;
    const at = entry.created_at ? Date.parse(entry.created_at) : 0;
    if (Number.isFinite(at) && at > 0) {
      if (!createdAt || at < createdAt) createdAt = at;
      if (at > updatedAt) updatedAt = at;
    }
    if (typeof entry.model === "string" && entry.model) model = entry.model;

    if (entry.type === "USER_INPUT" && entry.source === "USER_EXPLICIT") {
      const text = cleanUserContent(entry.content);
      if (!text) continue;
      if (!firstUser) firstUser = text;
      items.push({
        id: `ag-u-${entry.step_index ?? items.length}`,
        role: "user",
        kind: "text",
        text,
        ...(at ? { at } : {}),
      });
    } else if (entry.type === "PLANNER_RESPONSE") {
      if (typeof entry.thinking === "string" && entry.thinking.trim()) {
        items.push({
          id: `ag-t-${entry.step_index ?? items.length}`,
          role: "assistant",
          kind: "thinking",
          text: entry.thinking.trim().slice(0, 4000),
          status: "done",
          ...(at ? { at } : {}),
        });
      }
      if (typeof entry.content === "string" && entry.content.trim()) {
        items.push({
          id: `ag-a-${entry.step_index ?? items.length}`,
          role: "assistant",
          kind: "text",
          text: entry.content.trim(),
          status: "done",
          ...(entry.model ? { detail: entry.model } : {}),
          ...(at ? { at } : {}),
        });
      }
    }
  }

  return { items, model, createdAt, updatedAt, firstUser };
}

function isExecutable(file) {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

export function createAntigravitySessions({
  home = os.homedir(),
  roots,
  agyBin,
  spawnImpl = spawn,
  execFileImpl = execFileAsync,
  env = process.env,
} = {}) {
  const dirs = roots || [
    path.join(home, ".gemini", "antigravity-cli", "brain"),
    path.join(home, ".gemini", "antigravity", "brain"),
  ];

  let cachedCli = undefined;
  let modelsCache = { at: 0, models: null };
  const activeRuns = new Map(); // id -> { status, streaming, thinking, error, userText, userAt, startedAt, updatedAt, version, child }
  const sessionMeta = new Map(); // id -> { cwd, model, effort, mode, title, createdAt }
  const subscribers = new Map(); // id -> Set<() => void>
  let versionCounter = 1000;

  const nextVersion = () => {
    versionCounter = Math.max(versionCounter + 1, Date.now());
    return versionCounter;
  };

  const notify = (id) => {
    const subs = subscribers.get(id);
    if (!subs) return;
    for (const fn of [...subs]) {
      try {
        fn();
      } catch {}
    }
  };

  const resolveCliSync = () => {
    if (agyBin !== undefined) return agyBin || null;
    if (cachedCli !== undefined) return cachedCli;
    const candidates = [
      path.join(home, ".local", "bin", "agy"),
      "/opt/homebrew/bin/agy",
      "/usr/local/bin/agy",
      ...String(env.PATH || "")
        .split(path.delimiter)
        .filter(Boolean)
        .map((dir) => path.join(dir, process.platform === "win32" ? "agy.exe" : "agy")),
    ];
    for (const file of candidates) {
      if (isExecutable(file)) {
        cachedCli = file;
        return file;
      }
    }
    return null;
  };

  const resolveCli = async () => {
    const sync = resolveCliSync();
    if (sync || agyBin !== undefined) return sync;
    if (process.platform !== "win32") {
      try {
        const { stdout } = await execFileImpl(env.SHELL || "/bin/zsh", ["-lc", "command -v agy"], { timeout: 5000 });
        const found = String(stdout || "").trim().split("\n").pop() || "";
        if (found.startsWith("/") && isExecutable(found)) {
          cachedCli = found;
          return found;
        }
      } catch {}
    }
    cachedCli = null;
    return null;
  };

  const candidateTranscripts = () => {
    const found = new Map();
    for (const root of dirs) {
      let names = [];
      try {
        names = fs.readdirSync(root);
      } catch {
        continue;
      }
      for (const entry of names) {
        if (!UUID_RE.test(entry)) continue;
        const file = path.join(root, entry, ".system_generated", "logs", "transcript.jsonl");
        if (!found.has(entry)) found.set(entry, []);
        found.get(entry).push(file);
      }
    }
    return found;
  };

  const openTranscriptById = (id) => {
    const files = candidateTranscripts().get(id) || [];
    for (const file of files) {
      const opened = readOpenedTranscript(file);
      if (opened) return opened;
    }
    return null;
  };

  const mergedItemsFor = (id, diskItems) => {
    const meta = sessionMeta.get(id);
    const items = [...(meta?.priorItems || []), ...diskItems];
    const run = activeRuns.get(id);
    if (!run) return items;
    const shownUser = run.displayUserText || run.userText;
    if (shownUser) {
      const lastUser = [...items].reverse().find((i) => i.role === "user" && i.kind === "text");
      if (!lastUser || lastUser.text.trim() !== shownUser.trim()) {
        items.push({
          id: `ag-live-u-${run.startedAt}`,
          role: "user",
          kind: "text",
          text: shownUser,
          at: run.userAt,
        });
      }
    }
    if (run.status === "running") {
      if (run.thinking) {
        items.push({
          id: `ag-live-t-${run.startedAt}`,
          role: "assistant",
          kind: "thinking",
          text: run.thinking,
          status: "running",
          at: run.updatedAt,
        });
      }
      if (run.streaming) {
        items.push({
          id: `ag-live-a-${run.startedAt}`,
          role: "assistant",
          kind: "text",
          text: run.streaming,
          status: "running",
          at: run.updatedAt,
        });
      }
    } else if (run.error) {
      const lastAssistant = [...items].reverse().find((i) => i.role === "assistant" && i.kind === "text");
      if (!lastAssistant || (lastAssistant.at && lastAssistant.at < run.startedAt)) {
        items.push({
          id: `ag-err-${run.startedAt}`,
          role: "system",
          kind: "error",
          text: run.error,
          at: run.updatedAt,
        });
      }
    } else if (run.finalReply) {
      const lastAssistant = [...items].reverse().find((i) => i.role === "assistant" && i.kind === "text");
      if (!lastAssistant || lastAssistant.text.trim() !== run.finalReply.trim()) {
        items.push({
          id: `ag-done-a-${run.startedAt}`,
          role: "assistant",
          kind: "text",
          text: run.finalReply,
          status: "done",
          at: run.updatedAt,
        });
      }
    }
    return items;
  };

  const sessionObject = (id, { parsed, stat } = {}) => {
    const meta = sessionMeta.get(id) || {};
    const run = activeRuns.get(id);
    const items = mergedItemsFor(id, parsed?.items || []);
    const lastText = [...items].reverse().find((i) => i.kind === "text" && i.text)?.text || "";
    const updatedAt = Math.max(parsed?.updatedAt || 0, stat?.mtimeMs || 0, run?.updatedAt || 0, meta.createdAt || 0);
    const createdAt = parsed?.createdAt || stat?.birthtimeMs || meta.createdAt || updatedAt || Date.now();
    const isRunning = run ? run.status === "running" : stat ? Date.now() - stat.mtimeMs < 15000 : false;
    return {
      session: {
        agent: "antigravity",
        id,
        title: meta.title || titleFromText(parsed?.firstUser || run?.userText || ""),
        cwd: meta.cwd || "",
        branch: "",
        origin: meta.origin || "app",
        inApp: true,
        updatedAt,
        createdAt,
        rev: run?.version || Math.max(1, Math.floor(updatedAt || 1)),
        status: isRunning ? "running" : "idle",
        preview: lastText.replace(/\s+/g, " ").trim().slice(0, 140),
        archived: Boolean(meta.archived),
        model: meta.model || parsed?.model || null,
        effort: meta.effort || null,
        mode: meta.mode || null,
        providerName: "Antigravity",
      },
      items,
    };
  };

  const buildPrompt = (text, { files = [], images = [] } = {}) => {
    const clean = String(text || "").trim();
    const attachments = [...images, ...files].filter(Boolean);
    if (!attachments.length) return clean;
    return [clean, attachments.map((p) => `@${p}`).join("\n")].filter(Boolean).join("\n\n");
  };

  const spawnTurn = async ({ conversationId = null, prompt, displayUserText, priorItems, cwd, model, effort, mode }) => {
    const cli = await resolveCli();
    if (!cli) {
      throw Object.assign(new Error("Antigravity CLI (agy) isn't installed on this computer."), { status: 503 });
    }
    if (!prompt) {
      throw Object.assign(new Error("Write a message first."), { status: 400 });
    }
    if (conversationId && activeRuns.get(conversationId)?.status === "running") {
      throw Object.assign(new Error("Antigravity is still answering. Wait a moment or tap Stop first."), { status: 409 });
    }

    const args = [];
    if (conversationId) args.push("--conversation", conversationId);
    args.push("-p", prompt, "--output-format", "stream-json", "--dangerously-skip-permissions");
    if (model) args.push("--model", model);
    if (effort && EFFORTS.includes(effort)) args.push("--effort", effort);
    if (mode && ["auto", "accept-edits", "plan"].includes(mode)) args.push("--mode", mode);

    const workDir = cwd && fs.existsSync(cwd) ? cwd : home;
    const childEnv = {
      ...env,
      PATH: [path.dirname(cli), path.join(home, ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin", env.PATH]
        .filter(Boolean)
        .join(path.delimiter),
    };

    const startedAt = Date.now();
    const run = {
      status: "running",
      streaming: "",
      thinking: "",
      finalReply: "",
      error: null,
      userText: prompt,
      displayUserText: displayUserText || prompt,
      userAt: startedAt,
      startedAt,
      updatedAt: startedAt,
      version: nextVersion(),
      child: null,
    };

    const child = spawnImpl(cli, args, {
      cwd: workDir,
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    run.child = child;

    let resolvedId = conversationId;
    if (resolvedId) {
      activeRuns.set(resolvedId, run);
      const prev = sessionMeta.get(resolvedId) || {};
      sessionMeta.set(resolvedId, {
        ...prev,
        cwd: cwd || prev.cwd || workDir,
        ...(model ? { model } : {}),
        ...(effort ? { effort } : {}),
        ...(mode ? { mode } : {}),
      });
      notify(resolvedId);
    }

    let initResolved = false;
    let resolveInit;
    let rejectInit;
    const initPromise = conversationId
      ? Promise.resolve(conversationId)
      : new Promise((resolve, reject) => {
          resolveInit = resolve;
          rejectInit = reject;
        });

    let stderrBuf = "";
    let stdoutBuf = "";

    const handleLine = (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let ev;
      try {
        ev = JSON.parse(trimmed);
      } catch {
        return;
      }
      const cid = ev?.conversation_id || ev?.step_update?.conversation_id || ev?.result?.conversation_id;
      if (cid && UUID_RE.test(cid) && !resolvedId) {
        resolvedId = cid;
        activeRuns.set(cid, run);
        sessionMeta.set(cid, {
          cwd: workDir,
          model: model || null,
          effort: effort || null,
          mode: mode || "auto",
          origin: "reach",
          createdAt: startedAt,
          title: titleFromText(displayUserText || prompt),
          ...(Array.isArray(priorItems) && priorItems.length ? { priorItems } : {}),
        });
        if (!initResolved) {
          initResolved = true;
          resolveInit?.(cid);
        }
      }
      if (ev?.event === "step_update" && ev.step_update) {
        const su = ev.step_update;
        if (su.step_type === "agent_response" && typeof su.text_delta === "string") {
          run.streaming += su.text_delta;
        }
        if (typeof su.thinking_delta === "string") {
          run.thinking += su.thinking_delta;
        }
        run.updatedAt = Date.now();
        run.version = nextVersion();
        if (resolvedId) notify(resolvedId);
      } else if (ev?.event === "result" && ev.result) {
        if (typeof ev.result.response === "string" && ev.result.response.trim()) {
          run.finalReply = ev.result.response.trim();
        } else if (run.streaming.trim()) {
          run.finalReply = run.streaming.trim();
        }
        if (ev.result.status && ev.result.status !== "SUCCESS" && ev.result.error) {
          run.error = String(ev.result.error);
        }
        run.status = "idle";
        run.streaming = "";
        run.updatedAt = Date.now();
        run.version = nextVersion();
        if (resolvedId) notify(resolvedId);
      } else if (ev?.event === "error" || ev?.error) {
        run.error = String(ev?.error?.message || ev?.error || "Antigravity encountered an error.");
      }
    };

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      stdoutBuf += chunk;
      let nl;
      while ((nl = stdoutBuf.indexOf("\n")) >= 0) {
        const line = stdoutBuf.slice(0, nl);
        stdoutBuf = stdoutBuf.slice(nl + 1);
        handleLine(line);
      }
    });

    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk) => {
      if (stderrBuf.length < 8192) stderrBuf += chunk;
    });

    child.on("error", (err) => {
      run.status = "idle";
      run.error = err.message || "Failed to launch Antigravity CLI.";
      run.updatedAt = Date.now();
      run.version = nextVersion();
      if (resolvedId) notify(resolvedId);
      if (!initResolved) {
        initResolved = true;
        rejectInit?.(Object.assign(new Error(run.error), { status: 502 }));
      }
    });

    child.on("close", (code) => {
      if (stdoutBuf.trim()) {
        handleLine(stdoutBuf);
        stdoutBuf = "";
      }
      if (run.status === "running") {
        if (run.streaming.trim() && !run.finalReply) run.finalReply = run.streaming.trim();
        if (code && code !== 0 && !run.finalReply && !run.error && !run.stopped) {
          run.error = stderrBuf.trim().split("\n").slice(-3).join(" ").slice(0, 400) || `Antigravity exited with code ${code}.`;
        }
        run.status = "idle";
        run.streaming = "";
      }
      run.child = null;
      run.updatedAt = Date.now();
      run.version = nextVersion();
      if (resolvedId) notify(resolvedId);
      if (!initResolved) {
        initResolved = true;
        rejectInit?.(
          Object.assign(
            new Error(run.error || stderrBuf.trim().slice(0, 300) || "Antigravity did not start a conversation."),
            { status: 502 },
          ),
        );
      }
    });

    if (!conversationId) {
      const timer = setTimeout(() => {
        if (!initResolved) {
          initResolved = true;
          rejectInit?.(Object.assign(new Error("Timed out waiting for Antigravity to start."), { status: 504 }));
        }
      }, 15000);
      timer.unref?.();
      try {
        resolvedId = await initPromise;
      } finally {
        clearTimeout(timer);
      }
    }

    return resolvedId;
  };

  return {
    hasCli() {
      return Boolean(resolveCliSync());
    },

    async models({ refresh = false } = {}) {
      if (!refresh && modelsCache.models && Date.now() - modelsCache.at < 5 * 60 * 1000) {
        return { models: modelsCache.models, modes: AGY_MODES, mode: "auto" };
      }
      const cli = await resolveCli();
      if (!cli) {
        return {
          models: FALLBACK_MODELS.map((m) => ({
            ...m,
            description: "Antigravity",
            efforts: EFFORTS,
            defaultEffort: null,
            images: true,
          })),
          modes: AGY_MODES,
          mode: "auto",
        };
      }
      try {
        const { stdout } = await execFileImpl(cli, ["models"], { timeout: 8000 });
        const parsed = [];
        for (const rawLine of String(stdout || "").split("\n")) {
          const line = rawLine.trim();
          if (!line || /^fetching\b/i.test(line)) continue;
          const parts = line.split(/\t+/);
          const id = parts[0]?.trim();
          if (!id || !/^[A-Za-z0-9._:-]{2,64}$/.test(id)) continue;
          const name = parts[1]?.trim() || id;
          parsed.push({
            id,
            name,
            description: "Antigravity",
            efforts: EFFORTS,
            defaultEffort: null,
            images: true,
            isDefault: parsed.length === 0,
          });
        }
        if (parsed.length > 0) {
          modelsCache = { at: Date.now(), models: parsed };
          return { models: parsed, modes: AGY_MODES, mode: "auto" };
        }
      } catch {}
      return {
        models: FALLBACK_MODELS.map((m) => ({
          ...m,
          description: "Antigravity",
          efforts: EFFORTS,
          defaultEffort: null,
          images: true,
        })),
        modes: AGY_MODES,
        mode: "auto",
      };
    },

    list() {
      const seen = new Set();
      const out = [];
      for (const [id, files] of candidateTranscripts()) {
        let opened = null;
        for (const file of files) {
          opened = readOpenedTranscript(file);
          if (opened) break;
        }
        if (!opened) continue;
        const { stat, content } = opened;
        const parsed = parseAntigravityTranscript(content);
        if (!parsed.items.length && !activeRuns.has(id)) continue;
        seen.add(id);
        out.push(sessionObject(id, { parsed, stat }).session);
      }
      for (const id of new Set([...activeRuns.keys(), ...sessionMeta.keys()])) {
        if (seen.has(id)) continue;
        out.push(sessionObject(id).session);
      }
      return out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    },

    read(id, { limit = 200, before } = {}) {
      const cleanId = String(id || "");
      if (!UUID_RE.test(cleanId))
        throw Object.assign(new Error("Invalid Antigravity conversation ID."), { status: 400 });
      const opened = openTranscriptById(cleanId);
      if (!opened && !activeRuns.has(cleanId) && !sessionMeta.has(cleanId)) {
        throw Object.assign(new Error("Antigravity conversation not found."), { status: 404 });
      }
      const parsed = opened ? parseAntigravityTranscript(opened.content) : { items: [], model: null, createdAt: 0, updatedAt: 0, firstUser: "" };
      const { session, items: allItems } = sessionObject(cleanId, { parsed, stat: opened?.stat });
      const max = Math.min(Math.max(Number(limit) || 200, 1), 500);
      const end = before != null ? Math.min(Math.max(Number(before) || 0, 0), allItems.length) : allItems.length;
      const start = Math.max(0, end - max);
      return {
        session,
        items: allItems.slice(start, end),
        before: start > 0 ? String(start) : null,
      };
    },

    async start({ text, displayUserText, priorItems, cwd, model, effort, mode, images = [], files = [], title } = {}) {
      const prompt = buildPrompt(text, { images, files });
      const convId = await spawnTurn({ prompt, displayUserText, priorItems, cwd, model, effort, mode });
      if (title) {
        const prev = sessionMeta.get(convId) || {};
        sessionMeta.set(convId, { ...prev, title: String(title).slice(0, 120) });
      }
      const { session } = sessionObject(convId);
      return { threadId: convId, turnId: null, session };
    },

    async send(id, { text, model, effort, mode, images = [], files = [] } = {}) {
      const cleanId = String(id || "");
      if (!UUID_RE.test(cleanId))
        throw Object.assign(new Error("Invalid Antigravity conversation ID."), { status: 400 });
      const prompt = buildPrompt(text, { images, files });
      await spawnTurn({
        conversationId: cleanId,
        prompt,
        cwd: sessionMeta.get(cleanId)?.cwd,
        model: model || sessionMeta.get(cleanId)?.model,
        effort: effort || sessionMeta.get(cleanId)?.effort,
        mode: mode || sessionMeta.get(cleanId)?.mode,
      });
      return { delivered: true };
    },

    stop(id) {
      const run = activeRuns.get(String(id || ""));
      if (run && run.status === "running") {
        run.stopped = true;
        if (run.streaming.trim() && !run.finalReply) run.finalReply = run.streaming.trim();
        run.status = "idle";
        run.streaming = "";
        try {
          run.child?.kill("SIGTERM");
        } catch {}
        run.updatedAt = Date.now();
        run.version = nextVersion();
        notify(String(id));
        return { stopped: true };
      }
      return { stopped: false };
    },

    setModel(id, { model, effort } = {}) {
      const cleanId = String(id || "");
      if (!UUID_RE.test(cleanId))
        throw Object.assign(new Error("Invalid Antigravity conversation ID."), { status: 400 });
      const prev = sessionMeta.get(cleanId) || {};
      sessionMeta.set(cleanId, {
        ...prev,
        ...(model !== undefined ? { model } : {}),
        ...(effort !== undefined ? { effort } : {}),
      });
      notify(cleanId);
      return { applied: true, model: model ?? prev.model ?? null, effort: effort ?? prev.effort ?? null };
    },

    setMode(id, { mode } = {}) {
      const cleanId = String(id || "");
      if (!UUID_RE.test(cleanId))
        throw Object.assign(new Error("Invalid Antigravity conversation ID."), { status: 400 });
      const prev = sessionMeta.get(cleanId) || {};
      sessionMeta.set(cleanId, { ...prev, mode: mode || "auto" });
      notify(cleanId);
      return { applied: true, mode: mode || "auto" };
    },

    rename(id, title) {
      const cleanId = String(id || "");
      const prev = sessionMeta.get(cleanId) || {};
      sessionMeta.set(cleanId, { ...prev, title: String(title || "").trim().slice(0, 120) });
      notify(cleanId);
      return { title: sessionMeta.get(cleanId).title };
    },

    archive(id, archived = true) {
      const cleanId = String(id || "");
      const prev = sessionMeta.get(cleanId) || {};
      sessionMeta.set(cleanId, { ...prev, archived: Boolean(archived) });
      notify(cleanId);
      return { archived: Boolean(archived) };
    },

    subscribe(id, listener) {
      const cleanId = String(id || "");
      let set = subscribers.get(cleanId);
      if (!set) {
        set = new Set();
        subscribers.set(cleanId, set);
      }
      set.add(listener);
      return () => {
        set.delete(listener);
        if (set.size === 0) subscribers.delete(cleanId);
      };
    },
  };
}
