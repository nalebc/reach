import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { desktopBinary, spawnVerified } from './desktop-native.mjs';
import { fail } from './core.mjs';
import { browserPrivatePaths, browserPrivateNames, validateBrowserRoot } from './browser-private-paths.mjs';
import { encodeSandboxRequest, createSandboxFrameReader } from './windows-sandbox.mjs';

let defaultCache;
const cache = () => defaultCache ||= fs.mkdtempSync(path.join(os.tmpdir(), 'reach-browser-files-'));
let activeOperations = 0;
const activeClients = new Map();
const allowed = new Set(['read', 'list', 'stat', 'mkdir', 'touch', 'rm', 'cp', 'write']);
const RESERVED_DEVICE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;
// A relative path inside the shared folder. On Windows (finding 12, §7.2) a
// component may not be a drive-relative/stream name (a ':'), a reserved device
// name, or end in a dot or space (Windows would trim it to another file);
// both separators are accepted and ".." is refused in either.
export function relative(value, { platform = process.platform } = {}) {
  if (typeof value !== 'string' || value.length > 4096) return false;
  if (platform === 'win32') {
    if (path.win32.isAbsolute(value) || /^[a-z]:/i.test(value) || value.startsWith('\\\\')) return false;
    if (/[\u0000-\u001f\u007f]/u.test(value)) return false;
    const parts = value.split(/[\\/]/);
    if (parts.includes('..')) return false;
    for (const part of parts) {
      if (part === '') continue;
      if (part.includes(':') || /[. ]$/.test(part) || RESERVED_DEVICE.test(part)) return false;
    }
    return true;
  }
  return !path.isAbsolute(value) && !value.split('/').includes('..') && !/[\u0000-\u001f\u007f\\]/u.test(value);
}
const literal = value => JSON.stringify(value);
export function fileBoundaryProfile(root, privatePaths, writable = false, privateNames = browserPrivateNames) {
  const namePattern = privateNames.map(name => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/[a-z]/g, c => `[${c}${c.toUpperCase()}]`)).join('|');
  const ancestors = [];
  for (let p = path.dirname(root); ; p = path.dirname(p)) { ancestors.push(p); if (path.dirname(p) === p) break; }
  return `(version 1)
(deny default)
(deny process-fork process-exec file-link)
(allow file-read-metadata ${ancestors.map(p => `(literal ${literal(p)})`).join(' ')})
(allow file-read* (subpath "/usr/lib") (subpath "/System/Library") (literal "/dev/null"))
(allow file-read* (subpath ${literal(root)}))
${writable ? `(allow file-write* (subpath ${literal(root)}))` : ''}
${namePattern ? `(deny file-read* file-write* (regex #"(^|/)(${namePattern})(/|$)"))` : ''}
${privatePaths.length ? `(deny file-read* file-write* ${privatePaths.map(p => `(subpath ${literal(p)})`).join(' ')})` : ''}`;
}

// All agent file access goes through directory descriptors. Every parent and
// final component is opened without following symbolic links, inside the helper.
export async function browserFileOperation(input, authorize, { config = { dataDir: cache() }, run, windowsSandbox } = {}) {
  let clientId;
  const check = () => {
    const client = authorize();
    if (client === false || (clientId && client?.id !== clientId)) throw fail(403, 'This file session ended.');
    return client;
  };
  const client = check();
  const fullControl = client?.policy?.browser === true && client.policy.preset === 'full';
  if (typeof client?.id === 'string' && client.id) clientId = client.id;
  if (activeOperations >= 4 || (clientId && (activeClients.get(clientId) || 0) >= 2))
    throw fail(429, 'Wait for a file operation to finish before starting another.');
  activeOperations++;
  if (clientId) activeClients.set(clientId, (activeClients.get(clientId) || 0) + 1);
  try {
    const absoluteRoot = typeof input.root === 'string' && (process.platform === 'win32' ? path.win32.isAbsolute(input.root) || /^[a-z]:/i.test(input.root) : path.isAbsolute(input.root));
    if (!allowed.has(input?.op) || !relative(input.path ?? '') || (input.op === 'cp' && !relative(input.to)) ||
        !absoluteRoot || (!fullControl && input.root === '/') ||
        (input.maxBytes !== undefined && (!Number.isSafeInteger(input.maxBytes) || input.maxBytes < 1 || input.maxBytes > 25 * 1024 * 1024)))
      throw fail(400, 'Choose a supported operation inside the shared folder.');
    // A trusted injected runner can exercise this JS contract on other hosts.
    // Real file access needs the macOS descriptor helper or, on Windows, the
    // owner-token broker (scripts/native/sandbox.cs, §3.4); any other platform,
    // or Windows without its broker, fails closed with the same reason.
    if (process.platform !== 'darwin' && process.platform !== 'win32' && typeof run !== 'function') throw fail(503, 'Protected agent file access is unavailable on this computer.');
    if (validateBrowserRoot(input.root, { policy: client?.policy }) !== input.root) throw fail(403, 'The shared folder changed.');
    const root = fs.lstatSync(input.root, { bigint: true });
    if (!root.isDirectory() || root.isSymbolicLink()) throw fail(403, 'The shared folder changed.');
    const request = { op: input.op, root: input.root, rootDev: String(root.dev), rootIno: String(root.ino), path: input.path ?? '',
      ...(input.to !== undefined ? { to: input.to } : {}), maxBytes: input.maxBytes ?? 1024 * 1024, maxEntries: input.maxEntries ?? 2000,
      fullControl, privatePaths: fullControl ? [] : [...browserPrivatePaths(config), ...(input.privatePaths ?? [])], privateNames: fullControl ? [] : [...browserPrivateNames] };
    if (input.op === 'write') {
      if (typeof input.data !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.data) || input.data.length > Math.ceil(1048576 / 3) * 4)
        throw fail(413, 'Write up to 1 MiB of content.');
      request.data = input.data;
    }
    request.sandbox = fileBoundaryProfile(request.root, request.privatePaths, ['mkdir', 'touch', 'rm', 'cp', 'write'].includes(request.op), request.privateNames);
    const body = JSON.stringify(request);
    if (Buffer.byteLength(body) > 2 * 1048576) throw fail(400, 'The file request is too large.');
    const binary = run || process.platform !== 'darwin' ? null : await desktopBinary(config, 'browser-files');
    check();
    const value = run ? await run(request, check)
      : process.platform === 'win32' ? await runWindowsFileOperation(request, check, windowsSandbox)
      : await new Promise((resolve, reject) => {
      const child = spawn(binary, [], { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8' } });
      let done = false, closed = false, size = 0; const chunks = [];
      const finish = (error, value) => { if (done) return; done = true; clearTimeout(timer); clearInterval(watch); if (error) { child.kill('SIGKILL'); if (closed) reject(error); else child.once('close', () => reject(error)); } else resolve(value); };
      const timer = setTimeout(() => finish(fail(504, 'The file operation timed out.')), 10000);
      const watch = setInterval(() => { try { check(); } catch (error) { finish(error); } }, 25);
      child.stdout.on('data', chunk => { size += chunk.length; if (size > Math.ceil(request.maxBytes * 4 / 3) + 2 * 1024 * 1024) return finish(fail(503, 'The file response was too large.')); chunks.push(chunk); });
      child.stderr.on('data', () => {});
      child.on('error', () => finish(fail(503, 'The protected file helper could not start.')));
      child.stdin.on('error', () => finish(fail(503, 'The protected file helper disconnected.')));
      child.on('close', code => {
        closed = true;
        if (done) return;
        try { check(); const result = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (result.error) throw fail([400, 403, 409, 413].includes(result.status) ? result.status : 403, String(result.error).slice(0, 300)); if (code !== 0 || !result || typeof result !== 'object') throw fail(503, 'Invalid protected file response.'); finish(null, result); }
        catch (error) { finish(error?.status ? error : fail(503, 'The protected file helper returned an invalid response.')); }
      });
      child.stdin.end(body);
    });
    check();
    if (value.stat && Number.isFinite(value.stat.modified)) value.stat.modified = new Date(value.stat.modified).toISOString();
    for (const item of value.items || []) if (Number.isFinite(item.modified)) item.modified = new Date(item.modified).toISOString();
    if (input.op === 'read') {
      if (typeof value.data !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.data)) throw fail(503, 'Invalid protected file data.');
      const data = Buffer.from(value.data, 'base64');
      if (data.length > request.maxBytes) throw fail(503, 'The protected file exceeded its bound.');
      return { ...value, data };
    }
    return value;
  } finally {
    activeOperations--;
    if (clientId) {
      const remaining = activeClients.get(clientId) - 1;
      if (remaining) activeClients.set(clientId, remaining); else activeClients.delete(clientId);
    }
  }
}

// §3.4, §7: the owner-token broker on Windows. The helper (scripts/native/sandbox.cs
// `mode:"file"`) does the whole boundary in code — NT handle-relative traversal
// that follows no reparse point, final-path verification against the root, the
// private-name/path check on the normalized name, and nlink==1 — and returns the
// same JSON result shape the Mac helper does, carried in one 'R' frame. Without
// the broker, Windows fails closed with the same reason as any other platform.
function fileRequestEntries(request) {
  const entries = [
    ['mode', 'file'], ['op', request.op], ['root', request.root],
    ['rootDev', request.rootDev], ['rootIno', request.rootIno], ['path', request.path ?? ''],
    ['maxBytes', String(request.maxBytes)], ['maxEntries', String(request.maxEntries)],
    ['fullControl', request.fullControl ? '1' : '0'],
  ];
  if (request.to !== undefined) entries.push(['to', request.to]);
  if (request.data !== undefined) entries.push(['data', request.data]);
  for (const p of request.privatePaths || []) entries.push(['privatePath', p]);
  for (const n of request.privateNames || []) entries.push(['privateName', n]);
  return entries;
}
async function runWindowsFileOperation(request, check, windowsSandbox) {
  if (!windowsSandbox) throw fail(503, 'Protected agent file access is unavailable on this computer.');
  const ready = await windowsSandbox.ready();
  if (!ready.ok) throw fail(503, ready.reason);
  check();
  return await new Promise((resolve, reject) => {
    let result, settled = false, size = 0;
    const child = spawnVerified(ready.built.file, ready.built.sha256, ['run'], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); clearInterval(watch); if (error) { try { child.kill(); } catch {} reject(error); } else resolve(value); };
    const read = createSandboxFrameReader({
      onResult: (buffer) => { size += buffer.length; if (size > Math.ceil(request.maxBytes * 4 / 3) + 2 * 1024 * 1024) return finish(fail(503, 'The file response was too large.')); try { result = JSON.parse(buffer.toString('utf8')); } catch { finish(fail(503, 'The protected file helper returned an invalid response.')); } },
      onRefused: ({ status, message }) => finish(fail([400, 403, 409, 413].includes(status) ? status : 403, String(message).slice(0, 300))),
      onError: () => finish(fail(503, 'The protected file helper returned an invalid response.')),
    });
    const timer = setTimeout(() => finish(fail(504, 'The file operation timed out.')), 10000);
    const watch = setInterval(() => { try { check(); } catch (error) { finish(error); } }, 25);
    child.stdout.on('data', read);
    child.on('error', () => finish(fail(503, 'The protected file helper could not start.')));
    child.on('close', () => { if (result) { try { check(); } catch (error) { return finish(error); } finish(null, result); } else finish(fail(503, 'The protected file helper returned an invalid response.')); });
    try { child.stdin.write(encodeSandboxRequest(fileRequestEntries(request))); } catch { finish(fail(503, 'The protected file helper disconnected.')); }
  });
}
