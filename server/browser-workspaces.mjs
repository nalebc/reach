import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fail } from './core.mjs';
import { browserFileOperation } from './browser-file-boundary.mjs';
import { browserPrivatePaths, isBrowserPrivatePath, validateBrowserRoot } from './browser-private-paths.mjs';

const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
const hash = data => crypto.createHash('sha256').update(data).digest('hex');
const hashValue = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const within = (child, parent) => child === parent || child.startsWith(parent + path.sep);
const relative = value => typeof value === 'string' && value.length > 0 && value.length <= 4096 && !path.isAbsolute(value) && value.split('/').every(part => part && part !== '.' && part !== '..') && !/[\u0000-\u001f\u007f\\]/u.test(value);
const identity = target => {
  const value = fs.lstatSync(target, { bigint: true });
  if (!value.isDirectory() || value.isSymbolicLink() || fs.realpathSync.native(target) !== target) throw fail(403, 'A workspace folder changed.');
  return { dev: String(value.dev), ino: String(value.ino) };
};
const sameIdentity = (target, expected) => {
  try { const current = identity(target); return current.dev === expected?.dev && current.ino === expected?.ino; } catch { return false; }
};
const clone = value => JSON.parse(JSON.stringify(value));
const unavailable = () => fail(503, 'Private workspace records are unavailable. No workspace access is allowed.');
const fingerprint = snapshot => JSON.stringify({ files: snapshot.files.map(({ root, path, hash }) => ({ root, path, hash })), directories: snapshot.directories });
const privateDirectory = target => {
  const stat = fs.lstatSync(target);
  if (!stat.isDirectory() || stat.isSymbolicLink() || typeof process.getuid !== 'function' || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o700)
    throw fail(503, 'Private workspace storage must be owned by your account with folder permissions 0700.');
};

