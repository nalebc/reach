import { memo, useMemo, useState } from "react";
import hljs from "highlight.js/lib/common";
import dart from "highlight.js/lib/languages/dart";
import powershell from "highlight.js/lib/languages/powershell";
import { WrapText } from "lucide-react";
import { extension } from "./file-kinds";

hljs.registerLanguage("dart", dart);
hljs.registerLanguage("powershell", powershell);

const languages: Record<string, string> = {
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "javascript",
  ts: "typescript",
  tsx: "typescript",
  py: "python",
  rb: "ruby",
  rs: "rust",
  kt: "kotlin",
  h: "c",
  cc: "cpp",
  hpp: "cpp",
  cs: "csharp",
  sh: "bash",
  ps1: "powershell",
  zsh: "bash",
  html: "xml",
  htm: "xml",
  vue: "xml",
  svelte: "xml",
  yml: "yaml",
  toml: "ini",
  md: "markdown",
  ipynb: "json",
};

export function codeLanguage(name: string) {
  const ext = extension(name);
  const language = languages[ext] || ext;
  if (hljs.getLanguage(language)) return language;
  if (/^(makefile|dockerfile)$/i.test(name))
    return name.toLowerCase() === "makefile" ? "makefile" : "bash";
  return "plaintext";
}

// Highlight.js escapes file bytes before adding its own spans. Files never
// become executable HTML. Bound parsing work for large text previews.
export const CodeText = memo(function CodeText({
  text,
  language,
}: {
  text: string;
  language: string;
}) {
  const html = useMemo(() => {
    if (text.length > 200_000 || !hljs.getLanguage(language)) return null;
    try {
      return hljs.highlight(text, { language, ignoreIllegals: true }).value;
    } catch {
      return null;
    }
  }, [text, language]);
  return html === null ? (
    <code>{text}</code>
  ) : (
    <code dangerouslySetInnerHTML={{ __html: html }} />
  );
});

export default function FileCode({
  text,
  name,
}: {
  text: string;
  name: string;
}) {
  const [wrap, setWrap] = useState(false);
  const language = codeLanguage(name);
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
          <WrapText size={16} /> Wrap
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
            <CodeText text={text} language={language} />
          </pre>
        </div>
      </div>
    </div>
  );
}
