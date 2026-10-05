import type { DesktopAction, InputResult } from "./desktop-input-queue";

// Paste what's on this phone where the cursor is on the computer: the text
// goes onto the computer's clipboard, then ⌘V (ctrl+V on Windows) pastes it.
// `reading` must be started inside the tap (navigator.clipboard.readText()):
// phones refuse clipboard reads that come later.
export const PASTE_LIMIT = 16000;
export async function pasteFromPhone(
  reading: Promise<string>,
  send: (action: DesktopAction) => Promise<InputResult>,
  platform: string,
): Promise<"pasted" | "empty"> {
  let text: string;
  try {
    text = await reading;
  } catch {
    throw Error(
      "Allow pasting from this phone (tap Paste when it asks), then try again.",
    );
  }
  if (!text) return "empty";
  if (new TextEncoder().encode(text).length > PASTE_LIMIT)
    throw Error("That's too long to paste in one go (16 KB at most).");
  await send({ type: "clipboard-write", text });
  await send({
    type: "key",
    key: "v",
    modifiers: [platform === "win32" ? "control" : "meta"],
  });
  return "pasted";
}