// Workspace copies are grants, not capabilities carried by an agent-supplied
// path. Their registry and review bytes live outside every agent file grant.
export function createBrowserWorkspaces({ config, fileOperation = browserFileOperation, assertInactive,
  runExclusiveApply = (_workspace, operation) => operation(), now = Date.now, limits: overrides = {} } = {}) {
  const limits = { files: 500, bytes: 32 * 1024 * 1024, fileBytes: 1024 * 1024, entries: 2000, depth: 32, workspaces: 10, reviewMs: 10 * 60 * 1000, ...overrides };
  const base = config?.browserWorkspaceDir;
  if (typeof base !== 'string' || !path.isAbsolute(base) || path.resolve(base) !== base || !config?.dataDir) throw unavailable();
  const dataDir = fs.realpathSync.native(config.dataDir);
  if (within(base, dataDir) || within(dataDir, base)) throw fail(400, 'Private workspace copies need their own storage folder.');
  fs.mkdirSync(base, { recursive: true, mode: 0o700 });
  const baseIdentity = identity(base); privateDirectory(base);
  const stateDir = path.join(dataDir, 'browser-workspaces');
  let first = false;
  try { fs.mkdirSync(stateDir, { mode: 0o700 }); first = true; } catch (error) { if (error.code !== 'EEXIST') throw unavailable(); }
  const stateIdentity = identity(stateDir), registryPath = path.join(stateDir, 'registry.json'); privateDirectory(stateDir);
  const dataIdentity = identity(dataDir);
  const pinned = () => {
    if (!sameIdentity(base, baseIdentity) || !sameIdentity(stateDir, stateIdentity) || !sameIdentity(dataDir, dataIdentity)) throw unavailable();
    privateDirectory(base); privateDirectory(stateDir);
  };
  const writePrivate = (target, value) => {
    pinned();
    const temporary = path.join(stateDir, `${crypto.randomUUID()}.tmp`);
    let fd;
    try {
      fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
      fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
      pinned(); fs.renameSync(temporary, target);
    } finally { if (fd !== undefined) fs.closeSync(fd); try { fs.unlinkSync(temporary); } catch {} }
  };
  const readPrivate = (target, maxBytes = 48 * 1024 * 1024) => {
    pinned(); let fd;
    try {
      fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > maxBytes || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) throw unavailable();
      const result = JSON.parse(fs.readFileSync(fd, 'utf8')); pinned(); return result;
    } catch { throw unavailable(); } finally { if (fd !== undefined) fs.closeSync(fd); }
  };
  if (first) writePrivate(registryPath, { version: 1, workspaces: [] });
  const validateRecord = record => {
    if (!record || !uuid(record.id) || typeof record.name !== 'string' || record.name.length > 100 || !Number.isFinite(record.createdAt) ||
      !Array.isArray(record.sources) || !record.sources.length || record.sources.length > 20 || record.sources.some(value => typeof value !== 'string' || !path.isAbsolute(value) || path.resolve(value) !== value) ||
      !Array.isArray(record.roots) || record.roots.length !== record.sources.length || record.roots.some((value, index) => value !== path.join(base, record.id, String(index))) ||
      !Array.isArray(record.sourceIdentities) || record.sourceIdentities.length !== record.sources.length || !Array.isArray(record.rootIdentities) || record.rootIdentities.length !== record.roots.length ||
      !record.containerIdentity || !['ready', 'bound', 'reviewed', 'applied', 'partial', 'discarded'].includes(record.status) ||
      (record.clientId !== null && (typeof record.clientId !== 'string' || !record.clientId)) || (record.expiresAt !== null && !Number.isFinite(record.expiresAt)) ||
      (record.reviewId !== undefined && !uuid(record.reviewId))) throw unavailable();
    for (const item of [...record.sourceIdentities, ...record.rootIdentities, record.containerIdentity]) if (!item || !/^\d+$/.test(item.dev) || !/^\d+$/.test(item.ino)) throw unavailable();
    return record;
  };
  const load = () => {
    const value = readPrivate(registryPath, 1024 * 1024);
    if (!value || value.version !== 1 || !Array.isArray(value.workspaces) || value.workspaces.length > limits.workspaces || new Set(value.workspaces.map(record => record?.id)).size !== value.workspaces.length) throw unavailable();
    value.workspaces.forEach(validateRecord); return value;
  };
  load();
  const get = id => {
    if (!uuid(id)) throw fail(400, 'Choose a private workspace.');
    const record = load().workspaces.find(value => value.id === id);
    if (!record) throw fail(404, 'This private workspace is no longer available.');
    return record;
  };
  const save = record => {
    validateRecord(record); const state = load();
    const index = state.workspaces.findIndex(value => value.id === record.id);
    if (index < 0) state.workspaces.push(record); else state.workspaces[index] = record;
    if (state.workspaces.length > limits.workspaces) throw fail(409, 'Discard an old private workspace before creating another.');
    writePrivate(registryPath, state);
  };
  const owner = authorize => {
    if (typeof authorize !== 'function') throw fail(403, 'Only the owner can manage private workspaces.');
    const client = authorize();
    if (client?.kind !== 'device' || !client.scopes?.includes('admin')) throw fail(403, 'Only the owner can manage private workspaces.');
    pinned(); return client;
  };
  const sourceGrants = record => {
    for (let index = 0; index < record.sources.length; index++) {
      const source = record.sources[index];
      if (!Array.isArray(config.roots) || !config.roots.some(root => {
        try { return within(source, fs.realpathSync.native(root)); } catch { return false; }
      }) || validateBrowserRoot(source) !== source || !sameIdentity(source, record.sourceIdentities[index]) || isBrowserPrivatePath(source, browserPrivatePaths(config))) throw fail(403, 'An original folder is no longer shared or has changed.');
    }
  };
  const rootsIntact = record => {
    if (!sameIdentity(path.join(base, record.id), record.containerIdentity) || record.roots.some((root, index) => !sameIdentity(root, record.rootIdentities[index]))) throw fail(403, 'The private workspace changed. Create a fresh invitation.');
  };
  const inactive = async record => {
    if (assertInactive) { if (await assertInactive(clone(record)) === false) throw fail(409, 'Stop this agent and wait for its commands to finish first.'); }
    else if (record.clientId) throw fail(409, 'Stop this agent and wait for its commands to finish first.');
  };
  const busy = new Set(); let creating = false;
  const exclusively = async (id, operation) => {
    if (busy.has(id)) throw fail(409, 'Another operation is using this private workspace.');
    busy.add(id); try { return await operation(); } finally { busy.delete(id); }
  };
  const checkFor = (record, authorize, copies = false) => () => {
    const client = owner(authorize); sourceGrants(record); if (copies) rootsIntact(record); return client;
  };
  const operation = (input, authorize) => fileOperation(input, authorize, { config });
  const snapshot = async (roots, authorize) => {
    const files = [], directories = []; let bytes = 0, visited = 0, skipped = 0;
    for (let root = 0; root < roots.length; root++) {
      const walk = async (folder, depth) => {
        if (depth > limits.depth) throw fail(413, 'The folder is too deep for a private workspace.');
        authorize();
        const listing = await operation({ op: 'list', root: roots[root], path: folder, maxEntries: limits.entries }, authorize);
        if (!listing || !Array.isArray(listing.items) || listing.truncated) throw fail(413, 'The folder is too large for a private workspace.');
        for (const item of listing.items) {
          if (++visited > limits.entries) throw fail(413, 'The folder has too many entries for a private workspace.');
          if (typeof item.name !== 'string' || !relative(item.name) || item.name.includes('/')) throw fail(403, 'A file name cannot be safely copied.');
          const name = folder ? `${folder}/${item.name}` : item.name;
          const privatePaths = browserPrivatePaths(config, within(roots[root], base) ? { workspaceRoot: roots[root] } : {});
          if (isBrowserPrivatePath(path.join(roots[root], name), privatePaths)) { skipped++; continue; }
          if (item.type === 'directory') { directories.push({ root, path: name }); await walk(name, depth + 1); }
          else if (item.type === 'file') {
            if (files.length >= limits.files) throw fail(413, 'The folder has too many files for a private workspace.');
            const read = await operation({ op: 'read', root: roots[root], path: name, maxBytes: limits.fileBytes }, authorize);
            if (!Buffer.isBuffer(read?.data) || read.data.length > limits.fileBytes) throw fail(413, 'A file is too large for a private workspace.');
            bytes += read.data.length; if (bytes > limits.bytes) throw fail(413, 'The folder is too large for a private workspace.');
            files.push({ root, path: name, hash: hash(read.data), data: read.data.toString('base64') });
          } else skipped++;
        }
      };
      await walk('', 0);
    }
    authorize(); files.sort((a, b) => a.root - b.root || a.path.localeCompare(b.path));
    directories.sort((a, b) => a.root - b.root || a.path.localeCompare(b.path));
    return { files, directories, bytes, skipped };
  };
  const validSnapshot = value => {
    if (!value || !Array.isArray(value.files) || value.files.length > limits.files || !Array.isArray(value.directories) || value.directories.length > limits.entries) throw unavailable();
    let bytes = 0; const seen = new Set();
    for (const item of value.files) {
      if (!Number.isSafeInteger(item.root) || item.root < 0 || item.root >= 20 || !relative(item.path) || !hashValue(item.hash) || typeof item.data !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(item.data)) throw unavailable();
      const data = Buffer.from(item.data, 'base64'); bytes += data.length;
      if (data.length > limits.fileBytes || bytes > limits.bytes || hash(data) !== item.hash || seen.has(`${item.root}:${item.path}`)) throw unavailable();
      seen.add(`${item.root}:${item.path}`);
    }
    for (const item of value.directories) if (!Number.isSafeInteger(item.root) || item.root < 0 || item.root >= 20 || !relative(item.path)) throw unavailable();
    return value;
  };
  const baseline = record => validSnapshot(readPrivate(path.join(stateDir, `${record.id}.baseline.json`)));
  const requiredParents = (before, item) => {
    const originalDirectories = new Set(before.directories.filter(directory => directory.root === item.root).map(directory => directory.path));
    const parts = item.path.split('/'); parts.pop();
    return parts.map((_, index) => parts.slice(0, index + 1).join('/')).filter(parent => originalDirectories.has(parent));
  };
  const checkChange = async (record, before, item, authorize) => {
    const result = await operation({ op: 'check-reviewed', root: record.sources[item.root], path: item.path, expectedHash: item.beforeHash,
      requiredParents: requiredParents(before, item), maxBytes: limits.fileBytes }, authorize);
    authorize();
    if (!result || typeof result.matches !== 'boolean') throw fail(503, 'The original file could not be checked safely.');
    return result.matches ? undefined : (typeof result.reason === 'string' && result.reason.trim() ? result.reason.trim().slice(0, 300) : 'The original file or its parent folder changed.');
  };
  const summary = record => {
    const { sourceIdentities, rootIdentities, containerIdentity, ...publicRecord } = record;
    return clone(publicRecord);
  };
  const create = async ({ sources, name = 'Agent workspace' } = {}, authorize) => {
    owner(authorize);
    if (creating) throw fail(409, 'Another private workspace is being prepared.');
    if (!Array.isArray(sources) || !sources.length || sources.length > 20 || typeof name !== 'string' || !name.trim() || name.length > 100 || /[\u0000-\u001f\u007f]/u.test(name)) throw fail(400, 'Choose folders and a name for this workspace.');
    if (load().workspaces.length >= limits.workspaces) throw fail(409, 'Discard an old private workspace before creating another.');
    creating = true; let container;
    try {
      for (const source of sources) if (typeof source !== 'string' || !path.isAbsolute(source) || validateBrowserRoot(source) !== source || sources.some(other => other !== source && within(source, other)) || sources.filter(other => other === source).length !== 1 || within(source, base) || within(base, source)) throw fail(400, 'Choose distinct, non-overlapping original folders.');
      const id = crypto.randomUUID();
      const record = { id, name: name.trim(), createdAt: now(), sources: [...sources], sourceIdentities: sources.map(identity), roots: sources.map((_, index) => path.join(base, id, String(index))), rootIdentities: [], containerIdentity: null, clientId: null, expiresAt: null, status: 'ready' };
      sourceGrants(record);
      const check = checkFor(record, authorize);
      const initial = await snapshot(sources, check);
      // Verify a stable initial snapshot before granting the private copy. Later
      // owner edits are checked against these bytes again before any apply.
      const confirmed = await snapshot(sources, check);
      if (fingerprint(initial) !== fingerprint(confirmed)) throw fail(409, 'The original folder changed while copying. Try again.');
      check(); container = path.join(base, id); fs.mkdirSync(container, { mode: 0o700 }); record.containerIdentity = identity(container);
      for (const root of record.roots) { fs.mkdirSync(root, { mode: 0o700 }); record.rootIdentities.push(identity(root)); }
      for (const item of initial.directories) fs.mkdirSync(path.join(record.roots[item.root], item.path), { recursive: true, mode: 0o700 });
      for (const item of initial.files) fs.writeFileSync(path.join(record.roots[item.root], item.path), Buffer.from(item.data, 'base64'), { flag: 'wx', mode: 0o600 });
      check(); rootsIntact(record); writePrivate(path.join(stateDir, `${id}.baseline.json`), initial); save(record); container = null;
      return summary(record);
    } finally {
      creating = false;
      // No credential exists yet. The fresh container has never been exposed
      // to an agent, and fs.rm does not follow symbolic links inside it.
      if (container) { pinned(); fs.rmSync(container, { recursive: true, force: true }); }
    }
  };
  const bind = (id, clientId, expiresAt, client) => {
    const record = get(id); sourceGrants(record); rootsIntact(record);
    if (busy.has(id) || record.status !== 'ready' || record.clientId || typeof clientId !== 'string' || !clientId || clientId.length > 256 || !Number.isFinite(expiresAt) || expiresAt <= now()) throw fail(409, 'This workspace cannot be attached to this invitation.');
    if (load().workspaces.some(other => other.id !== id && other.clientId === clientId)) throw fail(409, 'This invitation already has a private workspace.');
    record.clientId = clientId; record.expiresAt = expiresAt; record.status = 'bound';
    if (client && client.id === clientId) record.session = clone({ name: client.name, scopes: client.scopes, policy: client.policy });
    save(record); return summary(record);
  };
  const validate = client => {
    if (!client?.browserWorkspaceId) return null;
    const record = get(client.browserWorkspaceId);
    const grantRoots = client.policy?.roots || client.agentRoots;
    if (record.status !== 'bound' || record.clientId !== client.id || record.expiresAt <= now() || record.expiresAt !== client.expiresAt || JSON.stringify(record.roots) !== JSON.stringify(grantRoots) || (client.agentRoots && JSON.stringify(record.roots) !== JSON.stringify(client.agentRoots))) throw fail(403, 'This private workspace session ended.');
    sourceGrants(record); rootsIntact(record); return [...record.roots];
  };
  const review = (id, authorize) => exclusively(id, async () => {
    owner(authorize); const record = get(id); await inactive(record);
    if (!['ready', 'bound', 'reviewed'].includes(record.status)) throw fail(409, 'This workspace has already been applied or discarded.');
    const check = checkFor(record, authorize, true); check();
    const before = baseline(record), after = await snapshot(record.roots, check);
    await inactive(record); check();
    const oldFiles = new Map(before.files.map(item => [`${item.root}:${item.path}`, item]));
    const newFiles = new Map(after.files.map(item => [`${item.root}:${item.path}`, item]));
    if (before.directories.some(item => newFiles.has(`${item.root}:${item.path}`))) throw fail(409, 'Replacing an original folder with a file is not supported. Keep the folder and review again.');
    const changes = []; let previewBytes = 0;
    const text = data => {
      if (data === undefined) return { text: null, binary: false, truncated: false };
      const bytes = Buffer.from(data, 'base64'), value = bytes.toString('utf8');
      const binary = bytes.includes(0) || !Buffer.from(value).equals(bytes);
      const truncated = !binary && (bytes.length > 65536 || previewBytes + bytes.length > 512 * 1024);
      if (!binary && !truncated) previewBytes += bytes.length;
      return { text: binary || truncated ? null : value, binary, truncated };
    };
    for (const key of [...new Set([...oldFiles.keys(), ...newFiles.keys()])].sort()) {
      const oldFile = oldFiles.get(key), newFile = newFiles.get(key);
      if (oldFile?.hash === newFile?.hash) continue;
      const oldText = text(oldFile?.data), newText = text(newFile?.data), item = newFile || oldFile;
      const change = { root: item.root, path: item.path, type: !oldFile ? 'added' : !newFile ? 'deleted' : 'changed', beforeHash: oldFile?.hash ?? null, afterHash: newFile?.hash ?? null,
        beforeText: oldText.text, afterText: newText.text, binary: oldText.binary || newText.binary, previewTruncated: oldText.truncated || newText.truncated, data: newFile?.data ?? null };
      const conflict = await checkChange(record, before, change, check);
      changes.push({ ...change, ...(conflict ? { conflict } : {}) });
    }
    const review = { id: crypto.randomUUID(), workspaceId: id, createdAt: now(), expiresAt: now() + limits.reviewMs, changes,
      summary: { added: changes.filter(item => item.type === 'added').length, changed: changes.filter(item => item.type === 'changed').length, deleted: changes.filter(item => item.type === 'deleted').length, conflicts: changes.filter(item => item.conflict).length, bytes: after.bytes, skipped: after.skipped } };
    const previousReviewId = record.reviewId;
    writePrivate(path.join(stateDir, `${review.id}.review.json`), review);
    record.reviewId = review.id; record.status = 'reviewed'; save(record);
    if (previousReviewId) { try { pinned(); fs.unlinkSync(path.join(stateDir, `${previousReviewId}.review.json`)); } catch {} }
    return { ...review, changes: changes.map(({ data, ...item }) => item) };
  });
  const apply = (id, reviewId, authorize) => exclusively(id, async () => {
    owner(authorize); const record = get(id); await inactive(record);
    if (record.status !== 'reviewed' || !uuid(reviewId) || record.reviewId !== reviewId) throw fail(409, 'Review these changes again before applying them.');
    const reviewed = readPrivate(path.join(stateDir, `${reviewId}.review.json`));
    if (!reviewed || reviewed.id !== reviewId || reviewed.workspaceId !== id || !Number.isFinite(reviewed.expiresAt) || reviewed.expiresAt <= now() || !Array.isArray(reviewed.changes) || reviewed.changes.length > limits.files * 2) throw fail(409, 'This review expired. Review these changes again.');
    if (!Number.isSafeInteger(reviewed.summary?.conflicts) || reviewed.summary.conflicts < 0 ||
      reviewed.changes.some(item => !item || typeof item !== 'object' || ('conflict' in item && (typeof item.conflict !== 'string' || !item.conflict.trim() || item.conflict.length > 300))) ||
      reviewed.summary.conflicts !== reviewed.changes.filter(item => item.conflict).length)
      throw fail(409, 'This review needs fresh conflict checks. Review the changes again.');
    if (reviewed.changes.some(item => item.conflict)) throw fail(409, 'This review contains conflicts. Review the changes again before applying them.');
    const check = checkFor(record, authorize, true); check();
    const before = baseline(record);
    const original = new Map(before.files.map(item => [`${item.root}:${item.path}`, item]));
    const keys = new Set();
    for (const item of reviewed.changes) {
      const key = `${item.root}:${item.path}`, oldFile = original.get(key);
      if (!Number.isSafeInteger(item.root) || item.root < 0 || item.root >= record.roots.length || !relative(item.path) || keys.has(key) || item.beforeHash !== (oldFile?.hash ?? null) || !['added', 'changed', 'deleted'].includes(item.type) || (item.type === 'added') !== !oldFile || (item.type === 'deleted') !== (item.data === null)) throw unavailable();
      if (item.data !== null) {
        if (typeof item.data !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(item.data)) throw unavailable();
        const bytes = Buffer.from(item.data, 'base64');
        if (bytes.length > limits.fileBytes || hash(bytes) !== item.afterHash) throw unavailable();
      } else if (item.afterHash !== null) throw unavailable();
      keys.add(key);
    }
    const outsideCheck = check;
    return runExclusiveApply(clone(record), async (assertLease = () => {}) => {
      const check = () => { assertLease(); return outsideCheck(); };
      await inactive(record); check();
      // Only the reviewed destinations and their original parent folders are
      // preconditions. Another agent's independent file changes are preserved.
      for (const item of reviewed.changes) {
        if (await checkChange(record, before, item, check)) throw fail(409, 'A reviewed file or its parent folder changed. Nothing was applied. Review the changes again.');
      }
      await inactive(record); check();
      if (reviewed.expiresAt <= now()) throw fail(409, 'This review expired. Review these changes again.');
      const result = { workspaceId: id, reviewId, applied: [], partial: false };
      // Persist consumption before writes so a crash cannot replay a review.
      // Full originals remain in the private baseline for manual recovery.
      record.status = 'partial'; record.lastApply = { ...result, partial: true, interrupted: true }; save(record);
      for (const item of reviewed.changes) {
        try {
          check(); await inactive(record);
          if (item.type !== 'deleted') {
            const parts = item.path.split('/'); parts.pop();
            const originalParents = new Set(requiredParents(before, item));
            for (let index = 1; index <= parts.length; index++) {
              const directory = parts.slice(0, index).join('/');
              if (originalParents.has(directory)) {
                const stat = await operation({ op: 'stat', root: record.sources[item.root], path: directory }, check);
                if (stat?.stat?.type !== 'directory') throw fail(409, 'An original parent folder changed.');
                continue;
              }
              try { await operation({ op: 'mkdir', root: record.sources[item.root], path: directory }, check); }
              catch (error) {
                if (error.status !== 409) throw error;
                const stat = await operation({ op: 'stat', root: record.sources[item.root], path: directory }, check);
                if (stat?.stat?.type !== 'directory') throw fail(409, 'A destination folder changed.');
              }
            }
          }
          await operation({ op: item.type === 'deleted' ? 'delete-reviewed' : 'write-reviewed', root: record.sources[item.root], path: item.path, expectedHash: item.beforeHash,
            requiredParents: requiredParents(before, item), ...(item.type === 'deleted' ? {} : { data: item.data }), maxBytes: limits.fileBytes }, check);
          result.applied.push({ root: item.root, path: item.path, type: item.type });
        } catch (error) {
          result.partial = true; result.failed = { root: item.root, path: item.path, message: error.status ? String(error.message).slice(0, 300) : 'This change could not be applied.' }; break;
        }
      }
      record.status = result.partial ? 'partial' : 'applied'; record.lastApply = clone(result); save(record); return result;
    }, () => { const client = owner(authorize); sourceGrants(record); return client; });
  });
  const discard = (id, authorize) => exclusively(id, async () => {
    owner(authorize); const record = get(id); await inactive(record); rootsIntact(record); owner(authorize);
    // Revoked, quiescent agent copies only. Never walk or remove source roots.
    fs.rmSync(path.join(base, id), { recursive: true, force: false });
    const state = load(); state.workspaces = state.workspaces.filter(value => value.id !== id); writePrivate(registryPath, state);
    // Explicit owner discard also removes private backups. Otherwise repeated
    // discards would bypass the retained-workspace storage bound indefinitely.
    for (const filename of [`${id}.baseline.json`, ...(record.reviewId ? [`${record.reviewId}.review.json`] : [])]) {
      try { pinned(); fs.unlinkSync(path.join(stateDir, filename)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    return { id, status: 'discarded' };
  });
  return { create, bind, validate, getOwner: id => summary(get(id)), listOwner: () => load().workspaces.map(summary), review, apply, discard };
}
