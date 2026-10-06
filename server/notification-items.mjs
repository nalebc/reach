import crypto from "node:crypto";
import { fail, isPlainRecord } from "./core.mjs";

export const sourceName = (source) =>
  ({
    codex: "Codex",
    claude: "Claude",
    gemini: "Gemini",
    openclaw: "OpenClaw",
    mac: "Your computer",
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
  ["codex", "claude", "gemini", "openclaw", "mac"].includes(source)
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
export function publicNotification({ _binding, signature, push, ...item }) {
  return item;
}
export function chatNotifications(session) {
  const source = session.agent;
  const base = {
    source,
    sender: sourceName(source),
    icon: sourceIcon(source),
    detail: clean(session.title || "Conversation"),
    target: { page: "sessions", agent: source, id: session.id },
    createdAt: session.updatedAt || session.createdAt,
  };
  if (!session.prompts?.length) {
    const consent = session.consent;
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
          prompt.kind === "question" && question && !question.secret
            ? clean(question.question, 1000)
            : clean(prompt.reason || prompt.message),
        prompt: complete
          ? {
              command,
              cwd: prompt.cwd,
              reason: prompt.reason,
              message: prompt.message,
            }
          : undefined,
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
export function notificationPush(item) {
  const invited = ["browser", "admission", "access"].includes(item.source);
  const sender = invited
    ? `✦ ${clean(item.sender || "Agent", 48)
        .replace(/\s+/g, " ")
        .trim()}`
    : sourceName(item.source);
  const topic =
    item.source === "admission"
      ? "Connection request"
      : item.source === "browser"
        ? item.title
        : item.source === "mac"
          ? "A prompt needs you"
          : {
              command: "Command approval",
              tool: "Permission needed",
              "file-change": "File changes to review",
              permissions: "Access to review",
              question: "Question for you",
            }[item.kind] || "Approval needed";
  const body =
    item.source === "admission"
      ? "Tap to compare the connection code and review access."
      : item.source === "browser"
        ? "Tap to review this agent action and choose whether to allow it."
        : item.source === "mac"
          ? "Tap to view the prompt on your computer."
          : {
              command: "Tap to review the command and allow or deny it.",
              tool: "Tap to review the requested action.",
              "file-change": "Tap to review the proposed file changes.",
              permissions: "Tap to review the requested permissions.",
              question: "Tap to open the question and send your answer.",
            }[item.kind] || "Tap to open this request and respond.";
  return {
    title: `${sender} · ${topic}`,
    body,
    icon: sourceIcon(item.source),
    url: targetUrl(item.target),
    actions: [
      { action: "open", title: item.kind === "question" ? "Reply" : "Review" },
      ...(item.actions?.some((action) => action.id === "deny")
        ? [{ action: "deny", title: "Deny" }]
        : []),
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
