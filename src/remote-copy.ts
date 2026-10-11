// What the computer's clipboard takes in one go: 16 KB (bytes, not characters).
export const CLIPBOARD_BYTES = 16384;
/** Cut text to fit `max` UTF-8 bytes, never through the middle of a character. */
export function fitBytes(text: string, max = CLIPBOARD_BYTES) {
  const encoder = new TextEncoder();
  if (encoder.encode(text).length <= max) return text;
  let bytes = 0,
    end = 0;
  for (const char of text) {
    bytes += encoder.encode(char).length;
    if (bytes > max) break;
    end += char.length;
  }
  return text.slice(0, end);
}

/** Start the browser clipboard write inside the original tap, before the network reply. */
export async function copyRemoteSelection(
  read: () => Promise<string>,
  clipboard: Pick<Clipboard, "write"> | undefined = navigator.clipboard,
  Item: typeof ClipboardItem | undefined = globalThis.ClipboardItem,
) {
  const selected = read().then((text) => {
    if (!text) throw Error("Select some text on your laptop first.");
    return text;
  });
  // Attach a rejection handler even if the browser rejects clipboard access first.
  void selected.catch(() => {});
  try {
    if (!clipboard?.write || !Item)
      throw Error("Clipboard access is unavailable.");
    const blob = selected.then(
      (text) => new Blob([text], { type: "text/plain" }),
    );
    void blob.catch(() => {});
    await clipboard.write([new Item({ "text/plain": blob })]);
    return { copied: true, text: "" };
  } catch {
    // Native text selection remains available if a browser denies clipboard writes.
    return { copied: false, text: await selected };
  }
}
