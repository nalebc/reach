// Share file bytes, never a companion URL or an authenticated download link.
export const MAX_SHARE_BYTES = 100 * 1024 * 1024;

const types: Record<string, string> = {
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/plain",
  csv: "text/csv",
  json: "application/json",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  heic: "image/heic",
  heif: "image/heif",
  mov: "video/quicktime",
  mp4: "video/mp4",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  wav: "audio/wav",
  zip: "application/zip",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

export function shareName(name: string) {
  return (
    name.replace(/[\\/\u0000-\u001f\u007f]/g, "_").replace(/^\.+$/, "file") ||
    "file"
  );
}

export function makeShareFile(blob: Blob, name: string) {
  const type =
    blob.type && blob.type !== "application/octet-stream"
      ? blob.type
      : types[name.split(".").pop()?.toLowerCase() || ""] ||
        "application/octet-stream";
  return new File([blob], shareName(name), { type });
}

export function canShareFile(file: File | File[]) {
  try {
    return (
      typeof navigator.share === "function" &&
      navigator.canShare?.({ files: ([] as File[]).concat(file) }) === true
    );
  } catch {
    return false;
  }
}

export function shareCancelled(error: unknown) {
  const e = error as { name?: string; message?: string } | null;
  return (
    e?.name === "AbortError" || /cancel(?:led|ed)?/i.test(e?.message || "")
  );
}

// Invoke directly from the button event, without a fetch or another await first.
export function shareBrowserFile(file: File | File[]) {
  return navigator.share({ files: ([] as File[]).concat(file) });
}
