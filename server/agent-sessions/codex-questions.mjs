// Answers to Codex's questions, as the Codex app sends them into the running
// turn: a message of this one envelope, each question named by its message
// and its place there (the app's own format).
const REPLY_OPEN = "<send_user_message_question_reply>";
const REPLY_CLOSE = "</send_user_message_question_reply>";
export const questionKey = (itemId, index) => JSON.stringify(["request_user_input_async", itemId, index]);
export const questionReply = (replies) => `${REPLY_OPEN}\n${JSON.stringify(replies)}\n${REPLY_CLOSE}`;
export function readQuestionReply(text) {
  const t = String(text ?? "").trim();
  if (!t.startsWith(REPLY_OPEN) || !t.endsWith(REPLY_CLOSE)) return null;
  try {
    const parsed = JSON.parse(t.slice(REPLY_OPEN.length, -REPLY_CLOSE.length));
    const list = Array.isArray(parsed) ? parsed : [parsed];
    return list.length && list.every((r) => typeof r?.questionItemId === "string" && typeof r.question === "string" && typeof r.answer === "string")
      ? list
      : null;
  } catch {
    return null;
  }
}

// Answers shown on the questions they answer, as the Codex app shows them,
// not as messages of their own; one whose question isn't on this page stays
// a message (its answers in words).
export function withQuestionReplies(items) {
  items = items.map((item) => item.questions?.length ? { ...item, questions: item.questions.map((q) => ({ ...q })) } : item);
  const questions = new Map(items.filter((i) => i.questions?.length).map((i) => [i.id, i]));
  return items.flatMap((item) => {
    if (!item.replies) return [item];
    const unplaced = [];
    for (const reply of item.replies) {
      let key;
      try { key = JSON.parse(reply.questionItemId); } catch {}
      const q = Array.isArray(key) && key.length === 3 && key[0] === "request_user_input_async" && Number.isInteger(key[2]) && key[2] >= 0
        ? questions.get(key[1])?.questions?.[key[2]] : null;
      if (q) q.answer = reply.answer;
      else unplaced.push(reply);
    }
    // Preserve unmatched identities so an older page can attach them later.
    return unplaced.length ? [{ ...item, replies: unplaced, text: unplaced.map((r) => r.answer).join("\n\n") }] : [];
  });
}

