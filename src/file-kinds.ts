// What a file is, from its name: drives the icon, colour and label in Files.
export type FileKind =
  | "folder"
  | "image"
  | "video"
  | "audio"
  | "pdf"
  | "archive"
  | "code"
  | "sheet"
  | "slides"
  | "doc"
  | "text"
  | "package"
  | "file";

const extensions: [FileKind, string[]][] = [
  [
    "image",
    [
      "png",
      "jpg",
      "jpeg",
      "gif",
      "webp",
      "heic",
      "heif",
      "svg",
      "tif",
      "tiff",
      "bmp",
      "ico",
      "avif",
      "raw",
      "psd",
    ],
  ],
  [
    "video",
    ["mov", "mp4", "m4v", "avi", "mkv", "webm", "wmv", "flv", "mpg", "mpeg"],
  ],
  [
    "audio",
    [
      "mp3",
      "wav",
      "m4a",
      "aac",
      "flac",
      "ogg",
      "aif",
      "aiff",
      "opus",
      "mid",
      "midi",
    ],
  ],
  ["pdf", ["pdf"]],
  ["archive", ["zip", "rar", "7z", "tar", "gz", "tgz", "bz2", "xz", "zst"]],
  [
    "code",
    [
      "js",
      "mjs",
      "cjs",
      "ts",
      "tsx",
      "jsx",
      "py",
      "rb",
      "go",
      "rs",
      "java",
      "kt",
      "swift",
      "c",
      "h",
      "cc",
      "cpp",
      "hpp",
      "cs",
      "php",
      "sh",
      "zsh",
      "bash",
      "ps1",
      "css",
      "scss",
      "html",
      "htm",
      "vue",
      "svelte",
      "json",
      "yml",
      "yaml",
      "toml",
      "xml",
      "sql",
      "lua",
      "dart",
      "r",
      "ipynb",
    ],
  ],
  ["sheet", ["xlsx", "xls", "csv", "tsv", "numbers", "ods"]],
  ["slides", ["key", "ppt", "pptx", "odp"]],
  ["doc", ["doc", "docx", "pages", "rtf", "odt", "epub"]],
  ["text", ["txt", "md", "markdown", "log", "ini", "cfg", "conf", "env"]],
  [
    "package",
    ["dmg", "pkg", "iso", "exe", "msi", "app", "apk", "ipa", "deb", "rpm"],
  ],
];
const byExtension = new Map(
  extensions.flatMap(([kind, list]) => list.map((ext) => [ext, kind] as const)),
);

export function extension(name: string) {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

export function fileKind(entry: { name: string; type: string }): FileKind {
  if (entry.type === "directory") return "folder";
  const ext = extension(entry.name);
  if (ext) return byExtension.get(ext) || "file";
  // Extensionless READMEs, LICENSEs and dotfiles are plain text.
  return /^(readme|license|licence|changelog|notice|authors|makefile|dockerfile)$|^\./i.test(
    entry.name,
  )
    ? "text"
    : "file";
}

const labels: Record<FileKind, string> = {
  folder: "Folder",
  image: "Image",
  video: "Video",
  audio: "Audio",
  pdf: "PDF document",
  archive: "Archive",
  code: "Code",
  sheet: "Spreadsheet",
  slides: "Presentation",
  doc: "Document",
  text: "Text",
  package: "Installer",
  file: "File",
};
export const kindLabel = (kind: FileKind) => labels[kind];

// Which icon the computer's file manager would show: one per folder/extension.
export function iconType(entry: { name: string; type: string }) {
  if (entry.type === "directory") return "folder";
  const ext = extension(entry.name);
  return /^[a-z0-9]{1,16}$/.test(ext) ? ext : "file";
}

// Images a browser can show from the file's bytes, by extension.
const imageTypes: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  bmp: "image/bmp",
  svg: "image/svg+xml",
};
export const imageType = (name: string) => imageTypes[extension(name)];
// Archives the computer unzips in place with one tap (server/archives.mjs).
export const isArchive = (name: string) =>
  /.\.(zip|tar|tgz|tar\.gz|tar\.bz2|tar\.xz)$/i.test(name);
// Markdown can be shown formatted as well as as source.
export const isMarkdown = (name: string) =>
  ["md", "markdown"].includes(extension(name));
// Formats the computer can turn into plain text (server/document-text.mjs):
// a Mac all four (textutil); elsewhere all but Word 97–2003's .doc, which
// needs Word itself.
const documents = new Set(["doc", "docx", "rtf", "odt"]);

// How the viewer opens a file: show the image or PDF, read it as text, extract
// a document's text, or offer a download.
export function previewMode(
  entry: {
    name: string;
    type: string;
  },
  platform?: string,
): "image" | "pdf" | "text" | "document" | null {
  if (entry.type === "directory") return null;
  const ext = extension(entry.name);
  if (imageTypes[ext]) return "image";
  if (ext === "pdf") return "pdf";
  if (documents.has(ext)) return !platform || platform === "darwin" || ext !== "doc" ? "document" : null;
  const kind = fileKind(entry);
  return kind === "text" ||
    kind === "code" ||
    kind === "file" ||
    ext === "csv" ||
    ext === "tsv"
    ? "text"
    : null;
}

// Building an Intl formatter is the slow part of formatting a date; Files
// formats one per row, so each style is built once and reused.
const formats = new Map<string, Intl.DateTimeFormat>();
const formatted = (date: Date, options: Intl.DateTimeFormatOptions) => {
  const key = JSON.stringify(options);
  let format = formats.get(key);
  if (!format)
    formats.set(key, (format = new Intl.DateTimeFormat(undefined, options)));
  return format.format(date);
};

// "Just now", "9:41 AM", "Yesterday", "Tue", "Oct 3", "Oct 3, 2024".
export function friendlyDate(value: string, now = new Date()) {
  const date = new Date(value);
  const time = date.getTime();
  if (!Number.isFinite(time)) return "";
  const elapsed = now.getTime() - time;
  if (elapsed >= 0 && elapsed < 60_000) return "Just now";
  const day = (d: Date) =>
    new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((day(now) - day(date)) / 86_400_000);
  if (days === 0)
    return formatted(date, { hour: "numeric", minute: "2-digit" });
  if (days === 1) return "Yesterday";
  if (days > 1 && days < 7) return formatted(date, { weekday: "short" });
  return formatted(date, {
    month: "short",
    day: "numeric",
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  });
}

// Folder paths are "a/b/c" relative to a shared folder ("" is its top).
export const parentPath = (dir: string) =>
  dir.split("/").filter(Boolean).slice(0, -1).join("/");
export const baseName = (dir: string) =>
  dir.split("/").filter(Boolean).at(-1) || "";

// What a failed request means for where the user is standing.
export function whenMissing(
  error: unknown,
  dir: string,
): "parent" | "first-root" | "stay" {
  const status = (error as { status?: number } | null)?.status;
  // 404: moved or deleted. 400: no longer a folder, or a shared folder the
  // computer stopped sharing. Climb until something exists. Anything else
  // (offline, expired access) keeps the user where they are.
  if (status === 404 || status === 400) return dir ? "parent" : "first-root";
  return "stay";
}
