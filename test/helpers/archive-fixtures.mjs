import { deflateRawSync, gzipSync } from "node:zlib";
import crc from "buffer-crc32";
import tar from "tar-stream";
const crc32 = crc.unsigned;

// Small genuine ZIP fixtures, independent of whichever `tar` the host ships.
// This writes fixture bytes only; production decoding uses yauzl.
export function zipFixture(entries) {
  const local = [], central = []; let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name), body = Buffer.from(entry.data || ""), method = entry.deflate ? 8 : 0;
    const compressed = method ? deflateRawSync(body) : body;
    const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x800, 6); header.writeUInt16LE(method, 8); header.writeUInt32LE(crc32(body), 14);
    header.writeUInt32LE(compressed.length, 18); header.writeUInt32LE(entry.size ?? body.length, 22); header.writeUInt16LE(name.length, 26);
    const index = Buffer.alloc(46); index.writeUInt32LE(0x02014b50); index.writeUInt16LE(0x314, 4); index.writeUInt16LE(20, 6);
    index.writeUInt16LE(0x800 | (entry.encrypted ? 1 : 0), 8); index.writeUInt16LE(method, 10); index.writeUInt32LE(crc32(body), 16);
    index.writeUInt32LE(compressed.length, 20); index.writeUInt32LE(entry.size ?? body.length, 24); index.writeUInt16LE(name.length, 28);
    index.writeUInt32LE(((entry.mode ?? (entry.name.endsWith("/") ? 0o40755 : 0o100644)) << 16) >>> 0, 38); index.writeUInt32LE(offset, 42);
    local.push(header, name, compressed); central.push(index, name); offset += header.length + name.length + compressed.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}
export async function tarFixture(entries, gzip = false) {
  const pack = tar.pack(), chunks = [];
  const collecting = (async () => { for await (const chunk of pack) chunks.push(chunk); })();
  for (const entry of entries) await new Promise((resolve, reject) => pack.entry({ name: entry.name, type: entry.type || "file", ...(entry.header || {}) }, Buffer.from(entry.data || ""), error => error ? reject(error) : resolve()));
  pack.finalize(); await collecting;
  const bytes = Buffer.concat(chunks);
  return gzip ? gzipSync(bytes) : bytes;
}
