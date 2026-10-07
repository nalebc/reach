import { exec } from "./platform.mjs";
import { fail } from "./core.mjs";

export const DOCUMENT_TEXT = /\.(docx?|rtf|odt)$/i;
const MAX_TEXT = 1024 * 1024;

// Plain text from a Word, RTF or OpenDocument file, for preview and copy.
// Read-only: the original document is never modified.
export async function readDocumentText(
  file,
  { run = exec, platform = process.platform } = {},
) {
  if (platform !== "darwin")
    throw fail(501, "Download this document to open it.");
  if (!DOCUMENT_TEXT.test(file))
    throw fail(415, "Download this file to open it.");
  try {
    const { stdout } = await run(
      "/usr/bin/textutil",
      ["-convert", "txt", "-encoding", "UTF-8", "-stdout", file],
      { timeout: 15000, maxBuffer: MAX_TEXT + 1 },
    );
    return String(stdout);
  } catch (e) {
    if (e?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER")
      throw fail(
        413,
        "This document is too long to preview. Download it instead.",
      );
    throw fail(415, "This document couldn’t be read. Download it to open it.");
  }
}
