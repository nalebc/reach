export const isolatedBrowserReason = 'Host browsers require an isolated agent browser. Existing signed-in browsers cannot be shared with agents.';
export const isolatedControlReason = 'Controlling host apps requires an isolated workspace. Only viewing is available.';
const browserFamilies = ['com.apple.safari', 'com.apple.safaritechnologypreview', 'com.google.chrome', 'org.chromium.chromium',
  'org.mozilla.firefox', 'com.microsoft.edgemac', 'com.brave.browser', 'company.thebrowser.browser', 'com.operasoftware.opera',
  'com.vivaldi.vivaldi', 'com.duckduckgo.macos.browser', 'com.kagi.kagimac'];
const browserNames = ['safari', 'safari technology preview', 'google chrome', 'google chrome beta', 'google chrome dev', 'google chrome canary',
  'chromium', 'firefox', 'firefox developer edition', 'firefox nightly', 'microsoft edge', 'microsoft edge beta', 'microsoft edge dev',
  'microsoft edge canary', 'brave browser', 'brave browser beta', 'brave browser nightly', 'arc', 'opera', 'opera gx', 'vivaldi', 'duckduckgo', 'orion'];
const normalized = (value) => typeof value === 'string' ? value.normalize('NFKC').toLowerCase() : '';
export function unmanagedBrowserApp(app) {
  const id = normalized(app?.bundleId);
  const pathName = normalized(app?.id).split('/').at(-1)?.replace(/\.app$/, '');
  return browserFamilies.some((family) => id === family || id.startsWith(`${family}.`)) ||
    browserNames.includes(normalized(app?.name)) || browserNames.includes(pathName);
}

// This is a non-overridable deny, in addition to the native helper's signed
// process checks. A stored grant or a mistaken catalog flag cannot make the
// apps that administer this connection available to an invited agent.
export function protectedBrowserAppReason(app) {
  const identity = [app?.bundleId, app?.name, app?.id]
    .filter((value) => typeof value === 'string')
    .map((value) => value.normalize('NFKC').toLowerCase())
    .join('\n');
  if (['reach', 'tailscale'].some((name) => identity.includes(name)))
    return 'Reach and Tailscale are always protected. Agents cannot view, control, or request access to them.';
  if (unmanagedBrowserApp(app)) return isolatedBrowserReason;
  return null;
}

export function protectBrowserApp(app) {
  const reason = protectedBrowserAppReason(app);
  return reason ? { ...app, protected: true, reason } : { ...app };
}
