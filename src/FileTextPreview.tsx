import { useMemo, useState, type ReactNode } from "react";
import { TextWrap } from "lucide-react";

// Shared Files reader. Plain logs need no syntax engine or lazy download.
export default function FileTextPreview({
  text,
  name,
  language = "plaintext",
  children,
}: {
  text: string;
  name: string;
  language?: string;
  children?: ReactNode;
}) {
  const [wrap, setWrap] = useState(false);
  const lines = useMemo(() => text.split("\n").length, [text]);
  const numbers = useMemo(
    () => Array.from({ length: lines }, (_, i) => String(i + 1)).join("\n"),
    [lines],
  );
  return (
    <div className={`file-code ${wrap ? "is-wrapped" : ""}`}>
      <div className="file-code-toolbar">
        <span>
          {language === "plaintext" ? "Plain text" : language} · {lines}{" "}
          {lines === 1 ? "line" : "lines"}
        </span>
        <button
          aria-label="Wrap lines"
          aria-pressed={wrap}
          onClick={() => setWrap((w) => !w)}
        >
          <TextWrap size={16} /> Wrap
        </button>
      </div>
      <div className="file-code-scroll">
        <div className="file-code-content">
          {!wrap && (
            <pre className="file-code-gutter" aria-hidden="true">
              {numbers}
            </pre>
          )}
          <pre
            className="file-code-source"
            tabIndex={0}
            aria-label={`${name} source`}
          >
            {children ?? <code>{text}</code>}
          </pre>
        </div>
      </div>
    </div>
  );
}
