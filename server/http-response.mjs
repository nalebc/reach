// Bound response bytes while reading, including chunked feeds with no
// Content-Length. Checking text.length after response.text() is too late.
export async function boundedResponseText(response, maxBytes) {
  const length = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(length) && length > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw new Error("Response is too large.");
  }
  if (!response.body?.getReader) {
    const text = await response.text();
    if (Buffer.byteLength(text) > maxBytes) throw new Error("Response is too large.");
    return text;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0, complete = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) { complete = true; break; }
      size += value.byteLength;
      if (size > maxBytes) throw new Error("Response is too large.");
      chunks.push(value);
    }
    return Buffer.concat(chunks, size).toString("utf8");
  } finally {
    if (!complete) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
