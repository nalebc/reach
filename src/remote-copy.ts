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
