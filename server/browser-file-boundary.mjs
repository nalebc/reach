import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { desktopBinary } from './desktop-native.mjs';
import { fail } from './core.mjs';
import { browserPrivatePaths, browserPrivateNames, validateBrowserRoot } from './browser-private-paths.mjs';
import { authorizedWorkspaceRoot } from './browser-workspace-paths.mjs';

let defaultCache;
const cache = () => defaultCache ||= fs.mkdtempSync(path.join(os.tmpdir(), 'reach-browser-files-'));
let activeOperations = 0;
const activeClients = new Map();
// Reviewed checks/writes are internal owner-workspace operations. They are not
// exposed by the browser agent routes or tool catalog.
const reviewed = new Set(['check-reviewed', 'write-reviewed', 'delete-reviewed']);
const allowed = new Set(['read', 'list', 'stat', 'mkdir', 'touch', 'rm', 'cp', ...reviewed]);
const base64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const reviewedLimit = 1024 * 1024;
const requestLimit = Math.ceil(reviewedLimit / 3) * 4 + 65536;
const isOwner = client => client?.kind === 'device' && Array.isArray(client.scopes) && client.scopes.includes('admin');
const relative = value => typeof value === 'string' && value.length <= 4096 && !path.isAbsolute(value) && !value.split('/').includes('..') && !/[\u0000-\u001f\u007f\\]/u.test(value);
const exactRelative = value => relative(value) && value.length > 0 && value.split('/').every(part => part && part !== '.');
const literal = value => JSON.stringify(value);
export function fileBoundaryProfile(root, privatePaths, writable = false) {
  const namePattern = browserPrivateNames.map(name => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/[a-z]/g, c => `[${c}${c.toUpperCase()}]`)).join('|');
  const ancestors = [];
  for (let p = path.dirname(root); ; p = path.dirname(p)) { ancestors.push(p); if (p === '/') break; }
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
  let clientId, workspaceException = false;
  const check = () => {
    const client = authorize();
    if (client === false || (clientId && client?.id !== clientId)) throw fail(403, 'This file session ended.');
    if (reviewed.has(input?.op) && !isOwner(client))
      throw fail(403, 'Only the owner can apply reviewed workspace changes.');
    if (workspaceException && !isOwner(client) && !authorizedWorkspaceRoot(client, config, input.root))
      throw fail(403, 'This private workspace is no longer available to this session.');
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
    if (reviewed.has(input.op)) {
      if (!exactRelative(input.path) || (input.expectedHash !== null && (typeof input.expectedHash !== 'string' || !/^[a-f0-9]{64}$/.test(input.expectedHash))) ||
          (input.maxBytes ?? reviewedLimit) > reviewedLimit || input.to !== undefined)
        throw fail(400, 'Choose a reviewed file no larger than 1 MiB with its exact original hash.');
      const parents = input.requiredParents === undefined ? [] : input.requiredParents;
      if (!Array.isArray(parents) || parents.length > 32 || new Set(parents).size !== parents.length ||
          parents.some(parent => !exactRelative(parent) || !input.path.startsWith(parent + '/')))
        throw fail(400, 'Choose only the original parent folders of this reviewed file.');
      if (input.op === 'write-reviewed') {
        if (typeof input.data !== 'string' || input.data.length > Math.ceil((input.maxBytes ?? reviewedLimit) / 3) * 4 || !base64.test(input.data))
          throw fail(400, 'The reviewed file data is invalid or too large.');
        const data = Buffer.from(input.data, 'base64');
        if (data.length > (input.maxBytes ?? reviewedLimit) || data.toString('base64') !== input.data)
          throw fail(400, 'The reviewed file data is invalid or too large.');
      } else if (input.data !== undefined) throw fail(400, 'A reviewed check or deletion cannot include file data.');
    }
    if (process.platform !== 'darwin') throw fail(503, 'Protected agent file access is unavailable on this computer.');
    if (validateBrowserRoot(input.root) !== input.root) throw fail(403, 'The shared folder changed.');
    const root = fs.lstatSync(input.root, { bigint: true });
    if (!root.isDirectory() || root.isSymbolicLink()) throw fail(403, 'The shared folder changed.');
    const workspaceAllowed = isOwner(client) || authorizedWorkspaceRoot(client, config, input.root);
    workspaceException = Boolean(workspaceAllowed);
    const request = { op: input.op, root: input.root, rootDev: String(root.dev), rootIno: String(root.ino), path: input.path ?? '',
      ...(input.to !== undefined ? { to: input.to } : {}), maxBytes: input.maxBytes ?? 1024 * 1024, maxEntries: input.maxEntries ?? 2000,
      ...(reviewed.has(input.op) ? { expectedHash: input.expectedHash, requiredParents: input.requiredParents ?? [], ...(input.op === 'write-reviewed' ? { data: input.data } : {}) } : {}),
      privatePaths: [...browserPrivatePaths(config, workspaceAllowed ? { workspaceRoot: input.root } : {}), ...(input.privatePaths ?? [])], privateNames: [...browserPrivateNames] };
    request.sandbox = fileBoundaryProfile(request.root, request.privatePaths, ['mkdir', 'touch', 'rm', 'cp', 'write-reviewed', 'delete-reviewed'].includes(request.op));
    const body = JSON.stringify(request);
    if (Buffer.byteLength(body) > (reviewed.has(input.op) ? requestLimit : 65536)) throw fail(400, 'The file request is too large.');
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
    if (input.op === 'check-reviewed') {
      if (typeof value?.matches !== 'boolean' || (value.reason !== undefined && (typeof value.reason !== 'string' || value.reason.length > 300)))
        throw fail(503, 'The protected file check returned an invalid response.');
      return { matches: value.matches, ...(value.reason ? { reason: value.reason } : {}) };
    }
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
