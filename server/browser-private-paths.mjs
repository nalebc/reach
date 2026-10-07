import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { workspacePrivatePaths } from './browser-workspace-paths.mjs';

export const browserPrivateNames = ['.reach', '.ssh', '.aws', '.azure', '.kube', '.gnupg', '.codex', '.claude', '.config', '.netrc', '.npmrc', '.git-credentials',
  '.git', '.gitconfig', '.zshenv', '.zshrc', '.zprofile', '.zlogin', '.zlogout', '.bashrc', '.bash_profile', '.bash_login', '.bash_logout',
  '.profile', '.login', '.cshrc', '.tcshrc', '.inputrc', '.curlrc', '.wgetrc', '.pythonrc.py'];
const applicationRoot = fileURLToPath(new URL('../', import.meta.url));

// Protect the running enforcement code as well as its state. A broad Documents
// share must never turn an approved script into an update of Reach itself.
export function browserPrivatePaths(config, { home = os.homedir(), appRoot = applicationRoot, workspaceRoot } = {}) {
  const paths = [appRoot, config.dataDir, config.agentPolicyFile, ...(config.privatePaths || []),
    ...browserPrivateNames.map(name => path.join(home, name)),
    path.join(home, 'Library'), path.join(home, '.tailscale'), path.join(home, '.local'), path.join(home, 'bin'),
    '/Library/Keychains', '/Library/LaunchAgents', '/Library/LaunchDaemons',
    '/Library/PrivilegedHelperTools', '/var/lib/tailscale', '/var/run/tailscale',
    '/etc/tailscale', '/Applications/Tailscale.app', '/Applications/Reach.app', ...workspacePrivatePaths(config, workspaceRoot)];
  return [...new Set(paths.filter(p => typeof p === 'string' && p).flatMap(p => {
    const absolute = path.resolve(p);
    try { return [absolute, fs.realpathSync.native(absolute)]; } catch { return [absolute]; }
  }))];
}

export function isBrowserPrivatePath(target, privatePaths) {
  const absolute = path.resolve(target);
  return absolute.split(path.sep).some(part => browserPrivateNames.includes(part.toLowerCase())) ||
    privatePaths.some(p => absolute === p || absolute.startsWith(p + path.sep));
}

// A file grant is for data/project folders, never a host home or executable
// installation. Known secret names alone cannot cover every startup mechanism.
export function validateBrowserRoot(root, { home = os.homedir(), runtime = process.execPath } = {}) {
  const error = () => Object.assign(new Error('Choose a project folder or Desktop. Home, system, and application installation folders cannot be shared with agents.'), { status: 403 });
  if (typeof root !== 'string' || !path.isAbsolute(root)) throw error();
  const canonical = value => { try { return fs.realpathSync.native(value); } catch { return path.resolve(value); } };
  const selected = canonical(root);
  const within = (value, parent) => value === parent || value.startsWith(parent + path.sep);
  const protectedRoots = ['/Applications', path.join(home, 'Applications'), '/Library', '/System', '/usr', '/bin', '/sbin', '/opt', '/private/etc', '/etc', path.dirname(runtime)]
    .flatMap(value => [path.resolve(value), canonical(value)]);
  const userHome = canonical(home);
  if (selected === '/' || within(userHome, selected) || protectedRoots.some(protectedRoot => within(selected, protectedRoot) || within(protectedRoot, selected))) throw error();
  return selected;
}
