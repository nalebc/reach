// What a message piece that isn't words or a picture is, in a word the chat
// can show ("Voice message", "PDF"). Agents write these in their own shapes:
// Anthropic's `document`, OpenAI's `input_audio`/`input_file`, Gemini's
// `inlineData`/`fileData` by MIME type. Dictation in the apps arrives as text;
// a voice note forwarded from a channel (OpenClaw) arrives as audio. Without a
// word for it, a message of only a voice note vanished from the chat.
const mimeOf = (part) =>
  String(
    part?.mimeType ||
      part?.mime_type ||
      part?.media_type ||
      part?.source?.media_type ||
      part?.inlineData?.mimeType ||
      part?.fileData?.mimeType ||
      "",
  ).toLowerCase();

export function partLabel(part) {
  if (!part || typeof part !== "object") return null;
  const type = String(part.type || "").toLowerCase();
  const mime = mimeOf(part);
  if (/audio|voice/.test(type) || mime.startsWith("audio/")) return "Voice message";
  if (/video/.test(type) || mime.startsWith("video/")) return "Video";
  if (type === "image" || type === "input_image" || type === "localimage" || mime.startsWith("image/")) return null;
  const file = type === "document" || /file/.test(type) || !!(part.fileData || part.inlineData);
  if (!file) return null;
  if (mime === "application/pdf" || /\.pdf$/i.test(String(part.filename || part.name || ""))) return "PDF";
  return type === "document" ? "Document" : "File";
}

// The labels for a message's pieces, in order ([] for a plain string).
export const partLabels = (content) =>
  Array.isArray(content) ? content.map(partLabel).filter(Boolean) : [];
