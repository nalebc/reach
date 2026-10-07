import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export const workspaceParent = () => path.join(os.homedir(), 'Reach Agent Workspaces');
export function browserWorkspaceDirectory(config = {}) {
  return path.resolve(config.browserWorkspaceDir || path.join(workspaceParent(),
    crypto.createHash('sha256').update(path.resolve(config.dataDir || '.reach')).digest('hex').slice(0, 16)));
}
export function workspacePrivatePaths(config = {}, workspaceRoot) {
  const paths = [workspaceParent(), browserWorkspaceDirectory(config)].flatMap(value => {
    try { return [value, fs.realpathSync.native(value)]; } catch { return [value]; }
  });
  // This exception is supplied by trusted callers after checking the registry
  // binding, or by the owner's workspace manager. It never broadens a file root.
  return [...new Set(paths)].filter(base => !workspaceRoot ||
    !(workspaceRoot !== base && workspaceRoot.startsWith(base + path.sep)));
}
export function authorizedWorkspaceRoot(client, config, root) {
  if (!client?.browserWorkspaceId || typeof config.resolveBrowserWorkspace !== 'function') return undefined;
  const roots = config.resolveBrowserWorkspace(client);
  return Array.isArray(roots) && roots.includes(root) ? root : undefined;
}
