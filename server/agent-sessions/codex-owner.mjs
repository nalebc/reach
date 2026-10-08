// Codex clients share one writer through the desktop's owner/follower IPC.
// Reach announces only threads its own engine has actually resumed. The
// desktop follows their native history and sends composer actions to Reach.
import net from "node:net";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { visibleUserText } from "./message-text.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_FRAME = 16 * 1024 * 1024;
export const CODEX_OWNER_METHODS = {
  "thread-owner-discovery": 1,
  "thread-follower-load-complete-history": 1,
  "thread-follower-start-turn": 2,
  "thread-follower-steer-turn": 1,
  "thread-follower-interrupt-turn": 4,
  "thread-follower-update-thread-settings": 2,
  "thread-follower-update-daybreak": 1,
  "thread-follower-edit-last-user-turn": 2,
  "thread-follower-compact-thread": 1,
  "thread-follower-command-approval-decision": 1,
  "thread-follower-file-approval-decision": 1,
  "thread-follower-permissions-request-approval-response": 1,
  "thread-follower-submit-user-input": 1,
  "thread-follower-submit-mcp-server-elicitation-response": 1,
  "thread-follower-set-queued-follow-ups-state": 1,
  "thread-follower-remove-queued-message": 1,
  "thread-follower-clear-queued-messages": 1,
};

export function codexQueuedMessage(q, cwd) {
  const text = (q.input || [])
    .filter((i) => i.type === "text")
    .map((i) => i.text)
    .join("\n");
  return {
    id: q.id,
    clientUserMessageId: q.clientUserMessageId,
    text: visibleUserText(text),
    cwd,
    createdAt: 0,
    canSendNow: true,
    context: {
      prompt: text,
      addedFiles: [],
      fileAttachments: [],
      ideContext: null,
      imageAttachments: (q.input || []).flatMap((i, n) =>
        i.type === "image"
          ? [{ id: `${q.id}:${n}`, src: i.url }]
          : i.type === "localImage"
            ? [{ id: `${q.id}:${n}`, src: i.path, localPath: i.path }]
            : [],
      ),
    },
  };
}

