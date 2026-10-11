import { createContext, Fragment, memo, useContext, useState, type ReactNode } from "react";

// A link to another Claude session, as the Claude app writes them
// ("[title](#local_<id>)"): the chat that shows this message opens that
// session here, when it's one of this Mac's. Without a provider (OpenClaw's
// space) the link shows as text, like any other link into an app.
export const SessionLinkContext = createContext<
  ((appSessionId: string) => boolean) | null
>(null);
const SESSION_LINK = /^#?(local_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
function SessionLink({ id, children }: { id: string; children: ReactNode }) {
  const open = useContext(SessionLinkContext);
  // Tapped, but that session isn't on this Mac yet (Reach reads the Claude
  // app's sessions every little while): said once, on the link.
  const [missing, setMissing] = useState(false);
  if (!open) return <u>{children}</u>;
  return (
    <button
      type="button"
      className="md-session-link"
      onClick={() => setMissing(!open(id))}
    >
      {children}
      {missing && <small> · not here yet</small>}
    </button>
  );
}

// The little markdown agents write: code blocks, inline code, bold, lists,
// headings and tables. Rendered as React elements only; nothing becomes HTML.
// Secure web links open in a new tab, as in both apps; any other link (plain
// http, a file path, a relative address that would land inside Reach) shows
// only its text.
function inline(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  const pattern = /`([^`\n]+)`|\*\*([^*\n]+)\*\*|\[([^\]\n]+)\]\(([^)\s]+)\)/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index! > last) out.push(text.slice(last, match.index));
    const k = `${key}-${match.index}`;
    if (match[1] !== undefined) out.push(<code key={k}>{match[1]}</code>);
    else if (match[2] !== undefined) out.push(<strong key={k}>{match[2]}</strong>);
    else if (/^https:\/\/[^\s"<>]+$/i.test(match[4]))
      out.push(
        <a key={k} href={match[4]} target="_blank" rel="noopener noreferrer">
          {match[3]}
        </a>,
      );
    else if (SESSION_LINK.test(match[4]))
      out.push(
        <SessionLink key={k} id={match[4].replace(/^#/, "")}>
          {match[3]}
        </SessionLink>,
      );
    else out.push(<u key={k}>{match[3]}</u>);
    last = match.index! + match[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

// A table's cells: "| a | b |" (outer pipes optional, "\|" is a pipe).
const cells = (line: string) =>
  line
    .trim()
    .replace(/^\|/, "")
    .replace(/(?<!\\)\|$/, "")
    .split(/(?<!\\)\|/)
    .map((c) => c.trim().replace(/\\\|/g, "|"));
const SEPARATOR = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;
// A header row with "|", then "|---|:--:|" under it (Claude's /context, its
// comparisons): it showed as raw pipes.
const tableAt = (lines: string[], i: number) =>
  lines[i].includes("|") &&
  i + 1 < lines.length &&
  SEPARATOR.test(lines[i + 1]) &&
  cells(lines[i]).length === cells(lines[i + 1]).length;

function blocks(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  const lines = text.split("\n");
  let i = 0;
  const list = (ordered: boolean) => {
    const pattern = ordered ? /^\s*\d+[.)]\s+(.*)$/ : /^\s*[-*•]\s+(.*)$/;
    const items: string[] = [];
    while (i < lines.length && pattern.test(lines[i])) items.push(lines[i++].match(pattern)![1]);
    const Tag = ordered ? "ol" : "ul";
    out.push(
      <Tag key={`${key}-${i}`}>
        {items.map((item, n) => (
          <li key={n}>{inline(item, `${key}-${i}-${n}`)}</li>
        ))}
      </Tag>,
    );
  };
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
    } else if (tableAt(lines, i)) {
      const start = i;
      const head = cells(lines[i]);
      const align = cells(lines[i + 1]).map((c) =>
        c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : undefined,
      );
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) rows.push(cells(lines[i++]));
      const k = `${key}-${start}`;
      out.push(
        <div key={k} className="md-table">
          <table>
            <thead>
              <tr>
                {head.map((h, n) => (
                  <th key={n} style={align[n] ? { textAlign: align[n] } : undefined}>
                    {inline(h, `${k}-h${n}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, r) => (
                <tr key={r}>
                  {head.map((_, n) => (
                    <td key={n} style={align[n] ? { textAlign: align[n] } : undefined}>
                      {inline(row[n] || "", `${k}-${r}-${n}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
    } else if (/^#{1,6}\s/.test(line)) {
      // "#", "##" and "###" and deeper at three sizes, as the apps draw them.
      const level = Math.min(3, line.match(/^#+/)![0].length);
      out.push(
        <h4 key={`${key}-${i}`} className={`md-h${level}`}>
          {inline(line.replace(/^#+\s*/, ""), `${key}-${i}`)}
        </h4>,
      );
      i++;
    } else if (/^\s*[-*•]\s+/.test(line)) list(false);
    else if (/^\s*\d+[.)]\s+/.test(line)) list(true);
    else {
      const start = i;
      const para: string[] = [];
      while (
        i < lines.length &&
        lines[i].trim() &&
        !/^#{1,6}\s/.test(lines[i]) &&
        !/^\s*([-*•]|\d+[.)])\s+/.test(lines[i]) &&
        !(i > start && tableAt(lines, i))
      )
        para.push(lines[i++]);
      out.push(<p key={`${key}-${start}`}>{inline(para.join("\n"), `${key}-${start}`)}</p>);
    }
  }
  return out;
}

function AgentMarkdown({ text }: { text: string }) {
  const parts = text.split(/^```[^\n]*\n?/m);
  return (
    <div className="md">
      {parts.map((part, i) =>
        i % 2 ? (
          <pre key={i}>
            <code>{part.replace(/\n$/, "")}</code>
          </pre>
        ) : (
          <Fragment key={i}>{blocks(part, String(i))}</Fragment>
        ),
      )}
    </div>
  );
}

// Drawn again only when its text changes: a chat redraws on every update,
// keystroke and stream delta, and parsing every message each time made long
// chats stutter.
export default memo(AgentMarkdown);
