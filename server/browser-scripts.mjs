import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fail } from './core.mjs';
import { terminalLocation } from './restricted-terminal.mjs';

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
    }
  }
  return runtimeFiles = [...files];
}
export function validateBrowserScript(action, authorize, { resolve } = {}) {
  if (process.platform !== 'darwin' || !fs.existsSync('/usr/bin/sandbox-exec')) throw fail(503, 'Isolated script execution is not available on this computer. Nothing was run.');
  const client = authorize();
  if (action.type !== 'terminal-script' || client.kind !== 'agent' || !client.policy?.browser || !client.policy.restrictedTerminal || !client.policy.scriptApproval || !client.agentRoots?.[action.root]) throw fail(403, 'Script approval requests are not enabled for this invitation.');
  terminalLocation({ ...action, command: 'pwd' });
  const root = resolve(action.root, '', client), cwd = resolve(action.root, action.cwd || '', client);
  if (!within(cwd, root) || !fs.statSync(cwd).isDirectory() || root === '/' || systemRoots.some(p => within(root, p) || within(p, root))) throw fail(403, 'Choose a shared project folder.');
  const words = parseBrowserScript(action.command);
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
export function scriptProfile(root, privatePaths = [], runtime = []) {
  const ancestors = []; for (let p = path.dirname(root); ; p = path.dirname(p)) { ancestors.push(p); if (p === '/') break; }
  const blocked = privatePaths.flatMap(p => { const full = path.resolve(p); return fs.existsSync(full) ? [full, fs.realpathSync(full)] : [full]; });
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
${runtime.length ? `(allow file-read-metadata ${runtime.map(p => `(path-ancestors ${literal(p)})`).join(' ')})` : ''}
(allow file-read-metadata ${ancestors.map(p => `(literal ${literal(p)})`).join(' ')})
(allow file-read* file-map-executable ${systemRoots.map(p => `(subpath ${literal(p)})`).join(' ')} ${runtime.map(p => `(literal ${literal(p)})`).join(' ')} ${[...new Set(runtime.filter(p => p.endsWith('.dylib')).map(p => path.dirname(p)))].map(p => `(subpath ${literal(p)})`).join(' ')})
(allow file-read* file-map-executable (subpath ${literal(root)}))
(allow file-write* (subpath ${literal(root)}))
(allow file-read* (literal "/dev/null") (literal "/dev/urandom") (literal "/dev/random"))
(allow file-write-data (literal "/dev/null"))
(deny process-exec (literal "/usr/bin/sudo") (literal "/usr/bin/su") (literal "/usr/bin/sandbox-exec"))
(deny file-read* file-write* (regex #"(^|/)(\\.reach|\\.ssh|\\.aws|\\.codex)(/|$)"))
${blocked.length ? `(deny file-read* file-write* ${blocked.map(p => `(subpath ${literal(p)})`).join(' ')})` : ''}`;
}
function checkTree(root, privatePaths) {
  let count = 0;
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (++count > 30000) throw fail(403, 'This folder is too large to check for isolated scripts. Share a smaller project folder.');
      const p = path.join(dir, entry.name);
      if (['.reach', '.ssh', '.aws', '.codex'].includes(entry.name) || privatePaths.some(x => within(p, path.resolve(x)))) continue;
      const stat = fs.lstatSync(p);
      if (stat.isSymbolicLink()) continue; // Kernel resolves the target and enforces its boundary.
      if (stat.isDirectory()) visit(p);
      else if (!stat.isFile() || stat.nlink !== 1) throw fail(403, 'Scripts require regular files without extra hard links in the shared folder.');
    }
  };
  visit(root);
}
export async function runBrowserScript(action, authorize, { resolve, privatePaths = [], timeoutMs = 30000 } = {}) {
  const plan = validateBrowserScript(action, authorize, { resolve });
  checkTree(plan.root, privatePaths);
  const profile = scriptProfile(plan.root, privatePaths, nodeRuntimeFiles());
  authorize();
  // No inherited environment, credentials, startup files, sockets, or terminal.
  const env = { PATH: `/usr/bin:/bin:${path.dirname(process.execPath)}`, HOME: plan.root, TMPDIR: plan.root, LANG: 'en_US.UTF-8', LC_ALL: 'C', NODE_PATH: '', NODE_OPTIONS: '', OPENSSL_CONF: '/dev/null' };
  return await new Promise((resolveResult, reject) => {
    let output = '', size = 0, failure, done = false;
    const child = spawn('/usr/bin/sandbox-exec', ['-p', profile, plan.executable, ...plan.args], { cwd: plan.cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const stop = (error) => { failure ||= error; if (!done) child.kill('SIGKILL'); };
    const append = (chunk) => { size += chunk.length; if (size > 65536) return stop(fail(403, 'Command stopped after reaching its output limit.')); output += chunk.toString(); };
    child.stdout.on('data', append); child.stderr.on('data', append);
    const timer = setTimeout(() => stop(fail(504, 'Command stopped after 30 seconds. Request approval again if needed.')), Math.min(timeoutMs, 30000));
    const check = setInterval(() => { try { authorize(); } catch (e) { stop(e); } }, 50);
    child.on('error', () => { failure ||= fail(503, 'The isolated command could not start. Nothing was retried.'); });
    child.on('close', (code, signal) => { done = true; clearTimeout(timer); clearInterval(check); if (failure) reject(failure); else resolveResult({ output: output || (signal ? `Command stopped (${signal}).` : ""), exitCode: code }); });
  });
}
