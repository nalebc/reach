// Permission cards the Claude app and the Codex app show in their chats,
// shown on the phone exactly as the app draws them and answered as if tapped
// there. Each app keeps its request to itself, with no way in from outside:
// Reach shows that chat in its app (the Claude app's own "waiting for you"
// link, the Codex app's chat link), reads the card that names this request
// (its words, its buttons, in order: scripts/native/permission-card.swift)
// and, on the person's tap only, presses the button with that very label.
// - Claude: Claude Code says the chat waits ("waiting · permission prompt" in
//   its registry); answered once it no longer does.
// - Codex: read from the chat's file (codex-asks.mjs); answered once the
//   card is gone, and remembered, since an allowed command runs on and writes
//   nothing until it ends.
// - Claude Code in a terminal: its menu read from that tab and its number
//   typed there (terminal-cards.mjs); nothing to bring up.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { desktopBinary } from "../desktop-native.mjs";
import { claudeAppShown } from "./claude-import.mjs";
import { markCodexAnswered } from "./codex-asks.mjs";
import { computerWord } from "../computer-word.mjs";

const exec = promisify(execFile);
const bad = (message, status) => Object.assign(new Error(message), { status });
export const cardId = (toolId) => `app-permission:${toolId}`;
// Claude's multiple-choice question in the Claude app, answered from the phone.
export const questionId = (toolId) => `app-question:${toolId}`;
const APP = { claude: "Claude", codex: "Codex" };
// Buttons on a card that aren't answers (copying the command, folding it).
const NOT_ANSWERS = /^(copy|expand|collapse|show (more|less)|close)\b/i;

// What the card shows of the request, for the helper to be sure it reads and
// presses that one: the command's first line, the file's name, the address.
export function cardExpect(tool) {
  const text = String(tool?.text || "").trim();
  const name = (p) => p.split("/").filter(Boolean).pop() || p;
  let key;
  if (tool?.kind === "command") key = text.split("\n")[0].slice(0, 40);
  else if (tool?.kind === "file-change") key = name(text);
  else if (tool?.kind === "web") key = text.replace(/^https?:\/\//, "").slice(0, 40);
  else if (/^Read /.test(text)) key = name(text.slice(5));
  else key = text.replace(/^(Grep|Glob) /, "").slice(0, 40);
  return key.trim() ? [key.trim()] : [];
}

async function helper(agent, args, { dataDir, run = exec, binary = () => desktopBinary({ dataDir }, "permission-card") } = {}) {
  const file = await binary();
  const { stdout } = await run(file, ["--app", agent, ...args], { timeout: 20000 });
  try {
    return JSON.parse(String(stdout).trim().split("\n").at(-1));
  } catch {
    throw bad(`Couldn't reach the ${APP[agent]} app's card. Answer it on your Mac.`, 502);
  }
}
const expecting = (expect) => expect.flatMap((text) => ["--expect", text]);

// The card's words as the app reads them out: its sentence in pieces ("Allow
// Claude to", "run", "Check the build", "?"), the description a second time,
// then the command. Put back as the card shows them: the sentence on one line,
// the command on its own (the piece holding what the request is about), each
// line once.
export function cardLines(texts, { buttons = [], command = [] } = {}) {
  const squeeze = (t) => String(t).replace(/\s+/g, "").toLowerCase();
  const isCommand = (t) => command.some((c) => squeeze(c) && squeeze(t).includes(squeeze(c)));
  const lines = [];
  let line = "";
  const flush = () => {
    if (line) lines.push(line);
    line = "";
  };
  for (const raw of texts) {
    const piece = String(raw).trim();
    if (!piece || buttons.includes(piece)) continue;
    if (isCommand(piece) && piece.length > 12) {
      flush();
      lines.push(piece);
      continue;
    }
    // A label of its own ("Reason") stays on its line.
    if (/^[A-Z][a-z]+$/.test(line) && /^[A-Z]/.test(piece)) flush();
    line = !line ? piece : /^[?.!,:;)]/.test(piece) ? line + piece : `${line} ${piece}`;
    if (/[?.!]$/.test(piece)) flush();
  }
  flush();
  // Once each: a line already said inside an earlier one goes.
  return lines.filter((l, i) => !lines.slice(0, i).some((before) => before.includes(l)));
}

// How much of its window an app lets Reach see ({ elements }): the Codex app
// (ChatGPT.app's Chromium view) shows a dozen, none of them its cards.
export const probeApp = (agent, options) => helper(agent, ["--probe"], options);

// The card as the app draws it: { found, texts, buttons: [{ label, menu }] }.
export const readAppCard = (agent, expect, options) => helper(agent, ["--read", ...expecting(expect)], options);
// Claude's questions in the Claude app: each by its words, with its picks.
export async function answerAppQuestion(agent, answers, options) {
  const result = await helper(agent, ["--answer", ...answers.flatMap((a) => ["--q", a.question, ...a.picks.flatMap((p) => ["--pick", p])])], options);
  if (result.error) throw bad(`${result.error} Answer it on your Mac.`, 409);
  return result;
}
export async function pressAppCard(agent, label, expect, options) {
  const result = await helper(agent, ["--press", label, ...expecting(expect)], options);
  if (result.error) throw Object.assign(bad(`${result.error} Answer it on your Mac.`, 409), { retry: result.untouched === true });
  if (result.pressed !== label) throw bad("The app didn't confirm which answer was pressed. Check it on your Mac.", 409);
  return result;
}

