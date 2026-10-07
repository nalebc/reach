// Only bundled font/CMap names can be requested by a PDF. Never concatenate a
// document-controlled filename into a network URL.
const bundled = {
  ...import.meta.glob("/node_modules/pdfjs-dist/cmaps/*.bcmap", {
    eager: true,
    query: "?url&no-inline",
    import: "default",
  }),
  ...import.meta.glob("/node_modules/pdfjs-dist/standard_fonts/*.{pfb,ttf}", {
    eager: true,
    query: "?url&no-inline",
    import: "default",
  }),
} as Record<string, string>;
const maps = new Map(
  Object.entries(bundled).map(([path, url]) => [
    `${path.includes("/cmaps/") ? "cMapUrl" : "standardFontDataUrl"}:${path.split("/").at(-1)}`,
    url,
  ]),
);

export class PdfBinaryDataFactory {
  async fetch({ kind, filename }: { kind: string; filename: string }) {
    const url = maps.get(`${kind}:${filename}`);
    if (!url)
      throw new Error(
        "This PDF requests an unsupported font or character map.",
      );
    if (new URL(url, location.href).origin !== location.origin)
      throw new Error("PDF assets must come from this app.");
    const response = await fetch(url, {
      credentials: "omit",
      redirect: "error",
    });
    if (!response.ok) throw new Error("A PDF preview asset could not load.");
    return new Uint8Array(await response.arrayBuffer());
  }
}

// PDF.js' non-Wasm image decoder imports only its fixed, bundled JS fallback
// names. The build emits those two assets without a CDN or eval permission.
export const pdfFallbackUrl = new URL(
  import.meta.env.DEV
    ? "/node_modules/pdfjs-dist/wasm/"
    : `${import.meta.env.BASE_URL}pdfjs/`,
  location.href,
).href;
