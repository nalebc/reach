// The real app and chrome, with only synthetic file data for responsive QA.
await import("./entry");
const sampleMarkdown = `# Project notes

A private workspace for your computers. This paragraph should stay readable on a phone and wrap to its width, even with a long path like /Projects/Reach/a-very-long-folder-name/another-long-folder-name/README.md.

## Next steps

- [x] Browse files
- [ ] Review the code
  - Syntax highlighting
  - Line numbers

> Everything you need, within reach.

| Feature | Expected behavior on a phone | Status |
| --- | --- | --- |
| Markdown | Readable text that fits the phone | **Ready** |
| Code view | Preserves indentation and scrolls sideways | Ready |

## A wide table

| ExtremelyLongUnbrokenColumnHeaderForTestingPhoneSizing | AnotherLongUnbrokenColumnHeaderForTesting | ThirdLongColumnHeaderForTesting |
| --- | --- | --- |
| Scroll this table sideways | Keep the page at phone width | Read at normal size |

\`\`\`typescript
const message = "A long code line should scroll inside its own block without making all the Markdown look zoomed out on a phone.";
console.log(message);
\`\`\`

---

**Bold**, *italic*, ~~completed~~ and [a web link](https://example.com).
`;
const sampleCode = `// Reach code preview
import { useState } from "react";

type Project = { name: string; files: number };

export function ProjectCard({ project }: { project: Project }) {
  const [selected, setSelected] = useState(false);
  const description = "This deliberately long code line verifies horizontal scrolling without squeezing or shrinking the entire phone interface.";

  return (
    <button onClick={() => setSelected(!selected)}>
      {project.name}: {project.files} files
    </button>
  );
}
`;
const contents: Record<string, string> = {
  "Project notes.md": sampleMarkdown,
  "ProjectCard.tsx": sampleCode,
};
const now = new Date().toISOString();
const files = [
  "Project notes.md",
  "ProjectCard.tsx",
  "Photos.zip",
  "Backup.zip",
  "Designs",
].map((name) => ({
  name,
  path: name,
  type: name === "Designs" ? "directory" : "file",
  size: contents[name]?.length || 4096,
  modified: now,
}));
const demoFetch = window.fetch;
window.fetch = async (input, init) => {
  const url = new URL(
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url,
    location.href,
  );
  if (url.pathname === "/api/files") return Response.json({ items: files });
  if (url.pathname === "/api/files/text")
    return Response.json({
      text: contents[url.searchParams.get("path") || ""] || "",
      truncated: false,
    });
  if (url.pathname === "/api/files/extract") {
    const { path } = JSON.parse(String(init?.body));
    const name = String(path).replace(/\.zip$/, "");
    if (!files.some((f) => f.name === name))
      files.push({
        name,
        path: name,
        type: "directory",
        size: 0,
        modified: now,
      });
    return Response.json({ name });
  }
  return demoFetch(input, init);
};
export {};
