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
const editUnavailable = () =>
  fail("The Codex app couldn't edit that message. Try again once the chat is open in Codex.");
const editUncertain = () =>
  Object.assign(fail("The Codex app didn't confirm the edit. Check the chat before trying again."), { uncertain: true });
const steerUnavailable = () =>
  fail("The Codex app couldn't take it now. It stays queued.");
const steerUncertain = () =>
  Object.assign(
    fail("The Codex app didn't confirm it. It may already be in the chat: check there before sending again."),
    { uncertain: true },
  );
const startUnavailable = () => Object.assign(fail("Codex's task owner is unavailable."), { ownerUnavailable: true });
const startUncertain = () => Object.assign(fail("Codex didn't confirm the message. Check the chat before sending again."), { uncertain: true });
// A chat's whole state comes in one frame (the Codex app allows 256 MB).
const MAX_FRAME = 256 * 1024 * 1024;

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
  // work, instead of one request: several steps with the owner ({ rpc,
  // snapshot }), e.g. reading the chat's state before answering in it.
  // discover: false, for a word to every Codex window (a broadcast) about a
  // chat none of them may hold.
  const ask = async (conversationId, { method, version, params, check, work, discover = true, unavailable = settingsUnavailable, uncertain = settingsUncertain }) => {
    if (!UUID.test(conversationId)) throw unavailable();
    try {
      await checkEndpoint();
    } catch {
      throw unavailable();
    }
    let socket,
      buffer = Buffer.alloc(0),
      // Pieces of a frame still coming (a chat's whole state can be large):
      // joined once it's all there, not on every piece.
      parts = [],
      partsLength = 0,
      need = 4,
      clientId = "initializing-client",
      ended = false,
      wroteSettings = false,
      following = false;
    const pending = new Map();
    // The chat's state as its owner sends it to a follower (newest first).
    const snapshots = [];
    let snapshotWaiter = null;
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
    // written: called once it's out (before the socket may close).
    const send = (message, written) => {
      if (ended || !socket?.writable) throw unavailable();
      const body = Buffer.from(JSON.stringify(message));
      const header = Buffer.alloc(4);
      header.writeUInt32LE(body.length);
      socket.write(Buffer.concat([header, body]), written);
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
            parts.push(chunk);
            partsLength += chunk.length;
            if (partsLength < need) return;
            buffer = Buffer.concat([buffer, ...parts]);
            parts = [];
            partsLength = 0;
            while (buffer.length >= 4) {
              const length = buffer.readUInt32LE(0);
              if (!length || length > MAX_FRAME) throw unavailable();
              if (buffer.length < 4 + length) break;
              const message = JSON.parse(
                buffer.subarray(4, 4 + length).toString("utf8"),
              );
              buffer = buffer.subarray(4 + length);
              if (
                message.type === "broadcast" &&
                message.method === "thread-stream-state-changed" &&
                message.params?.conversationId === conversationId &&
                message.params?.change?.type === "snapshot"
              ) {
                snapshots.unshift(message.params.change.conversationState);
                snapshotWaiter?.();
              } else if (message.type === "client-discovery-request") {
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
            // What's next awaited: the rest of a header, or of a frame.
            need = buffer.length < 4 ? 4 - buffer.length : 4 + buffer.readUInt32LE(0) - buffer.length;
          } catch {
            end(wroteSettings ? uncertain() : unavailable());
          }
        });
      });
      const hello = await rpc("initialize", { clientType: "reach" }, 0);
      if (typeof hello.result?.clientId !== "string" || !hello.result.clientId)
        throw unavailable();
      clientId = hello.result.clientId;
      if (!discover)
        return await work({
          broadcast: (m, p, v) =>
            new Promise((resolve) => send({ type: "broadcast", method: m, sourceClientId: clientId, params: p, version: v }, () => resolve())),
        });
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
      if (work) {
        // Following the chat: its owner sends its whole state (and again
        // whenever asked by following once more).
        const snapshot = async () => {
          const before = snapshots.length;
          following = true;
          send({ type: "broadcast", method: "thread-stream-following-changed", sourceClientId: clientId, params: { conversationId, hostId: "local", following: true }, version: 1 });
          await new Promise((resolve, reject) => {
            const timer = setTimeout(() => { snapshotWaiter = null; reject(wroteSettings ? uncertain() : unavailable()); }, timeoutMs);
            snapshotWaiter = () => {
              if (snapshots.length === before) return;
              clearTimeout(timer);
              snapshotWaiter = null;
              resolve();
            };
          });
          const state = snapshots[0];
          if (!state || typeof state !== "object") throw wroteSettings ? uncertain() : unavailable();
          return state;
        };
        return await work({
          rpc: (m, p, v) => rpc(m, { conversationId, ...p }, v, owner.handledByClientId),
          snapshot,
        });
      }
      const answer = await rpc(method, { conversationId, ...params }, version, owner.handledByClientId);
      if (!check(answer.result)) throw uncertain();
      return answer.result;
    } finally {
      if (following && !ended)
        try {
          send({ type: "broadcast", method: "thread-stream-following-changed", sourceClientId: clientId, params: { conversationId, hostId: "local", following: false }, version: 1 });
        } catch {}
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
  const approvalUnavailable = () =>
    fail("The Codex app couldn't take this answer now. Answer it in the Codex app.");
  const approvalUncertain = () =>
    Object.assign(fail("The Codex app didn't confirm the answer. Check the chat in Codex before answering again."), { uncertain: true });
  const pendingOf = (state) =>
    (Array.isArray(state?.requests) ? state.requests : []).filter(
      (r) => r && (typeof r.id === "string" || Number.isInteger(r.id)) && typeof r.method === "string",
    );
  return {
    // What a chat the Codex app holds waits on: its owner's own requests
    // ({ id, method, params }), each with the id it answers by.
    requests(conversationId) {
      return ask(conversationId, {
        work: async ({ snapshot }) => pendingOf(await snapshot()),
        unavailable: approvalUnavailable,
        uncertain: approvalUnavailable,
      });
    },
    // Answers one of them as the Codex app's own buttons do (forwarded to the
    // chat's owner): only while it still waits, then confirmed by the request
    // leaving the chat's state. The owner says "ok" even for an id it no
    // longer has, so that alone isn't taken as answered.
    answer(conversationId, { id, method, response }) {
      const call = {
        "item/commandExecution/requestApproval": ["thread-follower-command-approval-decision", { decision: response?.decision }],
        "item/fileChange/requestApproval": ["thread-follower-file-approval-decision", { decision: response?.decision }],
        "item/permissions/requestApproval": ["thread-follower-permissions-request-approval-response", { response }],
        "item/tool/requestUserInput": ["thread-follower-submit-user-input", { response }],
        "mcpServer/elicitation/request": ["thread-follower-submit-mcp-server-elicitation-response", { response }],
      }[method];
      if (!call || response == null) return Promise.reject(approvalUnavailable());
      return ask(conversationId, {
        unavailable: approvalUnavailable,
        uncertain: approvalUncertain,
        work: async ({ rpc, snapshot }) => {
          const same = (r) => String(r.id) === String(id) && r.method === method;
          if (!pendingOf(await snapshot()).some(same)) throw fail("This request was already answered.");
          const sent = await rpc(call[0], { requestId: id, ...call[1] }, 1);
          if (sent.result?.ok !== true) throw approvalUncertain();
          for (let i = 0; i < 10; i++) {
            if (!pendingOf(await snapshot()).some(same)) return { answered: true };
            await new Promise((r) => setTimeout(r, 200));
          }
          throw approvalUncertain();
        },
      });
    },
    startTurn(conversationId, request) {
      if (!Array.isArray(request?.input) || !request.input.length) return Promise.reject(startUnavailable());
      return ask(conversationId, {
        method: "thread-follower-start-turn", version: 2,
        params: { turnStart: { request: { ...request, threadId: conversationId, clientUserMessageId: request.clientUserMessageId || randomUUID() }, context: { inheritThreadSettings: true } } },
        check: result => result?.result?.turn?.id != null,
        unavailable: startUnavailable, uncertain: startUncertain,
      }).then(result => ({ turnId: result.result.turn.id }));
    },
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
    // Compact the chat's context, as the Codex app's own /compact.
    compact(conversationId) {
      return ask(conversationId, {
        method: "thread-follower-compact-thread",
        version: 1,
        params: {},
        check: (result) => result?.ok === true,
        unavailable: () => fail("The Codex app couldn't compact this chat now."),
        uncertain: () => Object.assign(fail("The Codex app didn't confirm compacting. Check the chat."), { uncertain: true }),
      }).then(() => ({ compacted: true }));
    },
    // The last message edited and sent again, as the Codex app's own Edit:
    // the app reverts that turn and starts it with the new words.
    editLast(conversationId, { turnId, message }) {
      if (typeof turnId !== "string" || !turnId || typeof message !== "string" || !message.trim())
        return Promise.reject(editUnavailable());
      return ask(conversationId, {
        method: "thread-follower-edit-last-user-turn",
        version: 2,
        params: { turnId, message },
        check: (result) => result != null && typeof result === "object",
        unavailable: editUnavailable,
        uncertain: editUncertain,
      }).then(() => ({ edited: true }));
    },
    // Archived (or back) by Reach through the shared Codex daemon: the Codex
    // app runs its own app-server, so it's told as its other windows tell
    // each other (thread-archived, v2; thread-unarchived, v1), and its list
    // drops (or brings back) the chat at once instead of on its next restart.
    archived(conversationId, archived = true) {
      return ask(conversationId, {
        discover: false,
        work: ({ broadcast }) =>
          archived
            ? broadcast("thread-archived", { hostId: "local", conversationId }, 2)
            : broadcast("thread-unarchived", { hostId: "local", conversationId }, 1),
      });
    },
    model(conversationId, { model, effort, serviceTier }) {
      if (typeof model !== "string" || !model.trim())
        return Promise.reject(settingsUnavailable());
      return update(conversationId, { model, ...(effort ? { effort } : {}), ...(serviceTier ? { serviceTier } : {}) });
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
