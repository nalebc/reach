import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fail } from './core.mjs';

const identity = stat => `${stat.dev}:${stat.ino}`;
function folderIdentity(root) {
  try {
    if (typeof root !== 'string' || !path.isAbsolute(root) || path.resolve(root) !== root || fs.realpathSync(root) !== root)
      throw fail(403, 'The shared folder changed. Request access again.');
    const stat = fs.lstatSync(root, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw fail(403, 'The shared folder changed.');
    const ancestors = [];
    for (let current = root; ; current = path.dirname(current)) {
      ancestors.push(identity(fs.statSync(current, { bigint: true })));
      if (current === path.dirname(current)) break;
    }
    if (ancestors[0] !== identity(stat) || identity(fs.lstatSync(root, { bigint: true })) !== identity(stat) || fs.realpathSync(root) !== root)
      throw fail(403, 'The shared folder changed.');
    return { key: identity(stat), ancestors };
  } catch (error) {
    if (error?.status) throw error;
    throw fail(403, 'The shared folder changed or is unavailable. Request access again.');
  }
}
const inside = (folder, parent) => folder === parent || folder.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);
const overlaps = (a, b) => inside(a.root, b.root) || inside(b.root, a.root) ||
  a.folder.ancestors.includes(b.folder.key) || b.folder.ancestors.includes(a.folder.key);

// Missing or changed roots invalidate approval assumptions too. Be conservative
// when this helper is used to retire another agent's shared-file approvals.
export function pathsOverlap(a, b) {
  try { return overlaps({ root: a, folder: folderIdentity(a) }, { root: b, folder: folderIdentity(b) }); }
  catch { return true; }
}

// This is a writer coordinator, not a sandbox. Readers may continue concurrently;
// every executing operation still uses its existing kernel-enforced boundary.
export function createBrowserOperationCoordinator({ waitTimeoutMs = 30000, maxWaiting = 20,
  maxWaitingPerClient = 3, pollMs = 50, maxScripts = 2, maxScriptsPerClient = 1,
  onWrite = () => {}, onWriteFinished = () => {} } = {}) {
  const operations = new Map();
  let closed = false, timer, pumping = false;
  const stopped = () => fail(403, 'This agent operation was stopped.');
  const check = entry => {
    if (entry.failure) throw entry.failure;
    const client = entry.authorize();
    if (!client || client.id !== entry.clientId || client.kind !== 'agent' || client.policy?.browser !== true ||
        !client.agentRoots?.includes(entry.root)) throw fail(403, 'This agent no longer has access to the shared folder.');
    const current = folderIdentity(entry.root);
    if (current.key !== entry.folder.key || current.ancestors.join('/') !== entry.folder.ancestors.join('/'))
      throw fail(403, 'The shared folder changed. Request access again.');
    return client;
  };
  const clearIdleTimer = () => { if (!operations.size && timer) { clearInterval(timer); timer = undefined; } };
  const cancel = (entry, error) => {
    entry.failure ||= error;
    entry.controller.abort(entry.failure);
    if (entry.state === 'waiting') {
      operations.delete(entry.id);
      clearTimeout(entry.deadline);
      entry.reject(entry.failure);
      clearIdleTimer();
    }
    // Running work retains its lease until its process/helper has actually
    // stopped. Releasing here would let a replacement writer race a dying one.
  };
  const canStart = entry => {
    const all = [...operations.values()];
    const running = all.filter(op => op.state === 'running');
    if (running.some(op => overlaps(op, entry))) return false;
    if (entry.kind === 'script') {
      const scripts = running.filter(op => op.kind === 'script');
      if (scripts.length >= maxScripts || scripts.filter(op => op.clientId === entry.clientId).length >= maxScriptsPerClient) return false;
    }
    // FIFO for conflicting folders; unrelated folders can make progress.
    for (const earlier of all) {
      if (earlier === entry) break;
      if (earlier.state === 'waiting' && (overlaps(earlier, entry) ||
          (earlier.kind === 'script' && entry.kind === 'script' && earlier.clientId === entry.clientId))) return false;
    }
    return true;
  };
  const pump = () => {
    if (pumping) return;
    pumping = true;
    try {
      for (const entry of [...operations.values()]) {
        if (entry.state !== 'waiting') continue;
        try { check(entry); } catch (error) { cancel(entry, error); continue; }
        if (!canStart(entry)) continue;
        clearTimeout(entry.deadline);
        entry.state = 'running';
        entry.startedAt = new Date().toISOString();
        // Starting in a microtask allows the caller to attach rejection handlers,
        // while the lease is held synchronously before another run() can start.
        const settle = (deliver, value) => {
          operations.delete(entry.id);
          clearIdleTimer();
          pump();
          deliver(value);
        };
        Promise.resolve().then(async () => {
          const context = { clientId: entry.clientId, root: entry.root };
          try {
            check(entry);
            await onWrite(context);
            check(entry);
            // A change that already completed is reported as completed, even if
            // access was revoked or the run was stopped while it finished.
            return await entry.execute({ authorize: () => check(entry), signal: entry.controller.signal });
          } finally { await onWriteFinished(context); }
        }).then(value => settle(entry.resolve, value), error => settle(entry.reject, error));
      }
    } finally { pumping = false; }
  };
  const run = async ({ clientId, root, kind, authorize } = {}, execute) => {
    if (closed) throw fail(503, 'Agent operations are shutting down.');
    if (typeof clientId !== 'string' || !clientId || !['script', 'file-change'].includes(kind) ||
        typeof authorize !== 'function' || typeof execute !== 'function') throw fail(400, 'Choose an authorized agent operation.');
    const entry = { id: randomUUID(), clientId, root, kind, authorize, execute, folder: folderIdentity(root),
      state: 'waiting', queuedAt: new Date().toISOString(), controller: new AbortController() };
    check(entry);
    const waiting = [...operations.values()].filter(op => op.state === 'waiting');
    if (!canStart(entry) && (waiting.length >= maxWaiting || waiting.filter(op => op.clientId === clientId).length >= maxWaitingPerClient))
      throw fail(429, 'Too many folder changes are waiting. Wait for an operation to finish.');
    return await new Promise((resolve, reject) => {
      Object.assign(entry, { resolve, reject });
      operations.set(entry.id, entry);
      entry.deadline = setTimeout(() => { cancel(entry, fail(504, 'Timed out waiting for this folder. Request the change again.')); pump(); }, waitTimeoutMs);
      if (!timer) timer = setInterval(() => {
        for (const pending of [...operations.values()]) {
          try { check(pending); } catch (error) { cancel(pending, error); }
        }
        pump();
      }, pollMs);
      pump();
    });
  };
  return {
    run,
    listOwner: () => [...operations.values()].map(entry => ({ id: entry.id, clientId: entry.clientId,
      state: entry.state, folder: entry.root, kind: entry.kind, queuedAt: entry.queuedAt,
      ...(entry.startedAt ? { startedAt: entry.startedAt } : {}), ...(entry.failure ? { stopping: true } : {}) })),
    cancelClient(clientId) { for (const entry of [...operations.values()]) if (entry.clientId === clientId) cancel(entry, stopped()); pump(); },
    close() { closed = true; for (const entry of [...operations.values()]) cancel(entry, stopped()); },
  };
}

export const browserOperationCoordinator = createBrowserOperationCoordinator();
