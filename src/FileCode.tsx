import { memo, useMemo } from "react";
import hljs from "highlight.js/lib/common";
import dart from "highlight.js/lib/languages/dart";
import powershell from "highlight.js/lib/languages/powershell";
import FileTextPreview from "./FileTextPreview";
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
  return (
    <FileTextPreview text={text} name={name} language={codeLanguage(name)}>
      <CodeText text={text} language={codeLanguage(name)} />
    </FileTextPreview>
  );
}
