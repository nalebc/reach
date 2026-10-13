import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { windowsCanonicalPath, windowsWithin } from './app-identity.mjs';

export const browserPrivateNames = ['.reach', '.ssh', '.aws', '.azure', '.kube', '.gnupg', '.codex', '.claude', '.config', '.netrc', '.npmrc', '.git-credentials',
  '.git', '.gitconfig', '.zshenv', '.zshrc', '.zprofile', '.zlogin', '.zlogout', '.bashrc', '.bash_profile', '.bash_login', '.bash_logout',
  '.profile', '.login', '.cshrc', '.tcshrc', '.inputrc', '.curlrc', '.wgetrc', '.pythonrc.py'];
const applicationRoot = fileURLToPath(new URL('../', import.meta.url));

// Protect the running enforcement code as well as its state. A broad Documents
// share must never turn an approved script into an update of Reach itself.
// What the macOS sandbox around agent commands denies (server/agent-shell.mjs):
// Reach's code can't change, its data (credentials) can't be read or written,
// and Tailscale's container (Reach's private socket, Tailscale's own) can't be
// read, written or connected to, nor the keychains or your browsers' data
// (signed-in sessions, Reach's own included). Nothing that runs later outside
// the sandbox can be planted: login launch agents, shell startup files, SSH
// keys that let someone in.
const browserData = ["Google/Chrome", "Google/Chrome Beta", "Google/Chrome Dev", "Google/Chrome Canary", "Chromium",
  "BraveSoftware", "Microsoft Edge", "Arc", "Vivaldi", "com.operasoftware.Opera", "Firefox", "Orion", "Comet", "Dia"];
const startupFiles = [".zshenv", ".zprofile", ".zshrc", ".zlogin", ".zlogout", ".bashrc", ".bash_profile", ".bash_login",
  ".profile", ".config/fish", ".ssh/authorized_keys", ".ssh/authorized_keys2", ".ssh/rc"];
export function agentShellSandbox(config, { home = os.homedir(), appRoot = applicationRoot, sockets = [] } = {}) {
  const containers = path.join(home, "Library", "Group Containers");
  let tailscale = [];
  try { tailscale = fs.readdirSync(containers).filter((name) => /tailscale/i.test(name)).map((name) => path.join(containers, name)); } catch {}
  const real = (list) => [...new Set(list.filter(Boolean).flatMap((item) => {
    const absolute = path.resolve(item);
    try { return [absolute, fs.realpathSync.native(absolute)]; } catch { return [absolute]; }
  }))];
  const library = path.join(home, "Library");
  const secrets = real([config.dataDir, path.join(appRoot, ".reach"), config.agentPolicyFile, ...tailscale, ...sockets,
    path.join(library, "Keychains"), path.join(home, ".tailscale"),
    ...browserData.map((name) => path.join(library, "Application Support", name)),
    path.join(library, "Safari"), path.join(library, "Containers", "com.apple.Safari"), path.join(library, "Cookies")]);
  return {
    readDeny: secrets,
    writeDeny: real([appRoot, ...secrets, path.join(library, "LaunchAgents"), ...startupFiles.map((name) => path.join(home, name))]),
    socketDeny: real([config.dataDir, ...tailscale, ...sockets, "/var/run/tailscaled.socket", "/private/var/run/tailscaled.socket"]),
    ports: [config.port].filter((port) => Number.isInteger(port) && port > 0),
  };
}

// On Windows, beside the list every computer gets: what a Mac keeps in
// ~/Library and the folders outside it that a Mac protects (launch agents,
// Tailscale's state and app, the keychains). The whole of AppData, as the
// Mac's whole ~/Library: browser profiles (Chrome, Edge, Brave, Firefox,
// Opera, Vivaldi), mail (Outlook, Thunderbird, Windows Mail), the credential
// stores (Microsoft\Credentials, Protect, Vault), the user's Startup folder,
// PowerShell's history. Then PowerShell's profiles (its .zshrc), everyone's
// Startup folder, Tailscale's state and program, Windows' own password
// database and scheduled tasks. Folders come from the environment where
// Windows says they are, else where Windows puts them.
function windowsPrivatePaths(home, env) {
  const p = path.win32, absolute = (value) => typeof value === 'string' && p.isAbsolute(value) && /^[a-z]:/i.test(value) ? value : null;
  const programData = absolute(env.ProgramData) || absolute(env.ALLUSERSPROFILE) || 'C:\\ProgramData';
  const systemRoot = absolute(env.SystemRoot) || absolute(env.windir) || 'C:\\Windows';
  const programFiles = [absolute(env.ProgramFiles) || 'C:\\Program Files', absolute(env['ProgramFiles(x86)']) || 'C:\\Program Files (x86)', absolute(env.ProgramW6432)];
  const documents = [p.join(home, 'Documents'), ...(absolute(env.OneDrive) ? [p.join(env.OneDrive, 'Documents')] : [])];
  return [p.join(home, 'AppData'), absolute(env.APPDATA), absolute(env.LOCALAPPDATA),
    ...documents.flatMap(folder => [p.join(folder, 'PowerShell'), p.join(folder, 'WindowsPowerShell')]),
    p.join(programData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'StartUp'), p.join(programData, 'Tailscale'),
    ...programFiles.filter(Boolean).map(folder => p.join(folder, 'Tailscale')),
    p.join(systemRoot, 'System32', 'config'), p.join(systemRoot, 'System32', 'Tasks')];
}