// The desktop's conversation state contains native items unchanged, wrapped
// in turns with composer settings. No text export or second history is made.
export async function codexOwnerSnapshot(
  daemon,
  id,
  settings = {},
  requests = [],
  complete = false,
) {
  const { thread } = await daemon.rpc("thread/read", {
    threadId: id,
    includeTurns: false,
  });
  const turns = [];
  let cursor = null,
    olderCursor;
  const seenCursors = new Set();
  do {
    const page = await daemon.rpc("thread/turns/list", {
      threadId: id,
      limit: complete ? 100 : 20,
      sortDirection: "desc",
      itemsView: "full",
      ...(cursor ? { cursor } : {}),
    });
    turns.push(...(page.data || []));
    olderCursor = page.nextCursor || null;
    if (!complete || !olderCursor || seenCursors.has(olderCursor)) break;
    seenCursors.add(olderCursor);
    cursor = olderCursor;
  } while (true);
  const model = settings.model || thread.model || "";
  const effort = settings.effort ?? settings.reasoningEffort ?? null;
  const sandboxPolicy = settings.sandboxPolicy ||
    settings.sandbox || {
      type: "workspaceWrite",
      writableRoots: [thread.cwd],
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    };
  const permissions = {
    approvalPolicy: settings.approvalPolicy || "on-request",
    approvalsReviewer: settings.approvalsReviewer || "user",
    sandboxPolicy,
    activePermissionProfile: settings.activePermissionProfile || null,
    runtimeWorkspaceRoots: settings.runtimeWorkspaceRoots || [thread.cwd],
  };
  return {
    id,
    hostId: "local",
    sessionId: thread.sessionId,
    title: thread.name || null,
    forkedFromId: thread.forkedFromId || null,
    parentThreadId: null,
    createdAt: thread.createdAt * 1000,
    updatedAt: thread.updatedAt * 1000,
    recencyAt: (thread.recencyAt || thread.updatedAt) * 1000,
    cwd: thread.cwd,
    workspaceKind: "project",
    gitInfo: thread.gitInfo || null,
    originator: thread.originator,
    source: thread.source,
    threadSource: thread.threadSource,
    modelProvider: settings.modelProvider || thread.modelProvider || "openai",
    mode: "default",
    threadStartKind: "default",
    resumeState: "resumed",
    historyMode: thread.historyMode,
    rolloutPath: thread.path || "",
    hasUnreadTurn: false,
    latestModel: model,
    latestReasoningEffort: effort,
    previousTurnModel: null,
    threadGoal: null,
    latestTokenUsageInfo: null,
    daybreakEnabled: thread.daybreakEnabled,
    threadRuntimeStatus: thread.status,
    latestCollaborationMode: settings.collaborationMode || {
      mode: "default",
      settings: {
        model,
        reasoning_effort: effort,
        developer_instructions: null,
      },
    },
    currentPermissions: permissions,
    latestThreadSettings: { ...settings, model, effort, sandboxPolicy },
    requests,
    turns: turns.reverse().map((turn) => {
      const first = (turn.items || []).find(
        (i) => i.type !== "contextCompaction",
      );
      return {
        turnId: turn.id,
        status: turn.status,
        error: turn.error || null,
        diff: null,
        turnStartedAtMs: turn.startedAt == null ? null : turn.startedAt * 1000,
        finalAssistantStartedAtMs:
          turn.completedAt == null ? null : turn.completedAt * 1000,
        durationMs: turn.durationMs ?? null,
        permissionParamsSource: "inferred",
        params: {
          threadId: id,
          input: first?.type === "userMessage" ? first.content : [],
          clientUserMessageId: first?.clientId,
          model,
          effort,
          cwd: thread.cwd,
          ...permissions,
          serviceTier: settings.serviceTier,
          summary: "none",
          personality: null,
          outputSchema: null,
          collaborationMode: null,
          attachments: [],
        },
        items: (turn.items || []).map((item) =>
          item.type === "collabAgentToolCall"
            ? {
                ...item,
                receiverThreads: (item.receiverThreadIds || []).map(
                  (threadId) => ({ threadId, thread: null }),
                ),
              }
            : item.type === "imageGeneration"
              ? {
                  ...item,
                  src:
                    item.savedPath ||
                    (item.result?.startsWith("data:")
                      ? item.result
                      : `data:image/png;base64,${item.result || ""}`),
                }
              : item,
        ),
      };
    }),
    turnsPagination: {
      olderCursor,
      oldestLoadedTurnId: turns[0]?.id || null,
      isLoadingOlder: false,
      hasLoadedOldest: !olderCursor,
    },
  };
}

