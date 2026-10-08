// The Codex app's approvals, shown on the phone and answered there with no
// click in the app: Reach follows the chat over the Codex app's own IPC
// (codex-desktop.mjs), reads the request the chat waits on (its real id, its
// command, the decisions it offers) and answers that very request as the
// app's own buttons do, then confirms it left the chat's state.
// - Which chat waits: read from the chat's file (codex-asks.mjs).
// - Claude Code (the Claude app, a terminal) is answered through its own
//   PermissionRequest hook instead (agent-asks.mjs).
import { describePrompt, answerFor } from "./codex-live.mjs";
import { markCodexAnswered } from "./codex-asks.mjs";
import { computerWord } from "../computer-word.mjs";

const bad = (message, status) => Object.assign(new Error(message), { status });
export const cardId = (callId) => `app-permission:codex:${callId}`;
const APPROVALS = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
]);

// Each decision as the phone's button says it (the first is the main one).
const LABELS = {
  accept: "Allow once",
  acceptForSession: "Allow for this chat",
  acceptWithExecpolicyAmendment: "Always allow this command",
  applyNetworkPolicyAmendment: "Always allow this host",
  decline: "Deny",
  cancel: "Deny and stop",
  allow: "Allow once",
  deny: "Deny",
};
const decisionKey = (d) => (typeof d === "string" ? d : Object.keys(d || {})[0]);

// The request as the phone draws it: its words, and one button per decision.
export function codexCard(promptId, request) {
  const prompt = describePrompt(request.method, request.params || {});
  const texts = [
    prompt.title,
    ...(prompt.reason ? [prompt.reason] : []),
    ...(prompt.kind === "file-change" ? prompt.files : [prompt.command]),
  ].filter((t) => typeof t === "string" && t.trim());
  const buttons = prompt.decisions.map(decisionKey).filter((k) => LABELS[k]).map((k) => LABELS[k]);
  return { prompt, card: { id: promptId, texts, buttons } };
}

export function createAppCards({
  // The Codex app's IPC (codex-desktop.mjs): requests(chat), answer(chat, request).
  desktop,
  // The request a chat waits on, read from its file ({ id, callId }), or null.
  pending,
  markAnswered = markCodexAnswered,
  // "Mac", "Windows PC" or "computer" in what the phone is told (computer-word.mjs).
  platform = process.platform,
}) {
  const there = () => `Answer it in the Codex app on your ${computerWord(platform)}.`;
  // The live request behind the card: the one with the call's id, or the
  // chat's only approval when the app doesn't name it.
  const find = async (id, promptId) => {
    const asked = await pending("codex", id);
    if (!asked || (promptId && asked.id !== promptId)) throw bad("This request was already answered.", 409);
    let requests;
    try {
      requests = (await desktop.requests(id)).filter((r) => APPROVALS.has(r.method));
    } catch (error) {
      throw bad(`${error.message} ${error.message.includes("Codex app") ? "" : there()}`.trim(), 409);
    }
    const named = requests.filter((r) => [r.params?.itemId, r.params?.callId].map(String).includes(String(asked.callId)));
    const request = named.length === 1 ? named[0] : !named.length && requests.length === 1 ? requests[0] : null;
    if (!request) throw bad(`Reach can't tell which request this is. ${there()}`, 409);
    return { asked, request };
  };
  // Keep the old card path's no-replay guarantee across phones, now keyed
  // by the native request so a later request in the same chat can proceed.
  const attempted = new Set();
  let busy = false;
  return {
    owns: (promptId) => typeof promptId === "string" && promptId.startsWith("app-permission:codex:"),
    // The card as the Codex app holds it, for the phone to draw.
    async card(agent, id) {
      if (agent !== "codex") throw bad("Answer it on the Mac.", 400);
      const { asked, request } = await find(id);
      return codexCard(asked.id, request).card;
    },
    async answer(agent, id, promptId, { label } = {}) {
      if (agent !== "codex") throw bad("That chat's app can't be answered from here.", 400);
      if (typeof label !== "string" || !label) throw bad("Choose one of the card's buttons.", 400);
      if (busy) throw bad("Reach is already answering a request in the Codex app.", 409);
      busy = true;
      try {
        const { asked, request } = await find(id, promptId);
        const key = JSON.stringify([id, request.method, request.id]);
        if (attempted.has(key)) throw bad("This answer was already attempted. Check the Codex app before answering again.", 409);
        if ((await pending("codex", id))?.id !== asked.id) throw bad("This request was already answered.", 409);
        const { prompt } = codexCard(promptId, request);
        const decision = prompt.decisions.map(decisionKey).find((k) => LABELS[k] === label);
        if (!decision) throw bad(`The request doesn't offer "${label}".`, 400);
        const response = answerFor(prompt, { decision });
        attempted.add(key);
        try {
          await desktop.answer(id, { id: request.id, method: request.method, response });
        } catch (error) {
          if (error?.uncertain !== true) attempted.delete(key);
          throw error;
        }
        // An allowed command runs on and writes nothing until it ends.
        markAnswered(asked.callId);
        return { answered: true };
      } finally {
        busy = false;
      }
    },
  };
}
