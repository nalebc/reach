import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Loader2 } from "lucide-react";
import {
  AnnotationMode,
  PDFWorker,
  getDocument,
  type PDFDocumentProxy,
  type PDFDocumentLoadingTask,
  type RenderTask,
} from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { PdfBinaryDataFactory, pdfFallbackUrl } from "./pdf-assets";

const MAX_PIXELS = 8_000_000;
const TIMEOUT_MS = 15_000;
function bounded<T>(promise: Promise<T>, stop: () => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        stop();
        reject(new Error("PDF preview took too long. Download it instead."));
      }, TIMEOUT_MS);
    }),
  ]).finally(() => clearTimeout(timer));
}

export default function FilePdf({ blob, name }: { blob: Blob; name: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const stop = useRef<() => void>(() => {});
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null);
  const [page, setPage] = useState(1);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    let worker: Worker | undefined;
    let bridge: PDFWorker | undefined;
    let task: PDFDocumentLoadingTask | undefined;
    const destroy = () => {
      void task?.destroy().catch(() => {});
      bridge?.destroy();
      worker?.terminate();
    };
    stop.current = destroy;
    setDocument(null);
    setPage(1);
    setBusy(true);
    setError("");
    (async () => {
      try {
        const data = new Uint8Array(await blob.arrayBuffer());
        if (!active) return;
        // An explicit Worker port prevents PDF.js from falling back to parsing
        // hostile/complex files on the UI thread when workers are unavailable.
        worker = new Worker(workerUrl, { type: "module" });
        bridge = PDFWorker.create({ port: worker });
        task = getDocument({
          data,
          worker: bridge,
          useWorkerFetch: false,
          useWasm: false,
          BinaryDataFactory: PdfBinaryDataFactory,
          wasmUrl: pdfFallbackUrl,
          maxImageSize: MAX_PIXELS,
          canvasMaxAreaInBytes: MAX_PIXELS * 4,
          enableXfa: false,
          stopAtErrors: true,
          useSystemFonts: true,
          // No PDF scripting manager, HTML annotation layer, or XFA renderer
          // is loaded. PDF.js 6 removed the old isEvalSupported API option.
        });
        const pdf = await bounded(task.promise, destroy);
        if (!active) return;
        if (pdf.numPages < 1 || pdf.numPages > 1000)
          throw new Error(
            "This PDF has too many pages to preview. Download it instead.",
          );
        setDocument(pdf);
      } catch (failure) {
        if (!active) return;
        destroy();
        setError(
          (failure as Error).name === "PasswordException"
            ? "This PDF needs a password. Download it to open it."
            : "This PDF could not be previewed. Download it instead.",
        );
        setBusy(false);
      }
    })();
    return () => {
      active = false;
      destroy();
    };
  }, [blob]);

  useEffect(() => {
    if (!document) return;
    let active = true;
    let render: RenderTask | undefined;
    const stopDocument = stop.current;
    setBusy(true);
    setError("");
    (async () => {
      try {
        const selected = await bounded(document.getPage(page), stopDocument);
        if (!active || !canvas.current) return;
        const natural = selected.getViewport({ scale: 1 });
        if (
          ![natural.width, natural.height].every(
            (value) => Number.isFinite(value) && value > 0,
          )
        )
          throw new Error("Invalid PDF page size.");
        const ratio = Math.min(window.devicePixelRatio || 1, 2);
        const width = Math.min(viewport.current?.clientWidth || 800, 1200);
        const scale = Math.min(
          (width * ratio) / natural.width,
          4096 / natural.width,
          4096 / natural.height,
          Math.sqrt(MAX_PIXELS / (natural.width * natural.height)),
        );
        const dimensions = selected.getViewport({ scale });
        canvas.current.width = Math.max(1, Math.floor(dimensions.width));
        canvas.current.height = Math.max(1, Math.floor(dimensions.height));
        canvas.current.style.width = `${dimensions.width / ratio}px`;
        const context = canvas.current.getContext("2d");
        if (!context) throw new Error("Canvas is unavailable.");
        render = selected.render({
          canvas: canvas.current,
          canvasContext: context,
          viewport: dimensions,
          annotationMode: AnnotationMode.DISABLE,
        });
        await bounded(render.promise, () => {
          render?.cancel();
          stopDocument();
        });
        selected.cleanup();
        if (active) setBusy(false);
      } catch {
        if (!active) return;
        stopDocument();
        setError("This PDF could not be previewed. Download it instead.");
        setBusy(false);
      }
    })();
    return () => {
      active = false;
      render?.cancel();
    };
  }, [document, page]);

  return (
    <section className="file-pdf" aria-label={`PDF preview: ${name}`}>
      {document && !error && (
        <nav className="file-pdf-pages" aria-label="PDF pages">
          <button
            className="files-tool"
            aria-label="Previous PDF page"
            disabled={busy || page <= 1}
            onClick={() => setPage((value) => value - 1)}
          >
            <ChevronLeft size={18} />
          </button>
          <span aria-live="polite">
            Page {page} of {document.numPages}
          </span>
          <button
            className="files-tool"
            aria-label="Next PDF page"
            disabled={busy || page >= document.numPages}
            onClick={() => setPage((value) => value + 1)}
          >
            <ChevronRight size={18} />
          </button>
        </nav>
      )}
      {error ? (
        <p role="alert">{error}</p>
      ) : (
        <div className="file-pdf-page" ref={viewport}>
          {busy && (
            <Loader2
              className="spin"
              size={24}
              aria-label="Rendering PDF page"
            />
          )}
          <canvas
            ref={canvas}
            hidden={busy}
            role="img"
            aria-label={`${name}, page ${page}`}
          />
        </div>
      )}
    </section>
  );
}