export function createCodexOwner({
  daemon,
  handleRequest,
  requests = () => [],
  enabled = !process.env.NODE_TEST_CONTEXT,
  home = process.env.CODEX_HOME || path.join(os.homedir(), ".codex"),
  endpoint = process.platform === "win32"
    ? "\\\\.\\pipe\\codex-ipc"
    : path.join(home, "ipc", "ipc.sock"),
  connect = net.connect,
  gapMs = 100,
  reconnectMs = 1000,
  checkEndpoint = async () => {
    if (process.platform === "win32") return;
    const [socket, directory] = await Promise.all([
      fs.lstat(endpoint),
      fs.lstat(path.dirname(endpoint)),
    ]);
    const uid = process.getuid?.();
    if (
      !socket.isSocket() ||
      socket.uid !== uid ||
      !directory.isDirectory() ||
      directory.uid !== uid ||
      socket.mode & 0o022 ||
      directory.mode & 0o022
    )
      throw Error("Codex IPC is unavailable.");
  },
} = {}) {
  const owned = new Map(),
    followers = new Map(),
    revisions = new Map(),
    timers = new Map(),
    publishing = new Map(),
    serial = new Map(),
    queueBaselines = new Map();
  let socket = null,
    clientId = null,
    buffer = Buffer.alloc(0),
    opening = null,
    closed = false,
    retry = null;
  const write = (message) => {
    if (!socket?.writable) throw Error("Codex IPC disconnected.");
    const body = Buffer.from(JSON.stringify(message));
    if (body.length > MAX_FRAME)
      throw Error("Codex thread snapshot is too large.");
    const header = Buffer.alloc(4);
    header.writeUInt32LE(body.length);
    socket.write(Buffer.concat([header, body]));
  };
  const broadcast = (method, params, version, targets) => {
    if (!clientId) return;
    write({
      type: "broadcast",
      sourceClientId: clientId,
      method,
      params,
      version,
      ...(targets ? { targetClientIds: targets } : {}),
    });
  };
  async function publish(
    id,
    targets = [...(followers.get(id) || [])],
    complete = false,
  ) {
    if (!owned.has(id) || !clientId || !targets.length) return null;
    const connection = socket;
    const previous = publishing.get(id) || Promise.resolve();
    const work = previous
      .catch(() => {})
      .then(async () => {
        const conversationState = await codexOwnerSnapshot(
          daemon,
          id,
          owned.get(id),
          requests(id),
          complete,
        );
        if (!owned.has(id) || !clientId || connection !== socket) return null;
        const revision = (revisions.get(id) || 0) + 1;
        broadcast(
          "thread-stream-state-changed",
          {
            conversationId: id,
            hostId: "local",
            change: { type: "snapshot", revision, conversationState },
          },
          11,
          targets,
        );
        revisions.set(id, revision);
        const queue = await daemon.rpc("thread/queue/list", { threadId: id });
        if (!owned.has(id) || connection !== socket) return null;
        broadcast(
          "thread-queued-followups-changed",
          {
            conversationId: id,
            hostId: "local",
            messages: (queue.data || []).map((q) =>
              codexQueuedMessage(q, conversationState.cwd),
            ),
          },
          2,
          targets,
        );
        for (const client of targets)
          queueBaselines.set(
            `${id}:${client}`,
            (queue.data || []).map((q) => q.id),
          );
        return revision;
      });
    publishing.set(id, work);
    try {
      return await work;
    } finally {
      if (publishing.get(id) === work) publishing.delete(id);
    }
  }
  const update = (id) => {
    if (!owned.has(id) || !followers.get(id)?.size || timers.has(id)) return;
    const timer = setTimeout(() => {
      timers.delete(id);
      void publish(id).catch(() => {});
    }, gapMs);
    timer.unref?.();
    timers.set(id, timer);
  };
  const canHandle = (request) => {
    const id = request.params?.conversationId;
    return (
      UUID.test(id || "") &&
      owned.has(id) &&
      (request.params?.hostId || request.hostId || "local") === "local" &&
      (request.version === CODEX_OWNER_METHODS[request.method] ||
        (request.method === "thread-follower-interrupt-turn" &&
          request.version === 3))
    );
  };
  async function receive(message) {
    if (message.type === "client-discovery-request") {
      write({
        type: "client-discovery-response",
        requestId: message.requestId,
        response: { canHandle: canHandle(message.request || {}) },
      });
    } else if (message.type === "broadcast") {
      const p = message.params || {},
        id = p.conversationId;
      if (
        message.method === "client-status-changed" &&
        p.status === "disconnected"
      ) {
        for (const clients of followers.values()) clients.delete(p.clientId);
      } else if (
        message.method === "thread-stream-following-changed" &&
        p.hostId === "local" &&
        owned.has(id)
      ) {
        const clients = followers.get(id) || new Set();
        p.following
          ? clients.add(message.sourceClientId)
          : clients.delete(message.sourceClientId);
        followers.set(id, clients);
        if (p.following)
          void publish(id, [message.sourceClientId]).catch(() => {});
      }
    } else if (message.type === "request") {
      if (!canHandle(message))
        return reply(message, null, "Reach no longer owns this task.");
      const id = message.params.conversationId;
      if (message.method === "thread-owner-discovery")
        return reply(message, { supportsUntrustedAppInput: false });
      const previous = serial.get(id) || Promise.resolve();
      const work = previous
        .catch(() => {})
        .then(async () => {
          if (!owned.has(id)) throw Error("Reach no longer owns this task.");
          if (message.method === "thread-follower-load-complete-history") {
            const clients = followers.get(id) || new Set();
            clients.add(message.sourceClientId);
            followers.set(id, clients);
            const revision = await publish(id, [message.sourceClientId], true);
            if (revision == null) throw Error("Codex history is unavailable.");
            return { revision };
          }
          return handleRequest(message.method, message.params, {
            sourceClientId: message.sourceClientId,
            queueIds:
              queueBaselines.get(`${id}:${message.sourceClientId}`) || [],
          });
        });
      serial.set(id, work);
      try {
        reply(message, await work);
        update(id);
      } catch (error) {
        reply(message, null, error.message);
      } finally {
        if (serial.get(id) === work) serial.delete(id);
      }
    }
  }
  function reply(request, result, error) {
    if (!clientId || !socket?.writable) return;
    write({
      type: "response",
      requestId: request.requestId,
      method: request.method,
      handledByClientId: clientId,
      ...(error
        ? { resultType: "error", error }
        : { resultType: "success", result }),
    });
  }
  function disconnected(ws) {
    if (socket !== ws) return;
    socket = null;
    clientId = null;
    buffer = Buffer.alloc(0);
    followers.clear();
    revisions.clear();
    if (!closed && owned.size && enabled && !retry) {
      retry = setTimeout(() => {
        retry = null;
        void open().catch(() => {});
      }, reconnectMs);
      retry.unref?.();
    }
  }
  async function open() {
    if (!enabled || closed || clientId) return;
    if (opening) return opening;
    opening = (async () => {
      await checkEndpoint();
      const ws = connect(endpoint);
      socket = ws;
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          ws.destroy();
          reject(Error("Codex IPC did not initialize."));
        }, 8000);
        timer.unref?.();
        ws.once("connect", () =>
          write({
            type: "request",
            sourceClientId: "initializing-client",
            requestId: randomUUID(),
            method: "initialize",
            version: 0,
            params: { clientType: "reach" },
          }),
        );
        ws.on("data", (chunk) => {
          try {
            buffer = Buffer.concat([buffer, chunk]);
            while (buffer.length >= 4) {
              const size = buffer.readUInt32LE(0);
              if (!size || size > MAX_FRAME)
                throw Error("Invalid Codex IPC frame.");
              if (buffer.length < size + 4) break;
              const message = JSON.parse(buffer.subarray(4, size + 4));
              buffer = buffer.subarray(size + 4);
              if (
                message.type === "response" &&
                message.method === "initialize" &&
                message.resultType === "success" &&
                typeof message.result?.clientId === "string"
              ) {
                clientId = message.result.clientId;
                clearTimeout(timer);
                resolve();
                for (const id of owned.keys())
                  broadcast(
                    "thread-stream-following-status-requested",
                    { conversationId: id, hostId: "local" },
                    1,
                  );
              } else void receive(message).catch(() => {});
            }
          } catch (error) {
            clearTimeout(timer);
            reject(error);
            ws.destroy();
          }
        });
        ws.on("error", (error) => {
          clearTimeout(timer);
          reject(error);
          disconnected(ws);
        });
        ws.on("close", () => {
          clearTimeout(timer);
          reject(Error("Codex IPC closed."));
          disconnected(ws);
        });
      });
    })()
      .catch((error) => {
        if (!closed && owned.size && enabled && !retry) {
          retry = setTimeout(() => {
            retry = null;
            void open().catch(() => {});
          }, reconnectMs);
          retry.unref?.();
        }
        throw error;
      })
      .finally(() => {
        opening = null;
      });
    return opening;
  }
  return {
    async claim(id, settings = {}) {
      if (!UUID.test(id || "")) return;
      const { thread, ...values } = settings;
      owned.set(id, { ...(owned.get(id) || {}), ...values });
      await open().catch(() => {});
      if (clientId)
        broadcast(
          "thread-stream-following-status-requested",
          { conversationId: id, hostId: "local" },
          1,
        );
    },
    has: (id) => owned.has(id),
    hasFollowers: (id) => !!followers.get(id)?.size,
    settings(id, settings) {
      if (owned.has(id)) {
        const { threadId, input, clientUserMessageId, ...values } = settings;
        owned.set(id, { ...owned.get(id), ...values });
        update(id);
      }
    },
    update,
    forget(id) {
      owned.delete(id);
      followers.delete(id);
      revisions.delete(id);
      for (const key of queueBaselines.keys())
        if (key.startsWith(`${id}:`)) queueBaselines.delete(key);
      clearTimeout(timers.get(id));
      timers.delete(id);
    },
    reset() {
      owned.clear();
      followers.clear();
      revisions.clear();
      queueBaselines.clear();
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
    },
    close() {
      closed = true;
      clearTimeout(retry);
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
      owned.clear();
      followers.clear();
      socket?.destroy();
    },
  };
}
