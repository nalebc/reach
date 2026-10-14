import fs from "node:fs/promises";
import yauzl from "yauzl";
import { exec } from "./platform.mjs";
import { fail } from "./core.mjs";

export const DOCUMENT_TEXT = /\.(docx?|rtf|odt)$/i;
const MAX_TEXT = 1024 * 1024;
// Shared across requests and Reach instances: a burst of previews must not
// create one native converter per request. The existing deadline bounds how
// long a reservation lives; no queue retains work after the caller leaves.
const MAX_CONVERSIONS = 2;
let conversions = 0;

// Plain text from a Word, RTF or OpenDocument file, for preview and copy.
// Read-only: the original document is never modified.
export async function readDocumentText(
  file,
  { run = exec, platform = process.platform, read = (f) => fs.readFile(f) } = {},
) {
  if (!DOCUMENT_TEXT.test(file))
    throw fail(415, "Download this file to open it.");
  // Elsewhere than a Mac (no textutil): Word, RTF and OpenDocument read here;
  // Word 97–2003's .doc needs Word itself.
  if (platform !== "darwin") {
    if (/\.doc$/i.test(file)) throw fail(501, "Download this document to open it.");
    if (conversions >= MAX_CONVERSIONS)
      throw fail(429, "Two documents are already being previewed. Try again when one finishes.");
    conversions++;
    try {
      return await documentTextHere(file, read);
    } finally {
      conversions--;
    }
  }
  if (conversions >= MAX_CONVERSIONS)
    throw fail(429, "Two documents are already being previewed. Try again when one finishes.");
  conversions++;
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
  } finally {
    conversions--;
  }
}

// What a computer without textutil reads itself: Word (.docx) and
// OpenDocument (.odt) are zip files whose text is XML, RTF is text with
// control words. Within the same limits as textutil's preview.
const MAX_FILE = 50 * 1024 * 1024;
const MAX_PART = 64 * 1024 * 1024;
const unreadable = () => fail(415, "This document couldn\u2019t be read. Download it to open it.");
const tooLong = () => fail(413, "This document is too long to preview. Download it instead.");
async function documentTextHere(file, read) {
  let bytes;
  try {
    bytes = await read(file);
  } catch {
    throw unreadable();
  }
  if (bytes.length > MAX_FILE) throw tooLong();
  let text;
  if (/\.rtf$/i.test(file)) text = rtfText(bytes.toString("latin1"));
  else {
    const part = /\.odt$/i.test(file) ? "content.xml" : "word/document.xml";
    const xml = await zipPart(bytes, part);
    if (xml == null) throw unreadable();
    text = /\.odt$/i.test(file) ? odtText(xml) : docxText(xml);
  }
  if (Buffer.byteLength(text) > MAX_TEXT) throw tooLong();
  return text;
}
async function zipPart(bytes, name) {
  let zip;
  try {
    zip = await yauzl.fromBufferPromise(bytes, { strictFileNames: false, validateEntrySizes: true });
  } catch {
    throw unreadable();
  }
  try {
    for await (const entry of zip.eachEntry()) {
      if (entry.fileName !== name) continue;
      if (entry.isEncrypted() || !entry.canDecodeFileData()) throw unreadable();
      if (entry.uncompressedSize > MAX_PART) throw tooLong();
      const stream = await zip.openReadStreamPromise(entry);
      const chunks = [];
      let size = 0;
      for await (const chunk of stream) {
        size += chunk.length;
        if (size > MAX_PART) throw tooLong();
        chunks.push(chunk);
      }
      return Buffer.concat(chunks).toString("utf8");
    }
    return null;
  } catch (error) {
    throw error?.status ? error : unreadable();
  } finally {
    zip.close();
  }
}
const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const decode = (text) =>
  text.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]+);/gi, (whole, name) => {
    if (name[0] !== "#") return ENTITIES[name] ?? whole;
    const code = name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : "";
  });
