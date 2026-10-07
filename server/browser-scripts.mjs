import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFile, execFileSync } from 'node:child_process';
import os from 'node:os';
import { fail } from './core.mjs';
import { terminalLocation } from './restricted-terminal.mjs';
import { browserPrivatePaths, browserPrivateNames, isBrowserPrivatePath, validateBrowserRoot } from './browser-private-paths.mjs';
import { stripVTControlCharacters } from 'node:util';
import { browserOperationCoordinator } from './browser-operation-coordinator.mjs';

// Parse one executable and its arguments, never a host shell expression. Script
// bodies are interpreted only after the kernel sandbox has been installed.
export function parseBrowserScript(command) {
  if (typeof command !== 'string' || !command.trim() || command.length > 4000 || /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u2028-\u202e\u2066-\u2069]/u.test(command)) throw fail(400, 'Enter one command without hidden controls.');
  const words = []; let word = '', quote = '', started = false;
  for (const c of command.trim()) {
    if (quote) { if (c === quote) quote = ''; else word += c; }
    else if (c === '"' || c === "'") { quote = c; started = true; }
    else if (c === ' ') { if (started) { words.push(word); word = ''; started = false; } }
    else { if (/[;&|><$`()\\]/.test(c)) throw fail(400, 'Request one command at a time. Put multi-step code in a script inside the shared folder.'); word += c; started = true; }
  }
  if (quote) throw fail(400, 'Close the command’s quotes.');
  if (started) words.push(word);
  if (!words[0] || words[0].includes('=') || words[0].startsWith('-')) throw fail(400, 'Start with a program or script name.');
  return words;
}
const systemRoots = ['/bin', '/usr/bin', '/usr/lib', '/System/Library', '/System/Volumes/Preboot/Cryptexes/OS'];
const within = (p, root) => p === root || p.startsWith(root + path.sep);
const literal = (p) => JSON.stringify(p);
function rejectProtectedProgram(program) {
  const name = path.basename(program).normalize('NFKC').toLowerCase();
  if (['reach', 'reach-agent', 'tailscale', 'tailscaled'].includes(name))
    throw fail(403, 'Reach and Tailscale management commands are protected and cannot be approved for agents.');
}
let runtimeFiles;
function nodeRuntimeFiles() {
  if (runtimeFiles) return runtimeFiles;
  const pending = [fs.realpathSync(process.execPath)], files = new Set(), visited = new Set();
  while (pending.length) {
    const file = pending.pop();
    if (visited.has(file) || file.startsWith('/usr/lib/') || file.startsWith('/System/Library/')) continue;
    if (files.size > 100) throw fail(503, 'The script runtime could not be isolated.');
    files.add(file); visited.add(file);
    const lines = execFileSync('/usr/bin/otool', ['-L', file], { encoding: 'utf8', timeout: 5000, maxBuffer: 262144 }).split('\n').slice(1);
    for (const line of lines) {
      let dep = line.trim().split(' (')[0];
      if (dep.startsWith('@loader_path/')) dep = path.resolve(path.dirname(file), dep.slice(13));
      if (dep.startsWith('@rpath/') && !dep.slice(7).includes('/')) dep = path.join(path.dirname(file), dep.slice(7));
      if (!dep) continue;
      if (!dep.startsWith('/')) throw fail(503, 'The script runtime uses unsupported library paths.');
      if (dep.startsWith('/usr/lib/') || dep.startsWith('/System/Library/')) continue;
      pending.push(fs.realpathSync(dep)); files.add(dep);
      files.add(path.join(fs.realpathSync(path.dirname(dep)), path.basename(dep)));
    }
  }
  return runtimeFiles = [...files];
}
// A path argument that leaves the shared folder is refused before anyone is
// asked: the sandbox would deny it anyway, so an approval could only fail.
// "~" is the owner's home here, as a shell would read it (the command itself
// never sees a shell, where it would be a folder named "~").
function rejectOutsidePaths(args, cwd, root) {
  for (const arg of args) {
    const value = arg.includes('=') && arg.startsWith('-') ? arg.slice(arg.indexOf('=') + 1) : arg;
    if (!value || (value.startsWith('-') && !value.includes('/'))) continue;
    const pathLike = value.startsWith('~') || value.startsWith('/') || value === '.' || value === '..' || value.startsWith('./') || value.startsWith('../') || value.split('/').includes('..');
    if (!pathLike) continue;
    const home = value === '~' || value.startsWith('~/') ? os.homedir() + value.slice(1) : null;
    if (value.startsWith('~') && home === null) throw fail(403, 'Stay inside the selected shared folder.');
    const full = path.resolve(cwd, home ?? value);
    if (!within(full, root)) throw fail(403, 'Stay inside the selected shared folder.');
  }
}
export function validateBrowserScript(action, authorize, { resolve, privatePaths = [], config = {} } = {}) {
  if (process.platform !== 'darwin' || !fs.existsSync('/usr/bin/sandbox-exec')) throw fail(503, 'Isolated script execution is not available on this computer. Nothing was run.');
  const client = authorize();
  if (action.type !== 'terminal-script' || !Number.isSafeInteger(action.root) || action.root < 0 || client.kind !== 'agent' || client.policy?.browser !== true || client.policy.restrictedTerminal !== true || client.policy.scriptApproval !== true || !client.agentRoots?.[action.root]) throw fail(403, 'Script approval requests are not enabled for this invitation.');
  terminalLocation({ ...action, command: 'pwd' });
  const root = client.agentRoots[action.root], cwd = resolve(action.root, action.cwd || '', client);
  if (validateBrowserRoot(root) !== root || resolve(action.root, '', client) !== root) throw fail(403, 'The shared folder changed. Request access again.');
  if (isBrowserPrivatePath(root, [...browserPrivatePaths(config), ...privatePaths]) || isBrowserPrivatePath(cwd, [...browserPrivatePaths(config), ...privatePaths])) throw fail(403, 'Reach, credentials, and private application data are not shared.');
  if (!within(cwd, root) || !fs.statSync(cwd).isDirectory() || root === '/' || systemRoots.some(p => within(root, p) || within(p, root))) throw fail(403, 'Choose a shared project folder.');
  const words = parseBrowserScript(action.command);
  rejectOutsidePaths(words.slice(1), cwd, root);
  rejectProtectedProgram(words[0]);
  let executable;
  if (words[0] === 'node') executable = fs.realpathSync(process.execPath);
  else if (words[0].includes('/')) executable = path.resolve(cwd, words[0]);
  else executable = ['/usr/bin', '/bin'].map(p => path.join(p, words[0])).find(p => fs.existsSync(p));
  if (!executable) throw fail(400, 'That program is not available in the isolated terminal. Use a system tool, node, or a script in the shared folder.');
  executable = fs.realpathSync(executable);
  rejectProtectedProgram(executable);
  if (!within(executable, root) && !systemRoots.some(p => within(executable, p)) && executable !== fs.realpathSync(process.execPath)) throw fail(403, 'That program is outside the isolated runtime.');
  if (['sudo', 'su', 'sandbox-exec'].includes(path.basename(executable))) throw fail(403, 'Administrator commands cannot run inside a folder-scoped approval.');
  return { root, cwd, executable, args: words.slice(1), client };
}
export function scriptProfile(root, privatePaths = [], runtime = [], guarded = { writes: [], special: [] }) {
  const ancestors = []; for (let p = path.dirname(root); ; p = path.dirname(p)) { ancestors.push(p); if (path.dirname(p) === p) break; }
  const blocked = [...browserPrivatePaths({}), ...privatePaths].flatMap(p => { const full = path.resolve(p); return fs.existsSync(full) ? [full, fs.realpathSync(full)] : [full]; });
  const pinnedAncestors = new Set([root, ...(guarded.pinned || []).filter(p => within(p, root))]);
  for (const p of [...blocked, ...runtime]) if (within(p, root)) {
    for (let ancestor = path.dirname(p); within(ancestor, root); ancestor = path.dirname(ancestor)) { pinnedAncestors.add(ancestor); if (ancestor === root) break; }
  }
  const privateNamePattern = browserPrivateNames.map(name => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/[a-z]/g, c => `[${c}${c.toUpperCase()}]`)).join('|');
  return `(version 1)
(deny default)
(allow process-exec)
; A script is one isolated process: it cannot start detached helpers that outlive
; cancellation, expiry, or the exact owner approval.
(deny process-fork)
(allow signal (target self))
; dyld opens the root directory itself. This literal is not a recursive grant.
(allow file-read-data (literal "/"))
(allow sysctl-read (sysctl-name-prefix "hw.") (sysctl-name "kern.osrelease") (sysctl-name "kern.osversion") (sysctl-name "kern.ostype") (sysctl-name "kern.version") (sysctl-name "kern.argmax") (sysctl-name "kern.iossupportversion") (sysctl-name "security.mac.lockdown_mode_state"))
(allow mach-lookup (global-name "com.apple.secinitd"))
(allow system-mac-syscall (mac-policy-name "vnguard"))
(allow system-mac-syscall (require-all (mac-policy-name "Sandbox") (mac-syscall-number 67)))
${runtime.length ? `(allow file-read-metadata ${runtime.map(p => `(path-ancestors ${literal(p)})`).join(' ')})\n(allow file-read* ${[...new Set(runtime.map(p => path.dirname(p)))].map(p => `(literal ${literal(p)})`).join(' ')})` : ''}
(allow file-read-metadata ${ancestors.map(p => `(literal ${literal(p)})`).join(' ')})
(allow file-read* file-map-executable ${systemRoots.map(p => `(subpath ${literal(p)})`).join(' ')} ${runtime.map(p => `(literal ${literal(p)})`).join(' ')})
(allow file-read* file-map-executable (subpath ${literal(root)}))
(allow file-write* (subpath ${literal(root)}))
; Hard links can alias a later write to a different pathname. Never create them.
(deny file-link)
(allow file-read* (literal "/dev/null") (literal "/dev/urandom") (literal "/dev/random"))
(allow file-write-data (literal "/dev/null"))
(deny process-exec (literal "/usr/bin/sudo") (literal "/usr/bin/su") (literal "/usr/bin/sandbox-exec"))
(deny file-read* file-write* (regex #"(^|/)(${privateNamePattern})(/|$)"))
(deny file-write-unlink file-write-mode ${[...pinnedAncestors].map(p => `(literal ${literal(p)})`).join(' ')})
${runtime.length ? `(deny file-write* ${runtime.map(p => `(literal ${literal(p)})`).join(' ')})` : ''}
${blocked.length ? `(deny file-read* file-write* ${blocked.map(p => `(subpath ${literal(p)})`).join(' ')})` : ''}
${guarded.writes.length ? `; Hard links may alias unshared data: neither read nor written.\n(deny file-read* file-write* ${guarded.writes.join(' ')})` : ''}
${guarded.special.length ? `(deny file-read* file-write* ${guarded.special.join(' ')})` : ''}`;
}
// Find existing aliases and special files without blocking the event loop for
// a whole large tree. A hard link can reveal or modify an unshared inode, so
// both access directions are denied. Pin every containing directory so the
// script cannot rename a parent and move an alias outside its pathname denial.
const MAX_GUARDED = 2000;
const FIND = ['(', '(', '-type', 'f', '-links', '+1', ')', '-o', '(', '!', '-type', 'f', '!', '-type', 'd', '!', '-type', 'l', ')', ')', '-print0'];
const scanFailed = () => fail(503, 'Reach could not completely check the shared folder. Nothing was run.');
const findIn = (dir) => new Promise((done, failed) => execFile('/usr/bin/find', [dir, ...FIND], { timeout: 20000, maxBuffer: 64 << 20, encoding: 'utf8' },
  // Any error means the exclusion set may be incomplete. An unreadable path
  // could become readable before execution; never turn a partial scan into a grant.
  (error, stdout) => error ? failed(scanFailed()) : done(stdout || '')));
async function guardedFiles(root) {
  const units = [], near = [];
  const expand = (dir, depth) => {
    let entries;
    try {
      const stat = fs.lstatSync(dir);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw scanFailed();
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch { throw scanFailed(); }
    for (const entry of entries) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) (depth < 3 ? expand(p, depth + 1) : units.push(p));
      else near.push(p);
    }
  };
  expand(root, 1);
  const outputs = [];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(8, units.length) }, async () => { while (next < units.length) outputs.push(await findIn(units[next++])); }));
  const found = [...near, ...outputs.join('\0').split('\0').filter(Boolean)];
  const linked = new Set(), special = [], pinned = new Set([root]);
  for (const p of found) {
    if (!within(p, root)) throw scanFailed();
    let stat; try { stat = fs.lstatSync(p); } catch { throw scanFailed(); }
    if (stat.isFile()) { if (stat.nlink > 1) linked.add(p); }
    else if (!stat.isDirectory() && !stat.isSymbolicLink()) special.push(p);
  }
  for (const p of [...linked, ...special]) {
    for (let parent = path.dirname(p); within(parent, root); parent = path.dirname(parent)) {
      pinned.add(parent); if (parent === root) break;
    }
  }
  // Many aliases in a package store can share a conservative directory denial.
  let writes = [...linked].map(p => `(literal ${literal(p)})`);
  if (writes.length > MAX_GUARDED) writes = [...new Set([...linked].map(p => path.dirname(p)))].map(p => `(subpath ${literal(p)})`);
  if (writes.length > MAX_GUARDED || special.length > MAX_GUARDED) throw fail(403, 'This folder has too many linked files to run commands safely. Share a smaller project folder.');
  return { writes, special: special.map(p => `(literal ${literal(p)})`), pinned: [...pinned] };
}
export async function runBrowserScript(action, authorize, { coordinator = browserOperationCoordinator, ...options } = {}) {
  const plan = validateBrowserScript(action, authorize, options);
  return await coordinator.run({ clientId: plan.client.id, root: plan.root, kind: 'script', authorize },
    ({ authorize: current }) => executeBrowserScript(action, current, options));
}
async function executeBrowserScript(action, authorize, { resolve, privatePaths = [], timeoutMs = 30000, config = {} } = {}) {
  const plan = validateBrowserScript(action, authorize, { resolve, privatePaths, config });
  const rootStat = fs.lstatSync(plan.root);
  const current = () => {
    const client = authorize();
    const root = client.agentRoots[action.root], cwd = resolve(action.root, action.cwd || '', client);
    if (client.policy?.restrictedTerminal !== true || client.policy?.scriptApproval !== true || validateBrowserRoot(root) !== root || resolve(action.root, '', client) !== root)
      throw fail(403, 'This invitation no longer allows the approved command.');
    const stat = fs.lstatSync(root);
    if (root !== plan.root || cwd !== plan.cwd || !stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== rootStat.dev || stat.ino !== rootStat.ino) throw fail(403, 'The shared folder changed. Command stopped.');
    return client;
  };
  const guarded = await guardedFiles(plan.root);
  const profile = scriptProfile(plan.root, privatePaths, nodeRuntimeFiles(), guarded);
  current();
  // No inherited environment, credentials, startup files, sockets, or terminal.
  const env = { PATH: `/usr/bin:/bin:${path.dirname(process.execPath)}`, HOME: plan.root, TMPDIR: plan.root, LANG: 'en_US.UTF-8', LC_ALL: 'C', NODE_PATH: '', NODE_OPTIONS: '', OPENSSL_CONF: '/dev/null' };
  return await new Promise((resolveResult, reject) => {
    let output = '', size = 0, failure, done = false;
    const child = spawn('/usr/bin/sandbox-exec', ['-p', profile, plan.executable, ...plan.args], { cwd: plan.cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const stop = (error) => { failure ||= error; if (!done) child.kill('SIGKILL'); };
    const append = (chunk) => { size += chunk.length; if (size > 65536) return stop(fail(403, 'Command stopped after reaching its output limit.')); output += chunk.toString(); };
    child.stdout.on('data', append); child.stderr.on('data', append);
    const timer = setTimeout(() => stop(fail(504, 'Command stopped after 30 seconds. Request approval again if needed.')), Math.min(timeoutMs, 30000));
    const check = setInterval(() => { try { current(); } catch (e) { stop(e); } }, 50);
    child.on('error', () => { failure ||= fail(503, 'The isolated command could not start. Nothing was retried.'); });
    child.on('close', (code, signal) => { done = true; clearTimeout(timer); clearInterval(check); try { current(); } catch (error) { failure ||= error; } if (failure) reject(failure); else resolveResult({ output: stripVTControlCharacters(output).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '') || (signal ? `Command stopped (${signal}).` : ""), exitCode: code }); });
  });
}