export function browserPrivatePaths(config, { home = os.homedir(), appRoot = applicationRoot, platform = process.platform, env = process.env } = {}) {
  // Windows paths are Windows' whatever the host (tests run them anywhere).
  const windows = platform === 'win32', where = windows ? path.win32 : path;
  const paths = [appRoot, config.dataDir, config.agentPolicyFile, ...(config.privatePaths || []),
    ...browserPrivateNames.map(name => where.join(home, name)),
    where.join(home, 'Library'), where.join(home, '.tailscale'), where.join(home, '.local'), where.join(home, 'bin'),
    '/Library/Keychains', '/Library/LaunchAgents', '/Library/LaunchDaemons',
    '/Library/PrivilegedHelperTools', '/var/lib/tailscale', '/var/run/tailscale',
    '/etc/tailscale', '/Applications/Tailscale.app', '/Applications/Reach.app', ...(windows ? windowsPrivatePaths(home, env) : [])];
  return [...new Set(paths.filter(p => typeof p === 'string' && p).flatMap(p => {
    const absolute = where.resolve(p);
    try { return [absolute, fs.realpathSync.native(absolute)]; } catch { return [absolute]; }
  }))];
}

export function isBrowserPrivatePath(target, privatePaths, { platform = process.platform } = {}) {
  // On Windows one file has one name whatever its letters' case, prefix or
  // trimmed dots (windowsCanonicalPath).
  if (platform === 'win32') {
    const absolute = windowsCanonicalPath(target);
    return absolute.split('\\').some(part => browserPrivateNames.includes(part)) || privatePaths.some(p => windowsWithin(absolute, windowsCanonicalPath(p)));
  }
  const absolute = path.resolve(target);
  return absolute.split(path.sep).some(part => browserPrivateNames.includes(part.toLowerCase())) ||
    privatePaths.some(p => absolute === p || absolute.startsWith(p + path.sep));
}

// Narrow file grants stay in data/project folders. The owner-issued Full and
// Read only presets also permit the exact Home they advertise; their operations
// still enforce private-name/path exclusions and the native descriptor boundary.
export function validateBrowserRoot(root, { home = os.homedir(), runtime = process.execPath, policy } = {}) {
  const homePreset = policy?.browser === true && ['full', 'readonly'].includes(policy.preset);
  const error = () => Object.assign(new Error(homePreset
    ? 'Choose Home, a project folder or Desktop. System and application installation folders cannot be shared with agents.'
    : 'Choose a project folder or Desktop. Home, system, and application installation folders cannot be shared with agents.'), { status: 403 });
  if (typeof root !== 'string' || !path.isAbsolute(root)) throw error();
  const canonical = value => { try { return fs.realpathSync.native(value); } catch { return path.resolve(value); } };
  const selected = canonical(root);
  if (policy?.browser === true && policy.preset === 'full') return selected;
  const within = (value, parent) => value === parent || value.startsWith(parent + path.sep);
  const protectedRoots = ['/Applications', path.join(home, 'Applications'), '/Library', '/System', '/usr', '/bin', '/sbin', '/opt', '/private/etc', '/etc', path.dirname(runtime)]
    .flatMap(value => [path.resolve(value), canonical(value)]);
  const userHome = canonical(home);
  // This context comes from the validated invitation/current credential, never
  // from a file request. No ancestor of Home or filesystem root is exempt.
  if (homePreset && selected !== path.parse(selected).root && selected === userHome) return selected;
  if (selected === path.parse(selected).root || within(userHome, selected) || protectedRoots.some(protectedRoot => within(selected, protectedRoot) || within(protectedRoot, selected))) throw error();
  return selected;
}
