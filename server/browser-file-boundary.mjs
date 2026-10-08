import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { desktopBinary } from './desktop-native.mjs';
import { fail } from './core.mjs';
import { browserPrivatePaths, browserPrivateNames, validateBrowserRoot } from './browser-private-paths.mjs';

let defaultCache;
const cache = () => defaultCache ||= fs.mkdtempSync(path.join(os.tmpdir(), 'reach-browser-files-'));
let activeOperations = 0;
const activeClients = new Map();
const allowed = new Set(['read', 'list', 'stat', 'mkdir', 'touch', 'rm', 'cp', 'write']);
const relative = value => typeof value === 'string' && value.length <= 4096 && !path.isAbsolute(value) && !value.split('/').includes('..') && !/[\u0000-\u001f\u007f\\]/u.test(value);
const literal = value => JSON.stringify(value);
export function fileBoundaryProfile(root, privatePaths, writable = false) {
  const namePattern = browserPrivateNames.map(name => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/[a-z]/g, c => `[${c}${c.toUpperCase()}]`)).join('|');
  const ancestors = [];
  for (let p = path.dirname(root); ; p = path.dirname(p)) { ancestors.push(p); if (path.dirname(p) === p) break; }
  return `(version 1)
(deny default)
(deny process-fork process-exec file-link)
(allow file-read-metadata ${ancestors.map(p => `(literal ${literal(p)})`).join(' ')})
(allow file-read* (subpath "/usr/lib") (subpath "/System/Library") (literal "/dev/null"))
(allow file-read* (subpath ${literal(root)}))
${writable ? `(allow file-write* (subpath ${literal(root)}))` : ''}
(deny file-read* file-write* (regex #"(^|/)(${namePattern})(/|$)"))
${privatePaths.length ? `(deny file-read* file-write* ${privatePaths.map(p => `(subpath ${literal(p)})`).join(' ')})` : ''}`;
}

// All agent file access goes through directory descriptors. Every parent and
// final component is opened without following symbolic links, inside the helper.
export async function browserFileOperation(input, authorize, { config = { dataDir: cache() }, run } = {}) {
  let clientId;
  const check = () => {
    const client = authorize();
    if (client === false || (clientId && client?.id !== clientId)) throw fail(403, 'This file session ended.');
    return client;
  };
  const client = check();
  if (typeof client?.id === 'string' && client.id) clientId = client.id;
  if (activeOperations >= 4 || (clientId && (activeClients.get(clientId) || 0) >= 2))
    throw fail(429, 'Wait for a file operation to finish before starting another.');
  activeOperations++;
  if (clientId) activeClients.set(clientId, (activeClients.get(clientId) || 0) + 1);
  try {
    if (!allowed.has(input?.op) || !relative(input.path ?? '') || (input.op === 'cp' && !relative(input.to)) ||
        typeof input.root !== 'string' || !path.isAbsolute(input.root) || input.root === '/' ||
        (input.maxBytes !== undefined && (!Number.isSafeInteger(input.maxBytes) || input.maxBytes < 1 || input.maxBytes > 25 * 1024 * 1024)))
      throw fail(400, 'Choose a supported operation inside the shared folder.');
    // A trusted injected runner can exercise this JS contract on other hosts;
    // real file access still requires the macOS descriptor/sandbox helper.
    if (process.platform !== 'darwin' && typeof run !== 'function') throw fail(503, 'Protected agent file access is unavailable on this computer.');
    if (validateBrowserRoot(input.root, { policy: client?.policy }) !== input.root) throw fail(403, 'The shared folder changed.');
    const root = fs.lstatSync(input.root, { bigint: true });
    if (!root.isDirectory() || root.isSymbolicLink()) throw fail(403, 'The shared folder changed.');
    const request = { op: input.op, root: input.root, rootDev: String(root.dev), rootIno: String(root.ino), path: input.path ?? '',
      ...(input.to !== undefined ? { to: input.to } : {}), maxBytes: input.maxBytes ?? 1024 * 1024, maxEntries: input.maxEntries ?? 2000,
      privatePaths: [...browserPrivatePaths(config), ...(input.privatePaths ?? [])], privateNames: [...browserPrivateNames] };
    if (input.op === 'write') {
      if (typeof input.data !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.data) || input.data.length > Math.ceil(1048576 / 3) * 4)
        throw fail(413, 'Write up to 1 MiB of content.');
      request.data = input.data;
    }
    request.sandbox = fileBoundaryProfile(request.root, request.privatePaths, ['mkdir', 'touch', 'rm', 'cp', 'write'].includes(request.op));
    const body = JSON.stringify(request);
    if (Buffer.byteLength(body) > 2 * 1048576) throw fail(400, 'The file request is too large.');
    const binary = run ? null : await desktopBinary(config, 'browser-files');
    check();
    const value = run ? await run(request, check) : await new Promise((resolve, reject) => {
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
