import crypto from "node:crypto";
import { fail, isPlainRecord } from "./core.mjs";

export const sourceName = (source) =>
  ({
    codex: "Codex",
    claude: "Claude Code",
    gemini: "Gemini CLI",
    openclaw: "OpenClaw",
    mac: "Your computer",
    update: "Reach",
    browser: "Agent",
    admission: "Agent",
    access: "Agent",
  })[source] || "Agent";
const clean = (value, limit = 240) =>
  String(value || "")
    .replace(
      /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200e\u200f\u2028-\u202e\u2066-\u2069]/gu,
      "",
    )
    .slice(0, limit);
export const sourceIcon = (source) =>
  source === "update" ? "mac"
    : ["codex", "claude", "gemini", "openclaw", "mac"].includes(source)
      ? source
      : "agent";
const hash = (value) =>
  crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const targetUrl = (target) => {
  const params = new URLSearchParams();
  for (const key of ["page", "agent", "id", "threadId", "needs", "prompt"])
    if (typeof target?.[key] === "string") params.set(key, target[key]);
  return `/?${params}`;
};
export function sealNotification(item, binding) {
  return {
    ...item,
    revision: hash([
      item.id,
      item.title,
      item.detail,
      item.prompt,
      item.actions,
      binding,
    ]),
    _binding: binding,
  };
}
export function publicNotification({ _binding, signature, push, bell, category, ...item }) {
  return item;
}
export function chatNotifications(session) {
  const source = session.agent;
  const base = {
    source,
    sender: sourceName(source),
    icon: sourceIcon(source),
    detail: clean(session.title || "Conversation"),
    chatTitle: clean(session.title, 200),
    target: { page: "sessions", agent: source, id: session.id },
    createdAt: session.updatedAt || session.createdAt,
  };
  if (!session.prompts?.length) {
    const consent = session.consent;
    // What it waits on in its own app or terminal, for the phone's text;
    // only text with nothing hidden in it.
    const asking = session.asking;
    const plain = (text) =>
      typeof text === "string" && text.length <= 4000 && clean(text, 4001) === text
        ? text
        : "";
    const waiting = consent
      ? undefined
      : {
          kind: asking?.kind || "",
          text:
            asking?.kind === "question"
              ? plain(asking.questions?.find((q) => !q?.secret)?.question)
              : plain(asking?.text),
          command: !!asking?.command,
        };
    return [
      sealNotification(
        {
          ...base,
          id: `chat:${source}:${session.id}`,
          signature: consent?.id || "waiting",
          kind: consent ? "permission" : "question",
          title: consent
            ? clean(consent.title)
            : session.asking?.kind === "permission"
              ? "Permission needed"
              : "Your answer is needed",
          summary: consent
            ? clean(consent.reason)
            : "Open the conversation to respond.",
          ...(waiting && { waiting }),
          actions: consent?.id
            ? [{ id: "deny", label: "Deny", tone: "deny" }]
            : [],
        },
        consent?.id
          ? {
              type: "chat",
              agent: source,
              session: session.id,
              prompt: consent.id,
              choices: { deny: { decision: "deny" } },
              evidence: consent,
            }
          : null,
      ),
    ];
  }
  return session.prompts.map((prompt) => {
    const keys = (prompt.decisions || []).filter(
      (key) => typeof key === "string",
    );
    const deny = keys.find((key) => /^(decline|deny|cancel|abort)$/.test(key));
    const approve = keys.find((key) => /^(accept|approved|allow)$/.test(key));
    const choices = {};
    const actions = [];
    if (deny && prompt.kind !== "dialog") {
      choices.deny = { decision: deny };
      actions.push({
        id: "deny",
        label: /^(cancel|abort)$/.test(deny) ? "Deny & stop" : "Deny",
        tone: "deny",
      });
    }
    // Only complete, bounded command requests can be approved inline.
    // File edits, policy changes and native dialogs keep their full review.
    const command = typeof prompt.command === "string" ? prompt.command : "";
    const complete =
      command &&
      command.length <= 8000 &&
      clean(command, 8001) === command &&
      [prompt.cwd, prompt.reason, prompt.message].every(
        (text) =>
          text == null ||
          (typeof text === "string" &&
            text.length <= 4000 &&
            clean(text, 4001) === text),
      );
    if (
      approve &&
      ["command", "tool"].includes(prompt.kind) &&
      complete &&
      !prompt.files?.length
    ) {
      choices.approve = { decision: approve };
      actions.push({ id: "approve", label: "Allow once", tone: "primary" });
    }
    const question =
      prompt.questions?.length === 1 ? prompt.questions[0] : null;
    if (
      prompt.kind === "question" &&
      question &&
      !question.secret &&
      !question.multiSelect &&
      question.options?.length > 0 &&
      question.options.length <= 4 &&
      typeof question.question === "string" &&
      question.question.length <= 1000 &&
      clean(question.question, 1001) === question.question &&
      question.options.every(
        (option) =>
          typeof option.label === "string" &&
          option.label.length <= 100 &&
          clean(option.label, 101) === option.label &&
          (!option.description ||
            (typeof option.description === "string" &&
              option.description.length <= 500 &&
              clean(option.description, 501) === option.description)),
      )
    ) {
      question.options.forEach((option, index) => {
        const id = `answer-${index}`;
        choices[id] = { answers: { [question.id]: [option.label] } };
        actions.push({
          id,
          label: option.label,
          detail: option.description,
          tone: "answer",
        });
      });
    }
    const title =
      {
        command: "Run this command?",
        "file-change": "Review file changes",
        tool: command ? "Run this command?" : "Permission needed",
        question: "A question for you",
        permissions: "Review requested permissions",
      }[prompt.kind] || clean(prompt.title || "Your answer is needed");
    return sealNotification(
      {
        ...base,
        id: `chat:${source}:${session.id}:prompt:${prompt.id}`,
        signature: String(prompt.id),
        kind: prompt.kind,
        title,
        summary:
          prompt.kind === "question"
            ? question && !question.secret
              ? clean(question.question, 1000)
              : prompt.questions?.some((q) => q.secret)
                ? "A private answer is needed in the conversation."
                : `${prompt.questions?.length || "Multiple"} questions need your answer.`
            : clean(prompt.reason || prompt.message),
        prompt: complete
          ? {
              command,
              cwd: prompt.cwd,
              reason: prompt.reason,
              message: prompt.message,
            }
          : undefined,
        ...(prompt.kind === "file-change" && Array.isArray(prompt.files)
          ? {
              files: prompt.files.slice(0, 2).map((file) => clean(file, 300)),
              fileCount: prompt.files.length,
            }
          : {}),
        target: { ...base.target, prompt: String(prompt.id) },
        actions,
      },
      {
        type: "chat",
        agent: source,
        session: session.id,
        prompt: prompt.id,
        choices,
        evidence: prompt,
      },
    );
  });
}
export function browserNotification(request) {
  const kind = request.action?.type;
  const title =
    {
      click: "Click on your screen?",
      text: "Type on your screen?",
      key: "Press a key?",
      scroll: "Scroll your screen?",
      terminal: "Run a read-only command?",
      "terminal-change": "Review a file-changing command",
      "terminal-script": "Review a script",
      "app-access": "Review app access",
      batch: "Review a group of actions",
      command: "A command needs your help",
    }[kind] || "Review an agent action";
  return sealNotification(
    {
      id: `browser:${request.id}`,
      source: "browser",
      sender: clean(request.name || "Agent", 80),
      icon: "agent",
      push: false,
      title,
      kind: "permission",
      detail: "Agent action",
      summary: clean(request.reason),
      createdAt: request.createdAt,
      expiresAt: request.expiresAt,
      target: { page: "overview", needs: `browser:${request.id}` },
      actions: [{ id: "deny", label: "Deny", tone: "deny" }],
    },
    {
      type: "browser",
      id: request.id,
      evidence: [request.action, request.reason, request.expiresAt],
    },
  );
}
export function admissionNotification(request) {
  return sealNotification(
    {
      id: `admission:${request.requestId}`,
      source: "admission",
      sender: clean(request.name || "Agent", 80),
      icon: "agent",
      push: false,
      title: "Connect to your computer?",
      kind: "connection",
      detail: "Agent connection",
      summary: "Check the code and shared permissions before allowing access.",
      createdAt: request.requestedAt,
      expiresAt: request.expiresAt,
      target: {
        page: "overview",
        needs: `agent-admission:${request.requestId}`,
      },
      actions: [{ id: "deny", label: "Deny", tone: "deny" }],
    },
    { type: "admission", id: request.requestId, evidence: request },
  );
}
// An agent asked to restart Reach (server/restart-requests.mjs): you decide,
// knowing what it ends.
export function restartNotification(request, terminals = 0) {
  const asker = clean(request.app || "An agent", 80);
  // Claude chats Reach runs that a restart would cut off mid-step.
  const working = (Array.isArray(request.working) ? request.working : []).map((c) => clean(c?.title || "A Claude chat", 60));
  const names = working.length > 2 ? `${working.slice(0, 2).join(", ")} and ${working.length - 2} more` : working.join(" and ");
  const ends = `${terminals ? `Its ${terminals === 1 ? "terminal" : `${terminals} terminals`} and live screens end.` : "Live screens end."}`;
  const waiting = request.after && working.length;
  // The chat that asked, when Reach knows it: the card opens it.
  const chat = request.chat && ["claude", "codex"].includes(request.chat.agent) ? request.chat : null;
  const from = chat && (Array.isArray(request.working) ? request.working : []).find((c) => c?.id === chat.id)?.title;
  return sealNotification(
    {
      id: `restart:${request.id}`,
      source: "restart",
      sender: asker,
      icon: "agent",
      title: waiting ? "Reach restarts when chats finish" : "Restart Reach?",
      kind: "permission",
      detail: from ? `Asked in ${clean(from, 60)}` : "Computer restart",
      summary: waiting
        ? `Waiting for ${names}.`
        : working.length
          ? `${names} ${working.length === 1 ? "is" : "are"} still working. ${ends}`
          : `Reach starts again in Terminal on your computer. ${ends}`,
      signature: request.id,
      createdAt: request.requestedAt,
      expiresAt: request.expiresAt,
      target: chat
        ? { page: "sessions", agent: chat.agent, id: chat.id }
        : { page: "overview", needs: `restart:${request.id}` },
      actions: waiting
        ? [
            { id: "restart", label: "Restart now" },
            { id: "deny", label: "Cancel", tone: "deny" },
          ]
        : working.length
          ? [
              { id: "after", label: "Restart when done", tone: "primary" },
              { id: "restart", label: "Restart now" },
              { id: "deny", label: "Not now", tone: "deny" },
            ]
          : [
              { id: "restart", label: "Restart", tone: "primary" },
              { id: "deny", label: "Not now", tone: "deny" },
            ],
    },
    // Which chats work changes every few seconds (each turn, each sub-agent):
    // only whether any do changes what the card offers, so a card a moment
    // old still answers.
    { type: "restart", id: request.id, evidence: [request.requestedAt, terminals, !!request.after, working.length > 0] },
  );
}
// Notification content carries the event and its context. System attribution
// is controlled by the OS; repeating the app name in our copy adds no context.
export const agentName = (source) =>
  ({ claude: "Claude Code" })[source] || sourceName(source);
