// The Claude app's own consent card (letting Claude use apps), answered from
// the phone: Reach shows that session in the Claude app's window (the card is
// drawn in the session's own view), presses the same button there through
// Accessibility (scripts/native/claude-consent.swift), and counts it answered
// once the transcript has the answer.
import { object } from "./compatibility.mjs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { desktopBinary } from "../desktop-native.mjs";
import { claudeAppShown } from "./claude-import.mjs";
import { computerWord } from "../computer-word.mjs";

const exec = promisify(execFile);
const bad = (message, status) => Object.assign(new Error(message), { status });
// The card's buttons, worded as the app words them.
export const CONSENT_CHOICES = { deny: "Deny", allow: "Allow for this session" };

// expect: texts the card must show (its question and apps), so only that
// request's card is pressed.
export async function pressClaudeConsent(
  choice,
  { dataDir, expect = [], run = exec, binary = () => desktopBinary({ dataDir }, "claude-consent") } = {},
) {
  const file = await binary();
  const { stdout } = await run(file, ["--press", choice, ...expect.flatMap((text) => ["--expect", text])], { timeout: 20000 });
  let result = {};
  try {
    result = JSON.parse(String(stdout).trim().split("\n").at(-1));
  } catch {
    throw bad("Couldn't press it in the Claude app. Answer it on your Mac.", 502);
  }
  if (!object(result)) throw bad("Unknown approval response. Check it on your Mac.", 409);
  // untouched: the helper pressed nothing, so the phone may try again.
  if (result.error) throw Object.assign(bad(`${result.error} Answer it on your Mac.`, 409), { retry: result.untouched === true });
  if (result.pressed !== choice) throw bad("The Claude app returned an unknown approval response. Check it on your Mac before answering again.", 409);
  return result;
}

export function createClaudeConsent({
  press,
  open,
  // The consent card a session waits on now ({ id }), or null.
  pending,
  shown = () => claudeAppShown(),
  wait = (ms) => new Promise((r) => setTimeout(r, ms)),
  switchMs = 1500,
  // The helper confirms the card closed; the transcript follows (reading a
  // long one takes a moment).
  confirmMs = 10000,
  // "Mac", "Windows PC" or "computer" in what the phone is told (computer-word.mjs).
  platform = process.platform,
}) {
  let busy = false;
  // Each pressed request: "answered" once confirmed, else "pressed".
  const attempted = new Map();
  return {
    owns: (promptId) => typeof promptId === "string" && promptId.startsWith("consent:"),
    async answer(id, promptId, { decision } = {}) {
      const choice = CONSENT_CHOICES[decision];
      if (!choice) throw bad("Choose Deny or Allow for this session.", 400);
      if (attempted.size >= 2048) throw bad(`Too many approval attempts. Answer on your ${computerWord(platform)}.`, 409);
      if (busy) throw bad("An answer is already being sent to the Claude app.", 409);
      const before = attempted.get(`${id}:${promptId}`);
      if (before === "answered") throw bad("This request was already answered.", 409);
      if (before) throw bad(`Reach already pressed an answer in the Claude app but couldn't confirm it. Check the card on your ${computerWord(platform)}.`, 409);
      busy = true;
      try {
      const asked = await pending(id);
      if (asked?.id !== promptId) throw bad("This request was already answered.", 409);
      // Drawn in its session's view: show that session first.
      const list = shown();
      if (list[0]?.id !== id) {
        const record = list.find((s) => s.id === id);
        if (!record) throw bad(`The Claude app doesn't list this session. Answer it on your ${computerWord(platform)}.`, 409);
        await open(`claude://code/continue?session=${record.session}`);
        await wait(switchMs);
      }
      if ((await pending(id))?.id !== promptId) throw bad("This request was already answered.", 409);
      if (shown()[0]?.id !== id) throw bad(`The Claude app is not showing this request. Answer it on your ${computerWord(platform)}.`, 409);
      attempted.set(`${id}:${promptId}`, "pressed");
      // The card says what Reach expects: "Allow Claude to use" and each app.
      try {
        await press(choice, ["Allow Claude to use", ...(asked.apps || [])]);
      } catch (e) {
        if (e?.retry) attempted.delete(`${id}:${promptId}`);
        throw e;
      }
      for (const until = Date.now() + confirmMs; Date.now() < until; await wait(150))
        if ((await pending(id))?.id !== promptId) {
          attempted.set(`${id}:${promptId}`, "answered");
          return { answered: true };
        }
      throw bad(`The Claude app did not confirm the answer. Answer it on your ${computerWord(platform)}.`, 409);
      } finally { busy = false; }
    },
  };
}
