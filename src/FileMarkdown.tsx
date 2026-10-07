import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { CodeText } from "./FileCode";

// Full file Markdown, including nested lists, tasks, quotes and tables.
// Raw HTML stays text, and images stay labels rather than loading remote URLs.
export default function FileMarkdown({ text }: { text: string }) {
  return (
    <div className="file-viewer-markdown">
      <div className="md">
        <Markdown
          remarkPlugins={[remarkGfm]}
          urlTransform={(url) =>
            /^https?:\/\/[^\s"<>]+$/i.test(url) ? url : ""
          }
          components={{
            a: ({ href, children }) =>
              href ? (
                <a href={href} target="_blank" rel="noopener noreferrer">
                  {children}
                </a>
              ) : (
                <span>{children}</span>
              ),
            img: ({ alt }) => <span>{alt || "Image"}</span>,
            table: ({ children }) => (
              <div className="md-table">
                <table>{children}</table>
              </div>
            ),
            code: ({ className, children }) => {
              const language = /language-([\w-]+)/.exec(className || "")?.[1];
              return language ? (
                <CodeText text={String(children)} language={language} />
              ) : (
                <code>{children}</code>
              );
            },
          }}
        >
          {text}
        </Markdown>
      </div>
    </div>
  );
}