// Each tag, or the text between tags, in order.
const TOKEN = /<(\/?)([\w:.-]+)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[([\s\S]*?)\]\]>|([^<]+)/g;
// Word: the text of its runs (w:t), a line per paragraph, its tabs and breaks.
export function docxText(xml) {
  let out = "",
    inText = 0;
  for (const m of xml.matchAll(TOKEN)) {
    const [, closing, tag, , self, cdata, text] = m;
    if (text !== undefined || cdata !== undefined) {
      if (inText) out += cdata ?? decode(text);
    } else if (tag === "w:t") {
      if (!self) inText += closing ? -1 : 1;
      inText = Math.max(0, inText);
    } else if (tag === "w:p" && closing) out += "\n";
    else if (tag === "w:tab" && !closing) out += "\t";
    else if ((tag === "w:br" || tag === "w:cr") && !closing) out += "\n";
  }
  return out;
}
// OpenDocument: everything in its body's paragraphs and headings, a line
// each, with its spaces, tabs and line breaks.
export function odtText(xml) {
  let out = "",
    body = 0;
  for (const m of xml.matchAll(TOKEN)) {
    const [, closing, tag, attributes, self, cdata, text] = m;
    if (text !== undefined || cdata !== undefined) {
      if (body) out += cdata ?? decode(text);
      continue;
    }
    if (tag === "office:body" && !self) body += closing ? -1 : 1;
    if (!body) continue;
    if ((tag === "text:p" || tag === "text:h") && (closing || self)) out += "\n";
    else if (tag === "text:tab" && !closing) out += "\t";
    else if (tag === "text:line-break" && !closing) out += "\n";
    else if (tag === "text:s" && !closing) {
      const count = Number(/text:c\s*=\s*["'](\d{1,4})["']/.exec(attributes || "")?.[1] || 1);
      out += " ".repeat(Math.min(count, 1000));
    }
  }
  return out;
}
// Groups whose words aren't the document's text.
const SKIP = new Set(["fonttbl", "colortbl", "stylesheet", "info", "pict", "object", "header", "headerl", "headerr", "headerf", "footer", "footerl", "footerr", "footerf", "listtable", "listoverridetable", "rsidtbl", "generator", "xmlnstbl", "themedata", "colorschememapping", "datastore", "latentstyles", "fldinst", "filetbl", "revtbl", "pgdsctbl", "mmathPr", "nonshppict", "shpinst", "bkmkstart", "bkmkend", "fchars", "lchars", "xe", "tc"]);
const SYMBOLS = { emdash: "\u2014", endash: "\u2013", bullet: "\u2022", lquote: "\u2018", rquote: "\u2019", ldblquote: "\u201c", rdblquote: "\u201d", emspace: "\u2003", enspace: "\u2002" };
// RTF: the text, its paragraphs and tabs, \'hh in the document's code page,
// \uN in Unicode (its fallback characters skipped).
export function rtfText(rtf) {
  let out = "",
    skipping = false,
    uc = 1,
    fallback = 0,
    decoder = new TextDecoder("windows-1252");
  const stack = [];
  const add = (text) => {
    if (skipping) return;
    if (fallback > 0) fallback--;
    else out += text;
  };
  for (let i = 0; i < rtf.length; ) {
    const c = rtf[i];
    if (c === "{") {
      stack.push({ skipping, uc });
      i++;
    } else if (c === "}") {
      ({ skipping, uc } = stack.pop() || { skipping: false, uc: 1 });
      fallback = 0;
      i++;
    } else if (c === "\\") {
      const next = rtf[i + 1];
      if (next === "\\" || next === "{" || next === "}") {
        add(next);
        i += 2;
      } else if (next === "'") {
        const byte = parseInt(rtf.slice(i + 2, i + 4), 16);
        if (!Number.isNaN(byte)) add(decoder.decode(Uint8Array.of(byte)));
        i += 4;
      } else if (next === "*") {
        skipping = true;
        i += 2;
      } else if (next === "~") {
        add("\u00a0");
        i += 2;
      } else if (next === "_") {
        add("-");
        i += 2;
      } else {
        const m = /^\\([a-zA-Z]{1,32})(-?\d{1,10})? ?/.exec(rtf.slice(i, i + 48));
        if (!m) {
          i += 2;
          continue;
        }
        i += m[0].length;
        const [, word, number] = m;
        const arg = number === undefined ? null : Number(number);
        if (SKIP.has(word)) skipping = true;
        else if (word === "ansicpg" && arg)
          try {
            decoder = new TextDecoder(`windows-${arg}`);
          } catch {
            /* a code page Node doesn't know: windows-1252 */
          }
        else if (word === "uc" && arg !== null) uc = Math.max(0, arg);
        else if (skipping) continue;
        else if (word === "par" || word === "line" || word === "sect" || word === "page" || word === "row") out += "\n";
        else if (word === "tab" || word === "cell") out += "\t";
        else if (word === "u" && arg !== null) {
          out += String.fromCharCode(arg < 0 ? arg + 65536 : arg);
          fallback = uc;
        } else if (SYMBOLS[word]) add(SYMBOLS[word]);
      }
    } else {
      if (c !== "\r" && c !== "\n") add(c);
      i++;
    }
  }
  return out;
}