const shorten = (text, limit) => text.length > limit
  ? `${text.slice(0, limit - 1).replace(/\s+\S*$/, "")}…`
  : text;
export const pushLine = (value, limit = 180) => {
  const text = clean(value, 8000)
    .replace(/```[\s\S]*?(```|$)/g, " ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^[ \t]{0,3}(#{1,6}|>|[-*+]|\d+[.)])[ \t]+/gm, "")
    .replace(/\*+|`+|~~/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return shorten(text, limit);
};
// Commands aren't Markdown: preserve globs, backticks, flags and operators.
// Indicate a multiline preview instead of presenting its first line as complete.
const commandLine = (value) => {
  const lines = String(value).trim().split(/\r?\n/);
  return shorten(lines[0], 110) + (lines.length > 1 ? " …" : "");
};
export const chatName = (title) =>
  /^(untitled\b|conversation$)/i.test(String(title || "").trim())
    ? ""
    : pushLine(title, 80);
export const chatEventTitle = (title, source, event) =>
  `${chatName(title) || agentName(source)} · ${event}`;
const folder = (cwd) =>
  pushLine(String(cwd || "").replace(/[\\/]+$/, "").split(/[\\/]/).pop(), 40);
const fileList = (files = [], count = files.length) => {
  const names = files.slice(0, 2).map((file) => folder(file)).filter(Boolean);
  const more = count - names.length;
  return `${count} file${count === 1 ? "" : "s"}${names.length ? `: ${names.join(", ")}${more > 0 ? ` +${more}` : ""}` : ""}`;
};
function chatPush(item) {
  const who = agentName(item.source);
  const waiting = item.waiting;
  const kind = waiting ? waiting.kind : item.kind;
  const question = kind === "question";
  const permission = ["permission", "permissions", "command", "tool", "file-change"].includes(kind);
  const event = question ? "Reply needed" : permission ? "Approval needed" : "Needs you";
  const prefix = chatName(item.chatTitle) ? `${who}: ` : "";
  const command = item.prompt?.command || (waiting?.command && waiting.text);
  const where = folder(item.prompt?.cwd);
  const summary = pushLine(waiting ? waiting.text : item.summary, 190);
  let text;
  if (command) text = `Run ${commandLine(command)}${where ? ` in ${where}` : ""}?`;
  else if (item.kind === "file-change")
    text = `Change ${item.fileCount ? fileList(item.files, item.fileCount) : "files"}?`;
  else if (question) text = summary || "Waiting for your answer.";
  else if (kind === "permissions") text = summary || "Review the requested permissions.";
  else text = summary || (permission ? "Review the pending request." : "Waiting for your response.");
  // A fallback explanation isn't the actual question.
  if (text === "Open the conversation to respond.") text = "Waiting for your response.";
  return {
    title: chatEventTitle(item.chatTitle, item.source, event),
    body: shorten(text.startsWith(who) ? text : prefix + text, 220),
  };
}
function otherPush(item) {
  const who = pushLine(item.sender || "Agent", 48);
  if (item.source === "admission")
    return { title: `${who} · Connection request`, body: "Compare the pairing code, then choose what this agent can access." };
  if (item.source === "access")
    return { title: `${who} · Access request`, body: "Review the requested permissions before allowing access." };
  if (item.source === "restart")
    return { title: "Restart requested", body: `${who} wants to restart the server. Active terminals and live screens will disconnect.` };
  if (item.source === "update")
    return { title: pushLine(item.title, 100), body: `${pushLine(item.detail, 60)}. Reach restarts on it; active terminals and live screens will disconnect.` };
  // What Reach drives, too old or behind (keep-in-sync.mjs): its own line.
  if (item.source === "sync")
    return { title: pushLine(item.title, 100), body: pushLine(item.detail, 200) };
  if (item.source === "browser")
    return { title: `${who} · Approval needed`, body: pushLine(item.title, 200) };
  return {
    title: "Computer · Permission needed",
    body: pushLine(item.title, 180) || "A system dialog needs your response on the live screen.",
  };
}
// OpenClaw's background work (openclaw-watch.mjs): its own fixed words.
function backgroundPush(item) {
  return {
    title: pushLine(item.title, 100) || "OpenClaw",
    body: pushLine(item.detail, 200),
    icon: "openclaw",
    url: targetUrl(item.target),
    actions: [{ action: "open", title: "Open" }],
  };
}
export function notificationPush(item) {
  if (item.source === "openclaw-watch") return backgroundPush(item);
  const open = item.target?.page === "screen" ? "Open live screen"
    : item.kind === "connection" ? "Review access"
    : item.kind === "question" ? "Reply"
    : item.source === "restart" ? "Review restart"
    : ["update", "sync"].includes(item.source) ? "Review update" : "Review request";
  return {
    ...(["mac", "browser", "admission", "access", "restart", "update", "sync"].includes(item.source)
      ? otherPush(item) : chatPush(item)),
    icon: sourceIcon(item.source),
    url: targetUrl(item.target),
    actions: [
      { action: "open", title: open },
      ...(item.actions?.some((action) => action.id === "deny")
        ? [{ action: "deny", title: ["restart", "update", "sync"].includes(item.source) ? "Not now" : "Deny" }] : []),
    ],
    notification: { id: item.id, revision: item.revision },
  };
}
// Only live, owner-readable requests may be answered. The browser submits an
// offered action ID, never a command, replacement answer, or arbitrary URL.
export function createNotificationActions({ read, run }) {
  const pending = new Set();
  const completed = new Map();
  return async (id, body, authorize) => {
    if (
      !isPlainRecord(body) ||
      Object.keys(body).some((key) => !["revision", "action"].includes(key)) ||
      typeof body.revision !== "string" ||
      !/^[a-f0-9]{64}$/.test(body.revision) ||
      typeof body.action !== "string"
    )
      throw fail(400, "Choose an action from this notification.");
    if (pending.has(id))
      throw fail(409, "This request is already being answered.");
    pending.add(id);
    try {
      authorize();
      const { items } = await read();
      authorize();
      const item = items.find((item) => item.id === id);
      const key = `${id}:${body.revision}`;
      for (const [key, at] of completed)
        if (at < Date.now() - 300000) completed.delete(key);
      if (!item || item.revision !== body.revision || completed.has(key))
        throw fail(
          409,
          "This request changed or was already answered. Open it to review the latest state.",
        );
      if (
        !item.actions?.some((action) => action.id === body.action) ||
        !item._binding
      )
        throw fail(400, "Review this request before choosing an action.");
      const result = await run(item._binding, body.action, authorize);
      completed.set(key, Date.now());
      if (completed.size > 200) completed.delete(completed.keys().next().value);
      return { ok: true, result };
    } finally {
      pending.delete(id);
    }
  };
}
