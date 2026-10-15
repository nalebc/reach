// A saved tool's receipt snapshot as a PDF on Windows (docs/parity/G-browser-tools.md),
// where a Mac draws it with Core Text (scripts/native/tool-receipt.swift):
// the same input ({text, source}, an https source), the same heading, plain
// text only, at most 100 pages, base64 out. No HTML, scripts, network or
// browser files; nothing is run. Courier, one of PDF's standard fonts (nothing
// embedded), in Windows' Western code page: a character outside it is "?".
const PAGE = { width: 612, height: 792, margin: 36, size: 10, leading: 12 };
const COLUMNS = Math.floor((PAGE.width - 2 * PAGE.margin) / (PAGE.size * 0.6));
const LINES = Math.floor((PAGE.height - 2 * PAGE.margin) / PAGE.leading);
const WIN_ANSI = new Map([
  ["€", 0x80], ["‚", 0x82], ["ƒ", 0x83], ["„", 0x84], ["…", 0x85], ["†", 0x86], ["‡", 0x87], ["ˆ", 0x88], ["‰", 0x89],
  ["Š", 0x8a], ["‹", 0x8b], ["Œ", 0x8c], ["Ž", 0x8e], ["‘", 0x91], ["’", 0x92], ["“", 0x93], ["”", 0x94], ["•", 0x95],
  ["–", 0x96], ["—", 0x97], ["˜", 0x98], ["™", 0x99], ["š", 0x9a], ["›", 0x9b], ["œ", 0x9c], ["ž", 0x9e], ["Ÿ", 0x9f],
]);
const byte = (char) => {
  const code = char.codePointAt(0);
  if ((code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff)) return code;
  return WIN_ANSI.get(char) ?? 0x3f;
};
// Lines that fit the page's width, broken at spaces where they can be.
function wrap(text) {
  const out = [];
  for (const raw of text.replace(/\r\n?/g, "\n").replace(/\t/g, "    ").split("\n")) {
    let line = [...raw];
    while (line.length > COLUMNS) {
      let cut = line.lastIndexOf(" ", COLUMNS);
      if (cut <= 0) cut = COLUMNS;
      out.push(line.slice(0, cut).join(""));
      line = line.slice(line[cut] === " " ? cut + 1 : cut);
    }
    out.push(line.join(""));
  }
  return out;
}
const literal = (line) => {
  const bytes = [...line].map(byte);
  let text = "";
  for (const value of bytes) {
    if (value === 0x28 || value === 0x29 || value === 0x5c) text += `\\${String.fromCharCode(value)}`;
    else if (value < 0x20 || value > 0x7e) text += `\\${value.toString(8).padStart(3, "0")}`;
    else text += String.fromCharCode(value);
  }
  return `(${text})`;
};

export function receiptPdf({ text, source } = {}) {
  let url;
  try {
    url = new URL(source);
  } catch {
    url = null;
  }
  if (typeof text !== "string" || typeof source !== "string" || !url || url.protocol !== "https:" || Buffer.byteLength(JSON.stringify({ text, source })) > 262144)
    throw Object.assign(Error("The receipt PDF could not be made."), { code: "pdf_failed" });
  const lines = wrap(`Receipt snapshot\nSource: ${source}\n\n${text}`);
  const pages = [];
  for (let at = 0; at < lines.length; at += LINES) pages.push(lines.slice(at, at + LINES));
  if (pages.length > 100) throw Object.assign(Error("The receipt is too long for a PDF."), { code: "pdf_failed" });
  // Objects: 1 catalog, 2 pages, 3 font, then a page and its content each.
  const objects = [];
  const kids = pages.map((_, index) => `${4 + index * 2} 0 R`).join(" ");
  objects.push("<< /Type /Catalog /Pages 2 0 R >>");
  objects.push(`<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`);
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>");
  for (const [index, page] of pages.entries()) {
    const top = PAGE.height - PAGE.margin - PAGE.size;
    const body = [`BT /F1 ${PAGE.size} Tf ${PAGE.leading} TL ${PAGE.margin} ${top} Td`, ...page.map((line) => `${literal(line)} Tj T*`), "ET"].join("\n");
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE.width} ${PAGE.height}] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + index * 2} 0 R >>`);
    objects.push(`<< /Length ${Buffer.byteLength(body, "latin1")} >>\nstream\n${body}\nendstream`);
  }
  let out = "%PDF-1.4\n%\xe2\xe3\xcf\xd3\n";
  const offsets = [];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(out, "latin1"));
    out += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1").toString("base64");
}
