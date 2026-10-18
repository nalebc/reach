// Editing a text file in Files. The computer writes back exactly the text it
// is sent (PUT /api/files/text), so the editor opens only a file it can give
// back unchanged apart from the edits: within the save limit, read as UTF-8
// byte for byte, and with one kind of line ending.

// The computer's limit for one save (server/index.mjs, PUT /api/files/text).
export const EDIT_LIMIT = 128 * 1024;
export const byteLength = (text: string) =>
  new TextEncoder().encode(text).length;

// A text box reads every line ending as "\n". A file using "\r\n" (Windows)
// gets it back on save; one mixing endings, or using a lone "\r", would
// change on lines nobody touched, so it isn't edited here.
export function lineEnding(text: string): "\n" | "\r\n" | null {
  const crlf = text.split("\r\n").length - 1;
  const lf = text.split("\n").length - 1 - crlf;
  if (/\r(?!\n)/.test(text) || (crlf && lf)) return null;
  return crlf ? "\r\n" : "\n";
}
export const forEditing = (text: string) => text.replace(/\r\n/g, "\n");
export function forSaving(draft: string, ending: "\n" | "\r\n") {
  const lines = draft.replace(/\r\n?/g, "\n");
  return ending === "\n" ? lines : lines.replace(/\n/g, "\r\n");
}

async function sha256(text: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// Whether `text` (read with its `hash`, the file's own bytes) can be edited
// here, and with which line ending it goes back. A file that isn't UTF-8
// reads with stand-in characters (U+FFFD): its hash differs from the text's,
// and saving would replace bytes nobody edited.
export type Editable = { ending: "\n" | "\r\n" } | { problem: string };
export async function editable(text: string, hash: string): Promise<Editable> {
  if (byteLength(text) > EDIT_LIMIT)
    return {
      problem:
        "Reach edits text files up to 128 KB. Download this one to edit it.",
    };
  const exact = await sha256(text).then(
    (h) => h === hash,
    () => false,
  );
  if (!exact)
    return {
      problem:
        "This file isn’t plain UTF-8 text, so saving it here could change characters you didn’t edit. Download it to edit it.",
    };
  const ending = lineEnding(text);
  if (!ending)
    return {
      problem:
        "This file mixes line endings, so saving it here would change lines you didn’t edit. Download it to edit it.",
    };
  return { ending };
}