export function createAppCards({
  read,
  press,
  // Answers a question card in the app (answerAppQuestion).
  answerQuestion = async () => {
    throw bad(`Answer it on your ${computerWord(platform)}.`, 409);
  },
  // The question a chat waits on in the app ({ id, questions, appSessionId }), or null.
  pendingQuestion = async () => null,
  // How much an app shows Reach ({ elements }), asked before bringing it up.
  probe = async () => ({ elements: Infinity }),
  open,
  // The card a chat waits on now ({ id, expect, appSessionId?, tty? }), or
  // null; tty: a terminal's menu, read and answered there.
  pending,
  // Menus in terminals ({ read(tty, expect), press(tty, label, expect) }).
  terminal = null,
  // The Claude app's chats, the one on screen first (claude-import.mjs).
  shown = () => claudeAppShown(),
  wait = (ms) => new Promise((r) => setTimeout(r, ms)),
  switchMs = 1500,
  // The helper confirms the card closed; Claude Code's registry follows.
  confirmMs = 10000,
  markAnswered = markCodexAnswered,
  // "Mac", "Windows PC" or "computer" in what the phone is told (computer-word.mjs).
  platform = process.platform,
  // Whether the Claude app is in front (true, false, or null: unknown), and
  // seconds since the last input on the Mac (null: unknown).
  frontmost = async () => null,
  idle = async () => null,
  // No input this long: nobody is using the Claude app.
  awayMs = 60 * 1000,
}) {
  let busy = false;
  // Each request's buttons as last read: only one of those can be pressed.
  const read_ = new Map(); // promptId -> labels
  const attempted = new Map(); // agent:chat -> last prompt pressed
  const checkAttempt = (agent, id, promptId) => {
    if (attempted.get(`${agent}:${id}`) === promptId)
      throw bad(`This answer was already attempted. Check the app or terminal on your ${computerWord(platform)} before answering again.`, 409);
  };
  const one = async (work) => {
    if (busy) throw bad("Reach is already answering a request in the app.", 409);
    busy = true;
    try {
      return await work();
    } finally {
      busy = false;
    }
  };
  // Someone is using the Claude app now: in front, and not away.
  const inClaude = async () => {
    if ((await Promise.resolve(frontmost()).catch(() => null)) === false) return false;
    const seconds = await Promise.resolve(idle()).catch(() => null);
    return seconds == null || seconds * 1000 < awayMs;
  };
  // The request still waiting, with its chat brought up in its app.
  // look: only to read it (a chat opened on the phone), never on a tap. Then
  // the Claude app isn't switched under someone using it, and is put back on
  // the chat it showed (back): two chats waiting, each looked at from the
  // phone, flipped the app's window between them.
  const show = async (agent, id, promptId, { look = false } = {}) => {
    if (!APP[agent]) throw bad("That chat's app can't be answered from here.", 400);
    const asked = await pending(agent, id);
    if (!asked || (promptId && asked.id !== promptId)) throw bad("This request was already answered.", 409);
    if (!asked.expect?.length) throw bad(`Reach can't tell this request's card apart. Answer it on your ${computerWord(platform)}.`, 409);
    // Only the Codex app hides its window from Reach; the Claude app always
    // shows its cards, so it isn't asked (one helper run saved per card).
    if (agent === "codex" && !asked.tty && ((await probe(agent).catch(() => null))?.elements ?? Infinity) < 50)
      // Nothing to read there: said at once, the app left where it is.
      throw bad(`The ${APP[agent]} app doesn't let Reach see its cards. Answer it on your ${computerWord(platform)}.`, 409);
    if (asked.tty) {
      if (!terminal) throw bad(`Answer it in the terminal on your ${computerWord(platform)}.`, 409);
    } else if (agent === "codex") {
      await open(`codex://threads/${encodeURIComponent(id)}`);
      await wait(switchMs);
    } else if (shown()[0]?.id !== id) {
      if (!asked.appSessionId) throw bad(`The Claude app doesn't list this chat. Answer it on your ${computerWord(platform)}.`, 409);
      if (look && (await inClaude()))
        throw Object.assign(bad(`The Claude app on your ${computerWord(platform)} shows another chat, and you're using it.`, 409), { inApp: true });
      const back = look ? shown()[0]?.session || null : null;
      await open(`claude://code/needs-input?session=${encodeURIComponent(asked.appSessionId)}`);
      await wait(switchMs);
      return { ...asked, back };
    }
    return asked;
  };
  const load = async (agent, id, promptId, { look = false } = {}) => {
    const asked = await show(agent, id, promptId, { look });
    let card;
    try {
      checkAttempt(agent, id, asked.id);
      card = asked.tty ? await terminal.read(asked.tty, asked.expect) : await read(agent, asked.expect);
    } finally {
      if (asked.back && asked.back !== asked.appSessionId)
        await open(`claude://code/continue?session=${encodeURIComponent(asked.back)}`, { background: true }).catch(() => {});
    }
    if (card?.error) throw bad(`${card.error} Answer it on your ${computerWord(platform)}.`, 409);
    if (!card?.found)
      throw bad(asked.tty ? "The terminal isn't showing this request. Answer it there." : `The ${APP[agent]} app isn't showing this request. Answer it on your ${computerWord(platform)}.`, 409);
    const buttons = (card.buttons || [])
      .filter((b) => b.label && !b.menu && !NOT_ANSWERS.test(b.label))
      .map((b) => b.label);
    // The card's menu ("Approval options"): its choices, as read in the app.
    const more = (card.more || []).filter((label) => label && !buttons.includes(label));
    const hasMenu = (card.buttons || []).some((b) => b.menu);
    read_.set(asked.id, [...buttons, ...more]);
    if (read_.size > 50) read_.delete(read_.keys().next().value);
    return {
      asked,
      card: {
        id: asked.id,
        texts: cardLines(card.texts || [], { buttons, command: asked.expect || [] }),
        buttons,
        ...(more.length ? { more } : {}),
        // A menu Reach couldn't read: its choices stay in the app.
        ...(hasMenu && !more.length ? { moreInApp: true } : {}),
      },
    };
  };
  // A question picked on the phone: every pick one of its options, each
  // question answered (one pick, or several where it takes several).
  const picksFor = (questions, answers) => {
    if (!answers || typeof answers !== "object") throw bad("Answer each question.", 400);
    return questions.map((q, i) => {
      const picks = answers[`q${i}`];
      const labels = (q.options || []).map((o) => o.label);
      if (!Array.isArray(picks) || !picks.length || picks.some((p) => !labels.includes(p)) || (!q.multiSelect && picks.length !== 1))
        throw bad(`Choose ${q.multiSelect ? "one or more" : "one"} of the options for "${q.question}".`, 400);
      return { question: q.question, picks: [...new Set(picks)] };
    });
  };
  const answerQuestionNow = (agent, id, promptId, answers) =>
    one(async () => {
      if (agent !== "claude") throw bad("That chat's app can't be answered from here.", 400);
      const asked = await pendingQuestion(agent, id);
      if (!asked || asked.id !== promptId) throw bad("This question was already answered.", 409);
      const picks = picksFor(asked.questions || [], answers);
      checkAttempt(agent, id, promptId);
      if (shown()[0]?.id !== id) {
        if (!asked.appSessionId) throw bad(`The Claude app doesn't list this chat. Answer it on your ${computerWord(platform)}.`, 409);
        await open(`claude://code/needs-input?session=${encodeURIComponent(asked.appSessionId)}`);
        await wait(switchMs);
      }
      attempted.set(`${agent}:${id}`, promptId);
      await answerQuestion(agent, picks);
      for (const until = Date.now() + confirmMs; Date.now() < until; await wait(150))
        if ((await pendingQuestion(agent, id))?.id !== promptId) return { answered: true };
      throw bad(`The Claude app didn't take the answer. Answer it on your ${computerWord(platform)}.`, 409);
    });
  return {
    owns: (promptId) => typeof promptId === "string" && (promptId.startsWith("app-permission:") || promptId.startsWith("app-question:")),
    // The card as the app shows it, for the phone to draw. bring: the person
    // tapped to bring the chat up in its app; it stays there.
    card: (agent, id, { bring = false } = {}) => one(async () => (await load(agent, id, undefined, { look: !bring })).card),
    async answer(agent, id, promptId, { label, answers } = {}) {
      if (promptId.startsWith("app-question:")) return answerQuestionNow(agent, id, promptId, answers);
      if (typeof label !== "string" || !label) throw bad("Choose one of the card's buttons.", 400);
      return one(async () => {
        if (!read_.has(promptId)) await load(agent, id, promptId);
        const known = read_.get(promptId) || [];
        if (!known.includes(label)) throw bad(`The card doesn't offer "${label}".`, 400);
        const asked = await show(agent, id, promptId);
        checkAttempt(agent, id, promptId);
        attempted.set(`${agent}:${id}`, promptId);
        if (attempted.size > 2000) attempted.delete(attempted.keys().next().value);
        try {
          if (asked.tty) await terminal.press(asked.tty, label, asked.expect);
          else await press(agent, label, asked.expect);
        } catch (error) {
          // Only retry when the app helper guarantees no answer was pressed.
          if (!asked.tty && error?.retry === true) {
            attempted.delete(`${agent}:${id}`);
            read_.delete(promptId);
          }
          throw error;
        }
        read_.delete(promptId);
        if (agent === "codex") {
          // The helper saw the card go; the command may run a long while.
          markAnswered(promptId.slice("app-permission:codex:".length));
          return { answered: true };
        }
        for (const until = Date.now() + confirmMs; Date.now() < until; await wait(150))
          if ((await pending(agent, id))?.id !== promptId) return { answered: true };
        throw bad(`The Claude app didn't take the answer. Answer it on your ${computerWord(platform)}.`, 409);
      });
    },
  };
}
