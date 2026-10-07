// Codex desktop and its editor clients coordinate through this private local
// socket. Settings go to the discovered thread owner, which updates its own
// composer and app-server together. Never take its writer lock or replay a
// settings request after an uncertain response.
import net from "node:net";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fail = (message) => Object.assign(new Error(message), { status: 409 });
const settingsUnavailable = () =>
  fail(
    "Codex desktop couldn't apply the model change. Try again once the chat is open in Codex.",
  );
const settingsUncertain = () =>
  fail(
    "Codex didn't confirm the model change. Check its model before trying again.",
  );
const steerUnavailable = () =>
  fail("The Codex app couldn't take it now. It stays queued.");
const steerUncertain = () =>
  Object.assign(
    fail("The Codex app didn't confirm it. It may already be in the chat: check there before sending again."),
    { uncertain: true },
  );
const MAX_FRAME = 16 * 1024 * 1024;

export function createCodexDesktop({
  home = process.env.CODEX_HOME || path.join(os.homedir(), ".codex"),
  endpoint = process.platform === "win32"
    ? "\\\\.\\pipe\\codex-ipc"
    : path.join(home, "ipc", "ipc.sock"),
  connect = net.connect,
  timeoutMs = 8000,
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
      throw settingsUnavailable();
  },
} = {}) {
  // One request to the app that owns the chat (found by asking): it's
  // written once and never replayed; with no clear answer after it's written,
  // the outcome is uncertain, not failed.
  const ask = async (conversationId, { method, version, params, check, unavailable = settingsUnavailable, uncertain = settingsUncertain }) => {
    if (!UUID.test(conversationId)) throw unavailable();
    try {
      await checkEndpoint();
    } catch {
      throw unavailable();
    }
    let socket,
      buffer = Buffer.alloc(0),
      clientId = "initializing-client",
      ended = false,
      wroteSettings = false;
    const pending = new Map();
    const end = (error) => {
      if (ended) return;
      ended = true;
      for (const p of pending.values()) {
        clearTimeout(p.timer);
        p.reject(error);
      }
      pending.clear();
      socket?.destroy();
    };
    const send = (message) => {
      if (ended || !socket?.writable) throw unavailable();
      const body = Buffer.from(JSON.stringify(message));
      const header = Buffer.alloc(4);
      header.writeUInt32LE(body.length);
      socket.write(Buffer.concat([header, body]));
    };
    const rpc = (method, params, version, targetClientId) =>
      new Promise((resolve, reject) => {
        const requestId = randomUUID();
        const timer = setTimeout(
          () => end(wroteSettings ? uncertain() : unavailable()),
          timeoutMs,
        );
        pending.set(requestId, {
          resolve,
          reject,
          timer,
          method,
          targetClientId,
        });
        try {
          if (method !== "initialize" && method !== "thread-owner-discovery")
            wroteSettings = true;
          send({
            type: "request",
            sourceClientId: clientId,
            requestId,
            method,
            params,
            version,
            ...(targetClientId ? { targetClientId } : {}),
            timeoutMs: Math.max(1, timeoutMs - 500),
          });
        } catch {
          end(wroteSettings ? uncertain() : unavailable());
        }
      });
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(unavailable());
          end(unavailable());
        }, timeoutMs);
        try {
          socket = connect(endpoint);
        } catch {
          clearTimeout(timer);
          reject(unavailable());
          return;
        }
        socket.once("connect", () => {
          clearTimeout(timer);
          resolve();
        });
        socket.on("error", () => {
          clearTimeout(timer);
          reject(unavailable());
          end(wroteSettings ? uncertain() : unavailable());
        });
        socket.on("close", () => {
          clearTimeout(timer);
          reject(unavailable());
          end(wroteSettings ? uncertain() : unavailable());
        });
        socket.on("data", (chunk) => {
          try {
            buffer = Buffer.concat([buffer, chunk]);
            while (buffer.length >= 4) {
              const length = buffer.readUInt32LE(0);
              if (!length || length > MAX_FRAME) throw unavailable();
              if (buffer.length < 4 + length) break;
              const message = JSON.parse(
                buffer.subarray(4, 4 + length).toString("utf8"),
              );
              buffer = buffer.subarray(4 + length);
              if (message.type === "client-discovery-request") {
                send({
                  type: "client-discovery-response",
                  requestId: message.requestId,
                  response: { canHandle: false },
                });
              } else if (message.type === "response") {
                const p = pending.get(message.requestId);
                if (!p) continue;
                pending.delete(message.requestId);
                clearTimeout(p.timer);
                if (
                  message.resultType !== "success" ||
                  message.method !== p.method ||
                  (p.targetClientId &&
                    message.handledByClientId !== p.targetClientId)
                )
                  p.reject(wroteSettings ? uncertain() : unavailable());
                else p.resolve(message);
              }
            }
          } catch {
            end(wroteSettings ? uncertain() : unavailable());
          }
        });
      });
      const hello = await rpc("initialize", { clientType: "reach" }, 0);
      if (typeof hello.result?.clientId !== "string" || !hello.result.clientId)
        throw unavailable();
      clientId = hello.result.clientId;
      const owner = await rpc(
        "thread-owner-discovery",
        { hostId: "local", conversationId },
        1,
      );
      if (
        typeof owner.handledByClientId !== "string" ||
        !owner.handledByClientId
      )
        throw unavailable();
      const answer = await rpc(method, { conversationId, ...params }, version, owner.handledByClientId);
      if (!check(answer.result)) throw uncertain();
      return answer.result;
    } finally {
      end(unavailable());
    }
  };
  const update = async (conversationId, threadSettings) => {
    await ask(conversationId, {
      method: "thread-follower-update-thread-settings",
      version: 2,
      params: { threadSettings },
      check: (result) => result?.applied === true,
    });
    return { ...threadSettings, applied: true };
  };
  return {
    // Into the running turn now, as the Codex app's own Steer does (from its
    // composer, or a queued message's Steer: then queued names it, and the
    // app takes it out of its queue). input: Codex's UserInput items.
    steer(conversationId, { input, text = "", cwd = null, clientUserMessageId = randomUUID(), queued = null }) {
      if (!Array.isArray(input) || !input.length) return Promise.reject(steerUnavailable());
      return ask(conversationId, {
        method: "thread-follower-steer-turn",
        version: 1,
        params: {
          clientUserMessageId,
          input,
          attachments: [],
          // What the app shows, and puts back, should the steer fail.
          restoreMessage: {
            id: clientUserMessageId,
            text,
            cwd,
            context: { workspaceRoots: cwd ? [cwd] : [], collaborationMode: null },
            ...(queued ? { serverQueuedMessageId: queued } : {}),
          },
        },
        check: (result) => result != null && typeof result === "object",
        unavailable: steerUnavailable,
        uncertain: steerUncertain,
      }).then(() => ({ steered: true, clientUserMessageId }));
    },
    model(conversationId, { model, effort }) {
      if (typeof model !== "string" || !model.trim())
        return Promise.reject(settingsUnavailable());
      return update(conversationId, { model, ...(effort ? { effort } : {}) });
    },
    permissions(
      conversationId,
      { approvalPolicy, approvalsReviewer, permissions },
    ) {
      if (
        !["on-request", "never"].includes(approvalPolicy) ||
        !["user", "auto_review"].includes(approvalsReviewer) ||
        typeof permissions !== "string" ||
        !/^:?[\w.-]+$/.test(permissions)
      )
        return Promise.reject(settingsUnavailable());
      return update(conversationId, {
        approvalPolicy,
        approvalsReviewer,
        permissions,
      });
    },
  };
}
